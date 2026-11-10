import express, { Router, type Request } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray, like, not, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// These fixtures inject req.actor without running the auth middleware, so no
// verified credential exists (same arrangement as agent-visibility-routes).
vi.mock("../services/issue-current-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-current-authority.js")>()),
  issueCurrentAuthority: () => undefined,
}));

import {
  activityLog,
  agentStewardships,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
  principalPermissionGrants,
  projectAccess,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { activityRoutes } from "../routes/activity.js";
import {
  AUDIT_CSV_COLUMNS,
  AUDIT_CSV_MAX_ROWS,
  AUDIT_CSV_PAGE_SIZE,
  companyAuditRoutes,
  csvCell,
  decodeAuditCursor,
  encodeAuditCursor,
} from "../routes/company-audit.js";
import { setAuthzRefusalDb } from "../routes/authz.js";
import { errorHandler } from "../middleware/index.js";
import { activityService, normalizeActivityLimit } from "../services/activity.js";
import { buildActivityReadScope } from "../services/activity-read-scope.js";
import {
  activityVisibilityCondition,
  agentVisibilityCondition,
  canReadCompanySpend,
  redactHiddenIssuesInActivityRows,
  resolveAgentVisibility,
} from "../routes/visibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * The feed's route handler exactly as it was before buildActivityReadScope
 * (94b9e03ee, server/src/routes/activity.ts), kept here as the oracle of the
 * refactor: the refactored feed must answer byte-for-byte what this answers.
 */
function legacyActivityRouter(db: ReturnType<typeof createDb>) {
  const router = Router();
  const svc = activityService(db);
  router.get("/legacy/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    await resolveAgentVisibility(db, req, companyId);
    let since: Date | undefined;
    const rawSince = req.query.since as string | undefined;
    if (rawSince !== undefined) {
      const parsed = new Date(rawSince);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "since must be an ISO 8601 timestamp" });
        return;
      }
      since = parsed;
    }
    const canReadSpend = await canReadCompanySpend(db, req, companyId);
    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
      since,
      limit: normalizeActivityLimit(Number(req.query.limit)),
      includeSystem: req.query.includeSystem === "false" ? false : req.query.includeSystem === "true" ? true : undefined,
      visibleWhere: and(
        activityVisibilityCondition(req, companyId),
        canReadSpend ? undefined : not(or(
          inArray(activityLog.entityType, ["cost_event", "finance_event", "budget_policy", "budget_incident"]),
          like(activityLog.action, "cost.%"), like(activityLog.action, "finance.%"), like(activityLog.action, "budget.%"),
          inArray(activityLog.action, ["company.budget_updated", "agent.budget_updated"]),
        )!),
        agentVisibilityCondition(req, companyId, activityLog.agentId),
      ),
    };
    const rows = await svc.list(filters);
    const result = canReadSpend ? rows : rows.map((row) => {
      if (!row.details) return row;
      const { budgetMonthlyCents: _budget, spentMonthlyCents: _spent, ...details } = row.details;
      return { ...row, details };
    });
    res.json(await redactHiddenIssuesInActivityRows(db, req, companyId, result));
  });
  return router;
}

describeEmbeddedPostgres("admin audit (part 4.1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OTHER_COMPANY = randomUUID();
  const BIG_COMPANY = randomUUID();
  const ADMIN = "audit-admin";
  const TITUS = "audit-titus"; // member: steward of Casper, on the listed project
  const SAM = "audit-sam"; // member with nothing
  const SPENDER = "audit-spender"; // member with agents:create (reads spend)
  const OTHER_ADMIN = "audit-other-admin"; // admin of OTHER_COMPANY only

  const CASPER = randomUUID();
  const OTHER_AGENT = randomUUID();
  const OPEN_PROJECT = randomUUID();
  const LISTED_PROJECT = randomUUID();
  const ISSUE_OPEN = randomUUID();
  const ISSUE_LISTED = randomUUID();
  const ISSUE_HIDDEN = randomUUID();

  const base = Date.parse("2026-11-01T10:00:00.000Z");
  const at = (minutes: number) => new Date(base + minutes * 60_000);
  let seeded: string[] = [];

  async function addRow(values: Partial<typeof activityLog.$inferInsert> & { action: string; createdAt: Date }, companyId = COMPANY) {
    const [row] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "user",
        actorId: ADMIN,
        entityType: "company",
        entityId: companyId,
        origin: "server",
        ...values,
      })
      .returning();
    return row!.id;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-audit-");
    db = createDb(tempDb.connectionString);
    setAuthzRefusalDb(db);

    await db.insert(companies).values([
      { id: COMPANY, name: "Audit Co", issuePrefix: "AUD", agentVisibilityDefault: "owner" },
      { id: OTHER_COMPANY, name: "Other Co", issuePrefix: "AUO" },
      { id: BIG_COMPANY, name: "Big Co", issuePrefix: "AUB" },
    ]);
    const now = new Date();
    for (const [id, name] of [
      [ADMIN, "Ada Admin"],
      [TITUS, "=HYPERLINK(\"http://evil\")"],
      [SAM, "Sam, \"the\" member"],
      [SPENDER, "Spender"],
      [OTHER_ADMIN, "Olga"],
    ] as const) {
      await db.insert(authUsers).values({ id, name, email: `${id}@example.test`, createdAt: now, updatedAt: now });
    }
    for (const [companyId, userId, role] of [
      [COMPANY, ADMIN, "admin"],
      [COMPANY, TITUS, "member"],
      [COMPANY, SAM, "member"],
      [COMPANY, SPENDER, "member"],
      [OTHER_COMPANY, OTHER_ADMIN, "admin"],
      [BIG_COMPANY, ADMIN, "admin"],
    ] as const) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
    }
    await db.insert(principalPermissionGrants).values({
      companyId: COMPANY, principalType: "user", principalId: SPENDER, permissionKey: "agents:create", grantedByUserId: ADMIN,
    });
    await db.insert(agents).values([
      { id: CASPER, companyId: COMPANY, name: "Casper", role: "general", createdByUserId: ADMIN },
      { id: OTHER_AGENT, companyId: COMPANY, name: "Hidden Agent", role: "general", createdByUserId: ADMIN },
    ]);
    await db.insert(agentStewardships).values({ companyId: COMPANY, agentId: CASPER, userId: TITUS });
    await db.insert(projects).values([
      { id: OPEN_PROJECT, companyId: COMPANY, name: "Open", createdByUserId: ADMIN },
      { id: LISTED_PROJECT, companyId: COMPANY, name: "Listed", createdByUserId: ADMIN, visibility: "restricted" },
    ]);
    await db.insert(projectAccess).values({ projectId: LISTED_PROJECT, principalType: "user", principalId: TITUS, grantedByUserId: ADMIN });
    await db.insert(issues).values([
      { id: ISSUE_OPEN, companyId: COMPANY, title: "Open task", status: "todo", projectId: OPEN_PROJECT, createdByUserId: ADMIN },
      { id: ISSUE_LISTED, companyId: COMPANY, title: "Listed task", status: "todo", projectId: LISTED_PROJECT, createdByUserId: ADMIN },
      { id: ISSUE_HIDDEN, companyId: COMPANY, title: "Hidden task", status: "todo", projectId: OPEN_PROJECT, createdByUserId: ADMIN, hiddenAt: now },
    ]);

    seeded = [
      await addRow({ action: "issue.updated", entityType: "issue", entityId: ISSUE_OPEN, createdAt: at(1), details: { blockedByIssueIds: [ISSUE_LISTED], title: "Open task" } }),
      await addRow({ action: "issue.created", entityType: "issue", entityId: ISSUE_LISTED, createdAt: at(2), details: { title: "Listed task" } }),
      await addRow({ action: "issue.updated", entityType: "issue", entityId: ISSUE_HIDDEN, createdAt: at(3), details: { title: "Hidden task" } }),
      await addRow({ action: "cost.recorded", entityType: "cost_event", entityId: randomUUID(), createdAt: at(4), details: { costCents: 12 } }),
      await addRow({ action: "company.updated", createdAt: at(5), details: { name: "Audit Co", budgetMonthlyCents: 5000, spentMonthlyCents: 10 } }),
      await addRow({ action: "agent.updated", actorType: "agent", actorId: OTHER_AGENT, agentId: OTHER_AGENT, entityType: "agent", entityId: OTHER_AGENT, createdAt: at(6), details: { note: "secret" } }),
      await addRow({ action: "agent.updated", actorType: "agent", actorId: CASPER, agentId: CASPER, entityType: "agent", entityId: CASPER, createdAt: at(7), details: { note: "casper" } }),
      await addRow({ action: "heartbeat.tick", actorType: "system", actorId: "system", createdAt: at(8), details: null }),
      await addRow({ action: "agent.paused", actorType: "system", actorId: "system", agentId: CASPER, entityType: "agent", entityId: CASPER, createdAt: at(9) }),
      await addRow({ action: "access.would_refuse", createdAt: at(10), details: { shadow: true } }),
      await addRow({ action: "environment.lease_acquired", actorType: "agent", actorId: CASPER, agentId: CASPER, createdAt: at(11) }),
      await addRow({ action: "issue.comment_added", actorType: "user", actorId: TITUS, entityType: "issue", entityId: ISSUE_OPEN, createdAt: at(12), details: { via: "assistant_grant g1 (Claude)", batch: { id: "batch-123", kind: "issue.update" } } }),
      await addRow({ action: "project.updated", entityType: "project", entityId: LISTED_PROJECT, createdAt: at(13), details: { name: "Listed" } }),
      await addRow({ action: "approval.approved", entityType: "approval", entityId: randomUUID(), createdAt: at(14), details: {} }),
    ];
    await addRow({ action: "issue.updated", entityType: "issue", entityId: randomUUID(), actorId: OTHER_ADMIN, createdAt: at(15), details: { secret: "other company" } }, OTHER_COMPANY);
  }, 60_000);

  afterAll(async () => {
    setAuthzRefusalDb(null);
    await tempDb?.cleanup();
  });

  function appAs(actor: Record<string, unknown>, auditOptions?: Parameters<typeof companyAuditRoutes>[1]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", activityRoutes(db));
    app.use("/api", companyAuditRoutes(db, auditOptions));
    app.use("/api", legacyActivityRouter(db));
    app.use(errorHandler);
    return app;
  }

  const asUser = (userId: string, role: string, companyIds = [COMPANY, BIG_COMPANY]) => ({
    type: "board",
    source: "session",
    userId,
    companyIds,
    memberships: companyIds.map((companyId) => ({ companyId, membershipRole: role, status: "active" })),
  });
  const asAgent = (agentId: string) => ({ type: "agent", agentId, companyId: COMPANY, source: "agent_key", companyIds: [COMPANY] });
  const admin = () => appAs(asUser(ADMIN, "admin"));

  async function auditAll(app: express.Express, query: string) {
    const items: Array<Record<string, any>> = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const res = await request(app).get(`/api/companies/${COMPANY}/audit?${query}&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      items.push(...res.body.items);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i += 1; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  describe("one read filter: buildActivityReadScope", () => {
    it("the refactored feed answers byte-for-byte what the pre-refactor handler answered", async () => {
      const actors = [
        ["admin", asUser(ADMIN, "admin")],
        ["steward member", asUser(TITUS, "member")],
        ["plain member", asUser(SAM, "member")],
        ["spend member", asUser(SPENDER, "member")],
        ["agent", asAgent(CASPER)],
        ["instance admin", { ...asUser("instance-admin", "member"), isInstanceAdmin: true }],
      ] as const;
      const queries = [
        "",
        "includeSystem=true",
        "includeSystem=false",
        "entityType=issue",
        `entityType=issue&entityId=${ISSUE_LISTED}`,
        `agentId=${OTHER_AGENT}`,
        "limit=3",
        `since=${encodeURIComponent(at(6).toISOString())}`,
        "since=not-a-date",
      ];
      let compared = 0;
      for (const [label, actor] of actors) {
        const app = appAs(actor);
        for (const query of queries) {
          const now = await request(app).get(`/api/companies/${COMPANY}/activity?${query}`);
          const before = await request(app).get(`/api/legacy/companies/${COMPANY}/activity?${query}`);
          expect(now.status, `${label} ?${query}`).toBe(before.status);
          expect(now.text, `${label} ?${query}`).toBe(before.text);
          compared += 1;
        }
      }
      expect(compared).toBe(54);
      // The fixture really exercises each rule (else "identical" proves little).
      const sam = await request(appAs(asUser(SAM, "member"))).get(`/api/companies/${COMPANY}/activity?includeSystem=true`);
      const samIds = sam.body.map((row: { id: string }) => row.id);
      expect(samIds).not.toContain(seeded[1]); // restricted project issue
      expect(samIds).not.toContain(seeded[2]); // hidden issue
      expect(samIds).not.toContain(seeded[3]); // spend row
      expect(samIds).not.toContain(seeded[5]); // invisible agent
      const company = sam.body.find((row: { id: string }) => row.id === seeded[4]);
      expect(company.details).toEqual({ name: "Audit Co" }); // spend fields stripped
      const blocked = sam.body.find((row: { id: string }) => row.id === seeded[0]);
      expect(JSON.stringify(blocked.details)).not.toContain(ISSUE_LISTED); // hidden blocker pruned
    });

    it("the audit's read path (scope + listPage) gives a restricted reader exactly the feed's rows", async () => {
      for (const actor of [asUser(TITUS, "member"), asUser(SAM, "member"), asUser(SPENDER, "member"), asAgent(CASPER)]) {
        const feed = await request(appAs(actor)).get(`/api/companies/${COMPANY}/activity?includeSystem=true`);
        const req = { actor } as unknown as Request;
        const scope = await buildActivityReadScope(db, req, COMPANY);
        const page = await activityService(db).listPage({ companyId: COMPANY, includeSystem: true, visibleWhere: scope.visibleWhere, limit: 200 });
        const items = JSON.parse(JSON.stringify(await scope.redact(page.rows)));
        expect(items).toEqual(feed.body);
      }
    });
  });

  describe("GET /companies/:companyId/audit", () => {
    it("non-admins get 403 and the refusal is logged; agents too", async () => {
      for (const actor of [asUser(TITUS, "member"), asUser(SPENDER, "member")]) {
        const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/audit`);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Only owners and admins can see this.");
        expect((await request(appAs(actor)).get(`/api/companies/${COMPANY}/audit.csv`)).status).toBe(403);
      }
      expect((await request(appAs(asAgent(CASPER))).get(`/api/companies/${COMPANY}/audit`)).status).toBe(403);
      await vi.waitFor(async () => {
        const refused = await db
          .select()
          .from(activityLog)
          .where(and(eq(activityLog.action, "authz.refused"), eq(activityLog.actorId, TITUS)));
        expect(refused.length).toBeGreaterThanOrEqual(1);
        expect(refused[0]!.details).toMatchObject({ reasonCode: "COMPANY_ADMINISTRATOR_REQUIRED" });
      });
    });

    it("an admin of another company cannot read this one, and this company's audit never shows another's rows", async () => {
      const outsider = appAs(asUser(OTHER_ADMIN, "admin", [OTHER_COMPANY]));
      expect((await request(outsider).get(`/api/companies/${COMPANY}/audit`)).status).toBe(403);
      expect((await request(outsider).get(`/api/companies/${COMPANY}/audit.csv`)).status).toBe(403);
      const mine = await auditAll(admin(), "includeSystem=true");
      expect(mine.every((row) => row.companyId === COMPANY)).toBe(true);
      expect(JSON.stringify(mine)).not.toContain("other company");
      const theirs = await request(outsider).get(`/api/companies/${OTHER_COMPANY}/audit`);
      expect(theirs.status).toBe(200);
      expect(theirs.body.items.map((row: { companyId: string }) => row.companyId)).toEqual([OTHER_COMPANY]);
    });

    it("returns the same rows, with the same redaction, as /activity for the same filters", async () => {
      const app = admin();
      for (const [auditQuery, feedQuery] of [
        ["includeSystem=true", "includeSystem=true"],
        ["includeSystem=false", "includeSystem=false"],
        ["entityType=issue", "entityType=issue&includeSystem=true"],
        [`entityType=issue&entityId=${ISSUE_OPEN}`, `entityType=issue&entityId=${ISSUE_OPEN}&includeSystem=true`],
        [`from=${encodeURIComponent(at(6).toISOString())}`, `since=${encodeURIComponent(at(6).toISOString())}&includeSystem=true`],
      ]) {
        const feed = await request(app).get(`/api/companies/${COMPANY}/activity?${feedQuery}&limit=500`);
        const audit = await auditAll(app, auditQuery);
        expect(audit, auditQuery).toEqual(feed.body);
      }
      const all = await auditAll(app, "includeSystem=true");
      const ids = all.map((row) => row.id);
      expect(ids).not.toContain(seeded[2]); // a hidden issue is absent for everyone, admins included
      expect(ids).toContain(seeded[3]); // an admin reads spend (agents:create)
    });

    it("filters: actor, actor type, exact and prefix actions, dates", async () => {
      const app = admin();
      const byActor = await auditAll(app, `actorId=${TITUS}&entityType=issue`);
      expect(byActor.map((row) => row.id)).toEqual([seeded[11]]);
      const systemOnly = await auditAll(app, "actorType=system");
      expect(systemOnly.map((row) => row.id)).toEqual([seeded[8], seeded[7]]);
      const prefix = await auditAll(app, "action=issue.*");
      expect(prefix.map((row) => row.action).sort()).toEqual(["issue.comment_added", "issue.created", "issue.updated"]);
      const exact = await auditAll(app, "action=agent.paused,cost.recorded");
      expect(exact.map((row) => row.id)).toEqual([seeded[8], seeded[3]]);
      const window = await auditAll(app, `from=${encodeURIComponent(at(4).toISOString())}&to=${encodeURIComponent(at(5).toISOString())}`);
      expect(window.map((row) => row.id)).toEqual([seeded[4], seeded[3]]);
      const noSystem = await auditAll(app, "includeSystem=false");
      expect(noSystem.map((row) => row.id)).not.toContain(seeded[7]);
      expect(noSystem.map((row) => row.id)).toContain(seeded[8]); // agent.paused stays (important)
      const names = await request(app).get(`/api/companies/${COMPANY}/audit?actorType=agent`);
      expect(names.body.actorNames[CASPER]).toBe("Casper");
    });

    it("rejects bad input with 400", async () => {
      const app = admin();
      const tooMany = Array.from({ length: 21 }, (_, i) => `a.b${i}`).join(",");
      for (const query of [
        "from=1",
        "to=yesterday",
        `from=${at(5).toISOString()}&to=${at(4).toISOString()}`,
        `action=${tooMany}`,
        "action=*",
        "action=issue.%25",
        "action=.*",
        "actorType=robot",
        "includeSystem=maybe",
        "cursor=not-a-cursor!",
        `cursor=${Buffer.from("2026-11-01|x").toString("base64url")}`,
        "limit=0",
        "limit=201",
        "limit=abc",
        "limit=1.5",
        "actorId=a&actorId=b",
      ]) {
        const res = await request(app).get(`/api/companies/${COMPANY}/audit?${query}`);
        expect(res.status, query).toBe(400);
      }
      const twenty = Array.from({ length: 20 }, (_, i) => `a.b${i}`).join(",");
      expect((await request(app).get(`/api/companies/${COMPANY}/audit?action=${twenty}`)).status).toBe(200);
      expect((await request(app).get(`/api/companies/${COMPANY}/audit?limit=200`)).status).toBe(200);
      expect((await request(app).get(`/api/companies/${COMPANY}/audit?limit=1`)).body.items).toHaveLength(1);
    });

    it("default limit is 100 and there is no 500 cap on paging", async () => {
      await db.execute(sql`
        insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, origin, created_at)
        select ${BIG_COMPANY}::uuid, 'user', ${ADMIN}, 'bulk.row', 'company', ${BIG_COMPANY}, 'server',
               timestamptz '2026-10-01T00:00:00Z' + (n || ' seconds')::interval
        from generate_series(1, 601) as n`);
      const app = admin();
      const first = await request(app).get(`/api/companies/${BIG_COMPANY}/audit`);
      expect(first.body.items).toHaveLength(100);
      let count = 0;
      let cursor: string | null = null;
      do {
        const res = await request(app).get(`/api/companies/${BIG_COMPANY}/audit?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
        count += res.body.items.length;
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(count).toBe(601);
    });

    it("the cursor is stable across inserts and ties", async () => {
      const app = admin();
      const tieAt = at(30);
      const ties = [
        await addRow({ action: "tie.row", createdAt: tieAt }),
        await addRow({ action: "tie.row", createdAt: tieAt }),
        await addRow({ action: "tie.row", createdAt: tieAt }),
      ];
      const pages: string[] = [];
      let res = await request(app).get(`/api/companies/${COMPANY}/audit?action=tie.*&limit=1`);
      pages.push(...res.body.items.map((row: { id: string }) => row.id));
      // New rows arrive, newer than everything, while the reader pages.
      await addRow({ action: "tie.row", createdAt: at(31) });
      await addRow({ action: "tie.row", createdAt: new Date() });
      while (res.body.nextCursor) {
        res = await request(app).get(`/api/companies/${COMPANY}/audit?action=tie.*&limit=1&cursor=${res.body.nextCursor}`);
        pages.push(...res.body.items.map((row: { id: string }) => row.id));
      }
      expect(pages).toEqual([...ties].sort().reverse());
      // Microsecond timestamps survive the round trip through the cursor.
      await db.execute(sql`update activity_log set created_at = created_at + interval '123 microseconds' where id = ${ties[0]}::uuid`);
      const cursor = decodeAuditCursor(encodeAuditCursor({ createdAt: "2026-11-01T10:30:00.000123Z", id: ties[0]! }));
      expect(cursor).toEqual({ createdAt: "2026-11-01T10:30:00.000123Z", id: ties[0] });
      const fine = await request(app).get(`/api/companies/${COMPANY}/audit?action=tie.*&limit=200`);
      const fineIds = fine.body.items.map((row: { id: string }) => row.id);
      expect(fineIds.indexOf(ties[0])).toBeLessThan(fineIds.indexOf(ties[1]));
      const afterFirst = await request(app).get(`/api/companies/${COMPANY}/audit?action=tie.*&limit=200&cursor=${encodeAuditCursor(cursor!)}`);
      expect(afterFirst.body.items.map((row: { id: string }) => row.id)).toEqual([...ties.slice(1)].sort().reverse());
      await db.delete(activityLog).where(eq(activityLog.action, "tie.row"));
    });
  });

  describe("GET /companies/:companyId/audit.csv", () => {
    it("quotes cells and guards formula injection", () => {
      expect(csvCell("plain")).toBe("plain");
      expect(csvCell("a,b")).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell("two\nlines")).toBe('"two\nlines"');
      expect(csvCell("=1+1")).toBe("'=1+1");
      expect(csvCell("+1")).toBe("'+1");
      expect(csvCell("-1")).toBe("'-1");
      expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
      expect(csvCell("\tx")).toBe("'\tx");
      expect(csvCell("\rx")).toBe("\"'\rx\"");
      expect(csvCell("=a,b")).toBe("\"'=a,b\"");
      expect(csvCell(null)).toBe("");
    });

    it("exports the audit's rows with the documented columns, and logs audit.exported", async () => {
      const injected = await addRow({ action: "issue.updated", entityType: "issue", entityId: "+cmd|' /C calc'!A0", actorId: TITUS, createdAt: at(20), details: { note: "a \"quoted\", comma" } });
      // Pin both reads to one instant: a refusal row an earlier test fired and
      // forgot can land at any moment, and must not count in one read only.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const pinned = encodeURIComponent(new Date().toISOString());
      const json = await auditAll(admin(), `includeSystem=true&to=${pinned}`);
      const res = await request(admin()).get(`/api/companies/${COMPANY}/audit.csv?includeSystem=true&to=${pinned}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/csv/);
      expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"$/);
      expect(res.headers["x-audit-truncated"]).toBeUndefined();
      const rows = parseCsv(res.text);
      expect(rows[0]).toEqual([...AUDIT_CSV_COLUMNS]);
      expect(rows.slice(1).map((row) => row[11] ? JSON.parse(row[11]).note ?? null : null)).toEqual(json.map((row) => row.details?.note ?? null));
      expect(rows).toHaveLength(json.length + 1);
      const evil = rows.find((row) => row[6]?.includes("calc"))!;
      expect(evil[6]).toBe("'+cmd|' /C calc'!A0");
      expect(evil[3]).toBe("'=HYPERLINK(\"http://evil\")");
      expect(JSON.parse(evil[11]!)).toEqual({ note: "a \"quoted\", comma" });
      const batchRow = rows.find((row) => row[4] === "issue.comment_added")!;
      expect(batchRow[9]).toBe("assistant_grant g1 (Claude)");
      expect(batchRow[10]).toBe("batch-123");
      expect(rows.find((row) => row[2] === SAM)).toBeUndefined();
      await vi.waitFor(async () => {
        const [exported] = await db
          .select()
          .from(activityLog)
          .where(and(eq(activityLog.companyId, COMPANY), eq(activityLog.action, "audit.exported")));
        expect(exported).toBeDefined();
        expect(exported!.actorId).toBe(ADMIN);
        expect(exported!.details).toMatchObject({
          rowCount: json.length,
          truncated: false,
          completed: true,
          filters: { includeSystem: true, action: [], actorId: null },
        });
      });
      await db.delete(activityLog).where(eq(activityLog.id, injected));
      await db.delete(activityLog).where(eq(activityLog.action, "audit.exported"));
    });

    it("stops at the cap: X-Audit-Truncated and a final row saying so (small cap)", async () => {
      const res = await request(appAs(asUser(ADMIN, "admin"), { csvMaxRows: 5, csvPageSize: 2 })).get(`/api/companies/${COMPANY}/audit.csv`);
      expect(res.headers["x-audit-truncated"]).toBe("true");
      const rows = parseCsv(res.text);
      expect(rows).toHaveLength(1 + 5 + 1);
      expect(rows.at(-1)![0]).toMatch(/^TRUNCATED: this export stopped at 5 rows/);
      const exact = await request(appAs(asUser(ADMIN, "admin"), { csvMaxRows: 1000, csvPageSize: 2 })).get(`/api/companies/${COMPANY}/audit.csv?action=agent.updated`);
      expect(exact.headers["x-audit-truncated"]).toBeUndefined();
      expect(parseCsv(exact.text)).toHaveLength(3);
    });

    it("the real cap: 50,000 rows in pages of 1,000", async () => {
      expect(AUDIT_CSV_MAX_ROWS).toBe(50_000);
      expect(AUDIT_CSV_PAGE_SIZE).toBe(1000);
      await db.execute(sql`
        insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, origin, created_at)
        select ${BIG_COMPANY}::uuid, 'user', ${ADMIN}, 'cap.row', 'company', ${BIG_COMPANY}, 'server',
               timestamptz '2026-09-01T00:00:00Z' + (n || ' seconds')::interval
        from generate_series(1, 50001 - 601) as n`);
      const res = await request(admin()).get(`/api/companies/${BIG_COMPANY}/audit.csv`);
      expect(res.headers["x-audit-truncated"]).toBe("true");
      const lines = res.text.split("\r\n").filter(Boolean);
      expect(lines).toHaveLength(1 + 50_000 + 1);
      expect(lines.at(-1)).toMatch(/^TRUNCATED: this export stopped at 50000 rows/);
      await vi.waitFor(async () => {
        const [exported] = await db
          .select()
          .from(activityLog)
          .where(and(eq(activityLog.companyId, BIG_COMPANY), eq(activityLog.action, "audit.exported")));
        expect(exported?.details).toMatchObject({ rowCount: 50_000, truncated: true, completed: true });
      });
    }, 180_000);

    it("review of 4de5523e9: formula characters after leading whitespace, and full-width forms, are neutralized", () => {
      for (const value of [" =1+1", "\n=cmd", "  +1", "\n\n-1", " @SUM(A1)", "＝1+1", "＋1", "－1", "＠SUM(A1)", " ＝1"]) {
        const cell = csvCell(value);
        const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
        expect(unquoted.startsWith("'"), JSON.stringify(value)).toBe(true);
      }
      expect(csvCell("\tx")).toBe("'\tx");
      expect(csvCell("\rx")).toBe("\"'\rx\"");
      expect(csvCell(" plain")).toBe(" plain");
      expect(csvCell("a=b")).toBe("a=b");
    });

    it("review of 4de5523e9: a slow client is served with backpressure, and a client that leaves is logged as incomplete", async () => {
      const SLOW = randomUUID();
      await db.insert(companies).values({ id: SLOW, name: "Slow Co", issuePrefix: "AUS" });
      await db.insert(companyMemberships).values({ companyId: SLOW, principalType: "user", principalId: ADMIN, status: "active", membershipRole: "admin" });
      // 5,000 rows of about 4 KB each: about 20 MB if the server buffered it all.
      await db.execute(sql`
        insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, origin, details, created_at)
        select ${SLOW}::uuid, 'user', ${ADMIN}, 'slow.row', 'company', ${SLOW}, 'server',
               jsonb_build_object('note', repeat('x', 4000)),
               timestamptz '2026-08-01T00:00:00Z' + (n || ' seconds')::interval
        from generate_series(1, 5000) as n`);
      let serverRes: http.ServerResponse | null = null;
      const app = express();
      app.use((req, res, next) => {
        (req as any).actor = asUser(ADMIN, "admin", [SLOW]);
        if (req.path.endsWith("/audit.csv")) serverRes = res;
        next();
      });
      app.use("/api", companyAuditRoutes(db, { csvPageSize: 100 }));
      app.use(errorHandler);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const buffered = () => (serverRes as http.ServerResponse | null)?.writableLength ?? 0;
      try {
        const clientReq = http.get({ host: "127.0.0.1", port, path: `/api/companies/${SLOW}/audit.csv` });
        const clientRes = await new Promise<http.IncomingMessage>((resolve) => clientReq.on("response", resolve));
        clientRes.pause(); // a client that reads nothing more
        // Let the server run until it is blocked on the socket.
        let last = -1;
        let peak = 0;
        for (let i = 0; i < 40; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          peak = Math.max(peak, buffered());
          if (buffered() === last && i > 5) break;
          last = buffered();
        }
        // At most about one page (100 rows of ~4 KB) waits in the server's buffer.
        expect(peak).toBeLessThan(2 * 1024 * 1024);
        clientReq.destroy();
        await vi.waitFor(async () => {
          const [exported] = await db
            .select()
            .from(activityLog)
            .where(and(eq(activityLog.companyId, SLOW), eq(activityLog.action, "audit.exported")));
          expect(exported?.details).toMatchObject({ completed: false, truncated: false });
          expect((exported!.details as { rowCount: number }).rowCount).toBeLessThan(5000);
        }, { timeout: 15_000 });
      } finally {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 60_000);
  });

  describe("round 5a: assistant connections", () => {
    it("an admin's assistant grant cannot read the audit (JSON or CSV)", async () => {
      const viaAssistant = appAs({ ...asUser(ADMIN, "admin"), source: "assistant_grant", assistantGrantId: randomUUID(), assistantClientName: "Claude" });
      for (const path of [`/api/companies/${COMPANY}/audit`, `/api/companies/${COMPANY}/audit.csv`]) {
        const res = await request(viaAssistant).get(path);
        expect(res.status, path).toBe(403);
        expect(res.headers["content-type"], path).not.toMatch(/csv/);
      }
      expect((await request(admin()).get(`/api/companies/${COMPANY}/audit`)).status).toBe(200);
    });
  });
});
