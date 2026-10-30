import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentProfileApplications,
  agentProfileRevisions,
  agents,
  approvals,
  assistantConversations,
  assistantMessages,
  authUsers,
  companies,
  createDb,
  projects,
  routineTriggers,
  routines,
  workforceEnrollments,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import {
  addAgent,
  addCompany,
  addUser,
  agentRequestActor,
  boardActor,
  editBody,
  seedProfileCompany,
  type TestDb,
} from "./helpers/agent-profile-fixtures.js";

const declareAgentContract = vi.hoisted(() =>
  vi.fn(async (_db: unknown, input: { profileRevisionId: string }) => ({ eventId: `contract-${input.profileRevisionId}`, inserted: true })),
);
vi.mock("../services/evaluation/agent-contract.js", () => ({
  declareAgentContract,
  agentContractSourceId: (agentId: string) => `agent:${agentId}`,
  buildAgentContractV2: vi.fn(),
}));

const { errorHandler } = await import("../middleware/index.js");
const { agentProfileRoutes } = await import("../routes/agent-profiles.js");
const { approvalRoutes } = await import("../routes/approvals.js");
const { approvalAuthorityService } = await import("../services/approval-authority.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Seed = Awaited<ReturnType<typeof seedProfileCompany>>;

/**
 * AgentDash: APM gate 2 — the operating-profile routes, the approval paths an
 * `agent_profile_change` takes, and the two profile reads moved from gate 1
 * (agent-performance-routes.test.ts), which now return `AgentProfileView`.
 */
describeEmbeddedPostgres("agent profile routes (APM gate 2, P2.2)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-profile-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    declareAgentContract.mockClear();
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function send(
    actor: Record<string, unknown>,
    method: "get" | "post" | "patch",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", agentProfileRoutes(db));
    app.use("/api", approvalRoutes(db, { autoDispatchQueuedRuns: false }));
    app.use(errorHandler);
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      let call = request(`http://127.0.0.1:${address.port}`)[method](path);
      for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
      return await (body === undefined ? call : call.send(body as object));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }

  const base = (s: Seed, agentId = s.analyst.id) => `/api/companies/${s.company.id}/agents/${agentId}/profile`;
  const owner = (s: Seed) => boardActor(s.company.id, s.ownerUserId, "owner");
  const steward = (s: Seed) => boardActor(s.company.id, s.stewardUserId);
  const decision = (approval: { revision: number }) => ({ revision: approval.revision, idempotencyKey: randomUUID(), channel: "web" });

  /** Draft (from derived rev 0), save with `mutate`, propose — all through the routes. */
  async function propose(s: Seed, actor: Record<string, unknown>, mutate: Parameters<typeof editBody>[1], agentId = s.analyst.id) {
    const created = await send(actor, "post", `${base(s, agentId)}/revisions`, {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const saved = await send(actor, "patch", `${base(s, agentId)}/revisions/${created.body.id}`, { body: editBody(created.body, mutate) }, {
      "If-Match": created.body.bodyHash,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const proposed = await send(actor, "post", `${base(s, agentId)}/revisions/${created.body.id}/propose`, { reason: "Clearer duties" });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const approval = await db.select().from(approvals).where(eq(approvals.id, proposed.body.approvalId)).then((rows) => rows[0]!);
    return { revisionId: created.body.id as string, approval };
  }

  async function activity(companyId: string, action: string) {
    return db
      .select({ details: activityLog.details, entityId: activityLog.entityId })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
  }

  // -------------------------------------------------------------------------
  // The two profile reads (moved from gate 1)
  // -------------------------------------------------------------------------

  async function addPlanCardAndEnrollment(s: Seed) {
    const conversation = await db
      .insert(assistantConversations)
      .values({ companyId: s.company.id, userId: s.ownerUserId })
      .returning()
      .then((rows) => rows[0]!);
    const plan = await db
      .insert(assistantMessages)
      .values({
        conversationId: conversation.id,
        role: "assistant",
        content: "Here is the team",
        cardKind: "agent_plan_proposal_v1",
        cardPayload: {
          rationale: "Grow pipeline",
          alignmentToShortTerm: "Q4",
          alignmentToLongTerm: "Growth",
          agents: [
            { name: "Chief", role: "chief_of_staff", adapterType: "process", responsibilities: ["Coordinate"], kpis: [] },
            { name: "Analyst", role: "research", adapterType: "process", responsibilities: ["Weekly pipeline report"], kpis: ["Report on time"] },
          ],
          confirmedAt: new Date().toISOString(),
          confirmedAgentIds: [s.chief.id, s.analyst.id],
        },
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(workforceEnrollments).values({ companyId: s.company.id, agentId: s.analyst.id, templateId: "sales-support", templateVersion: 1, objective: "Keep the pipeline honest" });
    return plan;
  }

  describe("GET /companies/:companyId/agents/:agentId/profile and /agents/me/profile", () => {
    it("serves the view with derived revision 0 to anyone in the company who can see the agent", async () => {
      const s = await seedProfileCompany(db);
      const plan = await addPlanCardAndEnrollment(s);
      for (const userId of [s.ownerUserId, s.stewardUserId, s.accountableUserId, s.outsiderUserId]) {
        const res = await send(boardActor(s.company.id, userId, userId === s.ownerUserId ? "owner" : "member"), "get", base(s));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      const res = await send(owner(s), "get", base(s));
      expect(res.body).toMatchObject({
        kind: "agent_profile_view",
        agentId: s.analyst.id,
        profileId: null,
        active: null,
        latestDraft: null,
        pendingProposal: null,
        latestApplication: null,
        applicationInProgress: false,
        derived: {
          kind: "agent_profile_derived",
          derived: true,
          identity: { title: { value: "Pipeline Analyst", provenance: "proposed", source: "agent.title" } },
          objective: { value: "Keep the pipeline honest", provenance: "proposed" },
          responsibilities: [{ key: "weekly-pipeline-report", title: "Weekly pipeline report", source: `plan_card:${plan.id}` }],
          rhythm: { heartbeat: { enabled: true, intervalSec: 900, wakeOnDemand: true }, reportsTo: { agentId: s.chief.id, agentName: "Chief" }, accountableUserId: s.stewardUserId },
        },
      });
    });

    it("is 404 for another company's agent and for an agent the viewer cannot see", async () => {
      const s = await seedProfileCompany(db);
      const other = await addCompany(db, "Other");
      const otherOwnerUserId = await addUser(db, other.id, "owner");
      expect((await send(boardActor(other.id, otherOwnerUserId, "owner"), "get", `/api/companies/${other.id}/agents/${s.analyst.id}/profile`)).status).toBe(404);
      await db.update(agents).set({ visibility: "owner" }).where(eq(agents.id, s.autonomous.id));
      expect((await send(boardActor(s.company.id, s.outsiderUserId), "get", base(s, s.autonomous.id))).status).toBe(404);
    });

    it("refuses agents on the company route; the agent reads its own at /agents/me/profile; never the evaluator", async () => {
      const s = await seedProfileCompany(db);
      const onCompanyRoute = await send(agentRequestActor(s.analyst), "get", base(s));
      expect(onCompanyRoute.status).toBe(403);
      expect(onCompanyRoute.body.error).toContain("/api/agents/me/profile");
      const mine = await send(agentRequestActor(s.analyst), "get", "/api/agents/me/profile");
      expect(mine.status, JSON.stringify(mine.body)).toBe(200);
      expect(mine.body).toMatchObject({ kind: "agent_profile_view", agentId: s.analyst.id, companyId: s.company.id });
      const solo = await send(agentRequestActor(s.autonomous), "get", "/api/agents/me/profile");
      expect(solo.body.derived.rhythm.accountableUserId).toBe(s.accountableUserId);
      expect((await send(owner(s), "get", "/api/agents/me/profile")).status).toBe(403);
      const evaluator = await addAgent(db, s.company.id, { name: "Evaluator", role: "evaluator" });
      expect((await send(agentRequestActor(evaluator, { principalKind: "evaluator", readOnly: true }), "get", "/api/agents/me/profile")).status).toBe(403);
    });

    it("keeps restricted-project routine titles out of the derived profile for viewers off the project", async () => {
      const s = await seedProfileCompany(db);
      const project = await db
        .insert(projects)
        .values({ companyId: s.company.id, name: "Secret acquisition", visibility: "restricted" })
        .returning()
        .then((rows) => rows[0]!);
      const secret = await db
        .insert(routines)
        .values({ companyId: s.company.id, projectId: project.id, title: "Secret digest", assigneeAgentId: s.analyst.id, status: "active" })
        .returning()
        .then((rows) => rows[0]!);
      await db.insert(routineTriggers).values({ companyId: s.company.id, routineId: secret.id, kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC" });
      expect(JSON.stringify((await send(steward(s), "get", base(s))).body)).not.toContain("Secret digest");
      expect(JSON.stringify((await send(owner(s), "get", base(s))).body)).toContain("Secret digest");
    });

    it("reads write nothing", async () => {
      const s = await seedProfileCompany(db);
      const counts = async () =>
        Promise.all([activityLog, agentProfileRevisions, approvals, agentConfigRevisions].map((table) =>
          db.select({ n: sql<number>`count(*)::int` }).from(table).then((rows) => rows[0]!.n),
        ));
      const before = await counts();
      expect((await send(owner(s), "get", base(s))).status).toBe(200);
      expect((await send(agentRequestActor(s.analyst), "get", "/api/agents/me/profile")).status).toBe(200);
      expect((await send(owner(s), "get", `${base(s)}/revisions`)).status).toBe(200);
      expect((await send(owner(s), "get", `${base(s)}/applications`)).status).toBe(200);
      expect(await counts()).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  // Drafts and proposals
  // -------------------------------------------------------------------------

  describe("drafts", () => {
    it("creates, saves with If-Match, answers 409 with the current draft on a stale one, and reads back", async () => {
      const s = await seedProfileCompany(db);
      const created = await send(steward(s), "post", `${base(s)}/revisions`, {});
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ state: "draft", revisionNumber: 1, basedOnRevisionId: null, createdByUserId: s.stewardUserId });
      expect(created.body.provenance["/identity/name"]).toMatchObject({ state: "proposed", sourceRef: "agent.name" });
      expect(created.body.provenance["/identity/style/tone"]).toEqual({ state: "missing" });

      const path = `${base(s)}/revisions/${created.body.id}`;
      const edited = editBody(created.body, (b) => (b.identity.audience = "Sales"));
      expect((await send(steward(s), "patch", path, { body: edited })).status).toBe(400);
      const saved = await send(steward(s), "patch", path, { body: edited }, { "If-Match": `"${created.body.bodyHash}"` });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const stale = await send(steward(s), "patch", path, { body: edited }, { "If-Match": created.body.bodyHash });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: "AGENT_PROFILE_DRAFT_CONFLICT", current: { id: created.body.id, bodyHash: saved.body.bodyHash } });

      // One open draft per profile.
      expect((await send(owner(s), "post", `${base(s)}/revisions`, {})).status).toBe(409);
      const view = await send(owner(s), "get", base(s));
      expect(view.body.latestDraft).toMatchObject({ id: created.body.id, bodyHash: saved.body.bodyHash });
      expect((await send(owner(s), "get", `${base(s)}/revisions`)).body).toHaveLength(1);
      const diff = await send(owner(s), "get", `${path}/diff?against=active`);
      expect(diff.body.diff).toEqual([{ op: "replace", pointer: "/identity/audience", before: "", after: "Sales" }]);
      const exported = await send(owner(s), "get", `${path}/export.md`);
      expect(exported.headers["content-type"]).toContain("text/markdown");
      expect(exported.text).toContain("# Operating profile: Analyst");
      expect((await activity(s.company.id, "agent_profile.draft_saved")).length).toBe(2);
    });

    it("lets the agent draft its own profile and the performance manager draft any; other agents and outsiders cannot", async () => {
      const s = await seedProfileCompany(db);
      expect((await send(agentRequestActor(s.analyst), "post", `${base(s)}/revisions`, {})).status).toBe(201);
      expect((await send(agentRequestActor(s.autonomous), "post", `${base(s, s.chief.id)}/revisions`, {})).status).toBe(403);
      expect((await send(agentRequestActor(s.chief), "post", `${base(s, s.autonomous.id)}/revisions`, {})).status).toBe(201);
      expect((await send(boardActor(s.company.id, s.outsiderUserId), "post", `${base(s, s.chief.id)}/revisions`, {})).status).toBe(403);
    });

    it("narrows withdraw: the proposer, or the agent's steward, accountable person or an admin; the performance manager only its own (APM gate 5)", async () => {
      const s = await seedProfileCompany(db);
      const withdraw = (actor: Record<string, unknown>, revisionId: string, agentId = s.analyst.id) =>
        send(actor, "post", `${base(s, agentId)}/revisions/${revisionId}/withdraw`, {});

      // The steward's proposal: the agent it is about, the performance manager and an outsider cannot withdraw it.
      const bySteward = await propose(s, steward(s), (b) => (b.identity.audience = "Steward's"));
      for (const actor of [agentRequestActor(s.analyst), agentRequestActor(s.chief), boardActor(s.company.id, s.outsiderUserId)]) {
        const refused = await withdraw(actor, bySteward.revisionId);
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(refused.body.error).toContain("the performance manager may withdraw only its own proposals");
      }
      // An admin may.
      expect((await withdraw(owner(s), bySteward.revisionId)).status).toBe(200);

      // The performance manager's own proposal: it may withdraw it; the agent it is about may not.
      const byManager = await propose(s, agentRequestActor(s.chief), (b) => (b.identity.audience = "Manager's"));
      expect((await withdraw(agentRequestActor(s.analyst), byManager.revisionId)).status).toBe(403);
      expect((await withdraw(agentRequestActor(s.chief), byManager.revisionId)).status).toBe(200);

      // A draft the agent wrote but its steward proposed: the proposer decides, not the draft's author.
      const created = await send(agentRequestActor(s.analyst), "post", `${base(s)}/revisions`, {});
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const saved = await send(agentRequestActor(s.analyst), "patch", `${base(s)}/revisions/${created.body.id}`, {
        body: editBody(created.body, (b) => (b.identity.audience = "Agent's")),
      }, { "If-Match": created.body.bodyHash });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect((await send(steward(s), "post", `${base(s)}/revisions/${created.body.id}/propose`, {})).status).toBe(201);
      expect((await withdraw(agentRequestActor(s.analyst), created.body.id)).status).toBe(403);
      expect((await send(agentRequestActor(s.analyst), "get", "/api/agents/me/profile")).body.viewer.canWithdraw).toBe(false);
      expect((await send(steward(s), "get", base(s))).body.viewer.canWithdraw).toBe(true);
      expect((await withdraw(steward(s), created.body.id)).status).toBe(200);

      // The agent's own proposal: it may withdraw it.
      const own = await propose(s, agentRequestActor(s.analyst), (b) => (b.identity.audience = "Own"));
      expect((await withdraw(agentRequestActor(s.analyst), own.revisionId)).status).toBe(200);

      // An autonomous agent's accountable person may withdraw an admin's proposal.
      const byAdmin = await propose(s, owner(s), (b) => (b.identity.audience = "Admin's"), s.autonomous.id);
      expect((await withdraw(boardActor(s.company.id, s.accountableUserId), byAdmin.revisionId, s.autonomous.id)).status).toBe(200);
      expect((await activity(s.company.id, "agent_profile.withdrawn")).length).toBe(5);
    });

    it("withdraws a pending proposal and cancels its approval", async () => {
      const s = await seedProfileCompany(db);
      const { revisionId, approval } = await propose(s, steward(s), (b) => (b.identity.audience = "X"));
      const res = await send(steward(s), "post", `${base(s)}/revisions/${revisionId}/withdraw`, { reason: "Not yet" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.state).toBe("withdrawn");
      expect((await db.select().from(approvals).where(eq(approvals.id, approval.id)))[0]!.status).toBe("cancelled");
      expect((await send(steward(s), "post", `${base(s)}/revisions/${revisionId}/withdraw`, {})).status).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  // Approval paths
  // -------------------------------------------------------------------------

  describe("agent_profile_change on the approval routes", () => {
    it("applies on approve, recording the decider role and a self-approval", async () => {
      const s = await seedProfileCompany(db);
      const { revisionId, approval } = await propose(s, owner(s), (b) => {
        b.identity.audience = "Board";
        b.runtime = { ...b.runtime, model: "test-model" };
      });
      expect(approval.payload).toMatchObject({ requiredAuthority: "admin", proposedBy: { kind: "user", userId: s.ownerUserId } });
      // The steward lacks admin authority for the runtime field.
      expect((await send(steward(s), "post", `/api/approvals/${approval.id}/approve`, decision(approval))).status).toBe(403);
      const res = await send(owner(s), "post", `/api/approvals/${approval.id}/approve`, decision(approval));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.decisionActorRole).toBe("admin");
      // The decider sees the authority each field needs, unredacted.
      expect(res.body.payload.requiredAuthority).toBe("admin");
      expect(res.body.payload.fieldAuthority).toEqual(
        expect.arrayContaining([expect.objectContaining({ pointer: "/runtime/model", required: "admin" })]),
      );
      const [application] = await db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, approval.id));
      expect(application!.status).toBe("applied");
      expect(application!.approverAuthority).toMatchObject({ role: "admin", selfApproval: true });
      const [approved] = await activity(s.company.id, "approval.approved");
      expect(approved!.details).toMatchObject({ profileDecision: { decisionActorRole: "admin", selfApproval: true, requiredLevel: "admin" } });
      const [started] = await activity(s.company.id, "agent_profile.application_started");
      expect(started!.details).toMatchObject({ path: "approval" });
      expect((await send(owner(s), "get", base(s))).body.active).toMatchObject({ id: revisionId, state: "applied" });
      const applications = await send(owner(s), "get", `${base(s)}/applications`);
      expect(applications.body).toMatchObject([{ id: application!.id, status: "applied" }]);
    });

    it("never lets an agent decide, not even the proposing performance manager", async () => {
      const s = await seedProfileCompany(db);
      const { approval } = await propose(s, agentRequestActor(s.chief), (b) => (b.identity.audience = "X"));
      for (const agent of [s.chief, s.analyst]) {
        expect((await send(agentRequestActor(agent), "post", `/api/approvals/${approval.id}/approve`, decision(approval))).status).toBe(403);
      }
      expect((await send(steward(s), "post", `/api/approvals/${approval.id}/approve`, decision(approval))).status).toBe(200);
    });

    it("marks the revision rejected on reject", async () => {
      const s = await seedProfileCompany(db);
      const { revisionId, approval } = await propose(s, steward(s), (b) => (b.identity.audience = "X"));
      expect((await send(steward(s), "post", `/api/approvals/${approval.id}/reject`, decision(approval))).status).toBe(200);
      const [revision] = await db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id, revisionId));
      expect(revision!.state).toBe("rejected");
      expect(await db.select().from(agentProfileApplications)).toHaveLength(0);
    });

    it("sends an emergency override through the same application function", async () => {
      const s = await seedProfileCompany(db);
      const { revisionId, approval } = await propose(s, steward(s), (b) => (b.identity.audience = "Override"));
      const res = await send(owner(s), "post", `/api/approvals/${approval.id}/override`, {
        decision: "approved",
        overrideReason: "Steward away",
        ...decision(approval),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [started] = await activity(s.company.id, "agent_profile.application_started");
      expect(started!.details).toMatchObject({ path: "override", approvalId: approval.id });
      expect((await activity(s.company.id, "agent_profile.applied"))[0]!.entityId).toBe(revisionId);
      expect(declareAgentContract).toHaveBeenCalledTimes(1);
    });

    it("refuses direct creation and resubmission of agent_profile_change", async () => {
      const s = await seedProfileCompany(db);
      const created = await send(owner(s), "post", `/api/companies/${s.company.id}/approvals`, {
        type: "agent_profile_change",
        payload: { agentId: s.analyst.id },
      });
      expect(created.status).toBe(422);
      expect(created.body.details?.code).toBe("AGENT_PROFILE_CHANGE_NOT_DIRECT");
      const { approval } = await propose(s, steward(s), (b) => (b.identity.audience = "X"));
      expect((await send(steward(s), "post", `/api/approvals/${approval.id}/request-revision`, {})).status).toBe(200);
      const resubmitted = await send(steward(s), "post", `/api/approvals/${approval.id}/resubmit`, { payload: { agentId: s.analyst.id } });
      expect(resubmitted.status).toBe(422);
      expect((await db.select().from(approvals).where(eq(approvals.id, approval.id)))[0]!.status).toBe("revision_requested");
    });

    it("is decided only where the change is shown: connector channels are refused", async () => {
      const s = await seedProfileCompany(db);
      const { approval } = await propose(s, steward(s), (b) => (b.identity.audience = "X"));
      await expect(
        approvalAuthorityService(db).requireDecisionAuthority(
          approval,
          { userId: s.stewardUserId, source: "session" },
          { revision: approval.revision, idempotencyKey: randomUUID(), channel: "teams" },
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("hides a profile change about an agent the viewer cannot see", async () => {
      const s = await seedProfileCompany(db);
      const { approval } = await propose(s, owner(s), (b) => (b.identity.audience = "X"), s.autonomous.id);
      await db.update(agents).set({ visibility: "owner" }).where(eq(agents.id, s.autonomous.id));
      expect((await send(boardActor(s.company.id, s.outsiderUserId), "get", `/api/approvals/${approval.id}`)).status).toBe(404);
      const list = await send(boardActor(s.company.id, s.outsiderUserId), "get", `/api/companies/${s.company.id}/approvals`);
      expect(list.body.map((row: { id: string }) => row.id)).not.toContain(approval.id);
      expect((await send(owner(s), "get", `/api/approvals/${approval.id}`)).status).toBe(200);
    });

    it("resumes a failed application for an administrator, not for an outsider", async () => {
      const s = await seedProfileCompany(db);
      declareAgentContract.mockRejectedValueOnce(new Error("ledger down"));
      const { approval } = await propose(s, steward(s), (b) => (b.identity.audience = "X"));
      expect((await send(steward(s), "post", `/api/approvals/${approval.id}/approve`, decision(approval))).status).toBe(200);
      const [failed] = await db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, approval.id));
      expect(failed!.status).toBe("failed");
      const path = `${base(s)}/applications/${failed!.id}/resume`;
      expect((await send(boardActor(s.company.id, s.outsiderUserId), "post", path)).status).toBe(403);
      const resumed = await send(owner(s), "post", path);
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
      expect(resumed.body).toMatchObject({ activated: true, application: { status: "applied" } });
    });
  });

  // -------------------------------------------------------------------------
  // The view's viewer flags: each one is the mutation's own guard
  // -------------------------------------------------------------------------

  describe("viewer permissions on the profile view", () => {
    type Actor = Record<string, unknown>;
    type Flags = {
      canEditDraft: boolean;
      canPropose: boolean;
      canWithdraw: boolean;
      canResumeApplication: boolean;
      canDecideActiveProposal: boolean | null;
    };

    /**
     * Every target at once on `agentId`: a failed application (revision 1,
     * approved by `decider`), a pending proposal (revision 2) and an open
     * draft (revision 3), all written by `author`.
     */
    async function seedTargets(s: Seed, agentId: string, author: Actor, decider: Actor) {
      declareAgentContract.mockRejectedValueOnce(new Error("ledger down"));
      const first = await propose(s, author, (b) => (b.identity.audience = "First"), agentId);
      expect((await send(decider, "post", `/api/approvals/${first.approval.id}/approve`, decision(first.approval))).status).toBe(200);
      const [failed] = await db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, first.approval.id));
      expect(failed!.status).toBe("failed");
      const pending = await propose(s, author, (b) => (b.identity.audience = "Second"), agentId);
      const draft = await send(author, "post", `${base(s, agentId)}/revisions`, {});
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      return { applicationId: failed!.id, pending, draft: draft.body as { id: string; bodyHash: string; body: unknown } };
    }

    /**
     * Read the flags as `actor`, then run every mutation as `actor` and check
     * each flag against the guard's own answer: refused (403) exactly when
     * the flag is false. State refusals (409) count as "the guard let me".
     */
    async function expectFlagsMatchGuards(s: Seed, agentId: string, actor: Actor, viewPath: string, expected: Flags) {
      const targets = await seedTargets(s, agentId, ...authorsFor(s, agentId));
      const viewed = await send(actor, "get", viewPath);
      expect(viewed.status, JSON.stringify(viewed.body)).toBe(200);
      expect(viewed.body.viewer).toEqual(expected);
      const flags = viewed.body.viewer as Flags;
      const refused = (status: number) => status === 403;

      const saved = await send(actor, "patch", `${base(s, agentId)}/revisions/${targets.draft.id}`, { body: targets.draft.body }, {
        "If-Match": targets.draft.bodyHash,
      });
      expect(refused(saved.status), `save ${saved.status} ${JSON.stringify(saved.body)}`).toBe(!flags.canEditDraft);
      const proposed = await send(actor, "post", `${base(s, agentId)}/revisions/${targets.draft.id}/propose`, {});
      expect(refused(proposed.status), `propose ${proposed.status} ${JSON.stringify(proposed.body)}`).toBe(!flags.canPropose);
      const resumed = await send(actor, "post", `${base(s, agentId)}/applications/${targets.applicationId}/resume`);
      expect(refused(resumed.status), `resume ${resumed.status} ${JSON.stringify(resumed.body)}`).toBe(!flags.canResumeApplication);
      const approval = await db.select().from(approvals).where(eq(approvals.id, targets.pending.approval.id)).then((rows) => rows[0]!);
      const decided = await send(actor, "post", `/api/approvals/${approval.id}/approve`, decision(approval));
      expect(refused(decided.status), `decide ${decided.status} ${JSON.stringify(decided.body)}`).toBe(flags.canDecideActiveProposal === false);
      const withdrawn = await send(actor, "post", `${base(s, agentId)}/revisions/${targets.pending.revisionId}/withdraw`, {});
      expect(refused(withdrawn.status), `withdraw ${withdrawn.status} ${JSON.stringify(withdrawn.body)}`).toBe(!flags.canWithdraw);
    }

    /** Who writes and approves the targets: the analyst's steward; the autonomous agent's admin. */
    function authorsFor(s: Seed, agentId: string): [Actor, Actor] {
      return agentId === s.analyst.id ? [steward(s), steward(s)] : [owner(s), owner(s)];
    }

    it("matches the guards for an admin", async () => {
      const s = await seedProfileCompany(db);
      await expectFlagsMatchGuards(s, s.analyst.id, owner(s), base(s), {
        canEditDraft: true,
        canPropose: true,
        canWithdraw: true,
        canResumeApplication: true,
        canDecideActiveProposal: true,
      });
    });

    it("matches the guards for the steward (who approved, so may resume)", async () => {
      const s = await seedProfileCompany(db);
      await expectFlagsMatchGuards(s, s.analyst.id, steward(s), base(s), {
        canEditDraft: true,
        canPropose: true,
        canWithdraw: true,
        canResumeApplication: true,
        canDecideActiveProposal: true,
      });
    });

    it("matches the guards for the accountable person (not the approver, not an admin)", async () => {
      const s = await seedProfileCompany(db);
      await expectFlagsMatchGuards(s, s.autonomous.id, boardActor(s.company.id, s.accountableUserId), base(s, s.autonomous.id), {
        canEditDraft: true,
        canPropose: true,
        canWithdraw: true,
        canResumeApplication: false,
        canDecideActiveProposal: true,
      });
    });

    it("matches the guards for a member with no relationship to the agent", async () => {
      const s = await seedProfileCompany(db);
      await expectFlagsMatchGuards(s, s.analyst.id, boardActor(s.company.id, s.outsiderUserId), base(s), {
        canEditDraft: false,
        canPropose: false,
        canWithdraw: false,
        canResumeApplication: false,
        canDecideActiveProposal: false,
      });
    });

    it("matches the guards for the agent itself, on its own view", async () => {
      const s = await seedProfileCompany(db);
      // APM gate 5: the steward proposed the pending change, so the agent (not its proposer) cannot withdraw it.
      await expectFlagsMatchGuards(s, s.analyst.id, agentRequestActor(s.analyst), "/api/agents/me/profile", {
        canEditDraft: true,
        canPropose: true,
        canWithdraw: false,
        canResumeApplication: false,
        canDecideActiveProposal: false,
      });
    });

    it("answers for the strongest field: a steward cannot decide a runtime change an admin can", async () => {
      const s = await seedProfileCompany(db);
      const { approval } = await propose(s, owner(s), (b) => {
        b.runtime = { ...b.runtime, model: "test-model" };
      });
      expect((await send(steward(s), "get", base(s))).body.viewer.canDecideActiveProposal).toBe(false);
      expect((await send(steward(s), "post", `/api/approvals/${approval.id}/approve`, decision(approval))).status).toBe(403);
      expect((await send(owner(s), "get", base(s))).body.viewer.canDecideActiveProposal).toBe(true);
    });

    it("has nothing to propose, withdraw, resume or decide before any revision exists", async () => {
      const s = await seedProfileCompany(db);
      expect((await send(steward(s), "get", base(s))).body.viewer).toEqual({
        canEditDraft: true,
        canPropose: false,
        canWithdraw: false,
        canResumeApplication: false,
        canDecideActiveProposal: null,
      });
      const outsider = boardActor(s.company.id, s.outsiderUserId);
      expect((await send(outsider, "get", base(s))).body.viewer.canEditDraft).toBe(false);
      expect((await send(outsider, "post", `${base(s)}/revisions`, {})).status).toBe(403);
    });
  });

  describe("MK regression on approvals", () => {
    it("keeps the steward-only rule for other approval types in agentdash_mk", async () => {
      const s = await seedProfileCompany(db);
      const [approval] = await db
        .insert(approvals)
        .values({ companyId: s.company.id, type: "approve_ceo_strategy", requestedByAgentId: s.analyst.id, status: "pending", payload: {} })
        .returning();
      expect((await send(owner(s), "post", `/api/approvals/${approval!.id}/approve`, decision(approval!))).status).toBe(403);
      const res = await send(steward(s), "post", `/api/approvals/${approval!.id}/approve`, decision(approval!));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.decisionActorRole).toBe("steward");
    });

    it("keeps the board rule for other approval types in default companies", async () => {
      const s = await seedProfileCompany(db, "default");
      const [approval] = await db
        .insert(approvals)
        .values({ companyId: s.company.id, type: "approve_ceo_strategy", requestedByAgentId: s.analyst.id, status: "pending", payload: {} })
        .returning();
      const res = await send(boardActor(s.company.id, s.outsiderUserId), "post", `/api/approvals/${approval!.id}/approve`, {});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.decisionActorRole).toBe("board");
    });
  });
});
