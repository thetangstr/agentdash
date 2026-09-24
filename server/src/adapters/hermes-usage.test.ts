import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyHermesSessionUsage,
  readHermesSessionId,
  readHermesSessionUsage,
  readHermesSessionUsageDetailed,
  resolveHermesStateDbCandidates,
  resolveHermesStateDbPath,
  summarizeHermesUsageRows,
} from "./hermes-usage.js";

/**
 * Rows copied from `session_model_usage` on the MKThink Mini: two rows for one
 * Hermes session, which is the ordinary shape (one per model per task).
 */
const LIVE_ROWS = [
  {
    model: "MiniMax-M3",
    billing_provider: "minimax",
    api_call_count: 1,
    input_tokens: 14,
    output_tokens: 200,
    cache_read_tokens: 2739,
    estimated_cost_usd: 0.0,
    actual_cost_usd: 0.0,
  },
  {
    model: "MiniMax-M3",
    billing_provider: "minimax",
    api_call_count: 1,
    input_tokens: 536,
    output_tokens: 13,
    cache_read_tokens: 0,
    estimated_cost_usd: 0.0,
    actual_cost_usd: 0.0,
  },
];

describe("summarizeHermesUsageRows", () => {
  it("sums every row of a session, because a bill is the sum", () => {
    const usage = summarizeHermesUsageRows(LIVE_ROWS);
    expect(usage?.usage).toEqual({ inputTokens: 550, outputTokens: 213, cachedInputTokens: 2739 });
    expect(usage?.apiCalls).toBe(2);
  });

  it("reports the model that did the most work, not the summariser", () => {
    const usage = summarizeHermesUsageRows([
      { ...LIVE_ROWS[0], model: "small-summariser", input_tokens: 10, output_tokens: 5 },
      { ...LIVE_ROWS[1], model: "MiniMax-M3", input_tokens: 9000, output_tokens: 400 },
    ]);
    expect(usage?.model).toBe("MiniMax-M3");
    expect(usage?.provider).toBe("minimax");
  });

  it("refuses a cost Hermes recorded as zero", () => {
    // Every MiniMax row on the Mini carries 0.0 for both cost columns: Hermes
    // has the token counts and not the price list. "$0.00 spent" on a board
    // that is spending money is a false statement, not a gap.
    expect(summarizeHermesUsageRows(LIVE_ROWS)?.costUsd).toBeNull();
  });

  it("takes a cost Hermes did record, preferring actual over estimated", () => {
    const usage = summarizeHermesUsageRows([
      { ...LIVE_ROWS[0], estimated_cost_usd: 0.02, actual_cost_usd: 0.031 },
    ]);
    expect(usage?.costUsd).toBeCloseTo(0.031);
  });

  it("returns null when there is nothing countable", () => {
    expect(summarizeHermesUsageRows([])).toBeNull();
    expect(summarizeHermesUsageRows([{ model: "m", input_tokens: 0, output_tokens: 0 }])).toBeNull();
  });
});

describe("readHermesSessionUsage", () => {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "hermes-usage-test-")),
    "state.db",
  );

  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_model_usage (
    session_id TEXT, model TEXT, billing_provider TEXT, billing_base_url TEXT,
    billing_mode TEXT, task TEXT, api_call_count INTEGER, input_tokens INTEGER,
    output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
    reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL)`);
  const insert = db.prepare(
    `INSERT INTO session_model_usage
       (session_id, model, billing_provider, api_call_count, input_tokens, output_tokens,
        cache_read_tokens, estimated_cost_usd, actual_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of LIVE_ROWS) {
    insert.run(
      "20260818_171709_4e143f",
      row.model,
      row.billing_provider,
      row.api_call_count,
      row.input_tokens,
      row.output_tokens,
      row.cache_read_tokens,
      row.estimated_cost_usd,
      row.actual_cost_usd,
    );
  }
  insert.run("another-session", "MiniMax-M3", "minimax", 1, 999999, 999999, 0, 0, 0);
  db.close();

  afterAll(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("reads one session's totals and nobody else's", () => {
    const usage = readHermesSessionUsage("20260818_171709_4e143f", { dbPath });
    expect(usage?.usage).toEqual({ inputTokens: 550, outputTokens: 213, cachedInputTokens: 2739 });
  });

  it("returns null for a session with no rows", () => {
    expect(readHermesSessionUsage("never-ran", { dbPath })).toBeNull();
  });

  it("returns null rather than throwing when the database is missing", () => {
    // A run that completed must not be turned into a failure because the
    // metering by-product could not be read.
    expect(readHermesSessionUsage("20260818_171709_4e143f", { dbPath: "/nonexistent/state.db" })).toBeNull();
  });

  it("returns null without a session id", () => {
    expect(readHermesSessionUsage(null, { dbPath })).toBeNull();
    expect(readHermesSessionUsage("   ", { dbPath })).toBeNull();
  });
});

describe("resolveHermesStateDbPath", () => {
  it("prefers the explicit override", () => {
    expect(resolveHermesStateDbPath({ AGENTDASH_HERMES_STATE_DB: "/srv/hermes/state.db" })).toBe(
      "/srv/hermes/state.db",
    );
  });

  it("falls back to the Hermes home, then to the default", () => {
    expect(resolveHermesStateDbPath({ HERMES_HOME: "/srv/hermes" })).toBe("/srv/hermes/state.db");
    expect(resolveHermesStateDbPath({})).toBe(path.join(os.homedir(), ".hermes", "state.db"));
  });
});

describe("resolveHermesStateDbCandidates", () => {
  it("puts the managed profile database first, then the home database", () => {
    // OBS-1: a `hermes -p <profile>` run writes to
    // <HERMES_PROFILES_DIR>/<profile>/state.db, NOT the root state.db — the
    // original incident was metering 467 runs against the wrong file.
    const candidates = resolveHermesStateDbCandidates(
      { HERMES_PROFILES_DIR: "/srv/hermes/profiles" },
      { profile: "agentdash-abc" },
    );
    expect(candidates[0]).toBe("/srv/hermes/profiles/agentdash-abc/state.db");
    expect(candidates[candidates.length - 1]).toBe(
      path.join(os.homedir(), ".hermes", "state.db"),
    );
  });

  it("defaults HERMES_PROFILES_DIR exactly like hermes-profile.ts", () => {
    const candidates = resolveHermesStateDbCandidates({}, { profile: "p1" });
    expect(candidates[0]).toBe(path.join(os.homedir(), ".hermes", "profiles", "p1", "state.db"));
  });

  it("keeps the env override ahead of the home fallback but behind the profile", () => {
    const candidates = resolveHermesStateDbCandidates(
      { HERMES_PROFILES_DIR: "/srv/p", AGENTDASH_HERMES_STATE_DB: "/srv/custom.db" },
      { profile: "p1" },
    );
    expect(candidates).toEqual([
      "/srv/p/p1/state.db",
      "/srv/custom.db",
      path.join(os.homedir(), ".hermes", "state.db"),
    ]);
  });

  it("dedupes when the override points at the same file", () => {
    const home = path.join(os.homedir(), ".hermes");
    const candidates = resolveHermesStateDbCandidates({
      AGENTDASH_HERMES_STATE_DB: path.join(home, "state.db"),
    });
    expect(candidates).toEqual([path.join(home, "state.db")]);
  });
});

describe("readHermesSessionUsageDetailed", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-root-"));
  const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-profiles-"));
  const profile = "agentdash-feedface";
  const profileDir = path.join(profilesDir, profile);
  fs.mkdirSync(profileDir, { recursive: true });

  function makeLedger(dbPath: string, sessionId: string, toolCalls: number | null) {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session_model_usage (
      session_id TEXT, model TEXT, billing_provider TEXT, task TEXT,
      api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL)`);
    db.prepare(
      `INSERT INTO session_model_usage
         (session_id, model, billing_provider, api_call_count, input_tokens, output_tokens,
          cache_read_tokens, estimated_cost_usd, actual_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, "glm-5.3-flash", "zai", 3, 1000, 200, 400, 0, 0);
    if (toolCalls !== null) {
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, tool_call_count INTEGER)`);
      db.prepare(`INSERT INTO sessions (id, tool_call_count) VALUES (?, ?)`).run(sessionId, toolCalls);
    }
    db.close();
  }

  const profileDb = path.join(profileDir, "state.db");
  const rootDb = path.join(rootDir, "state.db");
  makeLedger(profileDb, "profiled-session", 7);
  makeLedger(rootDb, "root-session", 0);

  const env = {
    HERMES_PROFILES_DIR: profilesDir,
    HERMES_HOME: rootDir,
  } as NodeJS.ProcessEnv;

  afterAll(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(profilesDir, { recursive: true, force: true });
  });

  it("meters a managed-profile session against the profile database", () => {
    const read = readHermesSessionUsageDetailed("profiled-session", { profile, env });
    expect(read.status).toBe("metered");
    expect(read.dbPath).toBe(profileDb);
    expect(read.usage?.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 400,
    });
    expect(read.usage?.model).toBe("glm-5.3-flash");
  });

  it("reads tool_call_count from the sessions table", () => {
    expect(readHermesSessionUsageDetailed("profiled-session", { profile, env }).usage?.toolCalls).toBe(7);
    // Zero is a real reading, not a missing one.
    expect(readHermesSessionUsageDetailed("root-session", { env }).usage?.toolCalls).toBe(0);
  });

  it("falls through to the root database for unmanaged sessions", () => {
    const read = readHermesSessionUsageDetailed("root-session", { profile, env });
    expect(read.status).toBe("metered");
    expect(read.dbPath).toBe(rootDb);
  });

  it("reports unmetered_no_session when every readable ledger lacks the session", () => {
    const read = readHermesSessionUsageDetailed("never-seen", { profile, env });
    expect(read.status).toBe("unmetered_no_session");
    expect(read.usage).toBeNull();
  });

  it("reports unmetered_no_session when no session id was produced", () => {
    expect(readHermesSessionUsageDetailed(null, { profile, env }).status).toBe(
      "unmetered_no_session",
    );
  });

  it("reports unmetered_no_ledger when no candidate file can be opened", () => {
    // `dbPath` pins the candidate list to one missing file — deterministic
    // regardless of whether the dev machine has a real ~/.hermes/state.db.
    const read = readHermesSessionUsageDetailed("anything", {
      dbPath: "/nonexistent/dir/state.db",
    });
    expect(read.status).toBe("unmetered_no_ledger");
    expect(read.usage).toBeNull();
  });

  it("tolerates a ledger without the sessions table", () => {
    const noSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-old-"));
    const dbPath = path.join(noSessionsDir, "state.db");
    makeLedger(dbPath, "old-session", null);
    const read = readHermesSessionUsageDetailed("old-session", { dbPath });
    expect(read.status).toBe("metered");
    expect(read.usage?.toolCalls).toBeNull();
    fs.rmSync(noSessionsDir, { recursive: true, force: true });
  });
});

describe("readHermesSessionId", () => {
  const base = { exitCode: 0, signal: null, timedOut: false } as const;

  it("finds the session wherever the adapter recorded it", () => {
    expect(readHermesSessionId({ ...base, sessionId: "a" })).toBe("a");
    expect(readHermesSessionId({ ...base, sessionParams: { sessionId: "b" } })).toBe("b");
    expect(readHermesSessionId({ ...base, resultJson: { session_id: "c" } })).toBe("c");
    expect(readHermesSessionId({ ...base })).toBeNull();
  });
});

describe("applyHermesSessionUsage", () => {
  const base = { exitCode: 0, signal: null, timedOut: false } as const;
  const usage = summarizeHermesUsageRows(LIVE_ROWS);

  it("fills in usage the adapter did not report", () => {
    const merged = applyHermesSessionUsage({ ...base }, usage);
    expect(merged.usage).toEqual({ inputTokens: 550, outputTokens: 213, cachedInputTokens: 2739 });
    expect(merged.model).toBe("MiniMax-M3");
  });

  it("never overwrites what the adapter already established", () => {
    const merged = applyHermesSessionUsage(
      { ...base, usage: { inputTokens: 1, outputTokens: 2 }, model: "configured-label" },
      usage,
    );
    expect(merged.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(merged.model).toBe("configured-label");
  });

  it("replaces a placeholder provider with the one that was actually billed", () => {
    // The adapter reports provider "auto" meaning "Hermes chose"; measured on
    // the live instance, that put real MiniMax spend in an "auto" bucket in
    // /costs/by-provider. The ledger knows which provider was billed.
    const merged = applyHermesSessionUsage({ ...base, provider: "auto", model: "auto" }, usage);
    expect(merged.provider).toBe("minimax");
    expect(merged.model).toBe("MiniMax-M3");
  });

  it("still defers to a label a human actually configured", () => {
    const merged = applyHermesSessionUsage({ ...base, provider: "openrouter", model: "my-model" }, usage);
    expect(merged.provider).toBe("openrouter");
    expect(merged.model).toBe("my-model");
  });

  it("leaves the result untouched when the ledger has nothing", () => {
    const result = { ...base, model: "x" };
    expect(applyHermesSessionUsage(result, null)).toEqual(result);
  });

  // AGE-142 DoD c2: the task recovery budget reads turns from
  // resultJson.num_turns, and until now no adapter wrote it — the turns
  // dimension could never exhaust. The ledger's per-model api_call_count sum
  // is that number, persisted on every run the ledger can see.
  it("persists the ledger's api call count as num_turns in resultJson", () => {
    const merged = applyHermesSessionUsage({ ...base }, usage);
    expect(merged.resultJson).toMatchObject({ num_turns: 2 });
  });

  it("merges num_turns into an existing resultJson without dropping keys", () => {
    const merged = applyHermesSessionUsage(
      { ...base, resultJson: { summary: "did the work" } },
      usage,
    );
    expect(merged.resultJson).toEqual({ summary: "did the work", num_turns: 2 });
  });

  it("does not clobber a turn count the adapter already reported", () => {
    const merged = applyHermesSessionUsage(
      { ...base, resultJson: { num_turns: 7 } },
      usage,
    );
    expect(merged.resultJson).toMatchObject({ num_turns: 7 });
  });

  it("writes no num_turns when the ledger recorded no api calls", () => {
    const merged = applyHermesSessionUsage(
      { ...base },
      summarizeHermesUsageRows([{ model: "m", api_call_count: 0, input_tokens: 1, output_tokens: 1 }]),
    );
    expect(merged.resultJson?.num_turns).toBeUndefined();
  });

  it("carries the session tool_call_count through as num_tool_calls", () => {
    const usageWithTools = { ...usage!, toolCalls: 9 };
    const merged = applyHermesSessionUsage({ ...base }, usageWithTools);
    expect(merged.resultJson).toMatchObject({ num_turns: 2, num_tool_calls: 9 });
  });

  it("records a tool_call_count of zero rather than dropping it", () => {
    const merged = applyHermesSessionUsage({ ...base }, { ...usage!, toolCalls: 0 });
    expect(merged.resultJson).toMatchObject({ num_tool_calls: 0 });
  });
});
