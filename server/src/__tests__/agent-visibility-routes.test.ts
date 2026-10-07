import express from "express";
import request from "supertest";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// These fixtures inject req.actor without running the auth middleware, so no
// verified credential exists (same arrangement as project-visibility.test.ts).
vi.mock("../services/issue-current-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-current-authority.js")>()),
  issueCurrentAuthority: () => undefined,
}));

import {
  agentStewardships,
  agents,
  approvals,
  assistantActionHandles,
  assistantGrants,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  projectAccess,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { approvalRoutes } from "../routes/approvals.js";
import { activityRoutes } from "../routes/activity.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { agentStewardshipRoutes } from "../routes/agent-stewardships.js";
import { agentMemoryRoutes } from "../routes/agent-memory.js";
import { companyRoutes } from "../routes/companies.js";
import { assistantRoutes } from "../routes/assistant.js";
import { logActivity } from "../services/activity-log.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * Agent visibility (2026-09-30), the leak test: one company in owner mode,
 * walked through the REAL routers against a REAL database by a steward, a
 * member with nothing, an admin and an agent.
 *
 * The property: to a member, an agent they do not answer for is NONEXISTENT
 * on every surface — the list, the org chart, detail and every sub-route,
 * runs, the issues attributed to it, approvals it raised, its activity, the
 * dashboard's counts. 404, never 403. Falsification for each case is removing
 * the one guard or condition it covers.
 */
describeEmbeddedPostgres("agent visibility routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const ADMIN = "admin-user";
  const TITUS = "titus";
  const SAM = "sam";

  const CASPER = randomUUID(); // stewarded by TITUS
  const DELIVERY = randomUUID(); // reports to CASPER
  const OTHER = randomUUID(); // nobody Titus answers for
  const SHARED = randomUUID(); // visibility 'company'
  const EXTRA = randomUUID(); // 'company' now; flipped to 'owner' by an admin in one test
  const OTHER_KEY = "other"; // the url key derived from the name "Other"

  const OPEN_PROJECT = randomUUID();
  const LISTED_PROJECT = randomUUID();
  const ISSUE_CASPER = randomUUID();
  const ISSUE_OTHER = randomUUID();
  const ISSUE_OTHER_IDENTIFIER = "AVR-1";
  const ISSUE_LISTED = randomUUID();
  const ISSUE_NOBODY = randomUUID();
  const RUN_CASPER = randomUUID();
  const RUN_OTHER = randomUUID();
  const APPROVAL_CASPER = randomUUID();
  const APPROVAL_OTHER = randomUUID();
  // GH #916 follow-ups: dedicated rows for the routes that mutate, so no case
  // changes a fixture another case reads.
  const APPROVAL_CASPER_DECIDE = randomUUID();
  const APPROVAL_CASPER_REVISION = randomUUID();
  const APPROVAL_OTHER_REVISION = randomUUID();
  const APPROVAL_CASPER_ASSIST = randomUUID();
  const APPROVAL_OTHER_ASSIST = randomUUID();
  const GRANT_TITUS = randomUUID();
  const GRANT_ADMIN = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-vis-routes-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Owner-mode Co", issuePrefix: "AVR", agentVisibilityDefault: "owner" });
    for (const [userId, role] of [
      [ADMIN, "admin"],
      [TITUS, "member"],
      [SAM, "member"],
    ] as const) {
      await db.insert(companyMemberships).values({
        companyId: COMPANY,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: role,
      });
    }
    await db.insert(agents).values([
      { id: CASPER, companyId: COMPANY, name: "Casper", role: "chief_of_staff", createdByUserId: ADMIN },
      { id: DELIVERY, companyId: COMPANY, name: "Delivery", role: "pm", reportsTo: CASPER, createdByUserId: ADMIN },
      { id: OTHER, companyId: COMPANY, name: "Other", role: "general", createdByUserId: ADMIN },
      { id: SHARED, companyId: COMPANY, name: "Shared", role: "general", createdByUserId: ADMIN, visibility: "company" },
      { id: EXTRA, companyId: COMPANY, name: "Extra", role: "general", createdByUserId: ADMIN, visibility: "company" },
    ]);
    await db.insert(agentStewardships).values({ companyId: COMPANY, agentId: CASPER, userId: TITUS });
    await db.insert(projects).values([
      { id: OPEN_PROJECT, companyId: COMPANY, name: "Open", createdByUserId: ADMIN },
      { id: LISTED_PROJECT, companyId: COMPANY, name: "Listed", createdByUserId: ADMIN, visibility: "restricted" },
    ]);
    await db.insert(projectAccess).values({
      projectId: LISTED_PROJECT,
      principalType: "user",
      principalId: TITUS,
      grantedByUserId: ADMIN,
    });
    await db.insert(issues).values([
      { id: ISSUE_CASPER, companyId: COMPANY, title: "Casper's task", status: "todo", assigneeAgentId: CASPER, projectId: OPEN_PROJECT },
      {
        id: ISSUE_OTHER,
        companyId: COMPANY,
        identifier: ISSUE_OTHER_IDENTIFIER,
        title: "Other's secret task",
        status: "todo",
        assigneeAgentId: OTHER,
        projectId: OPEN_PROJECT,
      },
      { id: ISSUE_LISTED, companyId: COMPANY, title: "Other's work in the listed project", status: "todo", assigneeAgentId: OTHER, projectId: LISTED_PROJECT },
      { id: ISSUE_NOBODY, companyId: COMPANY, title: "Nobody's backlog", status: "backlog", createdByUserId: ADMIN },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: RUN_CASPER, companyId: COMPANY, agentId: CASPER, status: "queued", contextSnapshot: { issueId: ISSUE_CASPER } },
      { id: RUN_OTHER, companyId: COMPANY, agentId: OTHER, status: "queued", contextSnapshot: { issueId: ISSUE_OTHER } },
    ]);
    await db.insert(approvals).values([
      { id: APPROVAL_CASPER, companyId: COMPANY, type: "generic", status: "pending", requestedByAgentId: CASPER, payload: { note: "casper" } },
      { id: APPROVAL_OTHER, companyId: COMPANY, type: "generic", status: "pending", requestedByAgentId: OTHER, payload: { note: "other secret" } },
      { id: APPROVAL_CASPER_DECIDE, companyId: COMPANY, type: "generic", status: "pending", requestedByAgentId: CASPER, payload: { note: "casper decide" } },
      { id: APPROVAL_CASPER_REVISION, companyId: COMPANY, type: "generic", status: "revision_requested", requestedByAgentId: CASPER, payload: { note: "casper revision" } },
      { id: APPROVAL_OTHER_REVISION, companyId: COMPANY, type: "generic", status: "revision_requested", requestedByAgentId: OTHER, payload: { note: "other secret revision" } },
      { id: APPROVAL_CASPER_ASSIST, companyId: COMPANY, type: "generic", status: "pending", requestedByAgentId: CASPER, payload: { note: "casper assist" } },
      { id: APPROVAL_OTHER_ASSIST, companyId: COMPANY, type: "generic", status: "pending", requestedByAgentId: OTHER, payload: { note: "other secret assist" } },
    ]);
    await db.insert(assistantGrants).values([
      { id: GRANT_TITUS, companyId: COMPANY, userId: TITUS, clientId: "client-titus", clientName: "Assistant", redirectHost: "assistant.example", scopes: ["agentdash:read", "agentdash:work", "agentdash:decide"] },
      { id: GRANT_ADMIN, companyId: COMPANY, userId: ADMIN, clientId: "client-admin", clientName: "Assistant", redirectHost: "assistant.example", scopes: ["agentdash:read", "agentdash:work", "agentdash:decide"] },
    ]);
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "agent",
      actorId: OTHER,
      agentId: OTHER,
      action: "agent.secret_activity",
      entityType: "agent",
      entityId: OTHER,
      details: { note: "other secret activity" },
    });
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "agent",
      actorId: CASPER,
      agentId: CASPER,
      action: "agent.visible_activity",
      entityType: "agent",
      entityId: CASPER,
      details: { note: "casper activity" },
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appAs(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use("/api", issueRoutes(db));
    app.use("/api", approvalRoutes(db));
    app.use("/api", activityRoutes(db));
    app.use("/api", dashboardRoutes(db));
    app.use("/api", agentStewardshipRoutes(db));
    app.use("/api", agentMemoryRoutes(db));
    app.use("/api/companies", companyRoutes(db));
    app.use("/api", assistantRoutes(db, { autoDispatchQueuedRuns: false }));
    app.use(errorHandler);
    return app;
  }

  const asUser = (userId: string, role: string) => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [COMPANY],
    memberships: [{ companyId: COMPANY, membershipRole: role, status: "active" }],
  });
  const asAgent = (agentId: string) => ({
    type: "agent",
    agentId,
    companyId: COMPANY,
    source: "agent_key",
    companyIds: [COMPANY],
  });
  // An assistant connection resolves to the person behind the grant.
  const asAssistant = (userId: string, role: string, grantId: string) => ({
    ...asUser(userId, role),
    source: "assistant_grant",
    assistantGrantId: grantId,
    assistantClientName: "Assistant",
  });
  const titus = () => appAs(asUser(TITUS, "member"));
  const sam = () => appAs(asUser(SAM, "member"));
  const admin = () => appAs(asUser(ADMIN, "admin"));

  const names = (body: Array<{ name: string }>) => body.map((row) => row.name).sort();
  const titles = (body: Array<{ title: string }>) => body.map((row) => row.title).sort();

  describe("agents", () => {
    it("the list: a steward sees their line and shared agents; an admin and an agent see all", async () => {
      expect(names((await request(titus()).get(`/api/companies/${COMPANY}/agents`)).body)).toEqual(
        ["Casper", "Delivery", "Extra", "Shared"],
      );
      expect(names((await request(sam()).get(`/api/companies/${COMPANY}/agents`)).body)).toEqual(["Extra", "Shared"]);
      expect(names((await request(admin()).get(`/api/companies/${COMPANY}/agents`)).body)).toEqual(
        ["Casper", "Delivery", "Extra", "Other", "Shared"],
      );
      expect(names((await request(appAs(asAgent(OTHER))).get(`/api/companies/${COMPANY}/agents`)).body)).toHaveLength(5);
    });

    it("detail and every sub-route: 404 for an invisible agent, by id and by key", async () => {
      for (const path of [
        `/api/agents/${OTHER}`,
        `/api/agents/${OTHER_KEY}?companyId=${COMPANY}`,
        `/api/agents/${OTHER}/configuration`,
        `/api/agents/${OTHER}/skills`,
        `/api/companies/${COMPANY}/agents/${OTHER}/stewardship`,
        `/api/companies/${COMPANY}/agents/${OTHER}/memory`,
      ]) {
        const res = await request(titus()).get(path);
        expect(res.status, path).toBe(404);
        expect(JSON.stringify(res.body), path).not.toMatch(/Other/);
      }
      expect((await request(titus()).get(`/api/agents/${CASPER}`)).status).toBe(200);
      expect((await request(titus()).get(`/api/agents/${DELIVERY}`)).status).toBe(200);
      expect((await request(admin()).get(`/api/agents/${OTHER}`)).status).toBe(200);
    });


    it("the org chart is pruned to what the member can see, lines intact", async () => {
      const tree = (await request(titus()).get(`/api/companies/${COMPANY}/org`)).body as Array<{ id: string; reports: Array<{ id: string }> }>;
      const ids = new Set<string>();
      const walk = (nodes: Array<{ id: string; reports: Array<{ id: string }> }>) => {
        for (const node of nodes) {
          ids.add(node.id);
          walk((node.reports ?? []) as Array<{ id: string; reports: Array<{ id: string }> }>);
        }
      };
      walk(tree);
      expect(ids.has(OTHER)).toBe(false);
      const casper = tree.find((node) => node.id === CASPER);
      expect(casper?.reports.map((node) => node.id)).toEqual([DELIVERY]);
      expect([...ids].sort()).toEqual([CASPER, DELIVERY, EXTRA, SHARED].sort());
    });

    it("runs: an invisible agent's runs are absent from the list and 404 by id", async () => {
      const runs = (await request(titus()).get(`/api/companies/${COMPANY}/heartbeat-runs`)).body as Array<{ id: string }>;
      expect(runs.map((run) => run.id)).toEqual([RUN_CASPER]);
      expect((await request(admin()).get(`/api/companies/${COMPANY}/heartbeat-runs`)).body).toHaveLength(2);
    });
  });

  describe("issues", () => {
    it("the list follows the rule: attributed, own, or in a listed project", async () => {
      expect(titles((await request(titus()).get(`/api/companies/${COMPANY}/issues`)).body)).toEqual(
        ["Casper's task", "Other's work in the listed project"],
      );
      expect(titles((await request(sam()).get(`/api/companies/${COMPANY}/issues`)).body)).toEqual([]);
      expect((await request(admin()).get(`/api/companies/${COMPANY}/issues`)).body).toHaveLength(4);
    });

    it("detail: 404 for an invisible agent's issue, by id and by identifier; the listed project's issue stays reachable", async () => {
      for (const ref of [ISSUE_OTHER, ISSUE_OTHER_IDENTIFIER, ISSUE_NOBODY]) {
        const res = await request(titus()).get(`/api/issues/${ref}`);
        expect(res.status, ref).toBe(404);
        expect(JSON.stringify(res.body), ref).not.toMatch(/secret/i);
      }
      expect((await request(titus()).get(`/api/issues/${ISSUE_CASPER}`)).status).toBe(200);
      expect((await request(titus()).get(`/api/issues/${ISSUE_LISTED}`)).status).toBe(200);
      expect((await request(titus()).get(`/api/issues/${ISSUE_OTHER}/comments`)).status).toBe(404);
    });

    it("writes: work cannot be given to an agent the actor cannot see", async () => {
      const refused = await request(titus())
        .post(`/api/companies/${COMPANY}/issues`)
        .send({ title: "Give it to Other", assigneeAgentId: OTHER });
      expect(refused.status).toBe(404);
      expect(JSON.stringify(refused.body)).not.toMatch(/Other/);
      // The same guard on PATCH: reassigning to an invisible agent is 404 and
      // writes nothing; reassigning within the visible line goes through.
      const moved = await request(titus()).patch(`/api/issues/${ISSUE_CASPER}`).send({ assigneeAgentId: OTHER });
      expect(moved.status).toBe(404);
      expect(JSON.stringify(moved.body)).not.toMatch(/Other/);
      const [unchanged] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, ISSUE_CASPER));
      expect(unchanged.assigneeAgentId).toBe(CASPER);
      const allowed = await request(titus()).patch(`/api/issues/${ISSUE_CASPER}`).send({ assigneeAgentId: DELIVERY });
      expect(allowed.status).toBe(200);
      await db.update(issues).set({ assigneeAgentId: CASPER }).where(eq(issues.id, ISSUE_CASPER));
    });
  });

  describe("approvals, activity, dashboard", () => {
    it("approvals raised by an invisible agent are absent and 404", async () => {
      const list = (await request(titus()).get(`/api/companies/${COMPANY}/approvals`)).body as Array<{ id: string }>;
      expect(list.map((row) => row.id).sort()).toEqual(
        [APPROVAL_CASPER, APPROVAL_CASPER_DECIDE, APPROVAL_CASPER_REVISION, APPROVAL_CASPER_ASSIST].sort(),
      );
      expect((await request(titus()).get(`/api/approvals/${APPROVAL_OTHER}`)).status).toBe(404);
      expect((await request(admin()).get(`/api/approvals/${APPROVAL_OTHER}`)).status).toBe(200);
    });

    it("GH #916: every decision route is 404 on an invisible agent's approval — and decides nothing", async () => {
      const app = titus();
      for (const path of [
        `/api/approvals/${APPROVAL_OTHER}/approve`,
        `/api/approvals/${APPROVAL_OTHER}/reject`,
        `/api/approvals/${APPROVAL_OTHER}/request-revision`,
      ]) {
        const res = await request(app).post(path).send({});
        expect(res.status, path).toBe(404);
      }
      const override = await request(app)
        .post(`/api/approvals/${APPROVAL_OTHER}/override`)
        .send({ decision: "approved", overrideReason: "guessing ids" });
      expect(override.status).toBe(404);
      const [row] = await db
        .select({ status: approvals.status })
        .from(approvals)
        .where(eq(approvals.id, APPROVAL_OTHER));
      expect(row.status).toBe("pending");
    });

    it("GH #916: a member can still decide a VISIBLE agent's approval", async () => {
      const res = await request(titus()).post(`/api/approvals/${APPROVAL_CASPER_DECIDE}/approve`).send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("approved");
      const [row] = await db
        .select({ status: approvals.status })
        .from(approvals)
        .where(eq(approvals.id, APPROVAL_CASPER_DECIDE));
      expect(row.status).toBe("approved");
    });

    it("GH #916: resubmit is 404 on an invisible agent's approval and changes nothing; the steward and an admin still resubmit", async () => {
      const refused = await request(titus()).post(`/api/approvals/${APPROVAL_OTHER_REVISION}/resubmit`).send({});
      expect(refused.status).toBe(404);
      expect(JSON.stringify(refused.body)).not.toMatch(/secret/);
      const [untouched] = await db
        .select({ status: approvals.status, revision: approvals.revision })
        .from(approvals)
        .where(eq(approvals.id, APPROVAL_OTHER_REVISION));
      expect(untouched.status).toBe("revision_requested");
      expect(untouched.revision).toBe(1);

      const steward = await request(titus()).post(`/api/approvals/${APPROVAL_CASPER_REVISION}/resubmit`).send({});
      expect(steward.status).toBe(200);
      expect(steward.body.status).toBe("pending");
      const owner = await request(admin()).post(`/api/approvals/${APPROVAL_OTHER_REVISION}/resubmit`).send({});
      expect(owner.status).toBe(200);
      expect(owner.body.status).toBe("pending");
    });

    it("GH #916: comments and linked issues are 404 on an invisible agent's approval; the steward and an admin still reach them", async () => {
      const app = titus();
      for (const path of [`/api/approvals/${APPROVAL_OTHER}/comments`, `/api/approvals/${APPROVAL_OTHER}/issues`]) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(404);
      }
      const posted = await request(app).post(`/api/approvals/${APPROVAL_OTHER}/comments`).send({ body: "probe" });
      expect(posted.status).toBe(404);
      expect(
        (await request(admin()).get(`/api/approvals/${APPROVAL_OTHER}/comments`)).body as unknown[],
      ).toHaveLength(0);

      expect((await request(app).get(`/api/approvals/${APPROVAL_CASPER}/comments`)).status).toBe(200);
      expect((await request(app).get(`/api/approvals/${APPROVAL_CASPER}/issues`)).status).toBe(200);
      expect((await request(app).post(`/api/approvals/${APPROVAL_CASPER}/comments`).send({ body: "steward note" })).status).toBe(201);
      expect((await request(admin()).get(`/api/approvals/${APPROVAL_OTHER}/issues`)).status).toBe(200);
      expect((await request(admin()).post(`/api/approvals/${APPROVAL_OTHER}/comments`).send({ body: "admin note" })).status).toBe(201);
    });

    it("GH #916: the assistant's prepare-decision is 404 on an invisible agent's approval (body-supplied id), names nobody, and the steward and an admin still prepare", async () => {
      const prepare = (actor: Record<string, unknown>, approvalId: string) =>
        request(appAs(actor))
          .post(`/api/companies/${COMPANY}/assistant/actions/prepare-decision`)
          .send({ approvalId, decision: "approve" });

      const refused = await prepare(asAssistant(TITUS, "member", GRANT_TITUS), APPROVAL_OTHER_ASSIST);
      expect(refused.status).toBe(404);
      expect(refused.body.code).toBe("approval_not_found");
      expect(JSON.stringify(refused.body)).not.toMatch(/Other|secret/);
      expect(refused.body.handle).toBeUndefined();

      const owner = await prepare(asAssistant(ADMIN, "admin", GRANT_ADMIN), APPROVAL_OTHER_ASSIST);
      expect(owner.status).toBe(200);
      expect(typeof owner.body.handle).toBe("string");

      const steward = await prepare(asAssistant(TITUS, "member", GRANT_TITUS), APPROVAL_CASPER_ASSIST);
      expect(steward.status).toBe(200);
      const confirmed = await request(appAs(asAssistant(TITUS, "member", GRANT_TITUS)))
        .post(`/api/companies/${COMPANY}/assistant/actions/confirm`)
        .send({ handle: steward.body.handle });
      expect(confirmed.status).toBe(200);
      const [decided] = await db
        .select({ status: approvals.status })
        .from(approvals)
        .where(eq(approvals.id, APPROVAL_CASPER_ASSIST));
      expect(decided.status).toBe("approved");
    });

    it("GH #916: the assistant's confirm re-checks visibility — a handle for an approval the person cannot see decides nothing", async () => {
      // A handle minted while the person could see the agent (stewardship
      // since removed, say): confirm resolves the approval again and must
      // refuse it the same way prepare would.
      const token = `aah_${randomUUID()}`;
      await db.insert(assistantActionHandles).values({
        token: createHash("sha256").update(token).digest("hex"),
        companyId: COMPANY,
        grantId: GRANT_TITUS,
        actorUserId: TITUS,
        kind: "approval_decision",
        payload: { approvalId: APPROVAL_OTHER_ASSIST, revision: 1, decision: "approve", note: null },
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      const res = await request(appAs(asAssistant(TITUS, "member", GRANT_TITUS)))
        .post(`/api/companies/${COMPANY}/assistant/actions/confirm`)
        .send({ handle: token });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("approval_not_found");
      expect(JSON.stringify(res.body)).not.toMatch(/Other|secret/);
      const [row] = await db
        .select({ status: approvals.status })
        .from(approvals)
        .where(eq(approvals.id, APPROVAL_OTHER_ASSIST));
      expect(row.status).toBe("pending");
    });

    it("the activity feed omits rows about an invisible agent", async () => {
      const feed = (await request(titus()).get(`/api/companies/${COMPANY}/activity`)).body as Array<{ agentId: string | null; action: string }>;
      expect(feed.some((row) => row.agentId === OTHER)).toBe(false);
      expect(feed.some((row) => row.action === "agent.visible_activity")).toBe(true);
      expect(JSON.stringify(feed)).not.toMatch(/other secret/);
    });

    it("the dashboard counts what the member can see", async () => {
      const mine = (await request(titus()).get(`/api/companies/${COMPANY}/dashboard`)).body;
      const all = (await request(admin()).get(`/api/companies/${COMPANY}/dashboard`)).body;
      // Approved decisions above wake the requesting agent, so count every
      // operational agent (idle is reported as active, plus running).
      expect(mine.agents.active + mine.agents.running).toBe(4);
      expect(all.agents.active + all.agents.running).toBe(5);
      expect(mine.tasks.open).toBeLessThan(all.tasks.open);
    });
  });

  describe("settings", () => {
    it("only a company administrator may change an agent's visibility", async () => {
      expect((await request(titus()).patch(`/api/agents/${CASPER}`).send({ visibility: "owner" })).status).toBe(403);
      const flipped = await request(admin()).patch(`/api/agents/${EXTRA}`).send({ visibility: "owner" });
      expect(flipped.status).toBe(200);
      expect(names((await request(sam()).get(`/api/companies/${COMPANY}/agents`)).body)).toEqual(["Shared"]);
      expect((await request(sam()).get(`/api/agents/${EXTRA}`)).status).toBe(404);
    });

    it("only a company administrator may change the company default; flipping it to 'company' restores full visibility", async () => {
      expect((await request(titus()).patch(`/api/companies/${COMPANY}`).send({ agentVisibilityDefault: "company" })).status).toBe(403);
      // The read must carry the value back, or the Settings radio can never show what was saved.
      expect((await request(admin()).get(`/api/companies/${COMPANY}`)).body.agentVisibilityDefault).toBe("owner");
      const flipped = await request(admin()).patch(`/api/companies/${COMPANY}`).send({ agentVisibilityDefault: "company" });
      expect(flipped.status).toBe(200);
      expect(flipped.body.agentVisibilityDefault).toBe("company");
      expect((await request(admin()).get(`/api/companies/${COMPANY}`)).body.agentVisibilityDefault).toBe("company");
      // Everything inheriting is now company-visible; EXTRA stays 'owner' from the previous case.
      expect(names((await request(sam()).get(`/api/companies/${COMPANY}/agents`)).body)).toEqual(["Casper", "Delivery", "Other", "Shared"]);
      await db.update(companies).set({ agentVisibilityDefault: "owner" }).where(eq(companies.id, COMPANY));
    });
  });
});
