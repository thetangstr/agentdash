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

function writeLedger(dbPath: string, rows: Array<{
  sessionId: string;
  model?: string;
  provider?: string;
  apiCalls?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
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
      actual_cost_usd REAL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      tool_call_count INTEGER
    );
  `);
  for (const row of rows) {
    db.prepare(
      `INSERT INTO session_model_usage
        (session_id, model, billing_provider, api_call_count, input_tokens, output_tokens,
         cache_read_tokens, estimated_cost_usd, actual_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    db.prepare(`INSERT INTO sessions (id, tool_call_count) VALUES (?, ?)`).run(
      row.sessionId,
      row.toolCalls ?? null,
    );
  }
  db.close();
}

describeEmbeddedPostgres("backfill-run-facts script", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let profilesDir = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-backfill-test-");
    db = createDb(tempDb.connectionString);
    profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-profiles-"));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (profilesDir) fs.rmSync(profilesDir, { recursive: true, force: true });
  });

  function runScript(args: string[]) {
    const env = { ...process.env };
    env.DATABASE_URL = tempDb!.connectionString;
    env.HERMES_PROFILES_DIR = profilesDir;
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

  it("backfills runFacts from a fixture profile ledger and reconciles per-day totals", async () => {
    // A managed-profile ledger shaped like the real one: cumulative rows per
    // session, two sessions, plus a sessions table carrying tool counts.
    writeLedger(path.join(profilesDir, "testprof", "state.db"), [
      {
        sessionId: sessA,
        apiCalls: 8,
        inputTokens: 5_000,
        cachedInputTokens: 300,
        outputTokens: 200,
        toolCalls: 17,
      },
      {
        sessionId: sessB,
        model: "glm-5.3-flash",
        apiCalls: 3,
        inputTokens: 1_000,
        cachedInputTokens: 50,
        outputTokens: 40,
        toolCalls: 5,
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
      adapterConfig: { hermesCommand: "testprof", model: "configured-model" },
      runtimeConfig: {},
      permissions: {},
    });

    // A pre-window run that already booked part of sess-a's cumulative total —
    // the in-window run must only take what remains.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "timer",
      status: "succeeded",
      sessionIdAfter: sessA,
      usageJson: {
        rawInputTokens: 2_000,
        rawCachedInputTokens: 100,
        rawOutputTokens: 80,
      },
      createdAt: new Date(Date.now() - 40 * DAY_MS),
    });

    const runA1 = randomUUID();
    const runA2 = randomUUID();
    const runB1 = randomUUID();
    const runNoSession = randomUUID();
    const runMissingSession = randomUUID();
    const base = {
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "succeeded",
      livenessState: "advanced",
      contextSnapshot: {},
    };
    await db.insert(heartbeatRuns).values([
      {
        ...base,
        id: runA1,
        sessionIdAfter: sessA,
        startedAt: new Date(Date.now() - 2 * DAY_MS),
        finishedAt: new Date(Date.now() - 2 * DAY_MS + 5_000),
        createdAt: new Date(Date.now() - 2 * DAY_MS),
      },
      {
        ...base,
        id: runA2,
        sessionIdAfter: sessA,
        startedAt: new Date(Date.now() - DAY_MS),
        finishedAt: new Date(Date.now() - DAY_MS + 5_000),
        createdAt: new Date(Date.now() - DAY_MS),
      },
      {
        ...base,
        id: runB1,
        sessionIdAfter: sessB,
        startedAt: new Date(Date.now() - DAY_MS),
        finishedAt: new Date(Date.now() - DAY_MS + 5_000),
        createdAt: new Date(Date.now() - DAY_MS),
      },
      {
        ...base,
        id: runNoSession,
        sessionIdAfter: null,
        createdAt: new Date(Date.now() - DAY_MS),
      },
      {
        ...base,
        id: runMissingSession,
        sessionIdAfter: sessMissing,
        createdAt: new Date(Date.now() - DAY_MS),
      },
    ]);

    // Dry-run reports but writes nothing.
    const dryOut = runScript(["--dry-run", "--days", "30"]);
    expect(dryOut).toContain("[dry-run]");
    expect(dryOut).toContain("runs  metered  unmetered");
    expect(await factsOf(await readRun(runA1))).toBeNull();

    const out = runScript(["--days", "30"]);
    expect(out).toContain("5 runs examined");

    const a1 = factsOf(await readRun(runA1));
    expect(a1).toMatchObject({
      meteringStatus: "metered",
      servedModel: "glm-5.3-flash",
      servedProvider: "openrouter",
      configuredModel: "configured-model",
      inputTokens: 3_000, // 5,000 cumulative minus the 2,000 pre-window baseline
      cachedInputTokens: 200,
      outputTokens: 120,
      turns: 8,
      toolCalls: 17,
      wallMs: 5_000,
      outcome: "produced",
      wakeReason: "timer",
      firstOutputMs: null,
    });

    const a2 = factsOf(await readRun(runA2));
    expect(a2?.meteringStatus).toBe("metered");
    // The session total was already attributed to A1 — the delta is honestly 0.
    expect(a2?.inputTokens).toBe(0);
    expect(a2?.turns).toBe(0);
    expect(a2?.toolCalls).toBe(0);

    const b1 = factsOf(await readRun(runB1));
    expect(b1).toMatchObject({
      meteringStatus: "metered",
      inputTokens: 1_000,
      cachedInputTokens: 50,
      outputTokens: 40,
      toolCalls: 5,
    });

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
    const again = runScript(["--days", "30"]);
    expect(again).toContain("already had runFacts");
    expect(again).not.toContain(" 1 updated");
  }, 120_000);
});
