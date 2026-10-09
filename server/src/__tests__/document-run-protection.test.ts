// AgentDash (per-steward document access, slice 6b): the three protections
// that gate `document_access_enabled`, against a real database and the real
// heartbeat, routers and run-log store.
//
// 1. Persist-time strip: a run whose output carries framed document text
//    (including a begin marker split across two stdout writes) leaves no
//    sentinel in heartbeat_run_events, the run row or the log file on disk;
//    an unmatched marker is left intact.
// 2. Readership: with the flag on, run detail/events/log answer 404 to a
//    company member who is not the agent's current steward (and to a company
//    admin), 200 to the steward and to an instance admin; flag off unchanged.
// 3. Retention: the purge deletes only rows/files older than the window, and
//    only for flagged companies.
import express from "express";
// These fixtures inject req.actor without running the auth middleware, so no
// verified credential exists (same arrangement as agent-visibility-routes).
vi.mock("../services/issue-current-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-current-authority.js")>()),
  issueCurrentAuthority: () => undefined,
}));
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentStewardships,
  agentTaskSessions,
  agents,
  companies,
  companyMemberships,
  createDb,
  feedbackExports,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { featureFlagsService } from "../services/feature-flags.ts";
import { frameUntrustedDocumentText } from "../services/document-content.ts";
import { pruneDocumentRunData } from "../services/document-run-retention.ts";
import { resetRunLogStoreForTests, runLogBasePath } from "../services/run-log-store.ts";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.ts";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { issueRoutes } from "../routes/issues.js";
import { feedbackService } from "../services/feedback.ts";
import { getRunLogStore } from "../services/run-log-store.ts";
import { workspacePersistenceHold } from "../services/workspace-persistence-recovery.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.ts";
import { ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS } from "../services/heartbeat.ts";
import { errorHandler } from "../middleware/index.js";
import { createLiveEventVisibility } from "../realtime/live-event-visibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SENTINEL = "SENTINEL-confidential-body-7c2e";
const DAY_MS = 24 * 60 * 60 * 1000;

const FAKE_ADAPTER = "document_strip_test";
type FakeBehaviour = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
const behaviours = new Map<string, FakeBehaviour>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRunToFinish(heartbeat: ReturnType<typeof heartbeatService>, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("document run protection (slice 6b)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  const saved: Record<string, string | undefined> = {};

  const FLAGGED = randomUUID();
  const UNFLAGGED = randomUUID();
  const STEWARD = "steward-user";
  const SECOND_STEWARD = "second-steward-user";
  const MEMBER = "member-user";
  const COMPANY_ADMIN = "company-admin-user";
  const FLAGGED_AGENT = randomUUID();
  const UNFLAGGED_AGENT = randomUUID();

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY", "RUN_LOG_BASE_PATH"]) {
      saved[key] = process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), "document-run-protection-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "document-run-protection-test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "c".repeat(64);
    process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("document-run-protection-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values([
      { id: FLAGGED, name: "Flagged Co", issuePrefix: "DRF", requireBoardApprovalForNewAgents: false },
      { id: UNFLAGGED, name: "Plain Co", issuePrefix: "DRP", requireBoardApprovalForNewAgents: false },
    ]);
    for (const companyId of [FLAGGED, UNFLAGGED]) {
      for (const [userId, role] of [
        [STEWARD, "member"],
        [SECOND_STEWARD, "member"],
        [MEMBER, "member"],
        [COMPANY_ADMIN, "admin"],
      ] as const) {
        await db.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: role,
        });
      }
    }
    await featureFlagsService(db).set(FLAGGED, FEATURE_FLAG_KEYS.DOCUMENT_ACCESS, true);
    // An adapter whose behaviour each test scripts, so a frame can be minted
    // for the run id the heartbeat assigns (frames are bound to their run).
    registerServerAdapter({
      type: FAKE_ADAPTER,
      execute: async (ctx) => {
        const behaviour = behaviours.get(ctx.agent.id);
        if (!behaviour) return { exitCode: 0, signal: null, timedOut: false };
        return behaviour(ctx);
      },
      testEnvironment: async () => ({ adapterType: FAKE_ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    } as never);
  }, 60_000);

  afterAll(async () => {
    unregisterServerAdapter(FAKE_ADAPTER);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    await rm(home, { recursive: true, force: true });
  });

  async function seedAgent(id: string, companyId: string, script: string, stewardUserId = STEWARD, adapterType = "process") {
    await db.insert(agents).values({
      id,
      companyId,
      name: `Agent ${id.slice(0, 4)}`,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: adapterType === "process" ? { command: process.execPath, args: ["-e", script] } : {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentStewardships).values({ companyId, agentId: id, userId: stewardUserId });
  }

  function appAs(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use("/api", activityRoutes(db));
    app.use("/api", dashboardRoutes(db));
    app.use("/api", issueRoutes(db));
    app.use(errorHandler);
    return app;
  }
  const asUser = (userId: string, role: string) => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [FLAGGED, UNFLAGGED],
    memberships: [
      { companyId: FLAGGED, membershipRole: role, status: "active" },
      { companyId: UNFLAGGED, membershipRole: role, status: "active" },
    ],
  });
  // The auth middleware lists every company for an instance admin.
  const asInstanceAdmin = () => ({
    type: "board",
    source: "session",
    userId: "instance-admin-user",
    isInstanceAdmin: true,
    companyIds: [FLAGGED, UNFLAGGED],
    memberships: [],
  });

  const asAgent = (agentId: string) => ({
    type: "agent",
    agentId,
    companyId: FLAGGED,
    source: "agent_key",
    companyIds: [FLAGGED],
  });

  let flaggedRunId = "";
  let unflaggedRunId = "";

  it("strips framed document text from the log file, run events, run row and runtime state; leaves an unmatched marker", async () => {
    const unmatched = `[[agentdash-untrusted-document:end nonce=${"b".repeat(32)}]]`;
    await seedAgent(FLAGGED_AGENT, FLAGGED, "", STEWARD, FAKE_ADAPTER);
    behaviours.set(FLAGGED_AGENT, async (ctx) => {
      const framed = frameUntrustedDocumentText("microsoft", `Budget line: ${SENTINEL}\nNext line.`, {
        runId: ctx.runId,
        docId: "item-42",
        title: "Board pack.docx",
      });
      await ctx.onMeta?.({ adapterType: FAKE_ADAPTER, command: "fake", prompt: `previous tool result: ${framed}` });
      const output = `tool result follows\n${framed}\ndone\n`;
      // Split INSIDE the begin marker, so the two halves arrive as two chunks.
      const splitAt = output.indexOf("[[agentdash-untrusted-document:begin") + 20;
      await ctx.onLog("stdout", output.slice(0, splitAt));
      await sleep(50);
      await ctx.onLog("stdout", output.slice(splitAt));
      await ctx.onLog("stdout", `stray ${unmatched}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `tool failed after reading ${framed}`,
        resultJson: { stdout: output },
      };
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(FLAGGED_AGENT, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(["failed", "succeeded"]).toContain(finished?.status);
    flaggedRunId = queued!.id;

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, flaggedRunId));
    expect(row!.logRef).toBeTruthy();
    const rawLog = await readFile(join(runLogBasePath(), row!.logRef!), "utf8");
    expect(rawLog).not.toContain(SENTINEL);
    expect(rawLog).toContain("[document text withheld: item-42 Board pack.docx");
    expect(rawLog).toContain(unmatched);
    expect(JSON.stringify(row)).not.toContain(SENTINEL);

    // The adapter.invoke event carries the prompt (and so the framed text).
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, flaggedRunId));
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
    expect(JSON.stringify(events)).toContain("[document text withheld: item-42");

    // Review fix 6: the adapter's error message is stored as lastError too.
    const runtime = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, FLAGGED_AGENT));
    expect(runtime.length).toBeGreaterThan(0);
    expect(JSON.stringify(runtime)).not.toContain(SENTINEL);
    expect(JSON.stringify(await db.select().from(agentTaskSessions))).not.toContain(SENTINEL);
  }, 30_000);

  // Review fix 4: while a frame is held the stripper emits nothing; liveness
  // must follow raw output, or a long read looks like a stalled run.
  it("bumps run liveness on raw output while a frame is being held", async () => {
    const liveAgent = randomUUID();
    await seedAgent(liveAgent, FLAGGED, "", "liveness-steward", FAKE_ADAPTER);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    behaviours.set(liveAgent, async (ctx) => {
      const framed = frameUntrustedDocumentText("microsoft", `Held ${SENTINEL}`, { runId: ctx.runId, docId: "item-5" });
      const beginAt = framed.indexOf("[[agentdash-untrusted-document:begin");
      // The very first output is the start of a frame: nothing can be emitted.
      await ctx.onLog("stdout", framed.slice(beginAt, beginAt + framed.slice(beginAt).indexOf(SENTINEL) + 4));
      await Promise.race([released, sleep(8_000)]);
      await ctx.onLog("stdout", `${framed.slice(beginAt + framed.slice(beginAt).indexOf(SENTINEL) + 4)}\n`);
      return { exitCode: 0, signal: null, timedOut: false };
    });
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(liveAgent, "on_demand", {}, "manual");
    let lastOutputAt: Date | null = null;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !lastOutputAt) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
      lastOutputAt = row?.lastOutputAt ?? null;
      if (!lastOutputAt) await sleep(100);
    }
    release();
    expect(lastOutputAt).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    const rawLog = await readFile(join(runLogBasePath(), finished!.logRef!), "utf8");
    expect(rawLog).not.toContain(SENTINEL);
    expect(rawLog).toContain("[document text withheld: item-5");
  }, 30_000);

  it("run detail, events and log are steward-only while the flag is on", async () => {
    expect(flaggedRunId).not.toBe("");
    const paths = [`/api/heartbeat-runs/${flaggedRunId}`, `/api/heartbeat-runs/${flaggedRunId}/events`, `/api/heartbeat-runs/${flaggedRunId}/log`];
    for (const path of paths) {
      expect((await request(appAs(asUser(MEMBER, "member"))).get(path)).status, `member ${path}`).toBe(404);
      expect((await request(appAs(asUser(COMPANY_ADMIN, "admin"))).get(path)).status, `company admin ${path}`).toBe(404);
      expect((await request(appAs(asUser(STEWARD, "member"))).get(path)).status, `steward ${path}`).toBe(200);
      expect((await request(appAs(asInstanceAdmin())).get(path)).status, `instance admin ${path}`).toBe(200);
      // Review fix 7: the agent reads its own runs (it saw the content live);
      // another agent of the same company does not.
      expect((await request(appAs(asAgent(FLAGGED_AGENT))).get(path)).status, `own agent ${path}`).toBe(200);
      expect((await request(appAs(asAgent(randomUUID()))).get(path)).status, `other agent ${path}`).toBe(404);
    }
  });

  it("listings keep the row but drop its free text for a non-steward", async () => {
    const failedRun = randomUUID();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: FLAGGED, title: "Pack review", status: "todo" });
    await db.insert(heartbeatRuns).values({
      id: failedRun,
      companyId: FLAGGED,
      agentId: FLAGGED_AGENT,
      invocationSource: "on_demand",
      status: "failed",
      error: "adapter said: quarterly figures",
      resultJson: { summary: "summary quoting figures" },
      contextSnapshot: { issueId },
    });

    // The issue's run listing: row kept, free text dropped for a non-steward.
    const memberIssueRuns = await request(appAs(asUser(MEMBER, "member"))).get(`/api/issues/${issueId}/runs`);
    expect(memberIssueRuns.status).toBe(200);
    const memberIssueRow = (memberIssueRuns.body as Array<Record<string, unknown>>).find((r) => r.runId === failedRun);
    expect(memberIssueRow).toBeDefined();
    expect(JSON.stringify(memberIssueRow)).not.toContain("quarterly figures");
    expect(JSON.stringify(memberIssueRow)).not.toContain("summary quoting");
    const stewardIssueRuns = await request(appAs(asUser(STEWARD, "member"))).get(`/api/issues/${issueId}/runs`);
    const stewardIssueRow = (stewardIssueRuns.body as Array<Record<string, unknown>>).find((r) => r.runId === failedRun);
    expect(stewardIssueRow!.error).toBe("adapter said: quarterly figures");
    const memberList = await request(appAs(asUser(MEMBER, "member"))).get(`/api/companies/${FLAGGED}/heartbeat-runs`);
    expect(memberList.status).toBe(200);
    const memberRow = (memberList.body as Array<Record<string, unknown>>).find((r) => r.id === failedRun);
    expect(memberRow).toBeDefined();
    expect(memberRow!.status).toBe("failed");
    expect(memberRow!.error ?? null).toBeNull();
    expect(memberRow!.resultSummary ?? null).toBeNull();
    expect(JSON.stringify(memberRow)).not.toContain("quarterly figures");

    // And the run itself is 404 to the member.
    expect((await request(appAs(asUser(MEMBER, "member"))).get(`/api/heartbeat-runs/${failedRun}`)).status).toBe(404);

    const stewardList = await request(appAs(asUser(STEWARD, "member"))).get(`/api/companies/${FLAGGED}/heartbeat-runs`);
    const stewardRow = (stewardList.body as Array<Record<string, unknown>>).find((r) => r.id === failedRun);
    expect(stewardRow!.error).toBe("adapter said: quarterly figures");
  });

  // Review fix 6: the free-text progress fields of a live run are content too.
  it("live-run views drop nextAction, livenessReason and the dashboard's last step for a non-steward", async () => {
    const liveRun = randomUUID();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: FLAGGED, title: "Live review", status: "in_progress", assigneeAgentId: FLAGGED_AGENT });
    await db.insert(heartbeatRuns).values({
      id: liveRun,
      companyId: FLAGGED,
      agentId: FLAGGED_AGENT,
      invocationSource: "on_demand",
      status: "running",
      startedAt: new Date(),
      nextAction: "next: compare the quarterly figures",
      livenessReason: "reading the quarterly figures",
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: liveRun }).where(eq(issues.id, issueId));
    try {
      const views = async (actor: Record<string, unknown>) => {
        const app = appAs(actor);
        const companyLive = (await request(app).get(`/api/companies/${FLAGGED}/live-runs`)).body as Array<Record<string, unknown>>;
        const issueLive = (await request(app).get(`/api/issues/${issueId}/live-runs`)).body as Array<Record<string, unknown>>;
        const active = (await request(app).get(`/api/issues/${issueId}/active-run`)).body as Record<string, unknown> | null;
        const working = (await request(app).get(`/api/companies/${FLAGGED}/dashboard/working-now`)).body as { items: Array<Record<string, unknown>> };
        const list = (await request(app).get(`/api/companies/${FLAGGED}/heartbeat-runs`)).body as Array<Record<string, unknown>>;
        return [
          companyLive.find((r) => r.id === liveRun),
          issueLive.find((r) => r.id === liveRun),
          active,
          working.items.find((r) => r.runId === liveRun),
          list.find((r) => r.id === liveRun),
        ];
      };
      const memberViews = await views(asUser(MEMBER, "member"));
      for (const view of memberViews) {
        expect(view).toBeTruthy();
        expect(JSON.stringify(view)).not.toContain("quarterly figures");
      }
      const stewardViews = await views(asUser(STEWARD, "member"));
      expect(stewardViews[0]!.nextAction).toBe("next: compare the quarterly figures");
      expect(stewardViews[3]!.lastStep).toBe("next: compare the quarterly figures");
    } finally {
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, liveRun));
    }
  });

  it("ending the stewardship closes the run to the former steward", async () => {
    const otherAgent = randomUUID();
    await seedAgent(otherAgent, FLAGGED, "process.exit(0);", SECOND_STEWARD);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: FLAGGED, agentId: otherAgent, invocationSource: "on_demand", status: "succeeded" });
    const path = `/api/heartbeat-runs/${runId}/events`;
    expect((await request(appAs(asUser(SECOND_STEWARD, "member"))).get(path)).status).toBe(200);
    // The steward of a different agent is not this agent's steward.
    expect((await request(appAs(asUser(STEWARD, "member"))).get(path)).status).toBe(404);
    await db.update(agentStewardships).set({ endedAt: new Date() }).where(eq(agentStewardships.agentId, otherAgent));
    expect((await request(appAs(asUser(SECOND_STEWARD, "member"))).get(path)).status).toBe(404);
  });

  it("flag off: company members read runs as before", async () => {
    await seedAgent(UNFLAGGED_AGENT, UNFLAGGED, "process.exit(0);");
    unflaggedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: unflaggedRunId,
      companyId: UNFLAGGED,
      agentId: UNFLAGGED_AGENT,
      invocationSource: "on_demand",
      status: "failed",
      error: "plain error",
    });
    for (const path of [`/api/heartbeat-runs/${unflaggedRunId}`, `/api/heartbeat-runs/${unflaggedRunId}/events`, `/api/heartbeat-runs/${unflaggedRunId}/log`]) {
      expect((await request(appAs(asUser(MEMBER, "member"))).get(path)).status, path).toBe(200);
    }
    const list = await request(appAs(asUser(MEMBER, "member"))).get(`/api/companies/${UNFLAGGED}/heartbeat-runs`);
    const row = (list.body as Array<Record<string, unknown>>).find((r) => r.id === unflaggedRunId);
    expect(row!.error).toBe("plain error");
  });

  it("live run log/event messages reach only the steward and instance admins while the flag is on", async () => {
    const visibility = createLiveEventVisibility(db);
    const filterFor = (companyId: string, actor: Record<string, unknown>) =>
      visibility.createSubscriberFilter({ companyId, loadActor: async () => actor as never });
    const event = (companyId: string, runId: string, agentId: string, type: string, payload: Record<string, unknown> = {}) => ({
      id: Date.now(),
      companyId,
      type,
      createdAt: new Date().toISOString(),
      payload: { runId, agentId, ...payload },
    }) as never;

    const flaggedLog = event(FLAGGED, flaggedRunId, FLAGGED_AGENT, "heartbeat.run.log", { chunk: "x" });
    const flaggedEvent = event(FLAGGED, flaggedRunId, FLAGGED_AGENT, "heartbeat.run.event", { message: "x" });
    for (const e of [flaggedLog, flaggedEvent]) {
      expect(await filterFor(FLAGGED, asUser(MEMBER, "member"))(e)).toBe(false);
      expect(await filterFor(FLAGGED, asUser(COMPANY_ADMIN, "admin"))(e)).toBe(false);
      expect(await filterFor(FLAGGED, asUser(STEWARD, "member"))(e)).toBe(true);
      expect(await filterFor(FLAGGED, asInstanceAdmin())(e)).toBe(true);
      expect(await filterFor(FLAGGED, asAgent(FLAGGED_AGENT))(e)).toBe(true);
      expect(await filterFor(FLAGGED, asAgent(randomUUID()))(e)).toBe(false);
    }

    // Status events still arrive, without their error text.
    const status = event(FLAGGED, flaggedRunId, FLAGGED_AGENT, "heartbeat.run.status", { status: "failed", error: "quarterly figures" });
    const memberFilter = filterFor(FLAGGED, asUser(MEMBER, "member"));
    expect(await memberFilter(status)).toBe(true);
    expect(((await memberFilter.redactForSubscriber(status)) as { payload: { error: unknown } }).payload.error).toBeNull();
    const stewardFilter = filterFor(FLAGGED, asUser(STEWARD, "member"));
    expect(((await stewardFilter.redactForSubscriber(status)) as { payload: { error: unknown } }).payload.error).toBe("quarterly figures");

    // Flag off: unchanged.
    const plainLog = event(UNFLAGGED, unflaggedRunId, UNFLAGGED_AGENT, "heartbeat.run.log", { chunk: "x" });
    expect(await filterFor(UNFLAGGED, asUser(MEMBER, "member"))(plainLog)).toBe(true);
  });

  it("retention purges only rows and log files older than the window, only for flagged companies", async () => {
    const base = await mkdtemp(join(home, "retention-logs-"));
    const now = new Date();
    const old = new Date(now.getTime() - 40 * DAY_MS);
    const recent = new Date(now.getTime() - 1 * DAY_MS);

    async function seedRun(companyId: string, agentId: string, finishedAt: Date) {
      const id = randomUUID();
      const logRef = `${companyId}/${agentId}/${id}.ndjson`;
      await mkdir(join(base, companyId, agentId), { recursive: true });
      await writeFile(join(base, logRef), "{}\n", "utf8");
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: finishedAt,
        finishedAt,
        logStore: "local_file",
        logRef,
        error: "error quoting figures",
        stdoutExcerpt: "stdout quoting figures",
        stderrExcerpt: "stderr quoting figures",
        // Operational keys the purge must keep: an unresolved workspace
        // quarantine (only an audited person may lift it), run facts and cost.
        resultJson: {
          summary: "result quoting figures",
          stdout: "stdout quoting figures",
          workspacePersistence: { workspaceId: `ws-${id}`, issueId: null, recoveryRequired: true, outcome: "uncertain" },
          runFacts: { outcome: "no_op", meteringStatus: "metered", inputTokens: 10 },
          total_cost_usd: 1.25,
        },
        usageJson: { workspacePersistenceAttemptId: `ws-${id}` },
        nextAction: "next quoting figures",
        livenessReason: "liveness quoting figures",
        contextSnapshot: { issueId: null, taskKey: "task-1", paperclipSessionHandoffMarkdown: "handoff quoting figures" },
      });
      await db.insert(heartbeatRunEvents).values({
        companyId,
        runId: id,
        agentId,
        seq: 1,
        eventType: "lifecycle",
        message: "run started",
        createdAt: finishedAt,
      });
      return { id, logPath: join(base, logRef) };
    }

    const flaggedOld = await seedRun(FLAGGED, FLAGGED_AGENT, old);
    const flaggedRecent = await seedRun(FLAGGED, FLAGGED_AGENT, recent);
    const unflaggedOld = await seedRun(UNFLAGGED, UNFLAGGED_AGENT, old);

    const result = await pruneDocumentRunData(db, { retentionDays: 30, now, basePath: base });
    expect(result.companies).toBe(1);
    expect(result.logFilesDeleted).toBe(1);

    const eventsOf = (runId: string) => db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(await eventsOf(flaggedOld.id)).toHaveLength(0);
    expect(await eventsOf(flaggedRecent.id)).toHaveLength(1);
    expect(await eventsOf(unflaggedOld.id)).toHaveLength(1);
    // The earlier run's events (written just now) are inside the window.
    expect((await eventsOf(flaggedRunId)).length).toBeGreaterThan(0);

    await expect(stat(flaggedOld.logPath)).rejects.toThrow();
    await expect(stat(flaggedRecent.logPath)).resolves.toBeTruthy();
    await expect(stat(unflaggedOld.logPath)).resolves.toBeTruthy();

    const [oldRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, flaggedOld.id));
    expect(oldRow!.logRef).toBeNull();
    // Review fix 6: the purged run keeps no free text either.
    expect(JSON.stringify(oldRow)).not.toContain("quoting figures");
    expect((oldRow!.contextSnapshot as Record<string, unknown>).taskKey).toBe("task-1");
    // Re-review fix 2: the quarantine, run facts and cost survive the purge.
    const keptResult = oldRow!.resultJson as Record<string, unknown>;
    expect((keptResult.workspacePersistence as Record<string, unknown>).recoveryRequired).toBe(true);
    expect((keptResult.runFacts as Record<string, unknown>).inputTokens).toBe(10);
    expect(keptResult.total_cost_usd).toBe(1.25);
    expect(keptResult.summary).toBeUndefined();
    expect(await workspacePersistenceHold(db, FLAGGED, FLAGGED_AGENT, null)).toMatchObject({ runId: flaggedOld.id });
    const listed = (await request(appAs(asUser(STEWARD, "member"))).get(`/api/companies/${FLAGGED}/heartbeat-runs`)).body as Array<Record<string, unknown>>;
    // The listing projects cost either as resultTotalCostUsd or, on a
    // legacy-encoding database (as in this test), inside a trimmed resultJson.
    const listedRow = listed.find((r) => r.id === flaggedOld.id)!;
    const listedCost = listedRow.resultTotalCostUsd ?? (listedRow.resultJson as Record<string, unknown> | null)?.total_cost_usd;
    expect(Number(listedCost)).toBe(1.25);
    expect(oldRow!.status).toBe("succeeded");
    const [recentRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, flaggedRecent.id));
    expect(recentRow!.logRef).not.toBeNull();
    expect(recentRow!.stdoutExcerpt).toBe("stdout quoting figures");
    const [unflaggedRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unflaggedOld.id));
    expect(unflaggedRow!.stdoutExcerpt).toBe("stdout quoting figures");

    // The log route answers an empty, missing log for a purged run.
    const log = await request(appAs(asUser(STEWARD, "member"))).get(`/api/heartbeat-runs/${flaggedOld.id}/log`);
    expect(log.status).toBe(200);
    expect(log.body.missing).toBe(true);
  });

  // Review fix 2: feedback trace bundles carry the run's log, events and the
  // adapter's own transcript files, and sharing uploads them off-instance.
  it("feedback trace bundles follow the steward rule, omit adapter transcripts and are never shared when flagged", async () => {
    const claudeDir = await mkdtemp(join(home, "claude-config-"));
    const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const TRANSCRIPT_SENTINEL = "ADAPTER-TRANSCRIPT-SENTINEL";
    try {
      async function seedTrace(companyId: string, stewardUserId: string) {
        const agentId = randomUUID();
        await seedAgent(agentId, companyId, "", stewardUserId, "claude_local");
        const runId = randomUUID();
        const sessionId = `sess-${runId.slice(0, 8)}`;
        await mkdir(join(claudeDir, "projects", "p"), { recursive: true });
        await writeFile(join(claudeDir, "projects", "p", `${sessionId}.jsonl`), `{"text":"${TRANSCRIPT_SENTINEL}"}\n`, "utf8");
        await db.insert(heartbeatRuns).values({
          id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded", sessionIdAfter: sessionId,
        });
        const issueId = randomUUID();
        await db.insert(issues).values({ id: issueId, companyId, title: "Feedback target", status: "todo" });
        const [comment] = await db.insert(issueComments).values({
          companyId, issueId, authorAgentId: agentId, createdByRunId: runId, body: "agent answer",
        }).returning();
        const saved = await feedbackService(db).saveIssueVote({
          issueId, targetType: "issue_comment", targetId: comment!.id, vote: "up", authorUserId: MEMBER, allowSharing: true,
        });
        const [exported] = await db.select().from(feedbackExports).where(eq(feedbackExports.issueId, issueId));
        return { agentId, runId, exported: exported!, saved };
      }

      const flagged = await seedTrace(FLAGGED, "feedback-steward");
      const plain = await seedTrace(UNFLAGGED, "feedback-steward-plain");

      // Sharing is refused for the flagged company: the trace stays local.
      expect(flagged.exported.status).toBe("local_only");
      expect(plain.exported.status).toBe("pending");

      const bundlePath = (id: string) => `/api/feedback-traces/${id}/bundle`;
      expect((await request(appAs(asUser(MEMBER, "member"))).get(bundlePath(flagged.exported.id))).status).toBe(404);
      const stewardBundle = await request(appAs({ ...asUser("feedback-steward", "member") })).get(bundlePath(flagged.exported.id));
      expect(stewardBundle.status).toBe(200);
      expect(JSON.stringify(stewardBundle.body)).not.toContain(TRANSCRIPT_SENTINEL);
      expect((stewardBundle.body.files as Array<{ path: string }>).some((f) => f.path.startsWith("adapter/"))).toBe(false);
      const adminBundle = await request(appAs(asInstanceAdmin())).get(bundlePath(flagged.exported.id));
      expect(adminBundle.status).toBe(200);
      expect(JSON.stringify(adminBundle.body)).not.toContain(TRANSCRIPT_SENTINEL);

      // Flag off: unchanged — a member reads it, adapter transcript included.
      const plainBundle = await request(appAs(asUser(MEMBER, "member"))).get(bundlePath(plain.exported.id));
      expect(plainBundle.status).toBe(200);
      expect(JSON.stringify(plainBundle.body)).toContain(TRANSCRIPT_SENTINEL);

      // A trace queued for sharing before the flag went on is never uploaded.
      await db.update(feedbackExports).set({ status: "pending" }).where(eq(feedbackExports.id, flagged.exported.id));
      const uploaded: string[] = [];
      const sharing = feedbackService(db, { shareClient: { uploadTraceBundle: async (bundle: { traceId: string }) => { uploaded.push(bundle.traceId); } } as never });
      await sharing.flushPendingFeedbackTraces({ companyId: FLAGGED });
      expect(uploaded).toEqual([]);
      const [afterFlush] = await db.select().from(feedbackExports).where(eq(feedbackExports.id, flagged.exported.id));
      expect(afterFlush!.status).not.toBe("sent");
      await sharing.flushPendingFeedbackTraces({ companyId: UNFLAGGED });
      expect(uploaded).toHaveLength(1);
    } finally {
      if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
    }
  }, 30_000);

  // Review fix 6: the stale-run watchdog copies the run-log tail into a review
  // issue every company member can read.
  it("stale-run evidence carries no document text, and no run-log tail for a flagged company", async () => {
    async function seedStaleRun(companyId: string, stewardUserId: string) {
      const managerId = randomUUID();
      const coderId = randomUUID();
      const now = new Date();
      const startedAt = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 120_000);
      await db.insert(agents).values([
        { id: managerId, companyId, name: `Manager ${managerId.slice(0, 4)}`, role: "manager", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
        { id: coderId, companyId, name: `Coder ${coderId.slice(0, 4)}`, role: "engineer", status: "running", reportsTo: managerId, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      ]);
      await db.insert(agentStewardships).values({ companyId, agentId: coderId, userId: stewardUserId });
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "Long task", status: "in_progress", assigneeAgentId: coderId, updatedAt: startedAt, createdAt: startedAt });
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId: coderId, status: "running", invocationSource: "assignment", triggerDetail: "system",
        startedAt, processStartedAt: startedAt, lastOutputAt: startedAt, lastOutputSeq: 1, lastOutputStream: "stdout",
        contextSnapshot: { issueId }, logBytes: 0,
      });
      // A log written behind the strip pass (e.g. by an older server) still
      // holds a frame; the evidence pass must not copy it.
      const framed = frameUntrustedDocumentText("microsoft", `Evidence ${SENTINEL}`, { runId, docId: "item-6" });
      const store = getRunLogStore();
      const handle = await store.begin({ companyId, agentId: coderId, runId });
      const logBytes = await store.append(handle, { stream: "stdout", chunk: `AGENT-COMMENTARY before\n${framed}\nAGENT-COMMENTARY after\n`, ts: startedAt.toISOString() });
      await db.update(heartbeatRuns).set({ logStore: handle.store, logRef: handle.logRef, logBytes }).where(eq(heartbeatRuns.id, runId));
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const heartbeat = heartbeatService(db);
      await heartbeat.scanSilentActiveRuns({ now, companyId });
      const [evaluation] = await db.select().from(issues).where(eq(issues.originId, runId));
      return evaluation;
    }
    const flaggedEvaluation = await seedStaleRun(FLAGGED, "stale-steward");
    expect(flaggedEvaluation?.description).toBeTruthy();
    expect(flaggedEvaluation!.description).not.toContain(SENTINEL);
    expect(flaggedEvaluation!.description).not.toContain("AGENT-COMMENTARY");
    const plainEvaluation = await seedStaleRun(UNFLAGGED, "stale-steward-plain");
    expect(plainEvaluation!.description).not.toContain(SENTINEL);
    expect(plainEvaluation!.description).toContain("AGENT-COMMENTARY");
    expect(plainEvaluation!.description).toContain("[document text withheld: item-6");
  }, 30_000);
});
