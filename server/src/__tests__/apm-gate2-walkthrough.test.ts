// AgentDash: Agent Performance Management gate 2 (P2.7) — the gate 2 exit
// walkthrough. One non-MK ("default" profile) company is driven through the
// whole loop over the real HTTP routes: draft → save → propose → approve →
// serialized application → contract → responsibility mapping → AGENTS.md
// block (delivered, then evidenced at run start) → V2 access in shadow mode.
//
// The routers are the production route factories, mounted the way app.ts
// mounts them, behind the same actor-injection shim every route suite in this
// directory uses (the real auth middleware needs sessions and API keys). The
// database is embedded Postgres with every migration applied. No APM service
// is mocked.
//
// Nothing external runs. The agents use an in-process fake adapter registered
// for this file only: it declares `supportsInstructionsBundle` so the managed
// AGENTS.md is materialized under a temporary PAPERCLIP_HOME, and its
// `execute` returns at once. No adapter process, model call or network call
// is made.
//
// The tests are one ordered scenario that shares state. Each step checks that
// the step before it left what it needs, so a failure names the first broken
// step instead of cascading silently.
//
// Gate 2 exit conditions (doc/plans/2026-10-29-apm-gate2-build-spec.md), and
// the steps that prove them:
//   E1 draft, save, propose and approve a profile revision ........ steps 2–5
//   E2 application serialized, stale-checked, resumable, every
//      applied step recorded ......................................... steps 6–7
//   E3 the agent's contract is declared for the evaluator ............ step 6
//   E4 work can be mapped to responsibilities ........................ step 8
//   E5 the AGENTS.md profile block is delivered, and its delivery is
//      evidenced at run start ........................................ step 6
//   E6 V2 access rules run in shadow mode and refuse nothing (gate 3
//      made enforce selectable; that is not walked here) .............. step 9
// Plus: gate 1 views still work (step 10) and MK is unchanged (step 11).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agentConfigRevisions,
  agentGovernancePolicies,
  agentProfileApplications,
  agentProfileRevisions,
  agentProfiles,
  agentWakeupRequests,
  agents,
  approvals,
  assistantConversations,
  assistantMessages,
  createDb,
  evaluationEvents,
  heartbeatRuns,
  issues,
  projects,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import type { AgentOperatingProfileV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser, agentRequestActor, boardActor, seedProfileCompany, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { activityRows, wouldRefuseRows } from "./helpers/agent-access-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";
import { resetRunLogStoreForTests } from "../services/run-log-store.js";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { activityRoutes } from "../routes/activity.js";
import { agentAccessEnforcementRoutes } from "../routes/agent-access-enforcement.js";
import { agentAccessRoutes } from "../routes/agent-access.js";
import { agentPerformanceRoutes } from "../routes/agent-performance.js";
import { agentProfileRoutes } from "../routes/agent-profiles.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { evaluationRoutes } from "../routes/evaluation.js";
import { issueResponsibilityRoutes } from "../routes/issue-responsibilities.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FAKE_ADAPTER = "apm_gate2_walkthrough_fake";
const ALL_VIA = ["assign", "comment_wake", "mention", "handoff"] as const;
const ACTOR_HEADER = "x-walkthrough-actor";

type Actor = Record<string, unknown>;
type Body = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function waitFor<T>(label: string, read: () => Promise<T | null | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeEmbeddedPostgres("APM gate 2 exit walkthrough (P2.7)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  let server: ReturnType<typeof createServer> | null = null;
  let baseUrl = "";
  const savedEnv: Record<string, string | undefined> = {};
  const actors = new Map<string, Actor>();

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY", "RUN_LOG_BASE_PATH"]) {
      savedEnv[key] = process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), "apm-gate2-walkthrough-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "apm-gate2-walkthrough";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "f".repeat(64);
    process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apm-gate2-walkthrough-");
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

    // The production route factories, mounted as app.ts mounts them.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const key = req.header(ACTOR_HEADER);
      const actor = key ? actors.get(key) : undefined;
      (req as unknown as { actor: Actor }).actor = actor ? { ...actor } : { type: "none" };
      next();
    });
    for (const router of [
      agentRoutes(db),
      agentAccessRoutes(db),
      agentPerformanceRoutes(db),
      agentProfileRoutes(db),
      issueResponsibilityRoutes(db),
      agentAccessEnforcementRoutes(db),
      issueRoutes(db, {} as never),
      // Approval decisions wake the requesting agent; never dispatch a run from here.
      approvalRoutes(db, { autoDispatchQueuedRuns: false }),
      activityRoutes(db),
      evaluationRoutes(db),
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
  ): Promise<{ status: number; body: Body; text: string }> {
    const key = randomUUID();
    actors.set(key, actor);
    try {
      let call = request(baseUrl)[method](path).set(ACTOR_HEADER, key);
      for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
      const res = await (body === undefined ? call : call.send(body as object));
      return { status: res.status, body: res.body, text: res.text };
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
    stewardUserId: string;
    outsiderUserId: string;
    analyst: { id: string; companyId: string };
    peer: { id: string };
    stranger: { id: string };
    routineId: string;
    triggerId: string;
    issueId: string;
    projectId: string;
    analystKeyId: string;
  }
  let seed: Seed | null = null;
  const state: {
    firstRevisionId?: string;
    firstApprovalId?: string;
    activeRevisionId?: string;
    milestoneBefore?: { contract: unknown; eventCount: number; contractEventId: string | null };
  } = {};

  function requireSeed(): Seed {
    expect(seed, "step 1 (seed) must have run").not.toBeNull();
    return seed!;
  }
  const owner = () => boardActor(requireSeed().companyId, requireSeed().ownerUserId, "owner");
  const steward = () => boardActor(requireSeed().companyId, requireSeed().stewardUserId);
  const outsider = () => boardActor(requireSeed().companyId, requireSeed().outsiderUserId);
  const analystActor = () => agentRequestActor(requireSeed().analyst, { keyId: requireSeed().analystKeyId });
  const profilePath = () => `/api/companies/${requireSeed().companyId}/agents/${requireSeed().analyst.id}/profile`;

  async function approvalRow(id: string) {
    return db.select().from(approvals).where(eq(approvals.id, id)).then((rows) => rows[0]!);
  }

  async function applicationFor(approvalId: string) {
    return db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, approvalId)).then((rows) => rows[0] ?? null);
  }

  async function activeRevisionIdNow() {
    const s = requireSeed();
    return db
      .select({ id: agentProfiles.activeRevisionId })
      .from(agentProfiles)
      .where(and(eq(agentProfiles.companyId, s.companyId), eq(agentProfiles.agentId, s.analyst.id)))
      .then((rows) => rows[0]?.id ?? null);
  }

  /** Create a draft from the active revision, save `mutate` with If-Match, propose. All over HTTP. */
  async function draftAndPropose(actor: Actor, mutate: (body: AgentOperatingProfileV1) => void) {
    const created = await send(actor, "post", `${profilePath()}/revisions`, {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const body = structuredClone(created.body.body) as AgentOperatingProfileV1;
    mutate(body);
    const saved = await send(actor, "patch", `${profilePath()}/revisions/${created.body.id}`, { body }, { "If-Match": created.body.bodyHash });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const proposed = await send(actor, "post", `${profilePath()}/revisions/${created.body.id}/propose`, { reason: "Walkthrough" });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    return { revisionId: created.body.id as string, approvalId: proposed.body.approvalId as string, payload: proposed.body.payload };
  }

  /** The analyst (an agent outside the board) assigns a new issue to `assigneeAgentId`. */
  async function assignAs(title: string, assigneeAgentId: string) {
    const s = requireSeed();
    const res = await send(analystActor(), "post", `/api/companies/${s.companyId}/issues`, { title, status: "todo", assigneeAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // The assignment wake is fire-and-forget; wait for its request row.
    const wake = await waitFor(`the assignment wake for ${title}`, () =>
      db
        .select()
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, assigneeAgentId), sql`${agentWakeupRequests.payload} ->> 'issueId' = ${res.body.id as string}`))
        .then((rows) => rows[0] ?? null),
    );
    return { res, wake };
  }

  // -------------------------------------------------------------------------
  // 1. Seed
  // -------------------------------------------------------------------------

  it("1. seeds a default-profile company: admin, steward, a stewarded agent with a routine trigger, an assigned issue", async () => {
    const company = await addCompany(db, "Walkthrough", "default");
    const ownerUserId = await addUser(db, company.id, "owner");
    const stewardUserId = await addUser(db, company.id, "member");
    const outsiderUserId = await addUser(db, company.id, "member");
    const fake = { adapterType: FAKE_ADAPTER, adapterConfig: {} };
    // The analyst may assign work (legacy canCreateAgents fallback for tasks:assign), so step 9 can contact other agents.
    const analyst = await addAgent(db, company.id, { name: "Analyst", title: "Pipeline Analyst", permissions: { canCreateAgents: true }, ...fake });
    const peer = await addAgent(db, company.id, { name: "Peer", ...fake });
    const stranger = await addAgent(db, company.id, { name: "Stranger", ...fake });
    await agentStewardshipService(db).assign(company.id, { agentId: analyst.id, userId: stewardUserId, assignedByUserId: ownerUserId });

    const routine = await db
      .insert(routines)
      .values({ companyId: company.id, title: "Weekly pipeline report", assigneeAgentId: analyst.id, status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const trigger = await db
      .insert(routineTriggers)
      .values({ companyId: company.id, routineId: routine.id, kind: "schedule", cronExpression: "0 9 * * 1", timezone: "UTC" })
      .returning()
      .then((rows) => rows[0]!);
    const issue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Explain the Q3 dip", status: "todo", assigneeAgentId: analyst.id })
      .returning()
      .then((rows) => rows[0]!);
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Q4 launch" })
      .returning()
      .then((rows) => rows[0]!);
    // A confirmed plan card naming the analyst: derived revision 0's responsibilities come from it.
    const conversation = await db
      .insert(assistantConversations)
      .values({ companyId: company.id, userId: ownerUserId })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(assistantMessages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: "Here is the team",
      cardKind: "agent_plan_proposal_v1",
      cardPayload: {
        rationale: "Grow pipeline",
        alignmentToShortTerm: "Q4",
        alignmentToLongTerm: "Growth",
        agents: [{ name: "Analyst", role: "engineer", adapterType: FAKE_ADAPTER, responsibilities: ["Weekly pipeline report"], kpis: ["Report on time"] }],
        confirmedAt: new Date().toISOString(),
        confirmedAgentIds: [analyst.id],
      },
    });
    // The issue-mutation authority re-reads an agent key, so the analyst has a real one.
    const key = await db
      .insert(agentApiKeys)
      .values({ agentId: analyst.id, companyId: company.id, name: "walkthrough", keyHash: `unused-${analyst.id}` })
      .returning()
      .then((rows) => rows[0]!);

    seed = {
      companyId: company.id,
      ownerUserId,
      stewardUserId,
      outsiderUserId,
      analyst: { id: analyst.id, companyId: company.id },
      peer: { id: peer.id },
      stranger: { id: stranger.id },
      routineId: routine.id,
      triggerId: trigger.id,
      issueId: issue.id,
      projectId: project.id,
      analystKeyId: key.id,
    };

    // A milestone (V1) contract for the project, declared over HTTP, so step 6
    // can show the agent contract leaves the milestone card unchanged.
    const now = new Date();
    const declared = await send(owner(), "post", `/api/companies/${company.id}/evaluation/contracts`, {
      contractVersion: "v1",
      companyId: company.id,
      goalId: null,
      parentGoalId: null,
      milestoneRef: { kind: "project", id: project.id },
      accountableUserId: ownerUserId,
      leadAgentId: null,
      acceptanceCriteria: [{ id: "k1", text: "An independent verdict passed", check: { kind: "record", record: "verdict.passed" }, source: "human" }],
      definitionOfDone: null,
      requiredEvidence: ["dod_present", "neutral_verdict"],
      independenceRule: "independence/v1",
      excludedReviewers: [],
      founderLocks: [],
      outcomeTarget: null,
      targetDate: null,
      downstreamRiskAcceptance: null,
      windowStart: new Date(now.getTime() - 86_400_000).toISOString(),
      windowEnd: null,
      source: "declared",
    });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    const replay = await send(owner(), "get", `/api/companies/${company.id}/evaluation/replay?kind=project&id=${project.id}`);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.card.contract).toMatchObject({ source: "declared", invalidVersions: 0 });
    state.milestoneBefore = {
      contract: replay.body.card.contract,
      eventCount: replay.body.card.eventCount,
      contractEventId: declared.body.eventId,
    };
  });

  // -------------------------------------------------------------------------
  // 2. The steward reads derived revision 0
  // -------------------------------------------------------------------------

  it("2. the steward reads the profile: derived revision 0, and viewer flags from the mutation guards", async () => {
    const s = requireSeed();
    const res = await send(steward(), "get", profilePath());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
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
        responsibilities: [{ key: "weekly-pipeline-report", title: "Weekly pipeline report" }],
      },
    });
    // The steward may start a draft; nothing exists yet to propose, withdraw, resume or decide.
    expect(res.body.viewer).toEqual({
      canEditDraft: true,
      canPropose: false,
      canWithdraw: false,
      canResumeApplication: false,
      canDecideActiveProposal: null,
    });
    // A member with no relationship to the agent cannot draft.
    expect((await send(outsider(), "get", profilePath())).body.viewer.canEditDraft).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Draft, edit, save with If-Match; a stale If-Match is 409
  // -------------------------------------------------------------------------

  it("3. the steward drafts, edits (bound responsibility, criterion, narrowed talk.agents, style) and saves with If-Match", async () => {
    const s = requireSeed();
    const created = await send(steward(), "post", `${profilePath()}/revisions`, {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ state: "draft", revisionNumber: 1, basedOnRevisionId: null, createdByUserId: s.stewardUserId });

    const body = structuredClone(created.body.body) as AgentOperatingProfileV1;
    expect(body.responsibilities.map((r) => r.key)).toEqual(["weekly-pipeline-report"]);
    const weekly = body.responsibilities[0]!;
    // Keep derived revision 0's stable key; bind it to the routine's existing trigger and give it a checkable criterion.
    weekly.outcome = "Leadership sees the pipeline every Monday";
    weekly.obligation = { kind: "routine", routineTriggerId: s.triggerId };
    weekly.deliverable = { what: "A one-page pipeline report", destination: "The weekly report issue" };
    weekly.escalation = { toUserId: s.stewardUserId, when: "The CRM export is missing" };
    weekly.performance = {
      ...weekly.performance,
      criteria: [{ id: "on-time", text: "Report posted by 10:00 Monday", check: { kind: "record", record: "deliverable.shipped" }, source: "human" }],
      coverage: ["deliverable_shipped"],
    };
    body.responsibilities.push({
      key: "ad-hoc-questions",
      title: "Ad-hoc pipeline questions",
      outcome: "Questions about the pipeline get an answer the same day",
      stakeholders: [],
      obligation: { kind: "assigned" },
      deliverable: { what: "An answer on the issue", destination: "The issue" },
      escalation: { when: "The data cannot answer it" },
      performance: { criteria: [], coverage: [], outcomeLinks: [], expectedHumanSteps: [], judges: { automated: [] } },
    });
    // Narrow talk.agents to one other agent (the Peer), through every channel.
    body.access = { ...body.access, talk: { agents: { mode: "listed", agentIds: [s.peer.id], via: [...ALL_VIA] } } };
    body.identity.style = { tone: "Plain and brief", uncertaintyRule: "Say what the data cannot show" };

    const path = `${profilePath()}/revisions/${created.body.id}`;
    const saved = await send(steward(), "patch", path, { body }, { "If-Match": created.body.bodyHash });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.bodyHash).not.toBe(created.body.bodyHash);
    expect(saved.body.body.responsibilities[0]).toMatchObject({ key: "weekly-pipeline-report", obligation: { kind: "routine", routineTriggerId: s.triggerId } });

    // A second save with the now-stale If-Match is a 409 carrying the current draft.
    const stale = await send(steward(), "patch", path, { body }, { "If-Match": created.body.bodyHash });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body).toMatchObject({ code: "AGENT_PROFILE_DRAFT_CONFLICT", current: { id: created.body.id, bodyHash: saved.body.bodyHash } });

    // Saving a draft is not applying it: governance, config and the contract are untouched.
    expect(await db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, s.analyst.id))).toHaveLength(0);
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, s.analyst.id))).toHaveLength(0);
    expect(await db.select().from(agentProfileApplications)).toHaveLength(0);
    expect(await activityRows(db, s.companyId, "agent_profile.draft_saved")).toHaveLength(2);
    state.firstRevisionId = created.body.id;
  });

  // -------------------------------------------------------------------------
  // 4. Propose: an agent_profile_change approval with diff and fieldAuthority
  // -------------------------------------------------------------------------

  it("4. proposing files an agent_profile_change approval with the diff and per-field authority; POST /approvals refuses the type", async () => {
    const s = requireSeed();
    expect(state.firstRevisionId, "step 3 must have saved a draft").toBeDefined();
    const proposed = await send(steward(), "post", `${profilePath()}/revisions/${state.firstRevisionId}/propose`, {
      reason: "Bind the weekly report and narrow who it may wake",
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const approval = await approvalRow(proposed.body.approvalId);
    expect(approval).toMatchObject({ type: "agent_profile_change", status: "pending", requestedByUserId: s.stewardUserId, requestedByAgentId: null });
    const payload = approval.payload as Body;
    expect(payload).toMatchObject({
      agentId: s.analyst.id,
      revisionId: state.firstRevisionId,
      bases: { basedOnRevisionId: null, configRevisionId: null },
      proposedBy: { kind: "user", userId: s.stewardUserId },
    });
    // The diff names each responsibility by key and title.
    const weeklyEntries = (payload.diff as Body[]).filter((entry) => entry.pointer.startsWith("/responsibilities/0/"));
    expect(weeklyEntries.length).toBeGreaterThan(0);
    for (const entry of weeklyEntries) expect(entry).toMatchObject({ key: "weekly-pipeline-report", title: "Weekly pipeline report" });
    expect(payload.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "add", pointer: "/responsibilities/1", key: "ad-hoc-questions", title: "Ad-hoc pipeline questions" }),
        expect.objectContaining({ pointer: "/responsibilities/0/obligation/routineTriggerId", key: "weekly-pipeline-report" }),
        expect.objectContaining({ pointer: "/access/talk" }),
      ]),
    );
    expect(payload.affectedResponsibilities).toEqual(["ad-hoc-questions", "weekly-pipeline-report"]);
    // Every diff entry has a field-authority entry; the access change needs the governance request rule.
    expect((payload.fieldAuthority as Body[]).map((entry) => entry.pointer).sort()).toEqual((payload.diff as Body[]).map((entry) => entry.pointer).sort());
    expect(payload.fieldAuthority).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: "/access/talk", required: "steward_or_accountable" })]));
    expect(payload.requiredAuthority).toBe("steward_or_accountable");
    expect(await activityRows(db, s.companyId, "agent_profile.proposed")).toHaveLength(1);

    // The generic approval route never files this type.
    const direct = await send(owner(), "post", `/api/companies/${s.companyId}/approvals`, { type: "agent_profile_change", payload: { agentId: s.analyst.id } });
    expect(direct.status, JSON.stringify(direct.body)).toBe(422);
    expect(direct.body.details?.code).toBe("AGENT_PROFILE_CHANGE_NOT_DIRECT");
    expect(await db.select().from(approvals).where(eq(approvals.type, "agent_profile_change"))).toHaveLength(1);
    state.firstApprovalId = approval.id;
  });

  // -------------------------------------------------------------------------
  // 5. The decision: never the agent; here not the steward; the admin approves
  // -------------------------------------------------------------------------

  it("5. the agent cannot decide; the steward cannot decide this one (non-MK access change); the admin approves", async () => {
    const s = requireSeed();
    expect(state.firstApprovalId, "step 4 must have filed the approval").toBeDefined();
    const approval = await approvalRow(state.firstApprovalId!);

    // Deciding is human-only: the agent the profile is about is refused.
    const byAgent = await send(analystActor(), "post", `/api/approvals/${approval.id}/approve`, decision(approval));
    expect(byAgent.status, JSON.stringify(byAgent.body)).toBe(403);

    // The real rule (agent-profile-authority.ts, A6): a changed `access` field
    // needs the authority to write the governance request directly, which is
    // `resolveConfigurationAuthority` — an admin, or (agentdash_mk only) the
    // active steward or creator. This is a default-profile company, so the
    // steward holds no configuration authority and cannot decide; the view
    // says so before they try. (The profile-only fields alone they could decide.)
    const stewardView = await send(steward(), "get", profilePath());
    expect(stewardView.body.viewer).toMatchObject({ canWithdraw: true, canDecideActiveProposal: false });
    const bySteward = await send(steward(), "post", `/api/approvals/${approval.id}/approve`, decision(approval));
    expect(bySteward.status, JSON.stringify(bySteward.body)).toBe(403);
    expect((await send(owner(), "get", profilePath())).body.viewer.canDecideActiveProposal).toBe(true);

    const approved = await send(owner(), "post", `/api/approvals/${approval.id}/approve`, decision(approval));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: "approved", decisionActorRole: "admin", decidedByUserId: s.ownerUserId });
    const [approvedActivity] = await activityRows(db, s.companyId, "approval.approved");
    expect(approvedActivity!.details).toMatchObject({ profileDecision: { decisionActorRole: "admin", selfApproval: false } });
  });

  // -------------------------------------------------------------------------
  // 6. Application, contract, AGENTS.md block, run-start evidence
  // -------------------------------------------------------------------------

  it("6. applies: every step recorded, active revision switched, V2 request stored, contract declared, AGENTS.md block delivered and evidenced at run start", async () => {
    const s = requireSeed();
    expect(state.firstApprovalId, "step 5 must have approved").toBeDefined();
    const application = await applicationFor(state.firstApprovalId!);
    expect(application, "approving must start the application").not.toBeNull();

    // The receipt over HTTP: applied, every step recorded with a terminal status.
    const receipts = await send(steward(), "get", `${profilePath()}/applications`);
    expect(receipts.status, JSON.stringify(receipts.body)).toBe(200);
    expect(receipts.body).toHaveLength(1);
    const receipt = receipts.body[0];
    expect(receipt).toMatchObject({ id: application!.id, status: "applied", failure: null, approverUserId: s.ownerUserId });
    expect(receipt.approverAuthority).toMatchObject({ role: "admin", selfApproval: false });
    expect(receipt.steps.map((step: Body) => step.step)).toEqual(["governance_request", "config", "environment", "routine_bindings", "skills", "contract"]);
    const stepStatus = Object.fromEntries(receipt.steps.map((step: Body) => [step.step, step.status]));
    expect(stepStatus).toEqual({
      governance_request: "done",
      config: "skipped",
      environment: "skipped",
      routine_bindings: "done",
      skills: "skipped",
      contract: "done",
    });
    for (const step of receipt.steps) expect(step.completedAt, `${step.step} has a completion time`).toEqual(expect.any(String));
    // One application_step activity per step, plus started and applied.
    const stepRows = await activityRows(db, s.companyId, "agent_profile.application_step");
    expect(stepRows.map((row) => (row.details as Body).step)).toEqual(receipt.steps.map((step: Body) => step.step));
    expect(await activityRows(db, s.companyId, "agent_profile.application_started")).toHaveLength(1);
    const [applied] = await activityRows(db, s.companyId, "agent_profile.applied");
    expect(applied!.entityId).toBe(state.firstRevisionId);

    // The active revision switched; the view shows it.
    expect(await activeRevisionIdNow()).toBe(state.firstRevisionId);
    const view = await send(steward(), "get", profilePath());
    expect(view.body).toMatchObject({ active: { id: state.firstRevisionId, state: "applied" }, derived: null, applicationInProgress: false });
    state.activeRevisionId = state.firstRevisionId;

    // No config field changed, so no profile_application config revision.
    const configRows = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, s.analyst.id));
    expect(configRows.filter((row) => row.source === "profile_application")).toHaveLength(0);

    // The governance REQUEST side holds the V2 talk.agents rule; the ceiling was not raised.
    const [governance] = await db.select().from(agentGovernancePolicies).where(eq(agentGovernancePolicies.agentId, s.analyst.id));
    // (Stored normalized: `userIds: []` is added.)
    expect((governance!.stewardRequest as Body).talk).toEqual({ agents: { mode: "listed", agentIds: [s.peer.id], userIds: [], via: [...ALL_VIA] } });
    expect((governance!.ownerCeiling as Body).talk).toBeUndefined();

    // The agent contract: contract.declared for subject agent, v2, keyed by responsibility.
    const contractStep = receipt.steps.find((step: Body) => step.step === "contract");
    const contractEvents = await db
      .select()
      .from(evaluationEvents)
      .where(and(eq(evaluationEvents.companyId, s.companyId), eq(evaluationEvents.eventType, "contract.declared"), eq(evaluationEvents.sourceId, `agent:${s.analyst.id}`)));
    expect(contractEvents).toHaveLength(1);
    expect(contractEvents[0]!.id).toBe(contractStep.targetId);
    expect((contractEvents[0]!.payload as Body).contract).toMatchObject({
      contractVersion: "v2",
      subjectRef: { kind: "agent", id: s.analyst.id },
      profileRevisionId: state.firstRevisionId,
      responsibilities: [
        { key: "weekly-pipeline-report", criteria: [{ id: "on-time", check: { kind: "record", record: "deliverable.shipped" } }] },
        { key: "ad-hoc-questions" },
      ],
    });
    // ...and the project's milestone card is unchanged by it.
    const replay = await send(owner(), "get", `/api/companies/${s.companyId}/evaluation/replay?kind=project&id=${s.projectId}`);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.card.contract).toEqual(state.milestoneBefore!.contract);
    expect(replay.body.card.eventCount).toBe(state.milestoneBefore!.eventCount);
    const milestoneContract = await send(owner(), "get", `/api/companies/${s.companyId}/evaluation/contracts?kind=project&id=${s.projectId}`);
    expect(milestoneContract.body).toMatchObject({ versions: 1, eventId: state.milestoneBefore!.contractEventId });

    // The managed AGENTS.md, read back over the instructions route: the
    // application wrote the per-agent `operating-profile` block (rev + hash),
    // distinct from the static `operating-profile-guidance` rules block.
    const file = await send(owner(), "get", `/api/agents/${s.analyst.id}/instructions-bundle/file?path=AGENTS.md`);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    const content = file.body.content as string;
    const opening = /<!-- AgentDash: operating-profile rev=(\d+) hash=([0-9a-f]+) -->/.exec(content);
    expect(opening, "the operating-profile block with rev and hash").not.toBeNull();
    expect(opening![1]).toBe("1");
    expect(content).toContain("<!-- /AgentDash: operating-profile -->");
    expect(content).toContain("weekly-pipeline-report");
    expect(content).toMatch(/<!-- AgentDash: operating-profile-guidance[^>]*-->/);
    expect(content).toContain("<!-- /AgentDash: operating-profile-guidance -->");
    const profileBlock = content.slice(opening!.index, content.indexOf("<!-- /AgentDash: operating-profile -->"));
    expect(profileBlock).not.toContain("operating-profile-guidance");

    // Run-start evidence: a manual wake starts a (fake-adapter) run, whose
    // context snapshot records which revision was delivered and that the hash
    // on disk matches the expected one.
    const woke = await send(owner(), "post", `/api/agents/${s.analyst.id}/wakeup`, { source: "on_demand", triggerDetail: "manual" });
    expect(woke.status, JSON.stringify(woke.body)).toBe(202);
    const run = await waitFor("the run to finish", () =>
      db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, woke.body.id as string))
        .then((rows) => (rows[0] && !["queued", "running"].includes(rows[0].status) ? rows[0] : null)),
    );
    expect(run.status).toBe("succeeded");
    const evidence = (run.contextSnapshot as Body).agentProfileDelivery;
    expect(evidence).toMatchObject({ profileRevisionId: state.firstRevisionId });
    expect(evidence.expectedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.blockHashOnDisk).toBe(evidence.expectedHash);
    expect(await activityRows(db, s.companyId, "profile.block_drift")).toHaveLength(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 7. Stale base → refused_stale; failed step → resume completes
  // -------------------------------------------------------------------------

  it("7. a proposal whose base changed is refused_stale; a failed step leaves it failed, and resume completes it", async () => {
    const s = requireSeed();
    expect(state.activeRevisionId, "step 6 must have activated revision 1").toBeDefined();

    // (a) Stale: the agent's config changes after the proposal.
    const second = await draftAndPropose(steward(), (body) => {
      body.identity.audience = "The sales leadership team";
    });
    const patched = await send(owner(), "patch", `/api/agents/${s.analyst.id}`, { title: "Senior Pipeline Analyst" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const secondApproval = await approvalRow(second.approvalId);
    expect((await send(owner(), "post", `/api/approvals/${second.approvalId}/approve`, decision(secondApproval))).status).toBe(200);
    const staleApplication = await applicationFor(second.approvalId);
    expect(staleApplication).toMatchObject({ status: "refused_stale" });
    const staleRevision = await db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id, second.revisionId)).then((rows) => rows[0]!);
    expect(staleRevision.state).toBe("refused_stale");
    expect(await activeRevisionIdNow()).toBe(state.activeRevisionId);
    const [refused] = await activityRows(db, s.companyId, "agent_profile.application_refused_stale");
    expect(refused!.details).toMatchObject({ reason: "config_changed" });
    const ended = await send(owner(), "post", `${profilePath()}/applications/${staleApplication!.id}/resume`);
    expect(ended.status, JSON.stringify(ended.body)).toBe(409);

    // (b) Fault, then resume. The proposal changes a config field (the model).
    // The fault is real state, not a mock: the bound routine is reassigned to
    // another agent after the proposal, so the routine_bindings step fails
    // validation. (The `beforeStep` fault hook is not reachable over HTTP.)
    const third = await draftAndPropose(owner(), (body) => {
      body.runtime = { ...body.runtime, model: "walkthrough-model" };
    });
    await db.update(routines).set({ assigneeAgentId: s.peer.id }).where(eq(routines.id, s.routineId));
    const thirdApproval = await approvalRow(third.approvalId);
    const approved = await send(owner(), "post", `/api/approvals/${third.approvalId}/approve`, decision(thirdApproval));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const failed = await applicationFor(third.approvalId);
    expect(failed).toMatchObject({ status: "failed" });
    const failedReceipt = (await send(owner(), "get", `${profilePath()}/applications`)).body.find((row: Body) => row.id === failed!.id);
    expect(failedReceipt.failure).toMatchObject({ kind: "step", step: "routine_bindings" });
    expect(Object.fromEntries(failedReceipt.steps.map((step: Body) => [step.step, step.status]))).toMatchObject({
      governance_request: "skipped",
      config: "done",
      environment: "skipped",
      routine_bindings: "failed",
      skills: "pending",
      contract: "pending",
    });
    // A failure never switches the active revision.
    expect(await activeRevisionIdNow()).toBe(state.activeRevisionId);
    expect(await activityRows(db, s.companyId, "agent_profile.application_failed")).toHaveLength(1);

    // Fix the cause and resume over HTTP: steps 1–3 re-run, then it continues from the failed step.
    await db.update(routines).set({ assigneeAgentId: s.analyst.id }).where(eq(routines.id, s.routineId));
    const resumed = await send(owner(), "post", `${profilePath()}/applications/${failed!.id}/resume`);
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body).toMatchObject({ activated: true, application: { id: failed!.id, status: "applied", failure: null } });
    expect(Object.fromEntries(resumed.body.application.steps.map((step: Body) => [step.step, step.status]))).toEqual({
      governance_request: "skipped",
      config: "done",
      environment: "skipped",
      routine_bindings: "done",
      skills: "skipped",
      contract: "done",
    });
    const startedRows = await activityRows(db, s.companyId, "agent_profile.application_started");
    expect(startedRows.at(-1)!.details).toMatchObject({ resumed: true, resumeFromStep: "routine_bindings", path: "resume" });
    expect(await activeRevisionIdNow()).toBe(third.revisionId);
    state.activeRevisionId = third.revisionId;

    // A config field changed this time, so there is exactly one profile_application config revision, carrying the model.
    const configRows = await db
      .select()
      .from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.agentId, s.analyst.id), eq(agentConfigRevisions.source, "profile_application")));
    expect(configRows).toHaveLength(1);
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, s.analyst.id));
    expect((agentRow!.adapterConfig as Body).model).toBe("walkthrough-model");
    // The contract was declared once per revision (revision 1 and revision 3), never for the stale one.
    const contractEvents = await db
      .select({ payload: evaluationEvents.payload })
      .from(evaluationEvents)
      .where(and(eq(evaluationEvents.eventType, "contract.declared"), eq(evaluationEvents.sourceId, `agent:${s.analyst.id}`)));
    expect(contractEvents.map((row) => (row.payload as Body).contract.profileRevisionId).sort()).toEqual(
      [state.firstRevisionId, third.revisionId].sort(),
    );
  }, 60_000);

  // -------------------------------------------------------------------------
  // 8. Responsibility mapping
  // -------------------------------------------------------------------------

  it("8. maps the issue to a responsibility key; a remap closes the old row", async () => {
    const s = requireSeed();
    expect(state.activeRevisionId, "step 7 must have left an active revision").toBeDefined();
    const path = `/api/companies/${s.companyId}/issues/${s.issueId}/responsibility`;

    // An unknown key is refused.
    const unknown = await send(analystActor(), "post", path, { agentId: s.analyst.id, responsibilityKey: "not-a-duty" });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(422);

    // The assignee agent maps its own work when it starts it.
    const first = await send(analystActor(), "post", path, { agentId: s.analyst.id, responsibilityKey: "ad-hoc-questions" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ issueId: s.issueId, agentId: s.analyst.id, responsibilityKey: "ad-hoc-questions", validTo: null, profileRevisionId: state.activeRevisionId });

    // The steward remaps it.
    const remapped = await send(steward(), "post", path, { agentId: s.analyst.id, responsibilityKey: "weekly-pipeline-report", reason: "It feeds the weekly report" });
    expect(remapped.status, JSON.stringify(remapped.body)).toBe(200);

    const read = await send(steward(), "get", path);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.current).toMatchObject({ id: remapped.body.id, responsibilityKey: "weekly-pipeline-report", validTo: null });
    expect(read.body.history).toHaveLength(2);
    expect(read.body.history[0]).toMatchObject({ id: first.body.id, responsibilityKey: "ad-hoc-questions" });
    expect(read.body.history[0].validTo).toEqual(expect.any(String));
    expect(await activityRows(db, s.companyId, "issue.responsibility_mapped")).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 9. Shadow mode
  // -------------------------------------------------------------------------

  it("9. shadow: an out-of-scope assignment and its wake go ahead exactly as in off, and are logged as would-be refusals", async () => {
    const s = requireSeed();
    const modePath = `/api/companies/${s.companyId}/agent-access-enforcement`;
    // APM gate 3 (P3.4): `enforce` is selectable now (agent-access-enforcement-routes.test.ts covers it).
    expect((await send(owner(), "get", modePath)).body).toMatchObject({ mode: "off", selectableModes: ["off", "shadow", "enforce"] });

    // Baseline in off: the analyst assigns work to the Stranger (outside its talk.agents list).
    const off = await assignAs("Off-mode request", s.stranger.id);
    expect(off.res.body.assigneeAgentId).toBe(s.stranger.id);
    expect(await wouldRefuseRows(db, s.companyId)).toHaveLength(0);

    // Only an admin changes the mode. (Gate 2 asserted here that enforce answered
    // 409; gate 3 allows it, so this walkthrough stays in shadow without asking.)
    expect((await send(steward(), "patch", modePath, { mode: "shadow" })).status).toBe(403);
    const shadowOn = await send(owner(), "patch", modePath, { mode: "shadow" });
    expect(shadowOn.status, JSON.stringify(shadowOn.body)).toBe(200);
    expect(shadowOn.body).toMatchObject({ mode: "shadow", changed: true, previousMode: "off" });
    expect((await send(steward(), "get", modePath)).body.mode).toBe("shadow");
    expect(await activityRows(db, s.companyId, "company.agent_access_enforcement_changed")).toHaveLength(1);

    // The same assignment in shadow: identical outcome, assignment and wake both happen.
    const shadow = await assignAs("Shadow-mode request", s.stranger.id);
    const shape = (res: { status: number; body: Body }) => ({ status: res.status, issueStatus: res.body.status, assigneeAgentId: res.body.assigneeAgentId });
    expect(shape(shadow.res)).toEqual(shape(off.res));
    expect({ source: shadow.wake.source, reason: shadow.wake.reason, requestedByActorType: shadow.wake.requestedByActorType }).toEqual({
      source: off.wake.source,
      reason: off.wake.reason,
      requestedByActorType: off.wake.requestedByActorType,
    });
    await waitFor("both wake requests for the Stranger (off and shadow)", async () => {
      const rows = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.stranger.id));
      return rows.length === 2 ? rows : null;
    });
    // Contact inside the scope is not a would-be refusal.
    await assignAs("In-scope request", s.peer.id);

    // ...and each out-of-scope contact is logged: the assignment and its wake.
    const logged = await waitFor("the wake.dispatch would-refuse row", async () => {
      const rows = await wouldRefuseRows(db, s.companyId);
      return rows.some((row) => (row.details as Body).site === "wake.dispatch") ? rows : null;
    });
    expect(logged.map((row) => (row.details as Body).site).sort()).toEqual(["issues.assign", "wake.dispatch"]);
    for (const row of logged) {
      expect(row.agentId).toBe(s.analyst.id);
      expect(row.details).toMatchObject({
        dimension: "talk.agents",
        rule: "talk.agents:not_listed",
        via: "assign",
        target: { agentId: s.stranger.id },
        policyMode: "shadow",
      });
    }

    // The access inventory: requested from the active profile, defined by V2, mode shadow, would-be refusals counted.
    const inventory = await send(owner(), "get", `/api/companies/${s.companyId}/agents/${s.analyst.id}/access`);
    expect(inventory.status, JSON.stringify(inventory.body)).toBe(200);
    expect(inventory.body).toMatchObject({ profileDefined: true, enforcementMode: "shadow" });
    const assignItem = (inventory.body.items as Body[]).find((item) => item.id === "talk.agents.assign");
    expect(assignItem).toMatchObject({
      requested: { state: "requested", revisionId: state.activeRevisionId },
      defined: { v2: { allowed: true, rule: "talk.agents.listed" } },
    });
    expect(inventory.body.shadow.wouldRefuseTotal).toBeGreaterThanOrEqual(1);
    expect(inventory.body.shadow.byDimension["talk.agents"]).toBeGreaterThanOrEqual(1);
    // The agent reads its own inventory the same way.
    expect((await send(analystActor(), "get", "/api/agents/me/access")).body).toMatchObject({ enforcementMode: "shadow", profileDefined: true });

    // The default activity feed hides would-be refusals; includeSystem=true shows them.
    const feed = await send(owner(), "get", `/api/companies/${s.companyId}/activity?limit=500`);
    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    expect((feed.body as Body[]).some((row) => row.action === "access.would_refuse")).toBe(false);
    expect((feed.body as Body[]).some((row) => row.action === "agent_profile.application_step")).toBe(false);
    const full = await send(owner(), "get", `/api/companies/${s.companyId}/activity?limit=500&includeSystem=true`);
    expect((full.body as Body[]).filter((row) => row.action === "access.would_refuse")).toHaveLength(logged.length);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 10. Gate 1 views
  // -------------------------------------------------------------------------

  it("10. gate 1 views still work: the performance projection answers with the agent's data", async () => {
    const s = requireSeed();
    const res = await send(owner(), "get", `/api/companies/${s.companyId}/evaluation/agents/${s.analyst.id}/projection`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ companyId: s.companyId, agentId: s.analyst.id });
    // The agent's own profile read keeps working too.
    const mine = await send(analystActor(), "get", "/api/agents/me/profile");
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.active).toMatchObject({ id: state.activeRevisionId });
  });

  // -------------------------------------------------------------------------
  // 11. MK sanity
  // -------------------------------------------------------------------------

  it("11. MK: the steward-only approval rule is the same in shadow as in off", async () => {
    const mk = await seedProfileCompany(db, "agentdash_mk");
    // Keep MK's agents on the in-process fake too: an approval wakes its requester.
    await db.update(agents).set({ adapterType: FAKE_ADAPTER, adapterConfig: {} }).where(eq(agents.companyId, mk.company.id));
    const mkOwner = boardActor(mk.company.id, mk.ownerUserId, "owner");
    const mkSteward = boardActor(mk.company.id, mk.stewardUserId);

    async function decideBoth() {
      const [row] = await db
        .insert(approvals)
        .values({ companyId: mk.company.id, type: "approve_ceo_strategy", requestedByAgentId: mk.analyst.id, status: "pending", payload: {} })
        .returning();
      const byOwner = await send(mkOwner, "post", `/api/approvals/${row!.id}/approve`, decision(row!));
      const bySteward = await send(mkSteward, "post", `/api/approvals/${row!.id}/approve`, decision(row!));
      return { owner: byOwner.status, steward: bySteward.status, role: bySteward.body.decisionActorRole };
    }

    const offOutcome = await decideBoth();
    expect(offOutcome).toEqual({ owner: 403, steward: 200, role: "steward" });
    expect((await send(mkOwner, "patch", `/api/companies/${mk.company.id}/agent-access-enforcement`, { mode: "shadow" })).status).toBe(200);
    expect(await decideBoth()).toEqual(offOutcome);
  });

  it("leaves no application in progress and the wakes settled", async () => {
    const s = requireSeed();
    const live = await db
      .select()
      .from(agentProfileApplications)
      .where(and(eq(agentProfileApplications.agentId, s.analyst.id), eq(agentProfileApplications.status, "in_progress")))
      .orderBy(desc(agentProfileApplications.createdAt));
    expect(live).toHaveLength(0);
    await waitFor("fake-adapter runs to finish", async () => {
      const running = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running') and ${heartbeatRuns.companyId} = ${s.companyId}`);
      return running.length === 0 ? true : null;
    });
  });
});
