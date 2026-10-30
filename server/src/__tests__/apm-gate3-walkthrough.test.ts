// AgentDash: Agent Performance Management gate 3 (P3.6) — the gate 3 exit
// walkthrough ("enforce and measure"). One non-MK ("default" profile) company
// is driven over the real HTTP routes: a profile applied through the gate 2
// flow, off → shadow → enforce at representative access LLD §4 rows, three
// days of one scheduled responsibility of which one never ran, judged and used
// deliverables, agent cards snapshotted and verified, calibration review
// items, a steward kept out of a restricted project, and a milestone card
// compared with the pre-gate-3 formula.
//
// As in the gate 2 walkthrough: the routers are the production route
// factories mounted the way app.ts mounts them (plus the agent access-scope
// middleware app.ts puts in front of them), behind the actor-injection shim
// every route suite uses. Embedded Postgres with every migration applied. No
// APM or evaluator service is mocked. Nothing external runs: the agents use an
// in-process fake adapter registered for this file only, whose `execute`
// returns at once (no adapter process, model call or network call).
//
// Explicit times. Owed work is generated from definitions, so the scenario
// needs a responsibility in force for three days before "now":
//  - the routine and its daily trigger are inserted with a creation time
//    before day 1, and the profile application (made over HTTP just now) is
//    re-stamped to an instant before day 1 — the walkthrough's only rewrite of
//    a production record;
//  - the routine scheduler (`routineService.tickScheduledTriggers(now)`) is
//    driven at day 1 and day 2 with the JS clock set to those instants
//    (`vi.useFakeTimers({ toFake: ["Date"] })`), because dispatch stamps
//    `routine_runs.triggered_at` from the wall clock (routines.ts:911), not
//    from the tick's `now`; day 3 is simply never dispatched;
//  - ingest is driven explicitly through `POST evaluation/ingest/run?backfill=true`
//    (the evaluator's `evaluationIngest.backfill`), and card snapshots run at
//    the route's own `asOf` (the snapshot route reads the clock; it takes no
//    `asOf`), with day 3 two hours before it.
//
// The tests are one ordered scenario that shares state; each step checks that
// the step before it left what it needs.
//
// Gate 3 exit conditions (doc/plans/2026-10-29-apm-gate3-build-spec.md) and
// the steps that prove them:
//   E1 enforce selectable by an admin only; four representative §4 rows
//      (issues.assign, wake.dispatch via mention, heartbeat.run_claim,
//      approval_routing) refuse as their "On refusal" column says; the
//      escalation path (an approval to the accountable person) stays open;
//      off and shadow give identical outcomes for the same actions ..... steps 3–4
//      (MK unchanged is not walked here: the P3.4 suites cover all modes.)
//   E2 one self-widening gap: `capabilities` is profile-managed (422) in
//      off, shadow and enforce ........................................ steps 3–4
//   E3 snapshot → verify over HTTP; a second snapshot with no new
//      non-evaluator events reuses the version; v1 still verifies ...... steps 7–8
//   E4 owed work counts a period in which nothing ran ............... steps 5, 7
//   E5 access classes: no restricted-project leak through the events API,
//      the agent card (counts included), the agents list or the cases .. step 9
//   E6 the milestone card differs from the pre-gate-3 formula only by the
//      declared bump (agent-side sources are not milestone inputs) ..... step 10
//      (The other declared m2-score/9 change, checkout → assignment +
//      transition, is an ingest change; this baseline scores the same
//      ingested rows, so it is covered by evaluation-gate3-ingest.test.ts.)
//   E7 calibration samples become review items for the named human ... step 7
// Plus: human acceptance, automated acceptance and use stay separate facts
// (steps 7–8), and the independent agent's verdict is a reviewer fact on its
// own card (step 7).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import request from "supertest";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentApiKeys,
  agentProfileApplications,
  agentProfileRevisions,
  agentWakeupRequests,
  approvals,
  authSessions,
  createDb,
  evaluationEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projectAccess,
  projects,
  routineRunOccurrences,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import type { AgentCardView, AgentCaseRow, AgentOperatingProfileV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser, agentRequestActor, boardActor, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { activityRows, wouldRefuseRows } from "./helpers/agent-access-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";
import { resetRunLogStoreForTests } from "../services/run-log-store.js";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { ACCESS_POLICY_BLOCKER_NOTE_PREFIX } from "../services/heartbeat.js";
import { routineService } from "../services/routines.js";
import { evaluationLedger } from "../services/evaluation/ledger.js";
import { evaluationReplay } from "../services/evaluation/replay.js";
import { FORMULA_VERSION as MILESTONE_FORMULA_VERSION, scoreMilestone } from "../services/evaluation/scoring/card.js";
import { isMilestoneInput } from "../services/evaluation/scoring/timeline.js";
import { agentAccessScopeMiddleware } from "../routes/visibility.js";
import { activityRoutes } from "../routes/activity.js";
import { agentAccessEnforcementRoutes } from "../routes/agent-access-enforcement.js";
import { agentAccessRoutes } from "../routes/agent-access.js";
import { agentPerformanceRoutes } from "../routes/agent-performance.js";
import { agentProfileRoutes } from "../routes/agent-profiles.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { evaluationAgentRoutes } from "../routes/evaluation-agents.js";
import { evaluationRoutes } from "../routes/evaluation.js";
import { issueResponsibilityRoutes } from "../routes/issue-responsibilities.js";
import { issueRoutes } from "../routes/issues.js";
import { verdictRoutes } from "../routes/verdicts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FAKE_ADAPTER = "apm_gate3_walkthrough_fake";
const ALL_VIA = ["assign", "comment_wake", "mention", "handoff"] as const;
const ACTOR_HEADER = "x-walkthrough-actor";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Actor = Record<string, unknown>;
type Body = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Mode = "off" | "shadow" | "enforce";

async function waitFor<T>(label: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The pre-gate-3 milestone formula (`m2-score/8`) as code: git HEAD's
 * `services/evaluation/scoring/` (committed before APM gate 1) with the one
 * gate 1–2 change under that directory — the gate 2 agent-contract skip in
 * `contract.ts` (taken from the working tree, whose only diff to HEAD it is).
 * Written to a temp dir with `@paperclipai/shared` and `../ledger.js` pointed
 * at this checkout's modules (`orderEvents`/`hashCanonical` are unchanged).
 */
async function loadPreGate3MilestoneScoring(): Promise<{ dir: string; mod: { FORMULA_VERSION: string; scoreMilestone: typeof scoreMilestone } }> {
  const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const scoringPath = "server/src/services/evaluation/scoring/";
  const shared = join(repo, "packages/shared/src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "apm-gate3-pre-bump-"));
  mkdirSync(join(dir, "scoring"));
  writeFileSync(join(dir, "ledger.ts"), `export * from ${JSON.stringify(join(repo, "server/src/services/evaluation/ledger.ts"))};\n`);
  const files = execFileSync("git", ["ls-tree", "--name-only", "HEAD", scoringPath], { cwd: repo, encoding: "utf8" }).trim().split("\n");
  for (const file of files) {
    const name = file.slice(scoringPath.length);
    const source = name === "contract.ts" ? readFileSync(join(repo, file), "utf8") : execFileSync("git", ["show", `HEAD:${file}`], { cwd: repo, encoding: "utf8" });
    writeFileSync(join(dir, "scoring", name), source.replaceAll('"@paperclipai/shared"', JSON.stringify(shared)));
  }
  const mod = (await import(pathToFileURL(join(dir, "scoring", "card.ts")).href)) as { FORMULA_VERSION: string; scoreMilestone: typeof scoreMilestone };
  return { dir, mod };
}

describeEmbeddedPostgres("APM gate 3 exit walkthrough (P3.6)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  let server: ReturnType<typeof createServer> | null = null;
  let baseUrl = "";
  const savedEnv: Record<string, string | undefined> = {};
  const actors = new Map<string, Actor>();
  /** userId → a live `auth_sessions` row: the shim binds it as the request's verified session credential, as the real auth middleware does. */
  const sessions = new Map<string, string>();

  // The three scheduled instants: day 3 two hours before "now", day 2 and day 1 one and two days earlier.
  const nowAtStart = Math.floor(Date.now() / MINUTE) * MINUTE;
  const day3 = nowAtStart - 2 * HOUR;
  const day2 = day3 - DAY;
  const day1 = day3 - 2 * DAY;
  const definedAt = day1 - 3 * HOUR; // the routine and its trigger exist from here
  const appliedAt = day1 - 2 * HOUR; // the profile is in force from here
  const cron = `${new Date(day3).getUTCMinutes()} ${new Date(day3).getUTCHours()} * * *`;

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY", "RUN_LOG_BASE_PATH"]) {
      savedEnv[key] = process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), "apm-gate3-walkthrough-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "apm-gate3-walkthrough";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "f".repeat(64);
    process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apm-gate3-walkthrough-");
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
      issueResponsibilityRoutes(db),
      agentAccessEnforcementRoutes(db),
      issueRoutes(db, {} as never),
      // Approval decisions wake the requesting agent; never dispatch a run from here.
      approvalRoutes(db, { autoDispatchQueuedRuns: false }),
      activityRoutes(db),
      verdictRoutes(db),
      evaluationRoutes(db),
      evaluationAgentRoutes(db),
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
    vi.useRealTimers();
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
    accountableUserId: string;
    judgeUserId: string;
    outsiderUserId: string;
    analyst: { id: string; companyId: string };
    peer: { id: string; companyId: string };
    stranger: { id: string; companyId: string };
    archivist: { id: string; companyId: string };
    reportingProjectId: string;
    outsideProjectId: string;
    restrictedProjectId: string;
    routineId: string;
    triggerId: string;
    notesIssueId: string;
    analystKeyId: string;
  }
  let seed: Seed | null = null;
  const state: {
    revisionId?: string;
    contractEventId?: string;
    dailyIssueIds?: string[];
    restricted?: { analystIssue: { id: string; identifier: string; title: string }; archivistIssue: { id: string; identifier: string; title: string } };
    snapshot1?: Body;
    snapshot2?: Body;
  } = {};

  function requireSeed(): Seed {
    expect(seed, "step 1 (seed) must have run").not.toBeNull();
    return seed!;
  }
  const owner = () => boardActor(requireSeed().companyId, requireSeed().ownerUserId, "owner");
  const steward = () => boardActor(requireSeed().companyId, requireSeed().stewardUserId);
  const accountable = () => boardActor(requireSeed().companyId, requireSeed().accountableUserId);
  const judge = () => boardActor(requireSeed().companyId, requireSeed().judgeUserId);
  const analystActor = () => agentRequestActor(requireSeed().analyst, { keyId: requireSeed().analystKeyId });
  const companyPath = () => `/api/companies/${requireSeed().companyId}`;
  const profilePath = () => `${companyPath()}/agents/${requireSeed().analyst.id}/profile`;
  const cardsPath = (agentId: string) => `${companyPath()}/evaluation/agents/${agentId}`;

  /** No queued or running heartbeat run left in the company. */
  async function settleRuns(label: string) {
    await waitFor(`heartbeat runs to settle (${label})`, async () => {
      const live = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running') and ${heartbeatRuns.companyId} = ${requireSeed().companyId}`);
      return live.length === 0;
    });
  }

  /** The (first) heartbeat run started for an issue, once it has ended. */
  async function endedRunFor(issueId: string) {
    return waitFor(`the run for issue ${issueId} to end`, () =>
      db
        .select()
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`)
        .orderBy(heartbeatRuns.createdAt)
        .then((rows) => (rows[0] && !["queued", "running"].includes(rows[0].status) ? rows[0] : null)),
    );
  }

  async function patchIssue(actor: Actor, issueId: string, patch: Record<string, unknown>) {
    const res = await send(actor, "patch", `/api/issues/${issueId}`, patch);
    expect(res.status, `PATCH issue ${JSON.stringify(patch)}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body;
  }

  async function issueRow(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  async function caseRows(actor: Actor, agentId: string, query = ""): Promise<{ total: number; rows: AgentCaseRow[] }> {
    const res = await send(actor, "get", `${cardsPath(agentId)}/cases?limit=500${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  function visibleBody<T>(section: { visibility: string; body?: T }, label: string): T {
    expect(section.visibility, `${label} must be readable`).not.toBe("not_visible");
    return section.body as T;
  }

  // -------------------------------------------------------------------------
  // 1. Seed
  // -------------------------------------------------------------------------

  it("1. seeds a default-profile company: people, agents, an open, an out-of-scope and a restricted project, a daily routine defined before day 1", async () => {
    const company = await addCompany(db, "Gate3 walkthrough", "default");
    const ownerUserId = await addUser(db, company.id, "owner");
    const stewardUserId = await addUser(db, company.id, "member");
    const accountableUserId = await addUser(db, company.id, "member");
    const judgeUserId = await addUser(db, company.id, "member");
    const outsiderUserId = await addUser(db, company.id, "member");
    // Each person is signed in: the issue PATCH path re-reads a live session (current-board-identity.ts).
    for (const userId of [ownerUserId, stewardUserId, accountableUserId, judgeUserId, outsiderUserId]) {
      const sessionId = randomUUID();
      const at = new Date();
      await db.insert(authSessions).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(at.getTime() + DAY), createdAt: at, updatedAt: at });
      sessions.set(userId, sessionId);
    }
    const fake = { adapterType: FAKE_ADAPTER, adapterConfig: {} };
    // The analyst may assign work (legacy canCreateAgents fallback for tasks:assign), so it can contact other agents.
    const analyst = await addAgent(db, company.id, { name: "Analyst", title: "Pipeline Analyst", permissions: { canCreateAgents: true }, accountableUserId, ...fake });
    const peer = await addAgent(db, company.id, { name: "Peer", ...fake });
    const stranger = await addAgent(db, company.id, { name: "Stranger", ...fake });
    const archivist = await addAgent(db, company.id, { name: "Archivist", ...fake });
    // One stewardship per person: the steward answers for the analyst; it reads the archivist's card as a member.
    await agentStewardshipService(db).assign(company.id, { agentId: analyst.id, userId: stewardUserId, assignedByUserId: ownerUserId });

    const [reporting] = await db.insert(projects).values({ companyId: company.id, name: "Reporting" }).returning();
    const [outside] = await db.insert(projects).values({ companyId: company.id, name: "Q4 launch" }).returning();
    const [restricted] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Board pack", visibility: "restricted", createdByUserId: ownerUserId })
      .returning();
    // On the restricted project's access list: the two agents that work there. Not the steward.
    for (const agentId of [analyst.id, archivist.id]) {
      await db.insert(projectAccess).values({ projectId: restricted!.id, principalType: "agent", principalId: agentId, grantedByUserId: ownerUserId });
    }

    // The daily routine and its trigger, defined three hours before day 1; the scheduler's next tick is day 1.
    const [routine] = await db
      .insert(routines)
      .values({ companyId: company.id, projectId: reporting!.id, title: "Daily pipeline digest", assigneeAgentId: analyst.id, status: "active", createdAt: new Date(definedAt), updatedAt: new Date(definedAt) })
      .returning();
    const [trigger] = await db
      .insert(routineTriggers)
      .values({ companyId: company.id, routineId: routine!.id, kind: "schedule", cronExpression: cron, timezone: "UTC", nextRunAt: new Date(day1), createdAt: new Date(definedAt), updatedAt: new Date(definedAt) })
      .returning();
    // The analyst's own working-notes issue (no project), where it writes comments.
    const [notes] = await db.insert(issues).values({ companyId: company.id, title: "Analyst working notes", status: "todo", assigneeAgentId: analyst.id }).returning();
    // The issue-mutation authority re-reads an agent key, so the analyst has a real one.
    const [key] = await db.insert(agentApiKeys).values({ agentId: analyst.id, companyId: company.id, name: "walkthrough", keyHash: `unused-${analyst.id}` }).returning();

    const ref = (agent: { id: string }) => ({ id: agent.id, companyId: company.id });
    seed = {
      companyId: company.id,
      ownerUserId,
      stewardUserId,
      accountableUserId,
      judgeUserId,
      outsiderUserId,
      analyst: ref(analyst),
      peer: ref(peer),
      stranger: ref(stranger),
      archivist: ref(archivist),
      reportingProjectId: reporting!.id,
      outsideProjectId: outside!.id,
      restrictedProjectId: restricted!.id,
      routineId: routine!.id,
      triggerId: trigger!.id,
      notesIssueId: notes!.id,
      analystKeyId: key!.id,
    };

    // A milestone (V1) contract for the Reporting project, declared over HTTP (step 10 scores it).
    const declared = await send(owner(), "post", `${companyPath()}/evaluation/contracts`, {
      contractVersion: "v1",
      companyId: company.id,
      goalId: null,
      parentGoalId: null,
      milestoneRef: { kind: "project", id: reporting!.id },
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
      windowStart: new Date(definedAt - DAY).toISOString(),
      windowEnd: null,
      source: "declared",
    });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
  });

  // -------------------------------------------------------------------------
  // 2. The profile, applied over HTTP; in force from before day 1
  // -------------------------------------------------------------------------

  it("2. applies a profile over HTTP: one scheduled responsibility bound to the daily trigger (human judge, sampleRate 1), one assigned, narrowed access", async () => {
    const s = requireSeed();
    const created = await send(steward(), "post", `${profilePath()}/revisions`, {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const body = structuredClone(created.body.body) as AgentOperatingProfileV1;
    body.responsibilities = [
      {
        key: "daily-digest",
        title: "Daily pipeline digest",
        outcome: "Sales leadership starts every day with the pipeline",
        stakeholders: [],
        obligation: { kind: "routine", routineTriggerId: s.triggerId },
        deliverable: { what: "A one-page digest", destination: "The digest issue" },
        escalation: { toUserId: s.accountableUserId, when: "The CRM export is missing" },
        performance: {
          criteria: [{ id: "reviewed", text: "An independent reviewer passed the digest", check: { kind: "record", record: "verdict.passed" }, source: "human" }],
          coverage: ["neutral_verdict"],
          outcomeLinks: [],
          expectedHumanSteps: [],
          judges: { automated: ["evaluator", "independent_agent"], human: { userId: s.judgeUserId, sampleRate: 1, minPerWindow: 1 } },
        },
      },
      {
        key: "ad-hoc",
        title: "Ad-hoc board questions",
        outcome: "Board questions get an answer the same week",
        stakeholders: [],
        obligation: { kind: "assigned" },
        deliverable: { what: "An answer on the issue", destination: "The issue" },
        escalation: { when: "The data cannot answer it" },
        performance: { criteria: [], coverage: [], outcomeLinks: [], expectedHumanSteps: [], judges: { automated: [] } },
      },
    ] as AgentOperatingProfileV1["responsibilities"];
    body.access = {
      ...body.access,
      see: { projects: { mode: "listed", ids: [s.reportingProjectId, s.restrictedProjectId] } },
      talk: {
        agents: { mode: "listed", agentIds: [s.peer.id], via: [...ALL_VIA] },
        people: { mode: "listed", userIds: [] },
      },
    };
    const saved = await send(steward(), "patch", `${profilePath()}/revisions/${created.body.id}`, { body }, { "If-Match": created.body.bodyHash });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const proposed = await send(steward(), "post", `${profilePath()}/revisions/${created.body.id}/propose`, { reason: "Gate 3 walkthrough" });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    expect(await db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, proposed.body.approvalId))).toHaveLength(0);
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, proposed.body.approvalId));
    const approved = await send(owner(), "post", `/api/approvals/${approval!.id}/approve`, decision(approval!));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const [application] = await db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, proposed.body.approvalId));
    expect(application, "approving must apply the profile").toBeDefined();
    expect(application!.status).toBe("applied");
    const contractEvent = await db
      .select({ id: evaluationEvents.id, payload: evaluationEvents.payload })
      .from(evaluationEvents)
      .where(and(eq(evaluationEvents.companyId, s.companyId), eq(evaluationEvents.eventType, "contract.declared"), eq(evaluationEvents.sourceId, `agent:${s.analyst.id}`)))
      .then((rows) => rows[0]!);
    expect((contractEvent.payload as Body).contract).toMatchObject({
      contractVersion: "v2",
      profileRevisionId: created.body.id,
      responsibilities: [{ key: "daily-digest", judges: { human: { userId: s.judgeUserId, sampleRate: 1 } } }, { key: "ad-hoc" }],
    });

    // In force from before day 1: the one re-stamp of a production record (see the header).
    await db.update(agentProfileApplications).set({ createdAt: new Date(appliedAt), updatedAt: new Date(appliedAt) }).where(eq(agentProfileApplications.id, application!.id));
    await db.update(agentProfileRevisions).set({ updatedAt: new Date(appliedAt) }).where(eq(agentProfileRevisions.id, created.body.id));
    state.revisionId = created.body.id;
    state.contractEventId = contractEvent.id;
  });

  // -------------------------------------------------------------------------
  // 3–4. Off, shadow, enforce at representative §4 rows
  // -------------------------------------------------------------------------

  /** The same five contacts in every mode. */
  async function contacts(mode: Mode) {
    const s = requireSeed();
    // §4 issues.assign (talk.agents): the analyst assigns new work to the Stranger (outside its talk.agents list).
    const assign = await send(analystActor(), "post", `${companyPath()}/issues`, { title: `${mode}: a request for the Stranger`, status: "todo", assigneeAgentId: s.stranger.id });
    // §4 wake.dispatch (talk.agents via mention): the analyst @-mentions the Stranger on its own issue.
    const mention = await send(analystActor(), "post", `/api/issues/${s.notesIssueId}/comments`, { body: `@Stranger ${mode}: could you check these totals?` });
    // §4 heartbeat.run_claim (see.projects): the owner assigns the analyst work in a project outside its see.projects.
    const outside = await send(owner(), "post", `${companyPath()}/issues`, { title: `${mode}: Q4 launch numbers`, status: "todo", projectId: s.outsideProjectId, assigneeAgentId: s.analyst.id });
    expect(outside.status, JSON.stringify(outside.body)).toBe(201);
    // §4 approval_routing (talk.people, listed as nobody): an approval routed to a member outside it...
    const approvalOut = await send(analystActor(), "post", `${companyPath()}/approvals`, {
      type: "request_board_approval",
      payload: { summary: `${mode}: sign off the digest format`, approverUserId: s.outsiderUserId },
    });
    // ...and the escalation path: the same request routed to the analyst's accountable person.
    const approvalAccountable = await send(analystActor(), "post", `${companyPath()}/approvals`, {
      type: "request_board_approval",
      payload: { summary: `${mode}: sign off the digest format`, approverUserId: s.accountableUserId },
    });
    // §3.1/§5 fixed rule: the analyst widening its own `capabilities`.
    const capabilities = await send(analystActor(), "patch", `/api/agents/${s.analyst.id}`, { capabilities: `${mode}: everything` });
    const run = await endedRunFor(outside.body.id as string);
    const mentionWake =
      mention.status === 201
        ? await waitFor(`the mention wake (${mode})`, () =>
            db
              .select()
              .from(agentWakeupRequests)
              .where(and(eq(agentWakeupRequests.agentId, s.stranger.id), sql`${agentWakeupRequests.payload} ->> 'commentId' = ${mention.body.id as string}`))
              .then((rows) => rows[0] ?? null),
          )
        : null;
    await settleRuns(mode);
    // Runs the mention started for the Stranger (the wake's run carries the comment as `wakeCommentId`).
    const mentionRuns =
      mention.status === 201
        ? await db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(sql`${heartbeatRuns.agentId} = ${s.stranger.id} and ${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId' = ${mention.body.id as string}`)
        : [];
    return { assign, mention, mentionWake, mentionRuns, outside, run, approvalOut, approvalAccountable, capabilities };
  }

  function expectCapabilitiesRefused(res: { status: number; body: Body }) {
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "AGENT_FIELD_PROFILE_MANAGED", fields: ["capabilities"] });
  }

  const gate2Outcomes: Partial<Record<Mode, Body>> = {};

  it("3. off and shadow: the five contacts go through exactly as in gate 2; shadow only logs would-be refusals; capabilities is 422 in both", async () => {
    const s = requireSeed();
    expect(state.revisionId, "step 2 must have applied the profile").toBeDefined();
    const modePath = `${companyPath()}/agent-access-enforcement`;
    expect((await send(owner(), "get", modePath)).body).toMatchObject({ mode: "off", selectableModes: ["off", "shadow", "enforce"] });

    for (const mode of ["off", "shadow"] as const) {
      if (mode === "shadow") {
        const changed = await send(owner(), "patch", modePath, { mode: "shadow" });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      }
      const refusedBefore = (await activityRows(db, s.companyId, "authz.refused")).length;
      const r = await contacts(mode);
      expect(r.assign.status, JSON.stringify(r.assign.body)).toBe(201);
      expect(r.assign.body.assigneeAgentId).toBe(s.stranger.id);
      expect(r.mention.status, JSON.stringify(r.mention.body)).toBe(201);
      expect(r.mentionWake!.status).not.toBe("skipped");
      expect(r.mentionRuns).toHaveLength(1);
      expect(r.run.status).toBe("succeeded");
      expect(r.run.errorCode ?? null).toBeNull();
      expect((await issueRow(r.outside.body.id)).status).not.toBe("blocked");
      expect(r.approvalOut.status, JSON.stringify(r.approvalOut.body)).toBe(201);
      expect(r.approvalAccountable.status, JSON.stringify(r.approvalAccountable.body)).toBe(201);
      expectCapabilitiesRefused(r.capabilities);
      // Nothing refused in either mode (the 422 above is a validation answer, not an access refusal row).
      expect((await activityRows(db, s.companyId, "authz.refused")).length).toBe(refusedBefore);
      gate2Outcomes[mode] = {
        assign: r.assign.status,
        mention: r.mention.status,
        mentionWake: r.mentionWake!.status === "skipped" ? "skipped" : "dispatched",
        run: r.run.status,
        approvalOut: r.approvalOut.status,
        approvalAccountable: r.approvalAccountable.status,
        capabilities: r.capabilities.status,
      };
    }
    // Shadow behaves exactly as off...
    expect(gate2Outcomes.shadow).toEqual(gate2Outcomes.off);
    // ...and logs each out-of-scope contact as a would-be refusal (none in off, none for the escalation contact).
    const logged = await wouldRefuseRows(db, s.companyId);
    const sites = logged.map((row) => `${(row.details as Body).site}:${(row.details as Body).dimension}`).sort();
    expect(sites).toEqual(
      expect.arrayContaining(["approval_routing:talk.people", "heartbeat.run_claim:see.projects", "issues.assign:talk.agents", "wake.dispatch:talk.agents"]),
    );
    for (const row of logged) expect((row.details as Body).policyMode).toBe("shadow");
    expect(logged.some((row) => (row.details as Body).target?.userId === s.accountableUserId)).toBe(false);
    const mentionLogged = logged.filter((row) => (row.details as Body).site === "wake.dispatch" && (row.details as Body).via === "mention");
    expect(mentionLogged).toHaveLength(1);
  }, 120_000);

  it("4. enforce (admin PATCH): an out-of-scope assignment is 403 with the documented body; a mention keeps the comment and withholds the wake; an out-of-scope run is not started and leaves a blocker note; the accountable person stays reachable", async () => {
    const s = requireSeed();
    const modePath = `${companyPath()}/agent-access-enforcement`;
    // Only an admin selects enforce.
    expect((await send(steward(), "patch", modePath, { mode: "enforce" })).status).toBe(403);
    const changed = await send(owner(), "patch", modePath, { mode: "enforce" });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ mode: "enforce", changed: true, previousMode: "shadow" });
    const modeRows = await activityRows(db, s.companyId, "company.agent_access_enforcement_changed");
    expect(modeRows.map((row) => (row.details as Body).to ?? (row.details as Body).mode)).toEqual(["shadow", "enforce"]);

    const issuesBefore = await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, s.companyId));
    const r = await contacts("enforce");

    // issues.assign: 403 ACCESS_POLICY_REFUSED { dimension, rule, requested, allowedSummary, howToRequest }, nothing written.
    expect(r.assign.status, JSON.stringify(r.assign.body)).toBe(403);
    expect(r.assign.body).toMatchObject({
      code: "ACCESS_POLICY_REFUSED",
      dimension: "talk.agents",
      rule: "talk.agents.not_listed",
      requested: { agentId: s.stranger.id, via: "assign" },
    });
    expect(typeof r.assign.body.error).toBe("string");
    expect(typeof r.assign.body.allowedSummary).toBe("string");
    expect(String(r.assign.body.howToRequest)).toContain("GET /api/agents/me/access");
    const strangerIssues = await db.select().from(issues).where(and(eq(issues.companyId, s.companyId), eq(issues.title, "enforce: a request for the Stranger")));
    expect(strangerIssues).toHaveLength(0);

    // wake.dispatch (mention): the comment is kept, the wake withheld (skipped, no run for the Stranger from it).
    expect(r.mention.status, JSON.stringify(r.mention.body)).toBe(201);
    expect(await db.select().from(issueComments).where(eq(issueComments.id, r.mention.body.id))).toHaveLength(1);
    expect(r.mentionWake).toMatchObject({ status: "skipped", reason: "access_policy_refused", runId: null });
    expect(r.mentionRuns).toHaveLength(0);

    // heartbeat.run_claim (see.projects): the run is not started, the issue is blocked with one blocker note by the agent.
    expect(r.run.status).toBe("cancelled");
    expect(r.run.errorCode).toBe("access_policy_refused");
    expect(r.run.startedAt ?? null).toBeNull();
    const blocked = await issueRow(r.outside.body.id);
    expect(blocked.status).toBe("blocked");
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, r.outside.body.id)).orderBy(desc(issueComments.createdAt));
    expect(notes.filter((c) => c.body.startsWith(ACCESS_POLICY_BLOCKER_NOTE_PREFIX))).toHaveLength(1);
    expect(notes[0]!.authorAgentId).toBe(s.analyst.id);

    // approval_routing (talk.people): a member outside the scope is 403 before the approval exists...
    expect(r.approvalOut.status, JSON.stringify(r.approvalOut.body)).toBe(403);
    expect(r.approvalOut.body).toMatchObject({ code: "ACCESS_POLICY_REFUSED", dimension: "talk.people", rule: "talk.people.not_listed", requested: { userId: s.outsiderUserId, purpose: "approval" } });
    expect(String(r.approvalOut.body.allowedSummary)).toContain("always reachable");
    // ...and the escalation path is open: the accountable person is reached although talk.people lists nobody.
    expect(r.approvalAccountable.status, JSON.stringify(r.approvalAccountable.body)).toBe(201);

    // capabilities stays profile-managed.
    expectCapabilitiesRefused(r.capabilities);

    // Each refusal is recorded as authz.refused in enforce, one per row.
    const refused = await activityRows(db, s.companyId, "authz.refused");
    const bySite = refused.map((row) => `${(row.details as Body).site}:${(row.details as Body).dimension}:${(row.details as Body).policyMode}`).sort();
    expect(bySite).toEqual(
      ["approval_routing:talk.people:enforce", "heartbeat.run_claim:see.projects:enforce", "issues.assign:talk.agents:enforce", "wake.dispatch:talk.agents:enforce"].sort(),
    );
    // The board user's own work and the in-scope contact are unaffected: only the outside issue was created.
    const issuesAfter = await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, s.companyId));
    expect(issuesAfter.length - issuesBefore.length).toBe(1);
    // The agent reads its rules and the mode.
    expect((await send(analystActor(), "get", "/api/agents/me/access")).body).toMatchObject({ enforcementMode: "enforce", profileDefined: true });
  }, 120_000);

  // -------------------------------------------------------------------------
  // 5. Three days of the scheduled responsibility; day 3 never runs
  // -------------------------------------------------------------------------

  it("5. the scheduler dispatches day 1 and day 2 at their instants (each recorded as the occurrence it served); both are delivered, one passed by a person, one by an independent agent; day 3 is never dispatched", async () => {
    const s = requireSeed();
    const scheduler = routineService(db);
    const dailyIssueIds: string[] = [];
    for (const [index, at] of [day1, day2].entries()) {
      const tickAt = new Date(at + MINUTE);
      vi.useFakeTimers({ toFake: ["Date"], now: tickAt, shouldAdvanceTime: true });
      let issueId: string;
      try {
        const tick = await scheduler.tickScheduledTriggers(tickAt);
        expect(tick.triggered, `day ${index + 1} dispatch`).toBe(1);
        const [run] = await db.select().from(routineRuns).where(eq(routineRuns.routineId, s.routineId)).orderBy(desc(routineRuns.createdAt)).limit(1);
        expect(run!.linkedIssueId, JSON.stringify(run)).toBeTruthy();
        issueId = run!.linkedIssueId!;
        const [occurrence] = await db.select().from(routineRunOccurrences).where(eq(routineRunOccurrences.routineRunId, run!.id));
        expect(occurrence!.scheduledFor.getTime()).toBe(at);
        expect(Math.abs(run!.triggeredAt.getTime() - tickAt.getTime())).toBeLessThan(10 * MINUTE);
        await endedRunFor(issueId);
        await settleRuns(`day ${index + 1}`);
      } finally {
        vi.useRealTimers();
      }
      dailyIssueIds.push(issueId);
      // The responsibility mapping the dispatch wrote, and the delivery: in review, judged, done.
      const mapped = await send(owner(), "get", `${companyPath()}/issues/${issueId}/responsibility`);
      expect(mapped.body.current, JSON.stringify(mapped.body)).toMatchObject({ responsibilityKey: "daily-digest", agentId: s.analyst.id });
      await patchIssue(owner(), issueId, { status: "in_review" });
      const reviewer = index === 0 ? judge() : agentRequestActor(s.peer);
      const verdict = await send(reviewer, "post", `${companyPath()}/verdicts`, { entityType: "issue", issueId, outcome: "passed", justification: "Read it; the totals reconcile" });
      expect(verdict.status, JSON.stringify(verdict.body)).toBe(201);
      await patchIssue(owner(), issueId, { status: "done" });
      await settleRuns(`day ${index + 1} delivered`);
    }
    // Day 3's tick came due two hours ago; nothing ran for it.
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, s.triggerId));
    expect(trigger!.nextRunAt!.getTime()).toBe(day3);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, s.routineId))).toHaveLength(2);
    state.dailyIssueIds = dailyIssueIds;
  }, 120_000);

  // -------------------------------------------------------------------------
  // 6. Work in the restricted project
  // -------------------------------------------------------------------------

  it("6. work in the restricted project: the analyst answers a board question (mapped to ad-hoc), the archivist does its only work there", async () => {
    const s = requireSeed();
    const make = async (title: string, agentId: string) => {
      const res = await send(owner(), "post", `${companyPath()}/issues`, { title, status: "todo", projectId: s.restrictedProjectId, assigneeAgentId: agentId });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const run = await endedRunFor(res.body.id);
      // In the analyst's see.projects (and the archivist has no V2 policy): the runs start.
      expect(run.status, `${title}: ${run.errorCode}`).toBe("succeeded");
      return { id: res.body.id as string, identifier: res.body.identifier as string, title };
    };
    const analystIssue = await make("Board pack: churn by segment", s.analyst.id);
    const archivistIssue = await make("Board pack: archive the minutes", s.archivist.id);
    const mapped = await send(owner(), "post", `${companyPath()}/issues/${analystIssue.id}/responsibility`, { agentId: s.analyst.id, responsibilityKey: "ad-hoc", reason: "A board question" });
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    for (const issue of [analystIssue, archivistIssue]) await patchIssue(owner(), issue.id, { status: "done" });
    await settleRuns("restricted work");
    state.restricted = { analystIssue, archivistIssue };
  }, 60_000);

  // -------------------------------------------------------------------------
  // 7. Ingest, snapshot, verify, reuse, calibration
  // -------------------------------------------------------------------------

  it("7. ingest, then snapshot: owed 3, delivered 2, day 3 cause_unknown; separate human and automated acceptance; use unknown; verify agrees; a second snapshot reuses the version; calibration items go to the named human", async () => {
    const s = requireSeed();
    expect(state.dailyIssueIds, "step 5 must have delivered two days").toHaveLength(2);
    expect(state.restricted, "step 6 must have run").toBeDefined();
    const [item1, item2] = state.dailyIssueIds!;

    const ingest = await send(owner(), "post", `${companyPath()}/evaluation/ingest/run?backfill=true`);
    expect(ingest.status, JSON.stringify(ingest.body)).toBe(200);
    expect(ingest.body).toMatchObject({ exhausted: true, lockedOut: false });
    expect(ingest.body.inserted).toBeGreaterThan(0);

    const snap = await send(owner(), "post", `${cardsPath(s.analyst.id)}/snapshot`, {});
    expect(snap.status, JSON.stringify(snap.body)).toBe(201);
    expect(snap.body.snapshot).toMatchObject({ version: 1, reused: false, formulaVersion: "agent-metrics/1" });
    expect(snap.body.verify).toMatchObject({ ok: true, status: "agree", version: 1 });
    const card = snap.body.card as AgentCardView;
    expect(card).toMatchObject({ kind: "agent_card_view", restricted: false, contract: { source: "declared" } });

    // E4: owed counts the day nothing ran.
    const obligations = visibleBody(card.worker.obligations, "obligations");
    const daily = obligations.responsibilities.find((row) => row.responsibilityKey === "daily-digest")!;
    expect(daily).toMatchObject({ kind: "scheduled", owed: 3, deliveredItemCount: 2 });
    expect(daily.byEndState).toMatchObject({ delivered_on_time: 2, delivered_late: 0, cause_unknown: 1, not_started: 0, skipped_by_policy: 0, missed: 0 });
    expect(daily.deliveredItems.map((item) => item.id).sort()).toEqual([item1, item2].sort());
    const occurrences = (await caseRows(owner(), s.analyst.id, "&section=obligations&responsibility=daily-digest")).rows;
    expect(occurrences.map((row) => [row.state, row.item?.id ?? null]).sort()).toEqual(
      [["cause_unknown", null], ["delivered_on_time", item1], ["delivered_on_time", item2]].sort(),
    );
    const unknown = occurrences.find((row) => row.state === "cause_unknown")!;
    expect(unknown.caseId).toContain(new Date(day3).toISOString());
    expect(unknown.note).toBe("nothing ran for this tick and no record says why");

    // Human vs automated acceptance are separate facts, per item.
    const acceptance = (await caseRows(owner(), s.analyst.id, "&section=acceptance")).rows;
    const fact = (note: string, id: string) => acceptance.find((row) => row.note === note && row.item?.id === id)?.state;
    // Corrected semantics (gate 3 walkthrough finding, item 3): the acceptance facts are judge-type-specific
    // (evaluation LLD §1). This step used to expect item 1 to be an automated acceptance too, because the
    // `verdict.passed` criterion was credited to the evaluator that read the person's verdict. The criterion is
    // still satisfied by either verdict, but a verdict is its reviewer's judgment: a person's counts as human
    // acceptance only, an independent agent's as automated acceptance only.
    // item 1, passed by a person: human acceptance only — no automated judge passed it.
    expect([fact("human acceptance", item1), fact("automated acceptance", item1), fact("use", item1)]).toEqual(["pass", "unknown", "unknown"]);
    // item 2, passed by an independent agent: automated only — no person accepted it.
    expect([fact("human acceptance", item2), fact("automated acceptance", item2), fact("use", item2)]).toEqual(["unknown", "pass", "unknown"]);
    const facts = visibleBody(card.worker.acceptance, "acceptance").facts;
    const restrictedItem = state.restricted!.analystIssue.id;
    expect(fact("human acceptance", restrictedItem)).toBe("unknown"); // the admin's card also holds the restricted delivery (ad-hoc, no criteria)
    expect(facts.humanAcceptance).toMatchObject({ yes: 1, no: 0, unknown: 2, of: 3 });
    expect(facts.automatedAcceptance).toMatchObject({ yes: 1, no: 0, unknown: 2, of: 3 });
    expect(facts.use).toMatchObject({ yes: 0, unknown: 3, of: 3 });
    // The quality breakdown agrees: each verdict is under its reviewer's kind, none under the evaluator.
    const criterion = visibleBody(card.worker.quality, "quality").criteria.find((row) => row.criterion.criterionId === "reviewed")!;
    expect(criterion.byJudge.person).toMatchObject({ pass: 1, fail: 0 });
    expect(criterion.byJudge.independent_agent).toMatchObject({ pass: 1, fail: 0 });
    expect(criterion.byJudge.evaluator).toMatchObject({ pass: 0, fail: 0 });

    // The independent agent's verdict is a reviewer fact on its own card, judged independent of the producer.
    const peerSnap = await send(owner(), "post", `${cardsPath(s.peer.id)}/snapshot`, {});
    expect(peerSnap.status, JSON.stringify(peerSnap.body)).toBe(201);
    const peerReviewer = visibleBody((peerSnap.body.card as AgentCardView).reviewer, "peer reviewer");
    expect(peerReviewer.reviews).toMatchObject({ total: 1 });
    expect(peerReviewer.independence).toMatchObject({ independent: 1, notIndependent: 0 });
    const peerCases = (await caseRows(owner(), s.peer.id, "&section=reviewer")).rows;
    expect(peerCases.map((row) => [row.item?.id, row.judge, row.state])).toEqual([[item2, "independent_agent", "pass"]]);

    // E3: verify over HTTP; a second snapshot with no new non-evaluator events reuses the version.
    const verify = await send(owner(), "get", `${cardsPath(s.analyst.id)}/verify`);
    expect(verify.body.verify).toMatchObject({ ok: true, status: "agree", version: 1, storedHash: snap.body.snapshot.cardHash, replayHash: snap.body.snapshot.cardHash });
    const again = await send(owner(), "post", `${cardsPath(s.analyst.id)}/snapshot`, {});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.snapshot).toMatchObject({ version: 1, reused: true, throughSeq: snap.body.snapshot.throughSeq, cardHash: snap.body.snapshot.cardHash });

    // E7: the calibration sample (sampleRate 1) became review items assigned to the named human, todo; none withheld.
    const items = snap.body.snapshot.reviewItems as Body;
    expect(items.withheld).toEqual([]);
    expect(items.created.length).toBeGreaterThan(0);
    const created = await db.select().from(issues).where(inArray(issues.id, items.created as string[]));
    const forJudge = created.filter((row) => row.assigneeUserId === s.judgeUserId);
    expect(forJudge.length, JSON.stringify(created.map((row) => [row.title, row.assigneeUserId]))).toBe(2);
    for (const row of forJudge) {
      expect(row).toMatchObject({ status: "todo", assigneeAgentId: null });
      expect(row.title).toMatch(/^Calibration — Analyst: /);
      expect(row.description).toContain("criterion_attest");
    }
    const sampledItems = forJudge.map((row) => [item1, item2].find((id) => row.description!.includes(id))).sort();
    expect(sampledItems).toEqual([item1, item2].sort());
    expect(again.body.snapshot.reviewItems.created).toEqual([]); // idempotent by key
    state.snapshot1 = snap.body;
  }, 120_000);

  // -------------------------------------------------------------------------
  // 8. use_confirmed
  // -------------------------------------------------------------------------

  it("8. a use_confirmed disposition by a person makes use count on the next version; both versions still verify", async () => {
    const s = requireSeed();
    expect(state.snapshot1, "step 7 must have stored version 1").toBeDefined();
    const [item1, item2] = state.dailyIssueIds!;
    const used = await send(accountable(), "post", `${companyPath()}/evaluation/dispositions`, { kind: "use_confirmed", subjectRef: { kind: "agent", id: s.analyst.id }, item: { kind: "issue", id: item1 } });
    expect(used.status, JSON.stringify(used.body)).toBe(201);
    const snap = await send(owner(), "post", `${cardsPath(s.analyst.id)}/snapshot`, {});
    expect(snap.status, JSON.stringify(snap.body)).toBe(201);
    expect(snap.body.snapshot).toMatchObject({ version: 2, reused: false });
    expect(snap.body.verify).toMatchObject({ ok: true, status: "agree", version: 2 });
    const facts = visibleBody((snap.body.card as AgentCardView).worker.acceptance, "acceptance").facts;
    expect(facts.use).toMatchObject({ yes: 1, unknown: 2, of: 3 });
    // The other facts did not move: use implies no acceptance and acceptance implies no use.
    expect(facts.humanAcceptance).toMatchObject({ yes: 1, unknown: 2 });
    expect(facts.automatedAcceptance).toMatchObject({ yes: 1, unknown: 2 }); // judge-type-specific, as in step 7
    const acceptance = (await caseRows(owner(), s.analyst.id, "&section=acceptance")).rows;
    expect(acceptance.find((row) => row.note === "use" && row.item?.id === item1)?.state).toBe("pass");
    expect(acceptance.find((row) => row.note === "use" && row.item?.id === item2)?.state).toBe("unknown");
    expect((await send(owner(), "get", `${cardsPath(s.analyst.id)}/verify?version=1`)).body.verify).toMatchObject({ ok: true, version: 1 });
    state.snapshot2 = snap.body;
  }, 60_000);

  // -------------------------------------------------------------------------
  // 9. A steward without access to the restricted project
  // -------------------------------------------------------------------------

  it("9. a steward off the restricted project's access list: its work is in neither the events API, the card (no counts) nor the cases; an admin sees it", async () => {
    const s = requireSeed();
    expect(state.snapshot2, "step 8 must have stored version 2").toBeDefined();
    const { analystIssue, archivistIssue } = state.restricted!;
    const secrets = [analystIssue.id, analystIssue.identifier, analystIssue.title, archivistIssue.id, archivistIssue.identifier, archivistIssue.title, s.restrictedProjectId];
    const leaks = (payload: unknown) => secrets.filter((secret) => JSON.stringify(payload).includes(secret));

    // Events API.
    const restrictedEvents = await db
      .select({ id: evaluationEvents.id, accessClass: evaluationEvents.accessClass })
      .from(evaluationEvents)
      .where(and(eq(evaluationEvents.companyId, s.companyId), eq(evaluationEvents.projectId, s.restrictedProjectId)));
    expect(restrictedEvents.length).toBeGreaterThan(0);
    for (const row of restrictedEvents) expect(row.accessClass).toBe(`project:${s.restrictedProjectId}`);
    const stewardEvents = await send(steward(), "get", `${companyPath()}/evaluation/events?limit=5000`);
    expect(stewardEvents.status).toBe(200);
    expect(stewardEvents.body.count).toBeGreaterThan(0);
    expect(leaks(stewardEvents.body)).toEqual([]);
    expect((await send(steward(), "get", `${companyPath()}/evaluation/events/${restrictedEvents[0]!.id}`)).status).toBe(404);
    const adminEvents = await send(owner(), "get", `${companyPath()}/evaluation/events?limit=5000`);
    const adminIds = new Set((adminEvents.body.events as Body[]).map((e) => e.id));
    expect(restrictedEvents.every((row) => adminIds.has(row.id))).toBe(true);
    expect((await send(owner(), "get", `${companyPath()}/evaluation/events/${restrictedEvents[0]!.id}`)).status).toBe(200);

    // The analyst's card (mixed): the steward's numbers are computed only from what it can read.
    const stewardCard = (await send(steward(), "get", cardsPath(s.analyst.id))).body.card as AgentCardView;
    const adminCard = (await send(owner(), "get", cardsPath(s.analyst.id))).body.card as AgentCardView;
    expect(stewardCard).toMatchObject({ restricted: true, stored: { version: 2 } });
    expect(leaks(stewardCard)).toEqual([]);
    expect(leaks(adminCard).length).toBeGreaterThan(0);
    const adHoc = (card: AgentCardView) => visibleBody(card.worker.obligations, "obligations").responsibilities.find((row) => row.responsibilityKey === "ad-hoc")!;
    expect(adHoc(adminCard)).toMatchObject({ owed: 1, deliveredItemCount: 1 });
    expect(adHoc(stewardCard)).toMatchObject({ owed: 0, deliveredItemCount: 0 });
    expect(stewardCard.worker.obligations.visibility).toBe("partial");
    // The responsibility the steward can read is whole: owed 3, delivered 2.
    expect(visibleBody(stewardCard.worker.obligations, "obligations").responsibilities.find((row) => row.responsibilityKey === "daily-digest")).toMatchObject({ owed: 3, deliveredItemCount: 2 });
    expect(visibleBody(stewardCard.worker.acceptance, "acceptance").facts.humanAcceptance).toMatchObject({ yes: 1, of: 2 });

    // The archivist's card rests only on the restricted project: "Not visible to you", with no body and no counts.
    const archivistSnap = await send(owner(), "post", `${cardsPath(s.archivist.id)}/snapshot`, {});
    expect(archivistSnap.status, JSON.stringify(archivistSnap.body)).toBe(201);
    const archivistAdmin = (await send(owner(), "get", cardsPath(s.archivist.id))).body.card as AgentCardView;
    expect(visibleBody(archivistAdmin.worker.obligations, "obligations").unmapped.items).toBe(1);
    const archivistSteward = (await send(steward(), "get", cardsPath(s.archivist.id))).body.card as AgentCardView;
    expect(archivistSteward.worker.obligations).toEqual({ visibility: "not_visible", note: "Not visible to you" });
    expect(archivistSteward.worker.acceptance).toEqual({ visibility: "not_visible", note: "Not visible to you" });
    expect(leaks(archivistSteward)).toEqual([]);
    const list = await send(steward(), "get", `${companyPath()}/evaluation/agents`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const summary = (agentId: string) => (list.body.agents as Body[]).find((row) => row.agentId === agentId);
    expect(summary(s.archivist.id)).toMatchObject({ obligations: null, restricted: true });
    expect(summary(s.analyst.id).obligations).toEqual(
      expect.arrayContaining([
        { responsibilityKey: "daily-digest", owed: 3, delivered: 2 },
        { responsibilityKey: "ad-hoc", owed: 0, delivered: 0 },
      ]),
    );
    expect(leaks(list.body)).toEqual([]);

    // Cases: filtered by class before counting.
    for (const agentId of [s.analyst.id, s.archivist.id]) {
      const stewardCases = await caseRows(steward(), agentId);
      const adminCases = await caseRows(owner(), agentId);
      expect(leaks(stewardCases)).toEqual([]);
      expect(adminCases.rows.some((row) => row.item?.id === analystIssue.id || row.item?.id === archivistIssue.id)).toBe(true);
      expect(stewardCases.total).toBeLessThan(adminCases.total);
    }
    expect((await caseRows(steward(), s.archivist.id)).total).toBe(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 10. The milestone card and the declared formula bump
  // -------------------------------------------------------------------------

  it("10. the Reporting milestone card differs from the pre-gate-3 formula (m2-score/8) only by the declared bump", async () => {
    const s = requireSeed();
    const ref = { kind: "project" as const, id: s.reportingProjectId };
    const replay = await send(owner(), "get", `${companyPath()}/evaluation/replay?kind=project&id=${s.reportingProjectId}`);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    const current = replay.body.card as Body;
    expect(current.formulaVersion).toBe("m2-score/9");
    expect(MILESTONE_FORMULA_VERSION).toBe("m2-score/9");
    expect(current.contract).toMatchObject({ source: "declared", invalidVersions: 0 });

    const throughSeq = replay.body.throughSeq as number;
    const window = await evaluationLedger(db).windowUpTo(s.companyId, throughSeq);
    const fallbackOpen = await evaluationReplay(db).milestoneOpen(s.companyId, ref);
    // The project carries agent-side source events (routine, profile, responsibility) — the inputs the bump excludes.
    const agentSide = window.filter((e) => !isMilestoneInput(e));
    expect(agentSide.filter((e) => e.projectId === s.reportingProjectId).length).toBeGreaterThan(0);
    // ...and real milestone work: the two delivered digests with their verdicts.
    expect(window.filter((e) => e.projectId === s.reportingProjectId && e.eventType === "verdict.recorded")).toHaveLength(2);
    // The HTTP card is the current formula over this window.
    expect(JSON.parse(JSON.stringify(scoreMilestone(window, ref, throughSeq, s.companyId, { fallbackOpen })))).toEqual(current);

    const pre = await loadPreGate3MilestoneScoring();
    try {
      expect(pre.mod.FORMULA_VERSION).toBe("m2-score/8");
      const normalize = (card: Body) => ({ ...JSON.parse(JSON.stringify(card)), formulaVersion: "<formula>" });
      // The declared rule (card.ts m2-score/9, decisions log "APM gate 3"): agent-side sources are not milestone inputs.
      // Under the old formula over the inputs the new one declares, the card is the same apart from its version.
      const baseline = pre.mod.scoreMilestone(window.filter(isMilestoneInput), ref, throughSeq, s.companyId, { fallbackOpen });
      expect((baseline as Body).formulaVersion).toBe("m2-score/8");
      expect(normalize(baseline)).toEqual(normalize(current));
      // The bump was needed: the old formula over the raw window counts the agent-side events into the card.
      const unbumped = pre.mod.scoreMilestone(window, ref, throughSeq, s.companyId, { fallbackOpen });
      expect(normalize(unbumped)).not.toEqual(normalize(current));
    } finally {
      rmSync(pre.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("leaves the wakes settled", async () => {
    await settleRuns("end");
  });
});
