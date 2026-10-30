import type { Request } from "express";
import { and, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentStewardships, agents, evaluationEvents, projectAccess, projects } from "@paperclipai/db";
import {
  formatEvaluationAccessClass,
  parseEvaluationAccessClass,
  type EvaluationAccessClass,
  type EvaluationEventType,
} from "@paperclipai/shared";
import { isCompanyAdministrator } from "../../routes/authz.js";
import { resolveAgentV2ProjectScope, seesEverything } from "../../routes/visibility.js";
import { accessService } from "../access.js";
import type { EvaluationEventRow } from "./ledger.js";

/**
 * AgentDash: Agent Performance Management gate 3 — evidence access classes
 * (evaluation LLD §9.1; gate 3 spec P3.1 freeze, implemented by P3.2).
 *
 * Every ledger event carries `evaluation_events.access_class`. Ingest sets it
 * from the source row (`classifyEvent`); every reader — the events list and
 * detail, agent cards, cases, exports, generated review items — filters on it
 * BEFORE anything is returned, counted or aggregated. Narrow only: an
 * unparseable class is readable by company admins alone, and the live
 * restricted-project rule still applies on top of the stored class.
 *
 * P3.1 froze the signatures; P3.2 implemented the bodies.
 *
 * History: rows ingested before gate 3 keep the column default `company`
 * (backfill never rewrites the ledger). The live restricted-project rule in
 * `viewerClassFilter` / `viewerClassCondition` hides any row whose
 * `project_id` is a restricted project the viewer may not read, whatever its
 * stored class, so old rows of restricted projects are covered too.
 */

/** What ingest knows about a source row when it classifies the event built from it. */
export interface EvaluationClassSource {
  sourceTable: string;
  eventType: EvaluationEventType;
  /** The event's project scope hint (`evaluation_events.project_id`): the issue's project, the run's issue's project, … */
  projectId: string | null;
  /** The harness receipt a private assessment belongs to (`agent_corrections` harness evaluations → `assessment.automated`). */
  pairingReceiptId?: string | null;
  /** The agent whose private record this is (human corrections → `correction.recorded`; memory-like content). */
  privateAgentId?: string | null;
}

export interface EvaluationClassContext {
  /** Projects whose visibility is `restricted` when the ingest pass reads the source. */
  restrictedProjectIds: ReadonlySet<string>;
}

/**
 * The class an ingested event carries. Pure. The most private applicable
 * class wins: `private_pairing:<receiptId>` > `private_agent:<agentId>` >
 * `project:<projectId>` (only when that project is restricted) > `company`.
 * Always returns a canonical class (`formatEvaluationAccessClass`).
 */
export function classifyEvent(source: EvaluationClassSource, ctx: EvaluationClassContext): EvaluationAccessClass {
  // A private record whose id cannot form a class is a programming error: it is never downgraded to a wider class.
  if (source.pairingReceiptId) {
    return formatEvaluationAccessClass({ kind: "private_pairing", receiptId: source.pairingReceiptId });
  }
  if (source.privateAgentId) {
    return formatEvaluationAccessClass({ kind: "private_agent", agentId: source.privateAgentId });
  }
  const projectId = source.projectId?.toLowerCase() ?? null;
  if (projectId && ctx.restrictedProjectIds.has(projectId)) {
    return formatEvaluationAccessClass({ kind: "project", projectId });
  }
  return "company";
}

/** Restricted project ids of a company, lowercased (the ingest pass reads them once per tick). */
export async function restrictedProjectIds(db: Pick<Db, "select">, companyId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.visibility, "restricted")));
  return new Set(rows.map((r) => r.id.toLowerCase()));
}

/**
 * Who is reading, resolved once per request. Sets, not callbacks, so the
 * filters below stay pure and can also be rendered as SQL.
 */
export interface EvaluationViewer {
  companyId: string;
  /** `board` covers members and the local board; `agent` includes the read-only evaluator principal. */
  principal: { type: "board"; userId: string | null } | { type: "agent"; agentId: string; evaluator: boolean };
  /** Company admin, instance admin or the local implicit board (`seesEverything`): reads every class, parseable or not. */
  admin: boolean;
  /**
   * Projects the viewer may read now — open, or restricted with the viewer on
   * the access list (`routes/visibility.ts` rules) — or `"all"` when the
   * restricted-project rule hides nothing from them. Decides `project:<id>`;
   * a deleted project is in neither set, so its `project:` rows stay hidden.
   */
  readableProjectIds: "all" | ReadonlySet<string>;
  /** Restricted projects the viewer may NOT read now. A row whose `projectId` is here is hidden whatever its stored class. */
  hiddenProjectIds: ReadonlySet<string>;
  /** Agents the viewer stewards or is the accountable user of: their `private_agent:<id>` rows. Empty for agent principals. */
  privateAgentIds: ReadonlySet<string>;
  /**
   * Receipts readable as `private_pairing:<id>`: the viewer is the represented
   * person, or the paired agent's steward or accountable user (the receipt
   * history rule). Empty for agent principals.
   */
  pairingReceiptIds: ReadonlySet<string>;
}

/**
 * Resolve the viewer for a request already checked for company access.
 * Agent principals (the evaluator included) read `company` and the
 * `project:<id>` rows of projects they may read; never a private class.
 */
export async function resolveEvaluationViewer(db: Db, req: Request, companyId: string): Promise<EvaluationViewer> {
  const none: ReadonlySet<string> = new Set();
  if (req.actor.type === "agent") {
    const agentId = req.actor.agentId ?? "";
    const evaluator = req.actor.principalKind === "evaluator" || req.actor.readOnly === true;
    const legacy = await projectScopeFor(db, companyId, agentId ? { type: "agent", id: agentId } : null);
    // AgentDash (APM gate 4, P4.1): an agent's enforced V2 project scope narrows
    // what it reads here too (the performance manager reads cards as an agent).
    const v2 = agentId ? await resolveAgentV2ProjectScope(db, req, companyId) : null;
    const scope = v2 ? narrowProjectScope(legacy, v2) : legacy;
    return {
      companyId,
      principal: { type: "agent", agentId, evaluator },
      admin: false,
      readableProjectIds: scope.readable,
      hiddenProjectIds: scope.hidden,
      privateAgentIds: none,
      pairingReceiptIds: none,
    };
  }
  const userId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
  const admin = req.actor.type === "board" && (seesEverything(req, companyId) || (await isCompanyAdministrator(accessService(db), req, companyId)));
  if (admin) {
    return {
      companyId,
      principal: { type: "board", userId },
      admin: true,
      readableProjectIds: "all",
      hiddenProjectIds: none,
      privateAgentIds: none,
      pairingReceiptIds: none,
    };
  }
  const scope = await projectScopeFor(db, companyId, userId ? { type: "user", id: userId } : null);
  const privateAgentIds = userId ? await answeredForAgentIds(db, companyId, userId) : new Set<string>();
  const pairingReceiptIds = userId ? await readablePairingReceiptIds(db, companyId, userId, privateAgentIds) : new Set<string>();
  return {
    companyId,
    principal: { type: "board", userId },
    admin: false,
    readableProjectIds: scope.readable,
    hiddenProjectIds: scope.hidden,
    privateAgentIds,
    pairingReceiptIds,
  };
}

/**
 * The restricted-project rule (`routes/visibility.ts`: open, the creator, or
 * on the access list) evaluated once over the company's projects for one
 * principal. Not for admins (they see everything).
 */
async function projectScopeFor(
  db: Pick<Db, "select">,
  companyId: string,
  principal: { type: "user" | "agent"; id: string } | null,
): Promise<{ readable: ReadonlySet<string>; hidden: ReadonlySet<string> }> {
  const rows = await db
    .select({ id: projects.id, visibility: projects.visibility, createdByUserId: projects.createdByUserId })
    .from(projects)
    .where(eq(projects.companyId, companyId));
  const listed = new Set<string>();
  const restricted = rows.filter((r) => r.visibility === "restricted");
  if (principal && restricted.length > 0) {
    const access = await db
      .select({ projectId: projectAccess.projectId })
      .from(projectAccess)
      .where(
        and(
          inArray(
            projectAccess.projectId,
            restricted.map((r) => r.id),
          ),
          eq(projectAccess.principalType, principal.type),
          eq(projectAccess.principalId, principal.id),
        ),
      );
    for (const a of access) listed.add(a.projectId.toLowerCase());
  }
  const readable = new Set<string>();
  const hidden = new Set<string>();
  for (const r of rows) {
    const id = r.id.toLowerCase();
    const open = r.visibility !== "restricted";
    const creator = principal?.type === "user" && !!r.createdByUserId && r.createdByUserId === principal.id;
    if (open || creator || listed.has(id)) readable.add(id);
    else hidden.add(id);
  }
  return { readable, hidden };
}

/**
 * Narrow a project scope to an enforced V2 `see.projects` set: a project
 * outside it is unreadable and its rows are hidden whatever their stored
 * class. Never widens: a project hidden by the legacy rule stays hidden.
 */
function narrowProjectScope(
  scope: { readable: ReadonlySet<string>; hidden: ReadonlySet<string> },
  v2: ReadonlySet<string>,
): { readable: ReadonlySet<string>; hidden: ReadonlySet<string> } {
  const allowed = new Set([...v2].map((id) => id.toLowerCase()));
  const readable = new Set<string>();
  const hidden = new Set(scope.hidden);
  for (const id of scope.readable) {
    if (allowed.has(id)) readable.add(id);
    else hidden.add(id);
  }
  return { readable, hidden };
}

/** Agents the user stewards now (an active stewardship) or is the accountable user of: their `private_agent:<id>` rows. */
async function answeredForAgentIds(db: Pick<Db, "select">, companyId: string, userId: string): Promise<Set<string>> {
  const [stewarded, accountable] = await Promise.all([
    db
      .select({ agentId: agentStewardships.agentId })
      .from(agentStewardships)
      .where(and(eq(agentStewardships.companyId, companyId), eq(agentStewardships.userId, userId), isNull(agentStewardships.endedAt))),
    db
      .select({ agentId: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.accountableUserId, userId))),
  ]);
  return new Set([...stewarded, ...accountable].map((r) => r.agentId.toLowerCase()));
}

/**
 * Receipts readable as `private_pairing:<id>`: the user is the represented
 * person, or answers for the paired agent (steward or accountable user). Read
 * from the receipts' own `assessment.automated` events, whose payload ingest
 * normalised (`representedUserId`, `pairedAgentId`); a receipt whose
 * represented person could not be read stays hidden from everyone but the
 * paired agent's steward, accountable user and admins (narrow, never wider).
 */
async function readablePairingReceiptIds(
  db: Pick<Db, "selectDistinct">,
  companyId: string,
  userId: string,
  answeredFor: ReadonlySet<string>,
): Promise<Set<string>> {
  const represented = sql`${evaluationEvents.payload}->>'representedUserId' = ${userId}`;
  const paired = answeredFor.size > 0 ? sql`${evaluationEvents.payload}->>'pairedAgentId' in (${sql.join([...answeredFor].map((id) => sql`${id}`), sql`, `)})` : undefined;
  const rows = await db
    .selectDistinct({ accessClass: evaluationEvents.accessClass })
    .from(evaluationEvents)
    .where(
      and(
        eq(evaluationEvents.companyId, companyId),
        eq(evaluationEvents.eventType, "assessment.automated"),
        sql`${evaluationEvents.accessClass} like 'private_pairing:%'`,
        paired ? or(represented, paired) : represented,
      ),
    );
  const out = new Set<string>();
  for (const r of rows) {
    const parsed = parseEvaluationAccessClass(r.accessClass);
    if (parsed?.kind === "private_pairing") out.add(parsed.receiptId);
  }
  return out;
}

/**
 * Class-level check, for things that carry classes but are not ledger rows
 * (card sections, dependency citations, review-item routing). Admins read
 * everything; otherwise an unparseable class is never readable.
 */
export function viewerReadsClass(viewer: EvaluationViewer, accessClass: string): boolean {
  if (viewer.admin) return true;
  const parsed = parseEvaluationAccessClass(accessClass);
  if (!parsed) return false;
  switch (parsed.kind) {
    case "company":
      return true;
    case "project":
      return viewer.readableProjectIds === "all" || viewer.readableProjectIds.has(parsed.projectId);
    case "private_pairing":
      return viewer.pairingReceiptIds.has(parsed.receiptId);
    case "private_agent":
      return viewer.privateAgentIds.has(parsed.agentId);
  }
}

/** A pure predicate over ledger rows. */
export type EvaluationRowPredicate = (row: Pick<EvaluationEventRow, "accessClass" | "projectId">) => boolean;

/**
 * The row filter for a viewer: `viewerReadsClass(row.accessClass)` AND the
 * row's `projectId` is not in `hiddenProjectIds` (so a project restricted
 * after its events were ingested as `company` is still hidden). Applied before
 * counting, aggregating or returning.
 */
export function viewerClassFilter(viewer: EvaluationViewer): EvaluationRowPredicate {
  if (viewer.admin) return () => true;
  return (row) => {
    if (!viewerReadsClass(viewer, row.accessClass)) return false;
    const projectId = row.projectId?.toLowerCase() ?? null;
    return !(projectId && viewer.hiddenProjectIds.has(projectId));
  };
}

const CANONICAL_PROJECT_CLASS_PATTERN = "^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/**
 * The same rule as `viewerClassFilter`, as a SQL condition over
 * `evaluation_events`, so list queries filter before their LIMIT. `undefined`
 * for admins (no extra condition). Must agree with the predicate row for row.
 */
export function viewerClassCondition(viewer: EvaluationViewer): SQL | undefined {
  if (viewer.admin) return undefined;
  const ac = evaluationEvents.accessClass;
  const classes = (kind: "project" | "private_pairing" | "private_agent", ids: Iterable<string>) =>
    [...ids].map((id) => `${kind}:${id}` as EvaluationAccessClass);
  const readable: SQL[] = [eq(ac, "company")];
  if (viewer.readableProjectIds === "all") readable.push(sql`${ac} ~ ${CANONICAL_PROJECT_CLASS_PATTERN}`);
  else if (viewer.readableProjectIds.size > 0) readable.push(inArray(ac, classes("project", viewer.readableProjectIds)));
  if (viewer.pairingReceiptIds.size > 0) readable.push(inArray(ac, classes("private_pairing", viewer.pairingReceiptIds)));
  if (viewer.privateAgentIds.size > 0) readable.push(inArray(ac, classes("private_agent", viewer.privateAgentIds)));
  const classOk = or(...readable)!;
  const hidden = [...viewer.hiddenProjectIds];
  if (hidden.length === 0) return classOk;
  // The live restricted-project rule, so a row ingested as `company` before its project was restricted stays hidden.
  return and(classOk, or(isNull(evaluationEvents.projectId), notInArray(evaluationEvents.projectId, hidden)))!;
}
