import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const sessA = randomUUID();
const sessB = randomUUID();
const sessC = randomUUID();
const sessMissing = randomUUID();

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backfill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const repoServerDir = path.resolve(import.meta.dirname, "..", "..");

const sec = (ms: number) => ms / 1000;

/**
 * A fixture ledger shaped like the real one: cumulative `session_model_usage`
 * rows carrying their own [first_seen, last_seen] activity span — the columns
 * the backfill's per-run window attribution reads.
 */
function writeLedger(dbPath: string, rows: Array<{
  sessionId: string;
  model?: string;
  provider?: string;
  apiCalls?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  firstSeen?: number; // ms epoch; undefined → null columns
  lastSeen?: number;
  toolCalls?: number | null;
}>) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_model_usage (
      session_id TEXT,
      model TEXT,
      billing_provider TEXT,
      api_call_count INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      first_seen REAL,
      last_seen REAL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      tool_call_count INTEGER
    );
  `);
  const seenSessions = new Set<string>();
  for (const row of rows) {
    db.prepare(
      `INSERT INTO session_model_usage
        (session_id, model, billing_provider, api_call_count, input_tokens, output_tokens,
         cache_read_tokens, estimated_cost_usd, actual_cost_usd, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.sessionId,
      row.model ?? "glm-5.3-flash",
      row.provider ?? "openrouter",
      row.apiCalls ?? 1,
      row.inputTokens,
      row.outputTokens,
      row.cachedInputTokens ?? 0,
      0,
      0,
      row.firstSeen === undefined ? null : sec(row.firstSeen),
      row.lastSeen === undefined ? null : sec(row.lastSeen),
    );
    if (!seenSessions.has(row.sessionId)) {
      seenSessions.add(row.sessionId);
      db.prepare(`INSERT INTO sessions (id, tool_call_count) VALUES (?, ?)`).run(
        row.sessionId,
        row.toolCalls ?? null,
      );
    }
  }
  db.close();
}

describeEmbeddedPostgres("backfill-run-facts script", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let profilesDir = "";
  let binDir = "";
  let hermesRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-backfill-test-");
    db = createDb(tempDb.connectionString);
    profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-profiles-"));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-bin-"));
    hermesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-root-"));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    for (const dir of [profilesDir, binDir, hermesRoot]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A managed-agent wrapper: a script that execs `hermes -p <profile>`. */
  function writeWrapper(name: string, profile: string) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec hermes -p ${profile} "$@"\n`, { mode: 0o755 });
    return file;
  }

  function runScript(args: string[]) {
    const env = { ...process.env };
    env.DATABASE_URL = tempDb!.connectionString;
    env.HERMES_PROFILES_DIR = profilesDir;
    env.AGENTDASH_HERMES_ROOT = hermesRoot;
    // Keep a developer machine's real Hermes ledger out of the fixture run.
    delete env.AGENTDASH_HERMES_STATE_DB;
    delete env.HERMES_HOME;
    return execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/backfill-run-facts.ts", ...args],
      { cwd: repoServerDir, env, encoding: "utf8", timeout: 120_000 },
    );
  }

  async function readRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  function factsOf(run: { resultJson: unknown } | null) {
    const rj =
      run?.resultJson && typeof run.resultJson === "object" && !Array.isArray(run.resultJson)
        ? (run.resultJson as Record<string, unknown>)
        : {};
    return (rj.runFacts ?? null) as Record<string, unknown> | null;
  }

  it("attributes per-run spend by ledger-row windows, marks straddlers ambiguous", async () => {
    const now = Date.now();
    const runA1Start = now - 2 * DAY_MS;
    const runA2Start = now - DAY_MS;
    const runB1Start = now - DAY_MS;
    const runC1Start = now - 3 * DAY_MS;
    const runC2Start = now - 2 * DAY_MS;

    // sessA: shared by a pre-window run and two in-window runs. Row timing —
    // not cumulative totals — decides what each in-window run spent.
    // sessB: a single-run session; its rows are whole-session attributable.
    // sessC: shared by two runs with a row straddling their boundary —
    // unsplittable, so both runs are honestly ambiguous.
    writeLedger(path.join(profilesDir, "testprof", "state.db"), [
      // Pre-window spend on sessA: must NOT land on runA1.
      {
        sessionId: sessA,
        apiCalls: 4,
        inputTokens: 2_000,
        cachedInputTokens: 100,
        outputTokens: 80,
        firstSeen: now - 40 * DAY_MS,
        lastSeen: now - 40 * DAY_MS + 60_000,
      },
      {
        sessionId: sessA,
        apiCalls: 8,
        inputTokens: 5_000,
        cachedInputTokens: 300,
        outputTokens: 200,
        firstSeen: runA1Start + 1_000,
        lastSeen: runA1Start + 4_000,
      },
      {
        sessionId: sessA,
        apiCalls: 2,
        inputTokens: 1_500,
        cachedInputTokens: 50,
        outputTokens: 60,
        firstSeen: runA2Start + 1_000,
        lastSeen: runA2Start + 4_000,
      },
      {
        sessionId: sessB,
        apiCalls: 3,
        inputTokens: 1_000,
        cachedInputTokens: 50,
        outputTokens: 40,
        firstSeen: runB1Start + 1_000,
        lastSeen: runB1Start + 4_000,
        toolCalls: 5,
      },
      {
        sessionId: sessC,
        apiCalls: 6,
        inputTokens: 3_000,
        outputTokens: 300,
        firstSeen: runC1Start + 1_000,
        lastSeen: runC2Start + 2_000, // straddles C1's end and C2's window
      },
    ]);

    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Backfill Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "HermesAgent",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      // The managed-agent shape: a wrapper script that execs `hermes -p`.
      adapterConfig: { hermesCommand: writeWrapper("testprof-wrap", "testprof"), model: "configured-model" },
      runtimeConfig: {},
      permissions: {},
    });

    // A pre-window run sharing sessA — it must NOT absorb the window's rows,
    // and the window's runs must NOT absorb its pre-window tokens.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "timer",
      status: "succeeded",
      sessionIdAfter: sessA,
      startedAt: new Date(now - 40 * DAY_MS),
      finishedAt: new Date(now - 40 * DAY_MS + 60_000),
      createdAt: new Date(now - 40 * DAY_MS),
    });

    const runA1 = randomUUID();
    const runA2 = randomUUID();
    const runB1 = randomUUID();
    const runC1 = randomUUID();
    const runC2 = randomUUID();
    const runNoSession = randomUUID();
    const runMissingSession = randomUUID();
    const base = {
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "succeeded",
      livenessState: "advanced",
      contextSnapshot: { wakeReason: "heartbeat_timer" },
    };
    await db.insert(heartbeatRuns).values([
      {
        ...base,
        id: runA1,
        sessionIdAfter: sessA,
        startedAt: new Date(runA1Start),
        finishedAt: new Date(runA1Start + 5_000),
        createdAt: new Date(runA1Start),
      },
      {
        ...base,
        id: runA2,
        sessionIdAfter: sessA,
        startedAt: new Date(runA2Start),
        finishedAt: new Date(runA2Start + 5_000),
        createdAt: new Date(runA2Start),
      },
      {
        ...base,
        id: runB1,
        sessionIdAfter: sessB,
        startedAt: new Date(runB1Start),
        finishedAt: new Date(runB1Start + 5_000),
        createdAt: new Date(runB1Start),
      },
      {
        ...base,
        id: runC1,
        sessionIdAfter: sessC,
        startedAt: new Date(runC1Start),
        finishedAt: new Date(runC1Start + 5_000),
        createdAt: new Date(runC1Start),
      },
      {
        ...base,
        id: runC2,
        sessionIdAfter: sessC,
        startedAt: new Date(runC2Start),
        finishedAt: new Date(runC2Start + 5_000),
        createdAt: new Date(runC2Start),
      },
      {
        ...base,
        id: runNoSession,
        sessionIdAfter: null,
        createdAt: new Date(now - DAY_MS),
      },
      {
        ...base,
        id: runMissingSession,
        sessionIdAfter: sessMissing,
        createdAt: new Date(now - DAY_MS),
      },
    ]);

    // A second company whose agent must stay untouched under --company.
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "OtherAgent",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: { hermesProfile: "testprof" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId: otherCompanyId,
      agentId: otherAgentId,
      invocationSource: "timer",
      status: "succeeded",
      sessionIdAfter: sessB,
      startedAt: new Date(runB1Start),
      finishedAt: new Date(runB1Start + 5_000),
      createdAt: new Date(runB1Start),
    });

    // Dry-run reports but writes nothing.
    const dryOut = runScript(["--dry-run", "--days", "30", "--company", companyId]);
    expect(dryOut).toContain("[dry-run]");
    expect(dryOut).toContain("runs  metered  unmetered");
    expect(await factsOf(await readRun(runA1))).toBeNull();

    const scoped = runScript(["--days", "30", "--company", companyId]);
    expect(scoped).toContain("7 runs examined");

    // The other company's run was filtered out entirely.
    expect(await factsOf(await readRun(otherRunId))).toBeNull();

    const a1 = factsOf(await readRun(runA1));
    expect(a1).toMatchObject({
      meteringStatus: "metered",
      servedModel: "glm-5.3-flash",
      servedProvider: "openrouter",
      configuredModel: "configured-model",
      inputTokens: 5_000,
      cachedInputTokens: 300,
      outputTokens: 200,
      turns: 8,
      toolCalls: null, // shared session — the cumulative counter is unattributable
      wallMs: 5_000,
      outcome: "produced",
      wakeReason: "timer",
      firstOutputMs: null,
      ledgerSource: "wrapper_script",
      ledgerCertainty: "certain",
    });

    // Per-run deltas: A2 gets the rows in ITS window, not a remainder of the
    // session's cumulative total — and the pre-window row lands on neither.
    const a2 = factsOf(await readRun(runA2));
    expect(a2).toMatchObject({
      meteringStatus: "metered",
      inputTokens: 1_500,
      cachedInputTokens: 50,
      outputTokens: 60,
      turns: 2,
    });

    const b1 = factsOf(await readRun(runB1));
    expect(b1).toMatchObject({
      meteringStatus: "metered",
      inputTokens: 1_000,
      cachedInputTokens: 50,
      outputTokens: 40,
      toolCalls: 5,
    });

    // The straddling row cannot be split — both runs say so instead of
    // guessing a share.
    for (const runId of [runC1, runC2]) {
      const facts = factsOf(await readRun(runId));
      expect(facts?.meteringStatus).toBe("unmetered_backfill_ambiguous");
      expect(facts?.inputTokens).toBeNull();
      expect(facts?.turns).toBeNull();
    }

    // Unmetered runs say so and keep null token fields — never fake zeros.
    const noSession = factsOf(await readRun(runNoSession));
    expect(noSession?.meteringStatus).toBe("unmetered_no_session");
    expect(noSession?.inputTokens).toBeNull();
    const missing = factsOf(await readRun(runMissingSession));
    expect(missing?.meteringStatus).toBe("unmetered_no_session");
    expect(missing?.inputTokens).toBeNull();

    const usageA1 = (await readRun(runA1))?.usageJson as Record<string, unknown>;
    expect(usageA1.meteringStatus).toBe("metered");

    // Idempotent: a second pass skips everything it already wrote.
    const again = runScript(["--days", "30", "--company", companyId]);
    expect(again).toContain("7 already had runFacts");
    expect(again).toContain("0 updated");

    // ...and a re-run does not re-attribute or double-count anything.
    expect(factsOf(await readRun(runA1))).toMatchObject({ inputTokens: 5_000 });
    expect(factsOf(await readRun(runA2))).toMatchObject({ inputTokens: 1_500 });
  }, 120_000);
});
