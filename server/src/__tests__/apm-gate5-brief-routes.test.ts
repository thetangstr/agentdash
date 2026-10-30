// AgentDash: Agent Performance Management gate 5 (P5.1) — start from a brief,
// over the real HTTP routes and embedded Postgres:
//   - a saved brief wakes no one; submitting assigns the planner (409 without one);
//   - the scenario manifest is validated on every write of a brief's document;
//   - an unbound draft's lifecycle (create, list, get, save, diff, new draft);
//   - preview and save never hire an agent or wake one;
//   - proposing files `hire_agent` through the hire validator; the approved
//     hire binds the profile and applies it through the gate 2 application;
//   - the first application needs the hire's authority (agents:create);
//   - rejecting the hire leaves the draft rejected; withdraw is the proposer's or an admin's.
//
// Nothing external runs: agents use an in-process fake adapter registered for
// this file, and `heartbeatService().wakeup` is recorded instead of run.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentProfileApplications,
  agentProfileRevisions,
  agentProfiles,
  agents,
  approvals,
  authUsers,
  companies,
  createDb,
  documentRevisions,
  issues,
} from "@paperclipai/db";
import { DEFAULT_AGENT_GOVERNANCE_POLICY, parseAccessPolicy, type AgentOperatingProfileV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { addAgent, addCompany, addUser, agentRequestActor, boardActor, type TestDb } from "./helpers/agent-profile-fixtures.js";

const wakeups = vi.hoisted(() => [] as Array<{ agentId: string; opts: Record<string, unknown> }>);
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
      const real = actual.heartbeatService(...args);
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "wakeup") {
            return async (agentId: string, opts: Record<string, unknown> = {}) => {
              wakeups.push({ agentId, opts });
              return null;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

const { errorHandler } = await import("../middleware/index.js");
const { registerServerAdapter, unregisterServerAdapter } = await import("../adapters/registry.js");
const { agentBriefRoutes } = await import("../routes/agent-briefs.js");
const { agentProfileRoutes } = await import("../routes/agent-profiles.js");
const { agentRoutes } = await import("../routes/agents.js");
const { approvalRoutes } = await import("../routes/approvals.js");
const { issueRoutes } = await import("../routes/issues.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FAKE_ADAPTER = "apm_gate5_brief_fake";
const BRIEF = `# Company agent-work brief

Business objective: keep renewals on time.

## Scenario S01 — Weekly renewal digest
Stakeholders and decision this supports: the account team decides who to call.
Current process and who does it today: an analyst builds it by hand on Mondays.
`;

type Body = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describeEmbeddedPostgres("APM gate 5 — start from a brief (P5.1)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) savedEnv[key] = process.env[key];
    home = await mkdtemp(join(tmpdir(), "apm-gate5-brief-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "apm-gate5-brief";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apm-gate5-brief-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: FAKE_ADAPTER,
      supportsInstructionsBundle: true,
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "gate 5 fake adapter" }),
      testEnvironment: async () => ({ adapterType: FAKE_ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    } as never);
  }, 30_000);

  beforeEach(() => {
    wakeups.length = 0;
  });

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    unregisterServerAdapter(FAKE_ADAPTER);
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });

  async function send(
    actor: Record<string, unknown>,
    method: "get" | "post" | "patch" | "put",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Body }> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = { ...actor };
      next();
    });
    for (const router of [
      agentRoutes(db),
      agentProfileRoutes(db),
      agentBriefRoutes(db),
      issueRoutes(db, {} as never),
      approvalRoutes(db, { autoDispatchQueuedRuns: false }),
    ]) {
      app.use("/api", router);
    }
    app.use(errorHandler);
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      let call = request(`http://127.0.0.1:${address.port}`)[method](path);
      for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
      const res = await (body === undefined ? call : call.send(body as object));
      return { status: res.status, body: res.body };
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }

  async function seed(options: { withManager?: boolean } = {}) {
    const company = await addCompany(db, "Briefs", "default");
    const ownerUserId = await addUser(db, company.id, "owner");
    const memberUserId = await addUser(db, company.id, "member");
    const fake = { adapterType: FAKE_ADAPTER, adapterConfig: {} };
    const chief =
      options.withManager === false
        ? null
        : await addAgent(db, company.id, { name: "Chief", role: "chief_of_staff", permissions: { canCreateAgents: true }, ...fake });
    const analyst = await addAgent(db, company.id, { name: "Analyst", ...fake });
    return {
      company,
      ownerUserId,
      memberUserId,
      chief,
      analyst,
      owner: boardActor(company.id, ownerUserId, "owner"),
      member: boardActor(company.id, memberUserId),
      manager: chief ? agentRequestActor(chief) : null,
    };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  async function activity(companyId: string, action: string) {
    return db
      .select({ details: activityLog.details, entityId: activityLog.entityId, agentId: activityLog.agentId, actorId: activityLog.actorId })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
  }

  async function createBrief(s: Seed) {
    const res = await send(s.owner, "post", `/api/companies/${s.company.id}/agent-briefs`, { title: "Renewals brief", markdown: BRIEF });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { issueId: string; document: { latestRevisionId: string; latestRevisionNumber: number } };
  }

  function unboundBody(overrides: (body: AgentOperatingProfileV1) => void = () => {}): AgentOperatingProfileV1 {
    const body: AgentOperatingProfileV1 = {
      profileVersion: 1,
      identity: {
        name: "Renewals Analyst",
        title: "Renewals Analyst",
        summary: "Prepares the weekly renewal digest",
        audience: "The account team",
        style: { tone: "Plain", uncertaintyRule: "Say what is unknown" },
      },
      responsibilities: [
        {
          key: "renewal-digest",
          title: "Weekly renewal digest",
          outcome: "The account team knows who to call",
          stakeholders: [],
          obligation: { kind: "assigned" },
          deliverable: { what: "The digest", destination: "The renewals issue" },
          escalation: { when: "The renewal data is missing" },
          performance: { criteria: [], coverage: [], outcomeLinks: [], expectedHumanSteps: [], judges: { automated: [] } },
        },
      ],
      knowledge: [],
      skills: [],
      access: parseAccessPolicy(DEFAULT_AGENT_GOVERNANCE_POLICY),
      rhythm: { timezone: "UTC", reportTo: {} },
      runtime: { adapterType: FAKE_ADAPTER, model: "fake-model-1" },
    };
    overrides(body);
    return body;
  }

  async function createUnbound(s: Seed, actor: Record<string, unknown>, body = unboundBody()) {
    const res = await send(actor, "post", `/api/companies/${s.company.id}/agent-profiles`, { body, sourceRefs: [{ kind: "brief", id: randomUUID() }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; profileId: string; bodyHash: string; body: AgentOperatingProfileV1 };
  }

  const draftPath = (s: Seed, profileId: string) => `/api/companies/${s.company.id}/agent-profiles/${profileId}`;
  const decision = (approval: { revision: number }) => ({ revision: approval.revision, idempotencyKey: randomUUID(), channel: "web" });

  async function counts(companyId: string) {
    const [agentRows, approvalRows] = await Promise.all([
      db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId)),
      db.select({ id: approvals.id }).from(approvals).where(eq(approvals.companyId, companyId)),
    ]);
    return { agents: agentRows.length, approvals: approvalRows.length, wakeups: wakeups.length };
  }

  // -------------------------------------------------------------------------
  // The brief
  // -------------------------------------------------------------------------

  describe("the brief", () => {
    it("saves as a backlog, unassigned planning issue that wakes no one; submitting assigns the planner the normal way", async () => {
      const s = await seed();
      const brief = await createBrief(s);
      const [issue] = await db.select().from(issues).where(eq(issues.id, brief.issueId));
      expect(issue).toMatchObject({ status: "backlog", assigneeAgentId: null, assigneeUserId: null, originKind: "agent_work_brief" });
      expect(brief).toMatchObject({ kind: "agent_brief", status: "backlog", assigneeAgentId: null, document: { key: "agent-work-brief", latestRevisionNumber: 1 } });
      expect(wakeups).toEqual([]);
      expect((await activity(s.company.id, "agent_brief.created")).length).toBe(1);

      // Editing is the issue-document revision API.
      const edited = await send(s.owner, "put", `/api/issues/${brief.issueId}/documents/agent-work-brief`, {
        format: "markdown",
        body: `${BRIEF}\nRestrictions: renewals pricing stays human-owned.\n`,
        baseRevisionId: brief.document.latestRevisionId,
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.latestRevisionNumber).toBe(2);
      expect(wakeups).toEqual([]);

      // Only a board user starts or submits a brief.
      expect((await send(s.manager!, "post", `/api/companies/${s.company.id}/agent-briefs`, { title: "x", markdown: "y" })).status).toBe(403);
      expect((await send(s.manager!, "post", `/api/companies/${s.company.id}/agent-briefs/${brief.issueId}/submit`, {})).status).toBe(403);

      const submitted = await send(s.member, "post", `/api/companies/${s.company.id}/agent-briefs/${brief.issueId}/submit`, {});
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      expect(submitted.body).toMatchObject({ status: "todo", assigneeAgentId: s.chief!.id });
      const [after] = await db.select().from(issues).where(eq(issues.id, brief.issueId));
      expect(after).toMatchObject({ status: "todo", assigneeAgentId: s.chief!.id });
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]).toMatchObject({
        agentId: s.chief!.id,
        opts: { source: "assignment", reason: "issue_assigned", payload: { issueId: brief.issueId, mutation: "update" } },
      });
      const [submittedRow] = await activity(s.company.id, "agent_brief.submitted");
      expect(submittedRow).toMatchObject({ entityId: brief.issueId, agentId: s.chief!.id, details: { performanceManagerAgentId: s.chief!.id, briefRevisionNumber: 2 } });

      const again = await send(s.owner, "post", `/api/companies/${s.company.id}/agent-briefs/${brief.issueId}/submit`, {});
      expect(again.status).toBe(409);
      expect(again.body.details.code).toBe("AGENT_BRIEF_ALREADY_SUBMITTED");
      expect(wakeups).toHaveLength(1);
    });

    it("answers 409 with a clear message when the company has no performance manager, and changes nothing", async () => {
      const s = await seed({ withManager: false });
      const brief = await createBrief(s);
      const res = await send(s.owner, "post", `/api/companies/${s.company.id}/agent-briefs/${brief.issueId}/submit`, {});
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details.code).toBe("AGENT_BRIEF_NO_PERFORMANCE_MANAGER");
      expect(res.body.error).toBe(
        "No performance manager is set. An admin can choose one in Company settings, or the company needs a Chief of Staff.",
      );
      expect(res.body.error).not.toContain("/api/");
      const [issue] = await db.select().from(issues).where(eq(issues.id, brief.issueId));
      expect(issue).toMatchObject({ status: "backlog", assigneeAgentId: null });
      expect(wakeups).toEqual([]);
    });

    it("submits only briefs, in the caller's company", async () => {
      const s = await seed();
      const [plain] = await db.insert(issues).values({ companyId: s.company.id, title: "Ordinary", status: "backlog" }).returning();
      expect((await send(s.owner, "post", `/api/companies/${s.company.id}/agent-briefs/${plain!.id}/submit`, {})).status).toBe(404);
      const other = await seed();
      const brief = await createBrief(other);
      expect((await send(s.owner, "post", `/api/companies/${other.company.id}/agent-briefs/${brief.issueId}/submit`, {})).status).toBe(403);
      expect((await send(s.owner, "post", `/api/companies/${s.company.id}/agent-briefs/${brief.issueId}/submit`, {})).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // The scenario manifest
  // -------------------------------------------------------------------------

  describe("the scenario manifest", () => {
    function manifest(scenario: Record<string, unknown> = {}) {
      return {
        manifestVersion: 1,
        scenarios: [
          {
            key: "s01",
            title: "Weekly renewal digest",
            stakeholders: "The account team",
            currentProcess: "An analyst builds it by hand",
            removedOrNewWork: "Removes the Monday build",
            triggerCadence: "Weekly, Monday 09:00 UTC",
            inputsSources: "The renewals export",
            deliverable: "A digest on the renewals issue",
            acceptanceNotes: "Every renewal due in 30 days is listed",
            authorityNeeds: "Read the renewals export",
            escalation: "The account lead, when data is missing",
            baselineMeasure: "",
            unknowns: ["The baseline time spent today"],
            recommendation: "new_role",
            reason: "No agent reads the renewals export today",
            ...scenario,
          },
        ],
      };
    }

    it("validates a brief's scenario-manifest on every write (422), and leaves other issues' documents alone", async () => {
      const s = await seed();
      const brief = await createBrief(s);
      const put = (actor: Record<string, unknown>, body: string, baseRevisionId?: string | null, issueId = brief.issueId) =>
        send(actor, "put", `/api/issues/${issueId}/documents/scenario-manifest`, { format: "markdown", body, baseRevisionId: baseRevisionId ?? null });

      const notJson = await put(s.owner, "not json");
      expect(notJson.status).toBe(422);
      expect(notJson.body.details.code).toBe("AGENT_SCENARIO_MANIFEST_INVALID");
      const missingTarget = await put(s.owner, JSON.stringify(manifest({ recommendation: "reuse" })));
      expect(missingTarget.status).toBe(422);
      expect(missingTarget.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "scenarios.0.targetAgentId" })]));
      const other = await seed();
      const foreignAgent = await put(s.owner, JSON.stringify(manifest({ recommendation: "reuse", targetAgentId: other.analyst.id })));
      expect(foreignAgent.status).toBe(422);
      expect(foreignAgent.body.details.issues).toEqual([{ path: "scenarios.0.targetAgentId", message: "not an agent of this company" }]);
      const unknownProfile = await put(s.owner, JSON.stringify(manifest({ unboundProfileId: randomUUID() })));
      expect(unknownProfile.status).toBe(422);
      expect(unknownProfile.body.details.issues[0].path).toBe("scenarios.0.unboundProfileId");

      // The planner (the assignee after submit) writes a valid manifest; a fenced ```json block is fine too.
      expect((await send(s.owner, "post", `/api/companies/${s.company.id}/agent-briefs/${brief.issueId}/submit`, {})).status).toBe(200);
      const first = await put(s.manager!, JSON.stringify(manifest({ recommendation: "reuse", targetAgentId: s.analyst.id, reason: "The analyst already has the export" })));
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const second = await put(s.manager!, "```json\n" + JSON.stringify(manifest(), null, 2) + "\n```\n", first.body.latestRevisionId);
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      const invalidUpdate = await put(s.manager!, JSON.stringify({ manifestVersion: 2, scenarios: [] }), second.body.latestRevisionId);
      expect(invalidUpdate.status).toBe(422);

      // Restoring is a write too: an old revision that no longer validates is refused.
      await db.update(documentRevisions).set({ body: "{ broken" }).where(eq(documentRevisions.id, first.body.latestRevisionId));
      const restore = await send(s.owner, "post", `/api/issues/${brief.issueId}/documents/scenario-manifest/revisions/${first.body.latestRevisionId}/restore`, {});
      expect(restore.status, JSON.stringify(restore.body)).toBe(422);
      expect(restore.body.details.code).toBe("AGENT_SCENARIO_MANIFEST_INVALID");

      // The same key on an issue that is not a brief is an ordinary document.
      const [plain] = await db.insert(issues).values({ companyId: s.company.id, title: "Ordinary", status: "todo" }).returning();
      expect((await put(s.owner, "anything at all", null, plain!.id)).status).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  // Unbound drafts
  // -------------------------------------------------------------------------

  describe("unbound drafts", () => {
    it("runs the lifecycle — create, list, get, save, diff, new draft — for admins and the performance manager, and nobody else", async () => {
      const s = await seed();
      const before = await counts(s.company.id);
      const byManager = await createUnbound(s, s.manager!);
      expect(byManager).toMatchObject({ agentId: null, state: "draft", revisionNumber: 1, createdByAgentId: s.chief!.id });
      const byOwner = await createUnbound(s, s.owner);
      expect(byOwner.createdByUserId).toBe(s.ownerUserId);
      expect((await send(s.member, "post", `/api/companies/${s.company.id}/agent-profiles`, { body: unboundBody() })).status).toBe(403);
      expect((await send(agentRequestActor(s.analyst), "post", `/api/companies/${s.company.id}/agent-profiles`, { body: unboundBody() })).status).toBe(403);

      const list = await send(s.member, "get", `/api/companies/${s.company.id}/agent-profiles`);
      expect(list.status).toBe(200);
      expect(list.body.map((row: Body) => row.profileId).sort()).toEqual([byManager.profileId, byOwner.profileId].sort());
      expect((await send(agentRequestActor(s.analyst), "get", `/api/companies/${s.company.id}/agent-profiles`)).status).toBe(403);
      expect((await send(s.manager!, "get", `/api/companies/${s.company.id}/agent-profiles`)).status).toBe(200);

      const view = await send(s.member, "get", draftPath(s, byManager.profileId));
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({
        kind: "unbound_agent_profile_view",
        agentId: null,
        latestDraft: { id: byManager.id },
        pendingProposal: null,
        viewer: { canEditDraft: false, canPropose: false, canWithdraw: false },
      });
      expect((await send(s.manager!, "get", draftPath(s, byManager.profileId))).body.viewer).toEqual({ canEditDraft: true, canPropose: true, canWithdraw: false });

      // Save with If-Match; a stale hash is 409 with the current draft.
      const edited = unboundBody((body) => (body.identity.summary = "Prepares the renewal digest and flags risks"));
      const saved = await send(s.owner, "patch", `${draftPath(s, byManager.profileId)}/revisions/${byManager.id}`, { body: edited }, { "If-Match": byManager.bodyHash });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const stale = await send(s.manager!, "patch", `${draftPath(s, byManager.profileId)}/revisions/${byManager.id}`, { body: edited }, { "If-Match": byManager.bodyHash });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("AGENT_PROFILE_DRAFT_CONFLICT");
      expect((await send(s.member, "patch", `${draftPath(s, byManager.profileId)}/revisions/${byManager.id}`, { body: edited }, { "If-Match": saved.body.bodyHash })).status).toBe(403);

      // Diff against nothing (a new role has no active profile) and against another revision.
      const diff = await send(s.member, "get", `${draftPath(s, byManager.profileId)}/revisions/${byManager.id}/diff`);
      expect(diff.status).toBe(200);
      expect(diff.body.against).toBe("none");
      expect(diff.body.diff.length).toBeGreaterThan(0);
      const one = await send(s.member, "get", `${draftPath(s, byManager.profileId)}/revisions/${byManager.id}`);
      expect(one.body.body.identity.summary).toBe("Prepares the renewal digest and flags risks");

      // One open draft per profile.
      expect((await send(s.owner, "post", `${draftPath(s, byManager.profileId)}/revisions`, {})).status).toBe(409);
      // Company-scoped: another company's profile is 404.
      const other = await seed();
      expect((await send(other.owner, "get", `/api/companies/${other.company.id}/agent-profiles/${byManager.profileId}`)).status).toBe(404);

      // Preview and save never hire or wake.
      expect(await counts(s.company.id)).toEqual(before);
      expect((await activity(s.company.id, "agent_profile.draft_saved")).length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Hire with profile
  // -------------------------------------------------------------------------

  describe("hire with profile", () => {
    async function pendingRevision(revisionId: string) {
      return db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id, revisionId)).then((rows) => rows[0]!);
    }

    it("refuses a draft the hire validator refuses, and releases it back to a draft", async () => {
      const s = await seed();
      const before = await counts(s.company.id);
      const cases: Array<[string, (body: AgentOperatingProfileV1) => void, string]> = [
        ["no adapter type", (body) => (body.runtime = {}), "runtime.adapterType"],
        ["a process agent without a command", (body) => (body.runtime = { adapterType: "process" }), "adapterConfig.command"],
        [
          "a routine binding",
          (body) => (body.responsibilities[0]!.obligation = { kind: "routine", routineTriggerId: randomUUID() }),
          "responsibilities.0.obligation",
        ],
      ];
      for (const [label, mutate, path] of cases) {
        const draft = await createUnbound(s, s.owner, unboundBody(mutate));
        const res = await send(s.owner, "post", `${draftPath(s, draft.profileId)}/revisions/${draft.id}/propose`, { role: "general" });
        expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(422);
        expect(res.body.details.code, label).toBe("AGENT_PROFILE_HIRE_INVALID");
        // One issue shape, whichever check refused: `path`, dot-joined, as the hire validator's.
        const issues = res.body.details.issues as Array<Record<string, unknown>>;
        expect(issues.map((issue) => issue.path), label).toContain(path);
        for (const issue of issues) expect(Object.keys(issue).sort(), label).toEqual(["message", "path"]);
        expect((await pendingRevision(draft.id)).state, label).toBe("draft");
      }
      expect(await counts(s.company.id)).toEqual(before);
    });

    it("files hire_agent through the hire path; the approved hire binds the profile and applies it with the hire's authority", async () => {
      const s = await seed();
      const draft = await createUnbound(s, s.manager!);
      const proposed = await send(s.manager!, "post", `${draftPath(s, draft.profileId)}/revisions/${draft.id}/propose`, {
        role: "researcher",
        reason: "Scenario S01 needs a new role",
      });
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
      expect(proposed.body.revision).toMatchObject({ state: "proposed", approvalId: proposed.body.approvalId });
      const approvalId = proposed.body.approvalId as string;
      const agentId = proposed.body.agentId as string;

      // Filed, not hired: the agent waits for approval, the profile is still unbound, nothing woke.
      const [pendingAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(pendingAgent).toMatchObject({ status: "pending_approval", name: "Renewals Analyst", title: "Renewals Analyst", role: "researcher", adapterType: FAKE_ADAPTER });
      const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
      expect(approval).toMatchObject({ type: "hire_agent", status: "pending", requestedByAgentId: s.chief!.id });
      expect(approval!.payload).toMatchObject({
        agentId,
        profileId: draft.profileId,
        profileRevisionId: draft.id,
        profileRevisionNumber: 1,
        profileBodyHash: draft.bodyHash,
        profileChange: { agentId, revisionId: draft.id, basedOnRevisionId: null, proposedBy: { kind: "agent", agentId: s.chief!.id, capacity: "performance_manager" } },
      });
      const [unbound] = await db.select().from(agentProfiles).where(eq(agentProfiles.id, draft.profileId));
      expect(unbound!.agentId).toBeNull();
      expect(wakeups).toEqual([]);
      expect((await send(s.manager!, "post", `${draftPath(s, draft.profileId)}/revisions/${draft.id}/propose`, {})).status).toBe(409);
      const view = await send(s.owner, "get", draftPath(s, draft.profileId));
      expect(view.body).toMatchObject({ pendingProposal: { id: draft.id }, hireApprovalId: approvalId, viewer: { canWithdraw: true } });
      // The manager can never decide its own hire, and a hire with a profile is never filed or resubmitted directly.
      expect((await send(s.manager!, "post", `/api/approvals/${approvalId}/approve`, decision(approval!))).status).toBe(403);
      const direct = await send(s.owner, "post", `/api/companies/${s.company.id}/approvals`, {
        type: "hire_agent",
        payload: { name: "Sneaky", role: "general", adapterType: FAKE_ADAPTER, profileRevisionId: draft.id },
      });
      expect(direct.status).toBe(422);
      expect(direct.body.details.code).toBe("AGENT_PROFILE_CHANGE_NOT_DIRECT");
      expect((await send(s.owner, "post", `/api/approvals/${approvalId}/resubmit`, {})).status).toBe(422);
      // The pending agent's first profile is the hire's draft: no second profile can be started for it.
      const competing = await send(s.owner, "post", `/api/companies/${s.company.id}/agents/${agentId}/profile/revisions`, {});
      expect(competing.status, JSON.stringify(competing.body)).toBe(409);

      // The owner approves: the agent is activated, the profile bound and applied, the receipt recorded.
      const approved = await send(s.owner, "post", `/api/approvals/${approvalId}/approve`, decision(approval!));
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body.payload.profileChange.requiredAuthority).toBe("admin");
      const [hired] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(hired!.status).toBe("idle");
      expect((hired!.adapterConfig as Record<string, unknown>).model).toBe("fake-model-1");
      const [bound] = await db.select().from(agentProfiles).where(eq(agentProfiles.id, draft.profileId));
      expect(bound).toMatchObject({ agentId, activeRevisionId: draft.id });
      const [application] = await db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, approvalId));
      expect(application).toMatchObject({ agentId, revisionId: draft.id, status: "applied", approverUserId: s.ownerUserId });
      expect(application!.approverAuthority).toMatchObject({ role: "admin", required: "admin", selfApproval: false });
      expect((await pendingRevision(draft.id)).state).toBe("applied");
      expect((await activity(s.company.id, "agent_profile.bound"))[0]).toMatchObject({ entityId: draft.profileId, agentId });
      expect((await activity(s.company.id, "agent_profile.applied"))[0]).toMatchObject({ entityId: draft.id, agentId });

      // The hired agent's own profile view now reads the applied revision; nothing woke the new agent.
      const profile = await send(s.owner, "get", `/api/companies/${s.company.id}/agents/${agentId}/profile`);
      expect(profile.status, JSON.stringify(profile.body)).toBe(200);
      expect(profile.body).toMatchObject({ profileId: draft.profileId, active: { id: draft.id, state: "applied" }, latestApplication: { status: "applied" } });
      expect(wakeups.map((wake) => wake.agentId)).not.toContain(agentId);
      // The bound profile is no longer an unbound draft.
      expect((await send(s.owner, "get", `/api/companies/${s.company.id}/agent-profiles`)).body).toEqual([]);
      expect((await send(s.owner, "post", `${draftPath(s, draft.profileId)}/revisions`, {})).status).toBe(409);
    });

    it("applies the first profile only with the hire's authority (agents:create): a decider without it applies nothing", async () => {
      const s = await seed();
      const draft = await createUnbound(s, s.owner);
      const proposed = await send(s.owner, "post", `${draftPath(s, draft.profileId)}/revisions/${draft.id}/propose`, {});
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
      const agentId = proposed.body.agentId as string;
      // The decision routes already require agents:create to decide a hire (403 here); the
      // application re-checks it anyway, so a decision recorded some other way changes nothing.
      expect((await send(s.member, "post", `/api/agents/${agentId}/approve`, {})).status).toBe(403);
      const { approvalService } = await import("../services/approvals.js");
      await approvalService(db).approve(proposed.body.approvalId, s.memberUserId, null);
      const { applyHireProfileRevision } = await import("../services/agent-profile-application.js");
      const result = await applyHireProfileRevision(db, proposed.body.approvalId, { userId: s.memberUserId, path: "approval" });
      expect(result?.activated).toBe(false);
      const [application] = await db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, proposed.body.approvalId));
      expect(application).toMatchObject({ status: "failed", approverUserId: s.memberUserId });
      const [profile] = await db.select().from(agentProfiles).where(eq(agentProfiles.id, draft.profileId));
      expect(profile).toMatchObject({ agentId, activeRevisionId: null });
      expect((await pendingRevision(draft.id)).state).toBe("application_failed");
      const failed = await activity(s.company.id, "agent_profile.application_failed");
      expect(failed[0]!.details).toMatchObject({ kind: "authority" });
    });

    it("rejecting the hire leaves the draft rejected and the profile unbound; a new draft can start from it", async () => {
      const s = await seed();
      const draft = await createUnbound(s, s.owner);
      const proposed = await send(s.owner, "post", `${draftPath(s, draft.profileId)}/revisions/${draft.id}/propose`, {});
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
      const [approval] = await db.select().from(approvals).where(eq(approvals.id, proposed.body.approvalId));
      const rejected = await send(s.owner, "post", `/api/approvals/${approval!.id}/reject`, decision(approval!));
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
      expect((await pendingRevision(draft.id)).state).toBe("rejected");
      const [profile] = await db.select().from(agentProfiles).where(eq(agentProfiles.id, draft.profileId));
      expect(profile!.agentId).toBeNull();
      const [agent] = await db.select().from(agents).where(eq(agents.id, proposed.body.agentId));
      expect(agent!.status).toBe("terminated");
      expect(await db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, approval!.id))).toEqual([]);
      const next = await send(s.owner, "post", `${draftPath(s, draft.profileId)}/revisions`, {});
      expect(next.status, JSON.stringify(next.body)).toBe(201);
      expect(next.body).toMatchObject({ revisionNumber: 2, state: "draft", agentId: null });
      expect(next.body.body).toEqual(draft.body);
    });

    it("withdraws a pending hire for its proposer or an admin only; the pending agent is ended and the draft withdrawn", async () => {
      const s = await seed();
      const draft = await createUnbound(s, s.manager!);
      const proposed = await send(s.manager!, "post", `${draftPath(s, draft.profileId)}/revisions/${draft.id}/propose`, {});
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
      const withdraw = (actor: Record<string, unknown>) => send(actor, "post", `${draftPath(s, draft.profileId)}/revisions/${draft.id}/withdraw`, { reason: "Not yet" });
      expect((await withdraw(s.member)).status).toBe(403);
      expect((await withdraw(agentRequestActor(s.analyst))).status).toBe(403);
      const res = await withdraw(s.manager!);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.state).toBe("withdrawn");
      const [approval] = await db.select().from(approvals).where(eq(approvals.id, proposed.body.approvalId));
      expect(approval!.status).toBe("cancelled");
      const [agent] = await db.select().from(agents).where(eq(agents.id, proposed.body.agentId));
      expect(agent!.status).toBe("terminated");
      expect((await withdraw(s.owner)).status).toBe(409);

      // An admin may withdraw the manager's next proposal.
      const next = await send(s.manager!, "post", `${draftPath(s, draft.profileId)}/revisions`, {});
      expect(next.status, JSON.stringify(next.body)).toBe(201);
      expect((await send(s.manager!, "post", `${draftPath(s, draft.profileId)}/revisions/${next.body.id}/propose`, {})).status).toBe(201);
      expect((await send(s.owner, "post", `${draftPath(s, draft.profileId)}/revisions/${next.body.id}/withdraw`, {})).status).toBe(200);
    });
  });
});
