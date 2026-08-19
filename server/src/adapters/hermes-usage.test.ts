import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyHermesSessionUsage,
  readHermesSessionId,
  readHermesSessionUsage,
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

  it("leaves the result untouched when the ledger has nothing", () => {
    const result = { ...base, model: "x" };
    expect(applyHermesSessionUsage(result, null)).toEqual(result);
  });
});
