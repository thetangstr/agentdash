import { Router, type Request, type Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers } from "@paperclipai/db";
import { accessService } from "../services/access.js";
import {
  activityService,
  type ActivityPageCursor,
  type ActivityPageFilters,
} from "../services/activity.js";
import { buildActivityReadScope } from "../services/activity-read-scope.js";
import { logActivity } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, assertCompanyAdministrator, assistantGrantAttribution, getActorInfo } from "./authz.js";

/**
 * AgentDash admin powers (part 4.1): the admin audit.
 *
 * A filterable, pageable view over the activity log, plus a CSV export, for a
 * company's owners and admins. It adds NO read authority: every row goes
 * through buildActivityReadScope, the very filter and redaction the activity
 * feed uses, so it shows exactly the rows (and fields) the same person can
 * already read in the feed, with filters and paging on top.
 */

export const AUDIT_DEFAULT_LIMIT = 100;
export const AUDIT_MAX_LIMIT = 200;
export const AUDIT_MAX_ACTIONS = 20;
export const AUDIT_CSV_PAGE_SIZE = 1000;
export const AUDIT_CSV_MAX_ROWS = 50_000;

export const AUDIT_CSV_COLUMNS = [
  "created_at",
  "actor_type",
  "actor_id",
  "actor_name",
  "action",
  "entity_type",
  "entity_id",
  "agent_id",
  "run_id",
  "via",
  "batch_id",
  "details_json",
] as const;

const ADMIN_ONLY_MESSAGE = "Only owners and admins can see this.";

/** Same shape check as the assistant routes' `since`: `new Date` alone accepts "1". */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ACTION_NAME = /^[A-Za-z0-9_:-]+(?:\.[A-Za-z0-9_:-]+)*$/;
const MAX_TEXT_FILTER = 200;

export interface AuditQuery {
  actorType?: "user" | "agent" | "system";
  actorId?: string;
  actions?: { exact: string[]; prefixes: string[] };
  actionFilter: string[];
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  includeSystem: boolean;
  cursor: ActivityPageCursor | null;
  limit: number;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function single(raw: unknown, name: string): Parsed<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, error: `${name} must be given once` };
  return { ok: true, value: raw };
}

function parseDate(raw: string | undefined, name: string): Parsed<Date | undefined> {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: undefined };
  if (!ISO_8601.test(raw.trim())) return { ok: false, error: `${name} must be an ISO 8601 timestamp` };
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) return { ok: false, error: `${name} must be an ISO 8601 timestamp` };
  return { ok: true, value: parsed };
}

export function encodeAuditCursor(cursor: ActivityPageCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeAuditCursor(raw: string): ActivityPageCursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return null;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [createdAt, id, ...rest] = text.split("|");
  if (rest.length > 0 || !createdAt || !id || !CURSOR_AT.test(createdAt) || !UUID.test(id)) return null;
  if (Number.isNaN(new Date(createdAt).getTime())) return null;
  return { createdAt, id };
}

/** Parses and validates the audit's query string; every bad input is a 400. */
export function parseAuditQuery(query: Request["query"], options: { csv?: boolean } = {}): Parsed<AuditQuery> {
  const fields: Record<string, string | undefined> = {};
  for (const name of ["actorType", "actorId", "action", "entityType", "entityId", "from", "to", "includeSystem", "cursor", "limit"]) {
    const got = single(query[name], name);
    if (!got.ok) return got;
    fields[name] = got.value;
  }

  let actorType: AuditQuery["actorType"];
  if (fields.actorType !== undefined && fields.actorType !== "") {
    if (fields.actorType !== "user" && fields.actorType !== "agent" && fields.actorType !== "system") {
      return { ok: false, error: "actorType must be user, agent or system" };
    }
    actorType = fields.actorType;
  }
  for (const name of ["actorId", "entityType", "entityId"] as const) {
    if ((fields[name]?.length ?? 0) > MAX_TEXT_FILTER) return { ok: false, error: `${name} is too long` };
  }

  const actionFilter = (fields.action ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (actionFilter.length > AUDIT_MAX_ACTIONS) {
    return { ok: false, error: `action accepts at most ${AUDIT_MAX_ACTIONS} names` };
  }
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const name of actionFilter) {
    if (name.length > MAX_TEXT_FILTER) return { ok: false, error: "action names must be shorter" };
    if (name.endsWith(".*")) {
      const prefix = name.slice(0, -2);
      if (!ACTION_NAME.test(prefix)) return { ok: false, error: `action "${name.slice(0, 60)}" is not a valid name or prefix.*` };
      prefixes.push(`${prefix}.`);
    } else {
      if (!ACTION_NAME.test(name)) return { ok: false, error: `action "${name.slice(0, 60)}" is not a valid name or prefix.*` };
      exact.push(name);
    }
  }

  const from = parseDate(fields.from, "from");
  if (!from.ok) return from;
  const to = parseDate(fields.to, "to");
  if (!to.ok) return to;
  if (from.value && to.value && from.value.getTime() > to.value.getTime()) {
    return { ok: false, error: "from must not be after to" };
  }

  let includeSystem = true;
  if (fields.includeSystem !== undefined) {
    if (fields.includeSystem === "false") includeSystem = false;
    else if (fields.includeSystem !== "true") return { ok: false, error: "includeSystem must be true or false" };
  }

  let cursor: ActivityPageCursor | null = null;
  if (!options.csv && fields.cursor !== undefined && fields.cursor !== "") {
    cursor = decodeAuditCursor(fields.cursor);
    if (!cursor) return { ok: false, error: "cursor is not valid" };
  }

  let limit = AUDIT_DEFAULT_LIMIT;
  if (!options.csv && fields.limit !== undefined) {
    if (!/^\d+$/.test(fields.limit)) return { ok: false, error: `limit must be a whole number from 1 to ${AUDIT_MAX_LIMIT}` };
    limit = Number.parseInt(fields.limit, 10);
    if (limit < 1 || limit > AUDIT_MAX_LIMIT) return { ok: false, error: `limit must be a whole number from 1 to ${AUDIT_MAX_LIMIT}` };
  }

  return {
    ok: true,
    value: {
      actorType,
      actorId: fields.actorId || undefined,
      actions: actionFilter.length > 0 ? { exact, prefixes } : undefined,
      actionFilter,
      entityType: fields.entityType || undefined,
      entityId: fields.entityId || undefined,
      from: from.value,
      to: to.value,
      includeSystem,
      cursor,
      limit,
    },
  };
}

const FORMULA_START = /^[\t\r]|^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u;

/**
 * One CSV cell. A cell a spreadsheet would read as a formula (`=`, `+`, `-`,
 * `@`, a tab or a carriage return first) gets a leading `'`; then the usual
 * RFC 4180 quoting.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Review of 4de5523e9: also a formula character after leading whitespace or
  // newlines (spreadsheets trim them), and the full-width forms ＝ ＋ － ＠.
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvLine(cells: unknown[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** The client closed the connection mid-export. */
class ClientGone extends Error {}

type AuditRow = {
  id: string;
  createdAt: Date;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
};

function detailString(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" ? value : null;
}

function batchId(details: Record<string, unknown> | null): string | null {
  const batch = details?.batch;
  if (batch && typeof batch === "object" && typeof (batch as { id?: unknown }).id === "string") {
    return (batch as { id: string }).id;
  }
  return null;
}

export function companyAuditRoutes(
  db: Db,
  options: { csvPageSize?: number; csvMaxRows?: number } = {},
) {
  const router = Router();
  const access = accessService(db);
  const svc = activityService(db);
  const csvPageSize = options.csvPageSize ?? AUDIT_CSV_PAGE_SIZE;
  const csvMaxRows = options.csvMaxRows ?? AUDIT_CSV_MAX_ROWS;

  async function guard(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    // Round 5a: a person's assistant connection (a Claude connector token or
    // its internal loopback) never dumps the audit log, admin or not.
    if (req.actor.source === "assistant_grant") throw forbidden(ADMIN_ONLY_MESSAGE);
    await assertCompanyAdministrator(access, req, companyId, ADMIN_ONLY_MESSAGE);
  }

  /** Display names for the actors on one page (people and this company's agents). */
  async function actorNames(companyId: string, rows: AuditRow[]): Promise<Record<string, string>> {
    const userIds = [...new Set(rows.filter((row) => row.actorType === "user").map((row) => row.actorId))];
    const agentIds = [...new Set(rows.filter((row) => row.actorType === "agent" && UUID.test(row.actorId)).map((row) => row.actorId))];
    const names: Record<string, string> = {};
    if (userIds.length > 0) {
      for (const user of await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds))) {
        if (user.name) names[user.id] = user.name;
      }
    }
    if (agentIds.length > 0) {
      const found = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
      for (const agent of found) names[agent.id] = agent.name;
    }
    return names;
  }

  function pageFilters(companyId: string, query: AuditQuery, visibleWhere: ActivityPageFilters["visibleWhere"]): ActivityPageFilters {
    return {
      companyId,
      actorType: query.actorType,
      actorId: query.actorId,
      actions: query.actions,
      entityType: query.entityType,
      entityId: query.entityId,
      from: query.from,
      to: query.to,
      includeSystem: query.includeSystem,
      visibleWhere,
      cursor: query.cursor,
      limit: query.limit,
    };
  }

  router.get("/companies/:companyId/audit", async (req, res) => {
    const companyId = req.params.companyId as string;
    await guard(req, companyId);
    const parsed = parseAuditQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    // The feed's read filter, unchanged: the audit adds no read authority.
    const scope = await buildActivityReadScope(db, req, companyId);
    const page = await svc.listPage(pageFilters(companyId, parsed.value, scope.visibleWhere));
    const items = await scope.redact(page.rows);
    res.json({
      items,
      actorNames: await actorNames(companyId, items),
      nextCursor: page.nextCursor ? encodeAuditCursor(page.nextCursor) : null,
    });
  });

  router.get("/companies/:companyId/audit.csv", async (req, res: Response) => {
    const companyId = req.params.companyId as string;
    await guard(req, companyId);
    const parsed = parseAuditQuery(req.query, { csv: true });
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const query = parsed.value;
    // Pin the upper bound to the moment the export starts, so the truncation
    // probe and the walk read the same rows even while new ones arrive.
    const now = new Date();
    const pinnedTo = query.to && query.to.getTime() < now.getTime() ? query.to : now;
    const scope = await buildActivityReadScope(db, req, companyId);
    const base = pageFilters(companyId, { ...query, to: pinnedTo, cursor: null, limit: csvPageSize }, scope.visibleWhere);

    // Headers cannot change once rows stream, so decide truncation first:
    // is there a row past the cap?
    const truncated = (await svc.listPage({ ...base, limit: 1, offset: csvMaxRows })).rows.length > 0;

    const day = now.toISOString().slice(0, 10);
    res.status(200);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-${day}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    if (truncated) res.setHeader("X-Audit-Truncated", "true");
    let rowCount = 0;
    let completed = false;
    /**
     * Review of 4de5523e9: respect backpressure. When the socket buffer is
     * full, wait for 'drain' (or the client going away) before the next page,
     * so a slow client never makes the server hold the whole export.
     * Returns false once the client is gone.
     */
    async function writeChunk(text: string): Promise<boolean> {
      if (res.destroyed || res.writableEnded) return false;
      if (res.write(text)) return true;
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });
      return !res.destroyed;
    }
    try {
      if (!(await writeChunk(csvLine([...AUDIT_CSV_COLUMNS])))) throw new ClientGone();
      let cursor: ActivityPageCursor | null = null;
      while (rowCount < csvMaxRows) {
        const page = await svc.listPage({ ...base, cursor, limit: Math.min(csvPageSize, csvMaxRows - rowCount) });
        const rows = await scope.redact(page.rows);
        const names = await actorNames(companyId, rows);
        let chunk = "";
        for (const row of rows) {
          chunk += csvLine([
            row.createdAt.toISOString(),
            row.actorType,
            row.actorId,
            names[row.actorId] ?? "",
            row.action,
            row.entityType,
            row.entityId,
            row.agentId ?? "",
            row.runId ?? "",
            detailString(row.details, "via") ?? "",
            batchId(row.details) ?? "",
            row.details ? JSON.stringify(row.details) : "",
          ]);
        }
        if (chunk && !(await writeChunk(chunk))) throw new ClientGone();
        rowCount += rows.length;
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      if (truncated) {
        const written = await writeChunk(csvLine([
          `TRUNCATED: this export stopped at ${csvMaxRows} rows. Narrow the filters or the dates to export the rest.`,
          ...AUDIT_CSV_COLUMNS.slice(1).map(() => ""),
        ]));
        if (!written) throw new ClientGone();
      }
      // Only a download that reached its end is complete; a client that went
      // away mid-export is recorded with the rows actually handed to it.
      completed = !res.destroyed;
    } catch (err) {
      if (err instanceof ClientGone) {
        completed = false;
      } else {
        // Headers are gone: cut the download short so it cannot pass for complete.
        logger.error({ err, companyId }, "audit CSV export failed");
        res.destroy(err as Error);
      }
    } finally {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "audit.exported",
        entityType: "company",
        entityId: companyId,
        details: {
          filters: {
            actorType: query.actorType ?? null,
            actorId: query.actorId ?? null,
            action: query.actionFilter,
            entityType: query.entityType ?? null,
            entityId: query.entityId ?? null,
            from: query.from?.toISOString() ?? null,
            to: pinnedTo.toISOString(),
            includeSystem: query.includeSystem,
          },
          rowCount,
          truncated,
          completed,
          ...assistantGrantAttribution(req),
        },
      }).catch((err) => logger.error({ err, companyId }, "audit.exported could not be logged"));
      if (!res.destroyed) res.end();
    }
  });

  return router;
}
