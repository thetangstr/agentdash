// AgentDash: Agent Performance Management gates 4 and 5 — the exit
// walkthrough ("manager proposes" and "start from a brief"). One non-MK
// ("default" profile) company is driven over the real HTTP routes: the
// performance manager designated (Chief of Staff by default), its card reads
// with an agent principal's class limits, a profile proposal and a "pause"
// recommendation that pauses nothing, the manager's record, a brief saved and
// then submitted, the planner's scenario manifest and unbound draft, and a
// hire from that draft approved (profile bound and applied) and another
// rejected.
//
// As in the gate 2 and gate 3 walkthroughs: the routers are the production
// route factories mounted the way app.ts mounts them (the agent access-scope
// middleware first), behind the actor-injection shim every route suite uses.
// Embedded Postgres with every migration applied. No APM service is mocked.
// Nothing external runs: the agents use an in-process fake adapter registered
// for this file only, whose `execute` returns at once (no adapter process,
// model call or network call). Wakes and runs are real rows.
//
// One seed is written directly rather than over HTTP: the agent whose card is
// read gets an applied profile and a small evaluation ledger (one open item,
// one item in a restricted project, one private correction), as the gate 4
// route suite seeds it. Every gate 4–5 action after that is an HTTP call.
//
// The tests are one ordered scenario that shares state; each step checks that
// the step before it left what it needs.
//
// Exit conditions (doc/plans/2026-10-29-apm-gate4-5-build-spec.md) and the
// steps that prove them:
//   Gate 4
//   E4.1 a designated performance manager, defaulting to the CoS .......... step 1
//   E4.2 the manager reads agent cards (per-viewer projection) and files a
//        proposal with evidence and an advisory recommendation ............ step 2
//   E4.3 the manager never approves; "pause" pauses nothing ............... step 2
//        (and never decides its own hire: step 6)
//   E4.4 the manager's own record ........................................ step 3
//   Gate 5
//   E5.1–2 a pasted brief is a planning issue with a revisioned document,
//        assigned to the planner only on submit (the normal wake) .......... step 4
//   E5.3 the planner writes a validated manifest and an unbound draft ...... step 5
//   E5.4 an unbound draft proposed as a hire; the approved hire creates the
//        agent and applies the profile through the gate 2 path; a rejected
//        hire ends the pending agent and rejects the revision .............. step 6
//   E5.5 previewing or saving never hires or starts a heartbeat ...... steps 4–7
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agentProfileApplications,
  agentProfileRevisions,
  agentProfiles,
  agentWakeupRequests,
  agents,
  approvals,
  authSessions,
  createDb,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { DEFAULT_AGENT_GOVERNANCE_POLICY, parseAccessPolicy, type AgentCardView, type AgentOperatingProfileV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser, agentRequestActor, boardActor, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { activityRows } from "./helpers/agent-access-fixtures.js";
import { profileBody, responsibility, seedActiveProfile } from "./helpers/responsibility-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";
import { resetRunLogStoreForTests } from "../services/run-log-store.js";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.js";
import { evaluationLedger } from "../services/evaluation/ledger.js";
import { agentAccessScopeMiddleware } from "../routes/visibility.js";
import { activityRoutes } from "../routes/activity.js";
import { agentAccessEnforcementRoutes } from "../routes/agent-access-enforcement.js";
import { agentAccessRoutes } from "../routes/agent-access.js";
import { agentBriefRoutes } from "../routes/agent-briefs.js";
import { agentPerformanceRoutes } from "../routes/agent-performance.js";
import { agentProfileRoutes } from "../routes/agent-profiles.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { evaluationAgentRoutes } from "../routes/evaluation-agents.js";
import { evaluationRoutes } from "../routes/evaluation.js";
import { issueResponsibilityRoutes } from "../routes/issue-responsibilities.js";
import { issueRoutes } from "../routes/issues.js";
import { performanceManagerRoutes } from "../routes/performance-manager.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FAKE_ADAPTER = "apm_gate45_walkthrough_fake";
const ACTOR_HEADER = "x-walkthrough-actor";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BRIEF = `# Company agent-work brief

Business objective: keep renewals on time.

## Scenario S01 — Weekly renewal digest
Stakeholders and decision this supports: the account team decides who to call.
Current process and who does it today: an analyst builds it by hand on Mondays.

## Scenario S02 — Delivery status notes
Current process and who does it today: the Builder already writes these.
`;

type Actor = Record<string, unknown>;
type Body = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function waitFor<T>(label: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeEmbeddedPostgres("APM gates 4 and 5 exit walkthrough", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  let server: ReturnType<typeof createServer> | null = null;
  let baseUrl = "";
  const savedEnv: Record<string, string | undefined> = {};
  const actors = new Map<string, Actor>();
  /** userId → a live `auth_sessions` row, bound as the request's verified session credential (as the real auth middleware does). */
  const sessions = new Map<string, string>();

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY", "RUN_LOG_BASE_PATH"]) {
      savedEnv[key] = process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), "apm-gate45-walkthrough-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "apm-gate45-walkthrough";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "f".repeat(64);
    process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apm-gate45-walkthrough-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: FAKE_ADAPTER,
      supportsInstructionsBundle: true,
      execute: async (ctx: { onLog: (stream: string, text: string) => Promise<void> }) => {
        await ctx.onLog("stdout", "walkthrough: nothing ran\n");
        return { exitCode: 0, signal: null, timedOut: false, summary: "walkthrough fake adapter" };
      },
      testEnvironment: async () => ({ adapterType: FAKE_ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    } as never);

    // The production route factories, mounted as app.ts mounts them (the access-scope middleware first).
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const key = req.header(ACTOR_HEADER);
      const actor = key ? actors.get(key) : undefined;
      (req as unknown as { actor: Actor }).actor = actor ? { ...actor } : { type: "none" };
      const sessionId = actor?.type === "board" ? sessions.get(actor.userId as string) : undefined;
      if (sessionId) (req as unknown as { verifiedCredential: unknown }).verifiedCredential = { kind: "session", sessionId, userId: actor!.userId };
      next();
    });
    app.use("/api", agentAccessScopeMiddleware(db));
    for (const router of [
      agentRoutes(db),
      agentAccessRoutes(db),
      agentPerformanceRoutes(db),
      agentProfileRoutes(db),
      agentBriefRoutes(db),
      issueResponsibilityRoutes(db),
      agentAccessEnforcementRoutes(db),
      issueRoutes(db, {} as never),
      // As app.ts mounts it: a decision wakes the requesting agent (the planner) and dispatches
      // that run (the fake adapter returns at once). Each step settles runs before it counts them.
      approvalRoutes(db),
      activityRoutes(db),
      evaluationRoutes(db),
      evaluationAgentRoutes(db),
      performanceManagerRoutes(db),
    ]) {
      app.use("/api", router);
    }
    app.use(errorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    // Let fire-and-forget wakes and fake-adapter runs settle before the database goes.
    if (seed) await quiesce("teardown").catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    unregisterServerAdapter(FAKE_ADAPTER);
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    await rm(home, { recursive: true, force: true });
  });

  async function send(
    actor: Actor,
    method: "get" | "post" | "patch" | "put",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Body; text: string; type: string }> {
    const key = randomUUID();
    actors.set(key, actor);
    try {
      let call = request(baseUrl)[method](path).set(ACTOR_HEADER, key);
      for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
      const res = await (body === undefined ? call : call.send(body as object));
      return { status: res.status, body: res.body, text: res.text, type: String(res.headers["content-type"] ?? "") };
    } finally {
      actors.delete(key);
    }
  }

  const decision = (approval: { revision: number }) => ({ revision: approval.revision, idempotencyKey: randomUUID(), channel: "web" });

  // -------------------------------------------------------------------------
  // Shared scenario state
  // -------------------------------------------------------------------------

  interface Seed {
    companyId: string;
    ownerUserId: string;
    accountableUserId: string;
    memberUserId: string;
    chief: { id: string; companyId: string };
    planner: { id: string; companyId: string };
    builder: { id: string; companyId: string };
    plannerKeyId: string;
    openEventId: string;
    hiddenEventId: string;
    privateEventId: string;
  }
  let seed: Seed | null = null;
  const state: {
    proposalApprovalId?: string;
    proposalRevisionId?: string;
    recommendationId?: string;
    briefIssueId?: string;
    /** The planner's heartbeat run woken by the submit: it checked the brief out, so the planner writes the brief's documents as that run. */
    plannerRunId?: string;
    unbound?: { profileId: string; revisionId: string; bodyHash: string };
    hire?: { approvalId: string; agentId: string };
    rejectedHire?: { approvalId: string; agentId: string; profileId: string; revisionId: string };
  } = {};

  function requireSeed(): Seed {
    expect(seed, "step 1 (seed) must have run").not.toBeNull();
    return seed!;
  }
  const owner = () => boardActor(requireSeed().companyId, requireSeed().ownerUserId, "owner");
  const accountable = () => boardActor(requireSeed().companyId, requireSeed().accountableUserId);
  const member = () => boardActor(requireSeed().companyId, requireSeed().memberUserId);
  const plannerActor = () => agentRequestActor(requireSeed().planner, { keyId: requireSeed().plannerKeyId });
  const chiefActor = () => agentRequestActor(requireSeed().chief);
  const builderActor = () => agentRequestActor(requireSeed().builder);
  const companyPath = () => `/api/companies/${requireSeed().companyId}`;
  const pmPath = () => `${companyPath()}/performance-manager`;
  const cardsPath = () => `${companyPath()}/evaluation/agents`;
  const cardPath = (agentId = requireSeed().builder.id) => `${cardsPath()}/${agentId}`;
  const recsPath = () => `${cardPath()}/recommendations`;
  const recordPath = () => `${companyPath()}/evaluation/performance-manager/record`;
  const builderProfilePath = () => `${companyPath()}/agents/${requireSeed().builder.id}/profile`;
  const draftsPath = () => `${companyPath()}/agent-profiles`;

  async function approvalRow(id: string) {
    return db.select().from(approvals).where(eq(approvals.id, id)).then((rows) => rows[0]!);
  }
  async function agentRow(id: string) {
    return db.select().from(agents).where(eq(agents.id, id)).then((rows) => rows[0]!);
  }

  /** Wakeup and heartbeat-run rows in the company (every wake writes a request row; every started heartbeat a run row). */
  async function wakeAndRunCounts() {
    const companyId = requireSeed().companyId;
    const [wakes, runs] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      db.select({ n: sql<number>`count(*)::int` }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
    ]);
    return { wakeups: wakes[0]!.n, runs: runs[0]!.n };
  }

  /** No run running and the wake/run counts unchanged for a beat: earlier fire-and-forget wakes have landed. */
  async function quiesce(label: string) {
    let last = await wakeAndRunCounts();
    let stableSince = Date.now();
    const live = () =>
      db
        .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, requireSeed().companyId), inArray(heartbeatRuns.status, ["queued", "running"])));
    try {
      await waitFor(`wakes and runs to settle (${label})`, async () => {
        const now = await wakeAndRunCounts();
        if (now.wakeups !== last.wakeups || now.runs !== last.runs || (await live()).length > 0) {
          last = now;
          stableSince = Date.now();
          return false;
        }
        return Date.now() - stableSince >= 750;
      });
    } catch (error) {
      throw new Error(`${(error as Error).message}; live runs: ${JSON.stringify(await live())}`);
    }
    return last;
  }

  function unboundBody(name: string, mutate: (body: AgentOperatingProfileV1) => void = () => {}): AgentOperatingProfileV1 {
    const body: AgentOperatingProfileV1 = {
      profileVersion: 1,
      identity: {
        name,
        title: name,
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
          escalation: { toUserId: requireSeed().ownerUserId, when: "The renewal data is missing" },
          performance: { criteria: [], coverage: [], outcomeLinks: [], expectedHumanSteps: [], judges: { automated: [] } },
        },
      ],
      knowledge: [],
      skills: [],
      access: parseAccessPolicy(DEFAULT_AGENT_GOVERNANCE_POLICY),
      rhythm: { timezone: "UTC", reportTo: {} },
      runtime: { adapterType: FAKE_ADAPTER, model: "fake-model-1" },
    };
    mutate(body);
    return body;
  }

  function manifest(scenarios: Array<Record<string, unknown>>) {
    const base = {
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
    };
    return { manifestVersion: 1, scenarios: scenarios.map((scenario) => ({ ...base, ...scenario })) };
  }

  // -------------------------------------------------------------------------
  // 0. Seed
  // -------------------------------------------------------------------------

  it("0. seeds a default-profile company: owner, accountable person, member; a Chief of Staff, a planner, and a Builder with an applied profile and a small ledger", async () => {
    const company = await addCompany(db, "Gate4-5 walkthrough", "default");
    const ownerUserId = await addUser(db, company.id, "owner");
    const accountableUserId = await addUser(db, company.id, "member");
    const memberUserId = await addUser(db, company.id, "member");
    for (const userId of [ownerUserId, accountableUserId, memberUserId]) {
      const sessionId = randomUUID();
      const at = new Date();
      await db.insert(authSessions).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(at.getTime() + DAY), createdAt: at, updatedAt: at });
      sessions.set(userId, sessionId);
    }
    const fake = { adapterType: FAKE_ADAPTER, adapterConfig: {} };
    const chief = await addAgent(db, company.id, { name: "Chief", role: "chief_of_staff", ...fake });
    // The planner may request hires (legacy canCreateAgents → agents:create for its own requests).
    const planner = await addAgent(db, company.id, { name: "Planner", role: "general", permissions: { canCreateAgents: true }, ...fake });
    const builder = await addAgent(db, company.id, { name: "Builder", accountableUserId, autonomy: "autonomous", ...fake });
    // The issue-mutation authority re-reads an agent key, so the planner has a real one.
    const [key] = await db.insert(agentApiKeys).values({ agentId: planner.id, companyId: company.id, name: "walkthrough", keyHash: `unused-${planner.id}` }).returning();

    const [openProject] = await db.insert(projects).values({ companyId: company.id, name: "Open work", status: "in_progress" }).returning();
    const [secretProject] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Secret work", status: "in_progress", visibility: "restricted", createdByUserId: ownerUserId })
      .returning();
    const [openIssue] = await db.insert(issues).values({ companyId: company.id, title: "Open item", status: "done", projectId: openProject!.id, assigneeAgentId: builder.id }).returning();
    const [hiddenIssue] = await db.insert(issues).values({ companyId: company.id, title: "Secret item", status: "done", projectId: secretProject!.id, assigneeAgentId: builder.id }).returning();
    const { revisionId } = await seedActiveProfile(db, {
      companyId: company.id,
      agentId: builder.id,
      body: { ...profileBody([responsibility("work")]), access: parseAccessPolicy(DEFAULT_AGENT_GOVERNANCE_POLICY) },
    });

    // The Builder's ledger, two days back: its contract, one open and one restricted-project item, and a private correction.
    const t0 = Date.now() - 2 * DAY;
    const at = (h: number) => new Date(t0 + h * HOUR);
    const companyId = company.id;
    const ledger = evaluationLedger(db);
    const contract = {
      contractVersion: "v2",
      companyId,
      subjectRef: { kind: "agent", id: builder.id },
      accountableUserId,
      profileRevisionId: revisionId,
      independenceRule: "independence/v1",
      responsibilities: [
        {
          key: "work",
          criteria: [{ id: "c1", text: "Delivered", check: { kind: "record", record: "deliverable.shipped" }, source: "human" }],
          coverage: [],
          outcomeLinks: [],
          expectedHumanSteps: [],
          judges: { automated: [] },
        },
      ],
    };
    const issueEvents = (issueId: string, projectId: string, identifier: string, accessClass: "company" | `project:${string}`) => {
      const base = { companyId, projectId, accessClass, subjectAgentId: builder.id };
      const pl = (extra: Record<string, unknown>) => ({ issueId, identifier, ...extra });
      return [
        { ...base, actorType: "system" as const, sourceTable: "issues", sourceId: issueId, sourceVersion: "s1", eventType: "issue.snapshot", eventTime: at(2), payload: pl({ status: "todo", projectId, assigneeAgentId: builder.id, labels: [], titleTokens: [] }) },
        { ...base, actorType: "agent" as const, actorId: builder.id, sourceTable: "activity_log", sourceId: `${issueId}:t1`, sourceVersion: "1", eventType: "issue.transition", eventTime: at(3), payload: pl({ from: "todo", to: "in_progress" }) },
        { ...base, actorType: "agent" as const, actorId: builder.id, sourceTable: "activity_log", sourceId: `${issueId}:t2`, sourceVersion: "1", eventType: "issue.transition", eventTime: at(6), payload: pl({ from: "in_progress", to: "done" }) },
        { ...base, actorType: "user" as const, actorId: ownerUserId, sourceTable: "issue_responsibilities", sourceId: `${issueId}:m`, sourceVersion: "open", eventType: "responsibility.interval", eventTime: at(2), payload: { mappingId: randomUUID(), issueId, identifier, agentId: builder.id, responsibilityKey: "work", profileRevisionId: revisionId, validFrom: at(2).toISOString(), validTo: null, mappedBy: "human" } },
      ];
    };
    await ledger.append([
      { companyId, actorType: "user", actorId: accountableUserId, sourceTable: "evaluation_contracts", sourceId: `agent:${builder.id}`, sourceVersion: `revision:${revisionId}`, eventType: "contract.declared", eventTime: at(0), payload: { contract, companyId } },
    ]);
    await ledger.append([
      { companyId, actorType: "system", sourceTable: "agents", sourceId: builder.id, sourceVersion: "a1", eventType: "agent.snapshot", eventTime: at(0), payload: { agentId: builder.id, name: "Builder", accountableUserId, status: "idle" } },
      { companyId, actorType: "system", subjectAgentId: builder.id, sourceTable: "agent_profile_revisions", sourceId: revisionId, sourceVersion: "applied", eventType: "profile.revision_changed", eventTime: at(1), payload: { revisionId, agentId: builder.id, state: "applied", responsibilities: [{ key: "work", obligation: { kind: "assigned" }, deadline: null }] } },
      ...issueEvents(openIssue!.id, openProject!.id, "WALK-1", "company"),
      ...issueEvents(hiddenIssue!.id, secretProject!.id, "WALK-2", `project:${secretProject!.id}`),
      { companyId, actorType: "user", actorId: accountableUserId, subjectAgentId: builder.id, sourceTable: "agent_corrections", sourceId: "corr-1", sourceVersion: "1", eventType: "correction.recorded", eventTime: at(7), accessClass: `private_agent:${builder.id}`, payload: { agentId: builder.id, kind: "correction" } },
    ]);
    const idOf = async (table: string, sourceId: string) => (await ledger.findBySource(companyId, table, sourceId, "1"))!.id;

    const ref = (agent: { id: string }) => ({ id: agent.id, companyId });
    seed = {
      companyId,
      ownerUserId,
      accountableUserId,
      memberUserId,
      chief: ref(chief),
      planner: ref(planner),
      builder: ref(builder),
      plannerKeyId: key!.id,
      openEventId: await idOf("activity_log", `${openIssue!.id}:t1`),
      hiddenEventId: await idOf("activity_log", `${hiddenIssue!.id}:t1`),
      privateEventId: await idOf("agent_corrections", "corr-1"),
    };
  });

  // -------------------------------------------------------------------------
  // 1. Designation
  // -------------------------------------------------------------------------

  it("1. the performance manager defaults to the Chief of Staff; only an admin designates another, with activity; the flag follows it", async () => {
    const s = requireSeed();
    const unset = await send(member(), "get", pmPath());
    expect(unset.status, JSON.stringify(unset.body)).toBe(200);
    expect(unset.body).toMatchObject({ designatedAgentId: null, source: "chief_of_staff", effective: { agentId: s.chief.id, role: "chief_of_staff" }, viewer: { canChange: false } });
    expect((await send(chiefActor(), "get", "/api/agents/me/profile")).body.performanceManager).toBe(true);

    // A member, the Chief of Staff and the planner itself cannot designate.
    for (const actor of [member(), accountable(), chiefActor(), plannerActor()]) {
      expect((await send(actor, "patch", pmPath(), { agentId: s.planner.id })).status).toBe(403);
    }
    expect(await activityRows(db, s.companyId, "company.performance_manager_changed")).toHaveLength(0);

    const set = await send(owner(), "patch", pmPath(), { agentId: s.planner.id });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ designatedAgentId: s.planner.id, source: "designated", effective: { agentId: s.planner.id }, changed: true, previousDesignatedAgentId: null });
    const [changed] = await activityRows(db, s.companyId, "company.performance_manager_changed");
    expect(changed).toMatchObject({ actorType: "user", actorId: s.ownerUserId, entityType: "company", entityId: s.companyId });
    expect(changed!.details).toMatchObject({ from: null, to: s.planner.id, effectiveFrom: s.chief.id, effectiveTo: s.planner.id });

    // The designation decides, not the role.
    expect((await send(plannerActor(), "get", "/api/agents/me/profile")).body.performanceManager).toBe(true);
    expect((await send(chiefActor(), "get", "/api/agents/me/profile")).body.performanceManager).toBe(false);
    expect((await send(member(), "get", pmPath())).body).toMatchObject({ source: "designated", effective: { agentId: s.planner.id } });
  });

  // -------------------------------------------------------------------------
  // 2. Card read, proposal, recommendation
  // -------------------------------------------------------------------------

  it("2. the manager reads the card through its own projection, files a proposal with evidence and a pause recommendation; it decides neither; the owner decides the recommendation and nothing is paused", async () => {
    const s = requireSeed();
    // A stored card (version 1) to cite.
    const snap = await send(owner(), "post", `${cardPath()}/snapshot`, {});
    expect(snap.status, JSON.stringify(snap.body)).toBe(201);
    expect(snap.body.snapshot.version).toBe(1);

    // Per-viewer limits: the owner sees both items, the manager (an agent principal without project access) only the open one.
    const owed = (card: AgentCardView) =>
      card.worker.obligations.visibility === "not_visible" ? "not_visible" : card.worker.obligations.body.responsibilities.reduce((n, r) => n + (r.owed ?? 0), 0);
    const asOwner = await send(owner(), "get", cardPath());
    expect(asOwner.status, JSON.stringify(asOwner.body)).toBe(200);
    expect(owed(asOwner.body.card)).toBe(2);
    const asManager = await send(plannerActor(), "get", cardPath());
    expect(asManager.status, JSON.stringify(asManager.body)).toBe(200);
    expect(asManager.body.card.restricted).toBe(true);
    expect(owed(asManager.body.card)).toBe(1);
    expect(asManager.body.viewer).toEqual({ canSnapshot: false, canNoteDisagreement: false, canConfirmUse: false, attestableCriteria: [] });
    const cases = await send(plannerActor(), "get", `${cardPath()}/cases?section=obligations`);
    expect(cases.status).toBe(200);
    expect(JSON.stringify(cases.body)).toContain("WALK-1");
    expect(JSON.stringify(cases.body)).not.toContain("WALK-2");
    expect((await send(plannerActor(), "get", cardsPath())).status).toBe(200);
    // Every other agent principal is refused, the Chief of Staff included now that someone else is designated.
    for (const actor of [chiefActor(), builderActor()]) {
      expect((await send(actor, "get", cardPath())).status).toBe(403);
    }
    // People-only card actions stay people-only.
    expect((await send(plannerActor(), "post", `${cardPath()}/snapshot`, {})).status).toBe(403);

    // A profile proposal through the gate 2 path, with cited evidence.
    const created = await send(plannerActor(), "post", `${builderProfilePath()}/revisions`, {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const body = structuredClone(created.body.body) as AgentOperatingProfileV1;
    body.identity.audience = "Operations leads";
    const saved = await send(plannerActor(), "patch", `${builderProfilePath()}/revisions/${created.body.id}`, { body }, { "If-Match": created.body.bodyHash });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const proposed = await send(plannerActor(), "post", `${builderProfilePath()}/revisions/${created.body.id}/propose`, {
      reason: "The work is read by operations",
      evidence: { cardVersion: 1, ledgerEventIds: [s.openEventId] },
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    expect(proposed.body.payload.proposedBy).toEqual({ kind: "agent", agentId: s.planner.id, runId: null, capacity: "performance_manager" });
    expect(proposed.body.payload.evidence).toEqual({ cardId: null, cardVersion: 1, ledgerEventIds: [s.openEventId] });
    state.proposalApprovalId = proposed.body.approvalId;
    state.proposalRevisionId = created.body.id;

    // The pause recommendation: only the manager files it, and its evidence must be something it can read.
    const rec = {
      kind: "pause",
      reason: "The open item needed a correction; pause until the check is in place",
      evidence: [{ kind: "card", ref: "1" }, { kind: "event", ref: s.openEventId }],
      proposalApprovalId: state.proposalApprovalId,
    };
    for (const actor of [owner(), chiefActor(), builderActor()]) {
      expect((await send(actor, "post", recsPath(), rec)).status).toBe(403);
    }
    for (const evidence of [[{ kind: "event", ref: s.privateEventId }], [{ kind: "event", ref: s.hiddenEventId }]]) {
      const unreadable = await send(plannerActor(), "post", recsPath(), { ...rec, evidence });
      expect(unreadable.status, JSON.stringify(unreadable.body)).toBe(422);
      expect(unreadable.body.details.code).toBe("AGENT_RECOMMENDATION_EVIDENCE_INVALID");
    }
    const filed = await send(plannerActor(), "post", recsPath(), rec);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect(filed.body).toMatchObject({ agentId: s.builder.id, kind: "pause", recommendedByAgentId: s.planner.id, advisory: true, decision: null });
    state.recommendationId = filed.body.id;

    // The manager decides neither its proposal nor its recommendation.
    const approval = await approvalRow(state.proposalApprovalId!);
    expect(approval).toMatchObject({ type: "agent_profile_change", status: "pending", requestedByAgentId: s.planner.id });
    expect((await send(plannerActor(), "post", `/api/approvals/${approval.id}/approve`, decision(approval))).status).toBe(403);
    expect((await send(plannerActor(), "post", `/api/approvals/${approval.id}/reject`, decision(approval))).status).toBe(403);
    const decisionPath = `${recsPath()}/${state.recommendationId}/decision`;
    expect((await send(plannerActor(), "post", decisionPath, { decision: "accepted" })).status).toBe(403);
    expect((await send(member(), "post", decisionPath, { decision: "accepted" })).status).toBe(403);
    expect((await send(plannerActor(), "get", recsPath())).body.viewer).toEqual({ canDecide: false });
    expect((await send(owner(), "get", recsPath())).body.viewer).toEqual({ canDecide: true });
    expect((await approvalRow(approval.id)).status).toBe("pending");

    // The owner decides the recommendation. Accepting a pause pauses nothing.
    const decided = await send(owner(), "post", decisionPath, { decision: "accepted", note: "Agreed; I'll pause it myself if the check slips" });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body).toMatchObject({ effect: "none", recommendation: { decision: { decision: "accepted", decidedByUserId: s.ownerUserId } } });
    expect(decided.body.next).toContain("Nothing was paused");
    expect((await send(owner(), "post", decisionPath, { decision: "declined" })).status).toBe(409);
    const builderNow = await agentRow(s.builder.id);
    expect(builderNow.status).not.toBe("paused");
    expect(builderNow.pausedAt).toBeNull();

    // The proposal is a person's decision: the owner approves it and it applies through the gate 2 path.
    const approved = await send(owner(), "post", `/api/approvals/${approval.id}/approve`, decision(approval));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const application = await waitFor("the proposal's application", () =>
      db
        .select()
        .from(agentProfileApplications)
        .where(eq(agentProfileApplications.approvalId, approval.id))
        .then((rows) => (rows[0]?.status === "applied" ? rows[0] : null)),
    );
    expect(application).toMatchObject({ agentId: s.builder.id, revisionId: state.proposalRevisionId, approverUserId: s.ownerUserId });
    expect((await agentRow(s.builder.id)).status).not.toBe("paused");
  });

  // -------------------------------------------------------------------------
  // 3. The manager's record
  // -------------------------------------------------------------------------

  it("3. the manager's record shows the proposal's outcome and the recommendation with its decision, descriptively", async () => {
    const s = requireSeed();
    // The first card stored after the application, so the record can show before and after.
    const after = await send(owner(), "post", `${cardPath()}/snapshot`, {});
    expect([200, 201]).toContain(after.status);

    const record = await send(owner(), "get", recordPath());
    expect(record.status, JSON.stringify(record.body)).toBe(200);
    expect(record.body).toMatchObject({ kind: "performance_manager_record", managerAgentId: s.planner.id, isEffectiveManager: true });
    expect(record.body.proposals).toMatchObject({ filed: 1, pending: 0, approved: 1, rejected: 0, withdrawn: 0, applied: 1 });
    expect(record.body.proposals.items.map((item: Body) => item.outcome)).toEqual(["applied"]);
    expect(record.body.recommendations.total).toBe(1);
    expect(record.body.recommendations.byKind.pause).toEqual({ total: 1, accepted: 1, declined: 0, undecided: 0 });
    expect(record.body.recommendations.items).toEqual([
      { id: state.recommendationId, agentId: s.builder.id, agentName: "Builder", kind: "pause", at: expect.any(String), decision: "accepted", decidedAt: expect.any(String) },
    ]);
    expect(record.body.applied).toHaveLength(1);
    expect(record.body.applied[0]).toMatchObject({ approvalId: state.proposalApprovalId, agentId: s.builder.id, before: { version: 1 } });
    expect(record.body.note).toContain("does not say the change caused");
    expect(JSON.stringify(record.body)).not.toMatch(/"score"/);

    // The manager reads its own record; another agent cannot.
    expect((await send(plannerActor(), "get", recordPath())).status).toBe(200);
    expect((await send(builderActor(), "get", recordPath())).status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 4. The brief
  // -------------------------------------------------------------------------

  it("4. a pasted brief is saved and edited without a wake (no wakeup or run rows); submitting assigns the planner with the normal wake", async () => {
    const s = requireSeed();
    const before = await quiesce("before the brief");

    const created = await send(owner(), "post", `${companyPath()}/agent-briefs`, { title: "Renewals brief", markdown: BRIEF });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ kind: "agent_brief", status: "backlog", assigneeAgentId: null, document: { key: "agent-work-brief", latestRevisionNumber: 1 } });
    const issueId = created.body.issueId as string;
    state.briefIssueId = issueId;
    const edited = await send(owner(), "put", `/api/issues/${issueId}/documents/agent-work-brief`, {
      format: "markdown",
      body: `${BRIEF}\nRestrictions: renewal pricing stays human-owned.\n`,
      baseRevisionId: created.body.document.latestRevisionId,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.latestRevisionNumber).toBe(2);
    const unsent = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(unsent).toMatchObject({ status: "backlog", assigneeAgentId: null, assigneeUserId: null, originKind: "agent_work_brief" });
    expect(await quiesce("after saving the brief")).toEqual(before);

    const submitted = await send(owner(), "post", `${companyPath()}/agent-briefs/${issueId}/submit`, {});
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body).toMatchObject({ status: "todo", assigneeAgentId: s.planner.id });
    // The ordinary assignment wake for the planner, and its (fake-adapter) run.
    const wake = await waitFor("the planner's assignment wake", () =>
      db
        .select()
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, s.planner.id), sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`))
        .then((rows) => rows[0] ?? null),
    );
    expect(wake).toMatchObject({ source: "assignment", reason: "issue_assigned" });
    const run = await waitFor("the planner's run", () =>
      db
        .select()
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`)
        .then((rows) => (rows[0] && !["queued", "running"].includes(rows[0].status) ? rows[0] : null)),
    );
    expect(run.agentId).toBe(s.planner.id);
    state.plannerRunId = run.id;
    const [submittedRow] = await activityRows(db, s.companyId, "agent_brief.submitted");
    expect(submittedRow!.details).toMatchObject({ performanceManagerAgentId: s.planner.id, briefRevisionNumber: 2 });
    // Nobody but the planner was woken by the brief.
    const briefWakes = await db
      .select({ agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`);
    expect(new Set(briefWakes.map((row) => row.agentId))).toEqual(new Set([s.planner.id]));
  });

  // -------------------------------------------------------------------------
  // 5. The planner's manifest and unbound draft
  // -------------------------------------------------------------------------

  it("5. the planner writes an unbound draft and a validated scenario manifest (an invalid one is 422); the draft exports as Markdown; no wake", async () => {
    const s = requireSeed();
    const issueId = state.briefIssueId!;
    expect(issueId, "step 4 must have created the brief").toBeTruthy();
    await quiesce("before the planner writes");
    const before = await wakeAndRunCounts();
    // The planner works the brief as its run (the submit's wake checked the issue out to that run).
    const briefIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(briefIssue).toMatchObject({ assigneeAgentId: s.planner.id });
    const plannerInRun = agentRequestActor(s.planner, { keyId: s.plannerKeyId, runId: state.plannerRunId });
    const putManifest = (text: string, baseRevisionId: string | null) =>
      send(plannerInRun, "put", `/api/issues/${issueId}/documents/scenario-manifest`, { format: "markdown", body: text, baseRevisionId });

    // Invalid: a reuse recommendation with no target agent, and an unbound draft that doesn't exist.
    const invalid = await putManifest(JSON.stringify(manifest([{ key: "s01", title: "Weekly renewal digest", recommendation: "reuse", reason: "x" }])), null);
    expect(invalid.status, JSON.stringify(invalid.body)).toBe(422);
    expect(invalid.body.details.code).toBe("AGENT_SCENARIO_MANIFEST_INVALID");
    expect(invalid.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "scenarios.0.targetAgentId" })]));
    const unknownDraft = await putManifest(
      JSON.stringify(manifest([{ key: "s01", title: "Weekly renewal digest", recommendation: "new_role", unboundProfileId: randomUUID(), reason: "x" }])),
      null,
    );
    expect(unknownDraft.status).toBe(422);
    expect(unknownDraft.body.details.issues[0].path).toBe("scenarios.0.unboundProfileId");

    // The unbound draft for the new role.
    const draft = await send(plannerActor(), "post", draftsPath(), { body: unboundBody("Renewals Analyst"), sourceRefs: [{ kind: "brief", id: issueId }] });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({ agentId: null, state: "draft", revisionNumber: 1, createdByAgentId: s.planner.id });
    state.unbound = { profileId: draft.body.profileId, revisionId: draft.body.id, bodyHash: draft.body.bodyHash };

    // The valid manifest: S01 is a new role (the draft), S02 stays with the Builder.
    const valid = await putManifest(
      JSON.stringify(
        manifest([
          { key: "s01", title: "Weekly renewal digest", recommendation: "new_role", unboundProfileId: state.unbound.profileId, reason: "No agent reads the renewals export today" },
          { key: "s02", title: "Delivery status notes", recommendation: "reuse", targetAgentId: s.builder.id, reason: "The Builder already writes these" },
        ]),
      ),
      null,
    );
    expect(valid.status, JSON.stringify(valid.body)).toBe(201);
    expect(valid.body).toMatchObject({ key: "scenario-manifest", latestRevisionNumber: 1 });

    // The draft as Markdown (gap fix: unbound drafts export like bound ones); readers only.
    const exported = await send(owner(), "get", `${draftsPath()}/${state.unbound.profileId}/revisions/${state.unbound.revisionId}/export.md`);
    expect(exported.status, exported.text).toBe(200);
    expect(exported.type).toContain("text/markdown");
    expect(exported.text).toContain("# Operating profile: Renewals Analyst");
    expect(exported.text).toContain("Revision 1 · draft");
    expect(exported.text).toContain("### Weekly renewal digest (`renewal-digest`)");
    expect((await send(plannerActor(), "get", `${draftsPath()}/${state.unbound.profileId}/revisions/${state.unbound.revisionId}/export.md`)).status).toBe(200);
    expect((await send(builderActor(), "get", `${draftsPath()}/${state.unbound.profileId}/revisions/${state.unbound.revisionId}/export.md`)).status).toBe(403);
    expect((await send(owner(), "get", `${draftsPath()}/${state.unbound.profileId}/revisions/${randomUUID()}/export.md`)).status).toBe(404);

    // Writing the manifest and the draft woke no one and hired no one.
    expect(await quiesce("after the planner writes")).toEqual(before);
    expect((await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, s.companyId))).length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 6. Hire from the unbound draft
  // -------------------------------------------------------------------------

  it("6. the planner proposes the draft as a hire: hire_agent filed, the pending agent can't run; an admin approves: agent active, profile bound, receipt applied; a second hire rejected ends its pending agent", async () => {
    const s = requireSeed();
    const draft = state.unbound!;
    expect(draft, "step 5 must have created the unbound draft").toBeTruthy();
    const draftPath = `${draftsPath()}/${draft.profileId}`;

    const proposed = await send(plannerActor(), "post", `${draftPath}/revisions/${draft.revisionId}/propose`, {
      role: "researcher",
      reason: "Scenario S01 needs a new role",
      sourceIssueId: state.briefIssueId,
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const approvalId = proposed.body.approvalId as string;
    const agentId = proposed.body.agentId as string;
    state.hire = { approvalId, agentId };
    const approval = await approvalRow(approvalId);
    expect(approval).toMatchObject({ type: "hire_agent", status: "pending", requestedByAgentId: s.planner.id });
    expect(approval.payload).toMatchObject({
      agentId,
      profileId: draft.profileId,
      profileRevisionId: draft.revisionId,
      profileChange: { agentId, revisionId: draft.revisionId, proposedBy: { kind: "agent", agentId: s.planner.id, capacity: "performance_manager" } },
    });

    // Filed, not hired: the agent waits for approval and cannot run.
    expect(await agentRow(agentId)).toMatchObject({ status: "pending_approval", name: "Renewals Analyst", role: "researcher", adapterType: FAKE_ADAPTER });
    const wake = await send(owner(), "post", `/api/agents/${agentId}/wakeup`, { source: "on_demand", reason: "walkthrough: try to run a pending hire" });
    expect(wake.status, JSON.stringify(wake.body)).toBe(409);
    expect((await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).length).toBe(0);
    const [unboundRow] = await db.select().from(agentProfiles).where(eq(agentProfiles.id, draft.profileId));
    expect(unboundRow!.agentId).toBeNull();

    // The manager can never decide its own hire.
    expect((await send(plannerActor(), "post", `/api/approvals/${approvalId}/approve`, decision(approval))).status).toBe(403);
    expect((await send(plannerActor(), "post", `/api/approvals/${approvalId}/reject`, decision(approval))).status).toBe(403);

    // An admin approves: the agent is activated, the profile bound and applied, the receipt recorded.
    const approved = await send(owner(), "post", `/api/approvals/${approvalId}/approve`, decision(await approvalRow(approvalId)));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const hired = await agentRow(agentId);
    expect(hired.status).toBe("idle");
    expect((hired.adapterConfig as Record<string, unknown>).model).toBe("fake-model-1");
    const [bound] = await db.select().from(agentProfiles).where(eq(agentProfiles.id, draft.profileId));
    expect(bound).toMatchObject({ agentId, activeRevisionId: draft.revisionId });
    const receipts = await send(owner(), "get", `${companyPath()}/agents/${agentId}/profile/applications`);
    expect(receipts.status, JSON.stringify(receipts.body)).toBe(200);
    expect(receipts.body).toEqual([expect.objectContaining({ approvalId, revisionId: draft.revisionId, status: "applied", approverUserId: s.ownerUserId })]);
    const profile = await send(owner(), "get", `${companyPath()}/agents/${agentId}/profile`);
    expect(profile.body).toMatchObject({ profileId: draft.profileId, active: { id: draft.revisionId, state: "applied" }, latestApplication: { status: "applied" } });
    expect((await activityRows(db, s.companyId, "agent_profile.bound"))[0]).toMatchObject({ entityId: draft.profileId, agentId });

    // A second hire, rejected: the pending agent is ended and the revision rejected; nothing is applied.
    const second = await send(plannerActor(), "post", draftsPath(), { body: unboundBody("Collections Analyst"), sourceRefs: [{ kind: "brief", id: state.briefIssueId }] });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const secondPath = `${draftsPath()}/${second.body.profileId}`;
    const secondProposed = await send(plannerActor(), "post", `${secondPath}/revisions/${second.body.id}/propose`, { role: "general" });
    expect(secondProposed.status, JSON.stringify(secondProposed.body)).toBe(201);
    state.rejectedHire = { approvalId: secondProposed.body.approvalId, agentId: secondProposed.body.agentId, profileId: second.body.profileId, revisionId: second.body.id };
    expect((await agentRow(state.rejectedHire.agentId)).status).toBe("pending_approval");
    const rejected = await send(owner(), "post", `/api/approvals/${state.rejectedHire.approvalId}/reject`, decision(await approvalRow(state.rejectedHire.approvalId)));
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await agentRow(state.rejectedHire.agentId)).status).toBe("terminated");
    const rejectedRevision = await send(owner(), "get", `${secondPath}/revisions/${second.body.id}`);
    expect(rejectedRevision.body).toMatchObject({ state: "rejected", agentId: null });
    const [stillUnbound] = await db.select().from(agentProfiles).where(eq(agentProfiles.id, second.body.profileId));
    expect(stillUnbound!.agentId).toBeNull();
    expect(await db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, state.rejectedHire.approvalId))).toEqual([]);
    expect((await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, state.rejectedHire.agentId))).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 7. Previewing and saving drafts
  // -------------------------------------------------------------------------

  it("7. previewing and saving drafts — unbound and bound — never creates a wakeup, a run, an agent or an approval", async () => {
    const s = requireSeed();
    const rejected = state.rejectedHire!;
    expect(rejected, "step 6 must have rejected a hire").toBeTruthy();
    await quiesce("before previews and saves");
    const counts = async () => ({
      ...(await wakeAndRunCounts()),
      agents: (await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, s.companyId))).length,
      approvals: (await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.companyId, s.companyId))).length,
    });
    const before = await counts();

    // An unbound draft by the owner: create, preview (view, revision, diff, export), save.
    const created = await send(owner(), "post", draftsPath(), { body: unboundBody("Support Triage") });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const path = `${draftsPath()}/${created.body.profileId}`;
    expect((await send(owner(), "get", path)).status).toBe(200);
    expect((await send(owner(), "get", `${path}/revisions/${created.body.id}`)).status).toBe(200);
    expect((await send(owner(), "get", `${path}/revisions/${created.body.id}/diff`)).status).toBe(200);
    expect((await send(owner(), "get", `${path}/revisions/${created.body.id}/export.md`)).status).toBe(200);
    const edited = unboundBody("Support Triage", (body) => (body.identity.summary = "Triages support tickets"));
    const saved = await send(owner(), "patch", `${path}/revisions/${created.body.id}`, { body: edited }, { "If-Match": created.body.bodyHash });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // A new draft after the rejected hire, saved by the planner.
    const next = await send(plannerActor(), "post", `${draftsPath()}/${rejected.profileId}/revisions`, {});
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body).toMatchObject({ revisionNumber: 2, state: "draft", agentId: null });
    const nextBody = structuredClone(next.body.body) as AgentOperatingProfileV1;
    nextBody.identity.summary = "Chases overdue renewals";
    expect((await send(plannerActor(), "patch", `${draftsPath()}/${rejected.profileId}/revisions/${next.body.id}`, { body: nextBody }, { "If-Match": next.body.bodyHash })).status).toBe(200);

    // A bound draft for the Builder by the manager: create, preview, save.
    const bound = await send(plannerActor(), "post", `${builderProfilePath()}/revisions`, {});
    expect(bound.status, JSON.stringify(bound.body)).toBe(201);
    expect((await send(owner(), "get", `${builderProfilePath()}/revisions/${bound.body.id}/diff`)).status).toBe(200);
    expect((await send(owner(), "get", `${builderProfilePath()}/revisions/${bound.body.id}/export.md`)).status).toBe(200);
    expect((await send(owner(), "get", builderProfilePath())).status).toBe(200);
    const boundBody = structuredClone(bound.body.body) as AgentOperatingProfileV1;
    boundBody.identity.summary = "Builds and ships the work, with a check.";
    expect((await send(plannerActor(), "patch", `${builderProfilePath()}/revisions/${bound.body.id}`, { body: boundBody }, { "If-Match": bound.body.bodyHash })).status).toBe(200);

    await quiesce("after previews and saves");
    expect(await counts()).toEqual(before);
    // The drafts are drafts.
    const states = await db
      .select({ id: agentProfileRevisions.id, state: agentProfileRevisions.state })
      .from(agentProfileRevisions)
      .where(sql`${agentProfileRevisions.id} in (${created.body.id}, ${next.body.id}, ${bound.body.id})`);
    expect(states.map((row) => row.state)).toEqual(["draft", "draft", "draft"]);
  });

  it("leaves no application in progress and the runs settled", async () => {
    const s = requireSeed();
    await quiesce("at the end");
    const unfinished = await db
      .select({ id: agentProfileApplications.id, status: agentProfileApplications.status })
      .from(agentProfileApplications)
      .where(and(eq(agentProfileApplications.companyId, s.companyId), sql`${agentProfileApplications.status} not in ('applied')`));
    expect(unfinished).toEqual([]);
  });
});
