import { describe, expect, it } from "vitest";
import {
  applyHermesUsageReport,
  parseHermesUsageReport,
  withUsageFileArg,
} from "./hermes-usage.js";

/** A real report, copied from a Hermes 0.20 run on the MKThink Mini. */
const LIVE_REPORT = {
  estimated_cost_usd: 0.0,
  cost_status: "unknown",
  cost_source: "none",
  input_tokens: 13743,
  output_tokens: 2,
  cache_read_tokens: 1023,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 14768,
  api_calls: 1,
  model: "MiniMax-M3",
  provider: "minimax",
  session_id: "20260818_165154_a7ae2a",
  completed: true,
  failed: false,
  service_tier: null,
};

describe("parseHermesUsageReport", () => {
  it("reads the counts out of a real Hermes report", () => {
    const report = parseHermesUsageReport(LIVE_REPORT);
    expect(report?.usage).toEqual({ inputTokens: 13743, outputTokens: 2, cachedInputTokens: 1023 });
    expect(report?.model).toBe("MiniMax-M3");
    expect(report?.provider).toBe("minimax");
    expect(report?.apiCalls).toBe(1);
  });

  it("refuses a cost Hermes says it does not know", () => {
    // estimated_cost_usd is 0.0 with cost_status "unknown": Hermes has the
    // token counts and not the price list. Recording $0.00 would put a false
    // statement on the costs page, not merely an incomplete one.
    expect(parseHermesUsageReport(LIVE_REPORT)?.costUsd).toBeNull();
  });

  it("takes a cost Hermes does claim to know", () => {
    const report = parseHermesUsageReport({
      ...LIVE_REPORT,
      estimated_cost_usd: 0.0123,
      cost_status: "estimated",
      cost_source: "price_table",
    });
    expect(report?.costUsd).toBeCloseTo(0.0123);
  });

  it("still reports the tokens of a failed run", () => {
    // Hermes writes the file even when the run fails, and an agent that burned
    // 40k tokens before dying spent them just the same.
    const report = parseHermesUsageReport({
      ...LIVE_REPORT,
      completed: false,
      failed: true,
      output_tokens: 0,
      input_tokens: 40123,
    });
    expect(report?.usage.inputTokens).toBe(40123);
  });

  it("returns null for a report with nothing countable in it", () => {
    expect(parseHermesUsageReport({ model: "MiniMax-M3" })).toBeNull();
    expect(parseHermesUsageReport(null)).toBeNull();
    expect(parseHermesUsageReport("{}")).toBeNull();
    expect(parseHermesUsageReport([])).toBeNull();
  });
});

describe("applyHermesUsageReport", () => {
  const base = { exitCode: 0, signal: null, timedOut: false } as const;

  it("fills in usage the adapter did not report", () => {
    const merged = applyHermesUsageReport({ ...base }, parseHermesUsageReport(LIVE_REPORT));
    expect(merged.usage).toEqual({ inputTokens: 13743, outputTokens: 2, cachedInputTokens: 1023 });
    expect(merged.model).toBe("MiniMax-M3");
  });

  it("never overwrites what the adapter already established", () => {
    const merged = applyHermesUsageReport(
      { ...base, usage: { inputTokens: 1, outputTokens: 2 }, model: "configured-label", provider: "hermes" },
      parseHermesUsageReport(LIVE_REPORT),
    );
    expect(merged.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(merged.model).toBe("configured-label");
    expect(merged.provider).toBe("hermes");
  });

  it("leaves the result untouched when there is no report", () => {
    const result = { ...base, model: "x" };
    expect(applyHermesUsageReport(result, null)).toEqual(result);
  });
});

describe("withUsageFileArg", () => {
  it("appends after the operator's own extra args", () => {
    expect(withUsageFileArg({ extraArgs: ["--safe-mode"] }, "/tmp/u.json").extraArgs).toEqual([
      "--safe-mode",
      "--usage-file",
      "/tmp/u.json",
    ]);
  });

  it("adds the flag when there are no extra args at all", () => {
    expect(withUsageFileArg({}, "/tmp/u.json").extraArgs).toEqual(["--usage-file", "/tmp/u.json"]);
  });

  it("leaves a path the operator pinned alone", () => {
    const config = { extraArgs: ["--usage-file", "/var/log/hermes-usage.json"] };
    expect(withUsageFileArg(config, "/tmp/u.json")).toBe(config);
  });

  it("ignores non-string entries rather than passing them to a shell", () => {
    expect(withUsageFileArg({ extraArgs: ["--safe-mode", 42, null] }, "/tmp/u.json").extraArgs).toEqual([
      "--safe-mode",
      "--usage-file",
      "/tmp/u.json",
    ]);
  });
});
