// AgentDash (OBS-5, #698): stuck vs quiet for non-streaming adapters, and the
// first-output deadline. Embedded Postgres + a real Hermes ledger fixture.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createHermesLedgerFixture } from "./helpers/hermes-ledger-fixture.js";
import { ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS, heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { getRunLogStore } from "../services/run-log-store.ts";
import { probeRunLiveness } from "../services/run-liveness-probe.ts";

const mockExecute = vi.hoisted(() =>
  vi.fn(async (_ctx?: unknown): Promise<Record<string, unknown>> => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stuck-vs-quiet tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

describeEmbeddedPostgres("stuck vs quiet (OBS-5)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const cleanups: Array<() => void> = [];
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stuck-vs-quiet-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanups.length > 0) cleanups.pop()!();
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function ledger(...args: Parameters<typeof createHermesLedgerFixture>) {
    const fixture = createHermesLedgerFixture(...args);
    cleanups.push(fixture.cleanup);
    return fixture;
  }

  async function seedRun(opts: {
    now: Date;
    ageMs: number;
    adapterType?: string;
    processPid?: number | null;
    sessionIdBefore?: string | null;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const workerId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(opts.now.getTime() - opts.ageMs);
    const adapterType = opts.adapterType ?? "hermes_local";

    await db.insert(companies).values({ id: companyId, name: "Quiet Co", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "Lead",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerId,
        companyId,
        name: "Priya",
        role: "engineer",
        status: "running",
        reportsTo: managerId,
        adapterType,
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Long quiet task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: workerId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    // Hermes prints one "[hermes] Starting" line before spawning, then nothing (-Q).
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      processPid: opts.processPid ?? null,
      sessionIdBefore: opts.sessionIdBefore ?? null,
      lastOutputAt: startedAt,
      lastOutputSeq: 1,
      lastOutputStream: "stdout",
      contextSnapshot: { issueId },
      logBytes: 0,
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, runId, issueId };
  }

  async function evaluationsFor(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stale_active_run_evaluation")));
  }

  it("does not flag a 74-minute Hermes run whose ledger is advancing", async () => {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    const { dbPath } = ledger([
      {
        id: "s-quiet",
        startedAt: minutesAgo(74),
        usage: [{ firstSeen: minutesAgo(73), lastSeen: minutesAgo(4), apiCalls: 38 }],
      },
    ]);
    vi.stubEnv("AGENTDASH_HERMES_STATE_DB", dbPath);
    const { companyId } = await seedRun({ now, ageMs: 74 * 60_000, processPid: process.pid });

    const result = await heartbeatService(db).scanSilentActiveRuns({ now, companyId });

    expect(result.scanned).toBe(1);
    expect(result.quietButAlive).toBe(1);
    expect(result.created).toBe(0);
    expect(await evaluationsFor(companyId)).toHaveLength(0);
  });

  it("still flags a Hermes run whose process is alive but whose ledger has not moved for an hour", async () => {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    const { dbPath } = ledger([
      {
        id: "s-stuck",
        startedAt: minutesAgo(74),
        usage: [{ firstSeen: minutesAgo(73), lastSeen: minutesAgo(62) }],
      },
    ]);
    vi.stubEnv("AGENTDASH_HERMES_STATE_DB", dbPath);
    const { companyId } = await seedRun({ now, ageMs: 74 * 60_000, processPid: process.pid });

    const result = await heartbeatService(db).scanSilentActiveRuns({ now, companyId });

    expect(result.created).toBe(1);
    const [evaluation] = await evaluationsFor(companyId);
    expect(evaluation?.description).toContain("Liveness probe: Hermes ledger (read)");
    expect(evaluation?.description).toContain(minutesAgo(62).toISOString());
  });

  it("flags a Hermes run whose process is dead even if the ledger moved", async () => {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    const { dbPath } = ledger([
      { id: "s-dead", startedAt: minutesAgo(74), usage: [{ firstSeen: minutesAgo(73), lastSeen: minutesAgo(4) }] },
    ]);
    vi.stubEnv("AGENTDASH_HERMES_STATE_DB", dbPath);
    const { companyId } = await seedRun({ now, ageMs: 74 * 60_000, processPid: await deadPid() });

    const result = await heartbeatService(db).scanSilentActiveRuns({ now, companyId });

    expect(result.quietButAlive).toBe(0);
    expect(result.created).toBe(1);
  });

  it("keeps output silence as the signal for streaming adapters", async () => {
    const now = new Date();
    const { companyId } = await seedRun({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 60_000,
      adapterType: "codex_local",
      processPid: process.pid,
    });

    const result = await heartbeatService(db).scanSilentActiveRuns({ now, companyId });

    expect(result.created).toBe(1);
  });

  // ── First-output deadline ───────────────────────────────────────────────

  const ENFORCE = { AGENTDASH_FIRST_OUTPUT_DEADLINE_MODE: "enforce" };

  function hungChild() {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    return child;
  }

  /** Register a child the way runChildProcess does, so the in-memory handle path is taken. */
  function registerHandle(runId: string, child: ChildProcess) {
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });
    cleanups.push(() => runningProcesses.delete(runId));
  }

  async function shadowEvents(runId: string) {
    return db
      .select()
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, runId), sql`${heartbeatRunEvents.payload}->>'kind' = 'would_stop_no_first_output'`));
  }

  it("shadow mode (the default) reports a zero-turn hang once, with a run-log line, and stops nothing", async () => {
    const now = new Date();
    const { dbPath } = ledger([{ id: "s-zero", startedAt: new Date(now.getTime() - 11 * 60_000) }]);
    const child = hungChild();
    const { companyId, runId } = await seedRun({ now, ageMs: 11 * 60_000, processPid: child.pid! });
    registerHandle(runId, child);
    const store = getRunLogStore();
    const handle = await store.begin({ companyId, agentId: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!.agentId, runId });
    await db.update(heartbeatRuns).set({ logStore: handle.store, logRef: handle.logRef }).where(eq(heartbeatRuns.id, runId));

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.enforceFirstOutputDeadlines({ now, companyId, env: { AGENTDASH_HERMES_STATE_DB: dbPath } });
    const second = await heartbeat.enforceFirstOutputDeadlines({ now, companyId, env: { AGENTDASH_HERMES_STATE_DB: dbPath } });

    expect(first).toMatchObject({ stopped: 0, wouldStop: 1 });
    expect(second.stopped).toBe(0);
    const events = await shadowEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ mode: "shadow", verdict: "none_certain", inMemoryHandle: true });
    const log = await store.read(handle);
    expect(log.content).toContain("would_stop_no_first_output");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
    expect(child.exitCode).toBeNull();
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("enforce mode stops a zero-turn Hermes hang through the in-memory handle with no_first_output", async () => {
    const now = new Date();
    // The session row exists (Hermes opens it at start) but no model call ever completed.
    const { dbPath } = ledger([{ id: "s-zero", startedAt: new Date(now.getTime() - 11 * 60_000) }]);
    const child = hungChild();
    const { companyId, runId } = await seedRun({ now, ageMs: 11 * 60_000, processPid: child.pid! });
    registerHandle(runId, child);

    const result = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      companyId,
      env: { ...ENFORCE, AGENTDASH_HERMES_STATE_DB: dbPath },
    });

    expect(result.stopped).toBe(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("no_first_output");
    expect(run?.resultJson).toMatchObject({
      stopReason: "no_first_output",
      timeoutFired: false,
      firstOutputDeadlineMs: 10 * 60_000,
      livenessProbe: "hermes_ledger",
      verdict: "none_certain",
      inMemoryHandle: true,
    });
    expect(await waitForExit(child.pid!)).toBe(true);
  });

  it("enforce mode signals a persisted pid only when its OS start time matches process_started_at", async () => {
    const now = new Date();
    const { dbPath } = ledger([{ id: "s-zero", startedAt: new Date(now.getTime() - 11 * 60_000) }]);
    const env = { ...ENFORCE, AGENTDASH_HERMES_STATE_DB: dbPath };

    // Real start time is "now", recorded start is 11 minutes ago: a reused pid.
    const reused = hungChild();
    const mismatch = await seedRun({ now, ageMs: 11 * 60_000, processPid: reused.pid! });
    const mismatchResult = await heartbeatService(db).enforceFirstOutputDeadlines({ now, companyId: mismatch.companyId, env });
    expect(mismatchResult.stopped).toBe(0);
    expect(mismatchResult.wouldStop).toBe(1);
    expect((await shadowEvents(mismatch.runId))[0]?.payload).toMatchObject({ processIdentified: false, mode: "enforce" });
    expect(isAlive(reused.pid!)).toBe(true);

    const same = hungChild();
    const matched = await seedRun({ now, ageMs: 11 * 60_000, processPid: same.pid! });
    const recorded = new Date(now.getTime() - 11 * 60_000);
    const matchedResult = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      companyId: matched.companyId,
      env,
      readProcessStart: () => recorded,
    });
    expect(matchedResult.stopped).toBe(1);
    expect(await waitForExit(same.pid!)).toBe(true);
  });

  it("never stops on an uncertain ledger (sticky active profile), even in enforce mode", async () => {
    const now = new Date();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-root-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "profiles", "agentdash"), { recursive: true });
    fs.writeFileSync(path.join(root, "active_profile"), "agentdash\n");
    createHermesLedgerFixture([{ id: "s-zero", startedAt: new Date(now.getTime() - 11 * 60_000) }], path.join(root, "profiles", "agentdash"));
    const child = hungChild();
    const { companyId, runId } = await seedRun({ now, ageMs: 11 * 60_000, processPid: child.pid! });
    registerHandle(runId, child);

    const result = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      companyId,
      env: { ...ENFORCE, AGENTDASH_HERMES_ROOT: root, PATH: "" },
    });

    expect(result.stopped).toBe(0);
    expect((await shadowEvents(runId))[0]?.payload).toMatchObject({
      verdict: "none_uncertain",
      ledgerCertainty: "uncertain",
      ledgerSource: "active_profile",
    });
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("never stops on a wrong-but-existing ledger that holds no session for the run", async () => {
    const now = new Date();
    // Readable, configured with certainty, and stale: the root-ledger trap from :3199.
    const { dbPath } = ledger([
      {
        id: "s-september-11",
        startedAt: new Date(now.getTime() - 13 * 24 * 60 * 60_000),
        endedAt: new Date(now.getTime() - 13 * 24 * 60 * 60_000 + 60_000),
        usage: [{ firstSeen: new Date(now.getTime() - 13 * 24 * 60 * 60_000), lastSeen: new Date(now.getTime() - 13 * 24 * 60 * 60_000) }],
      },
    ]);
    const child = hungChild();
    const { companyId, runId } = await seedRun({ now, ageMs: 11 * 60_000, processPid: child.pid! });
    registerHandle(runId, child);

    const result = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      companyId,
      env: { ...ENFORCE, AGENTDASH_HERMES_STATE_DB: dbPath },
    });

    expect(result.stopped).toBe(0);
    expect((await shadowEvents(runId))[0]?.payload).toMatchObject({ verdict: "none_uncertain", windowSessionIds: [] });
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("does not stop on a shared profile where another run's session is the only open one", async () => {
    const now = new Date();
    // This run started 11 minutes ago; the only open session opened 6 minutes later.
    const { dbPath } = ledger([{ id: "s-someone-else", startedAt: new Date(now.getTime() - 5 * 60_000) }]);
    const child = hungChild();
    const { companyId, runId } = await seedRun({ now, ageMs: 11 * 60_000, processPid: child.pid! });
    registerHandle(runId, child);

    const result = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      companyId,
      env: { ...ENFORCE, AGENTDASH_HERMES_STATE_DB: dbPath },
    });

    expect(result.stopped).toBe(0);
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("leaves runs alone before the deadline, after a first ledger row, with a locked or corrupt ledger", async () => {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    const withRow = ledger([
      { id: "s-working", startedAt: minutesAgo(30), usage: [{ firstSeen: minutesAgo(29), lastSeen: minutesAgo(28) }] },
    ]);
    const young = ledger([{ id: "s-zero", startedAt: minutesAgo(5) }]);
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-corrupt-"));
    cleanups.push(() => fs.rmSync(corruptDir, { recursive: true, force: true }));
    const corrupt = path.join(corruptDir, "state.db");
    fs.writeFileSync(corrupt, "not a database ".repeat(500));
    const locked = ledger([{ id: "s-zero", startedAt: minutesAgo(30) }]);
    const writer = new DatabaseSync(locked.dbPath);
    writer.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE; INSERT INTO sessions (id, source, started_at) VALUES ('x', 'tool', 1);");
    cleanups.push(() => {
      writer.exec("ROLLBACK");
      writer.close();
    });

    const cases: Array<{ ageMin: number; dbPath: string }> = [
      { ageMin: 5, dbPath: young.dbPath },
      { ageMin: 30, dbPath: withRow.dbPath },
      { ageMin: 30, dbPath: corrupt },
      { ageMin: 30, dbPath: locked.dbPath },
      { ageMin: 30, dbPath: "/nonexistent/hermes/state.db" },
    ];
    for (const testCase of cases) {
      const child = hungChild();
      const seeded = await seedRun({ now, ageMs: testCase.ageMin * 60_000, processPid: child.pid! });
      registerHandle(seeded.runId, child);
      const result = await heartbeatService(db).enforceFirstOutputDeadlines({
        now,
        companyId: seeded.companyId,
        env: { ...ENFORCE, AGENTDASH_HERMES_STATE_DB: testCase.dbPath },
      });
      expect(result, testCase.dbPath).toMatchObject({ stopped: 0, wouldStop: 0, errors: 0 });
    }
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "running"));
    expect(runs).toHaveLength(cases.length);
  });

  it("loses the completion race gracefully: a run that finished meanwhile keeps its outcome and is not signalled", async () => {
    const now = new Date();
    const { dbPath } = ledger([{ id: "s-zero", startedAt: new Date(now.getTime() - 11 * 60_000) }]);
    const child = hungChild();
    const { companyId, runId } = await seedRun({ now, ageMs: 11 * 60_000, processPid: child.pid! });
    registerHandle(runId, child);
    const env = { ...ENFORCE, AGENTDASH_HERMES_STATE_DB: dbPath };

    const result = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      companyId,
      env,
      // The run completes between the candidate read and the stop.
      probe: async (run, agent) => {
        const evidence = probeRunLiveness(run, agent, { env });
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
        return evidence;
      },
    });

    expect(result.stopped).toBe(0);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("isolates a failure on one run so the others are still checked", async () => {
    const now = new Date();
    const { dbPath } = ledger([{ id: "s-zero", startedAt: new Date(now.getTime() - 11 * 60_000) }]);
    const a = hungChild();
    const first = await seedRun({ now, ageMs: 11 * 60_000, processPid: a.pid! });
    registerHandle(first.runId, a);
    const env = { AGENTDASH_HERMES_STATE_DB: dbPath };
    let calls = 0;
    const result = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      env,
      probe: (run, agent) => {
        calls += 1;
        if (calls === 1) throw new Error("probe exploded");
        return probeRunLiveness(run, agent, { env });
      },
    });
    expect(result.errors).toBe(1);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
  });

  it("keeps no_first_output when the adapter's execute resolves after the kill", async () => {
    const env = { ...ENFORCE } as NodeJS.ProcessEnv;
    let executeResolved = false;
    mockExecute.mockImplementationOnce(async (ctx: any) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      children.push(child);
      runningProcesses.set(ctx.runId, { child, graceSec: 1, processGroupId: null });
      await ctx.onSpawn({ pid: child.pid, processGroupId: null, startedAt: new Date().toISOString() });
      await new Promise((resolve) => child.once("exit", resolve));
      runningProcesses.delete(ctx.runId);
      executeResolved = true;
      // What an adapter reports for a signalled child.
      return { exitCode: null, signal: "SIGTERM", timedOut: false, errorMessage: "Process exited via SIGTERM", errorCode: "adapter_failed" };
    });
    const now = new Date();
    const { companyId, runId } = await seedRun({ now, ageMs: 0, processPid: null });
    const [seeded] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    // Drive a real run through the heartbeat instead of the seeded one.
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, seeded!.agentId));
    const heartbeat = heartbeatService(db);
    const wake = await heartbeat.wakeup(seeded!.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "obs5_test",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(wake).not.toBeNull();
    const liveRunId = wake!.id;
    let live = null as typeof seeded | null;
    for (let i = 0; i < 100; i += 1) {
      [live] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, liveRunId));
      if (live?.processStartedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(live?.processStartedAt).toBeTruthy();
    const { dbPath } = ledger([{ id: "s-zero", startedAt: live!.processStartedAt! }]);
    env.AGENTDASH_HERMES_STATE_DB = dbPath;

    const result = await heartbeat.enforceFirstOutputDeadlines({
      now: new Date(live!.processStartedAt!.getTime() + 11 * 60_000),
      companyId,
      env,
    });
    expect(result.stopped).toBe(1);

    for (let i = 0; i < 200 && !executeResolved; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(executeResolved).toBe(true);
    // Give the heartbeat's own finalization time to run after execute resolves.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, liveRunId));
    expect(settled?.status).toBe("failed");
    expect(settled?.errorCode).toBe("no_first_output");
    expect(settled?.error).toContain("No first output");
    expect(settled?.resultJson).toMatchObject({ stopReason: "no_first_output" });
  });
});
