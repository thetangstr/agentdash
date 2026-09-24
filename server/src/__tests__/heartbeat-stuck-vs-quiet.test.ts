// AgentDash (OBS-5, #698): stuck vs quiet for non-streaming adapters, and the
// first-output deadline. Embedded Postgres + a real Hermes ledger fixture.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createHermesLedgerFixture } from "./helpers/hermes-ledger-fixture.js";
import { ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS, heartbeatService } from "../services/heartbeat.ts";

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
      execute: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null })),
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

  it("stops a zero-turn Hermes hang at the first-output deadline with no_first_output", async () => {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    // The session row exists (Hermes opens it at start) but no model call ever completed.
    const { dbPath } = ledger([{ id: "s-zero", startedAt: minutesAgo(11) }]);
    const hung = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(hung);
    const { companyId, runId } = await seedRun({ now, ageMs: 11 * 60_000, processPid: hung.pid! });

    const result = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      companyId,
      env: { AGENTDASH_HERMES_STATE_DB: dbPath },
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
    });
    expect(await waitForExit(hung.pid!)).toBe(true);
  });

  it("leaves Hermes runs alone before the deadline, after a first ledger row, or without a readable ledger", async () => {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    const withRow = ledger([
      { id: "s-working", startedAt: minutesAgo(30), usage: [{ firstSeen: minutesAgo(29), lastSeen: minutesAgo(28) }] },
    ]);
    const empty = ledger([{ id: "s-zero", startedAt: minutesAgo(5) }]);
    // Real children, never this test process: a wrong stop must not kill the runner.
    const sleeper = () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      children.push(child);
      return child.pid!;
    };

    const young = await seedRun({ now, ageMs: 5 * 60_000, processPid: sleeper() });
    const youngResult = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      companyId: young.companyId,
      env: { AGENTDASH_HERMES_STATE_DB: empty.dbPath },
    });

    const working = await seedRun({ now, ageMs: 30 * 60_000, processPid: sleeper() });
    const workingResult = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      companyId: working.companyId,
      env: { AGENTDASH_HERMES_STATE_DB: withRow.dbPath },
    });

    const noLedger = await seedRun({ now, ageMs: 30 * 60_000, processPid: sleeper() });
    const noLedgerResult = await heartbeatService(db).enforceFirstOutputDeadlines({
      now,
      companyId: noLedger.companyId,
      env: { AGENTDASH_HERMES_STATE_DB: "/nonexistent/hermes/state.db" },
    });

    expect(youngResult.stopped).toBe(0);
    expect(workingResult.stopped).toBe(0);
    expect(noLedgerResult.stopped).toBe(0);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "running"));
    expect(runs).toHaveLength(3);
  });
});
