import { describe, expect, it, vi } from "vitest";
vi.mock("../services/hermes-provider-setup.js", () => ({ configuredProviderKeysSync: () => [] }));
vi.mock("../services/redact-secrets.js", () => ({ knownKeysFromEnv: () => ["fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls", "first secret\nsecond secret"] }));
vi.mock("../log-redaction.js", () => ({
  redactCurrentUserText: (text: string) => text.replaceAll("/Users/fixture-person", "/Users/f*************"),
}));
import * as redaction from "../services/feedback-redaction.js";

// Missing cooperative processing stalls a queued event-loop task. The sync
// implementation remains a policy oracle; literal assertions also catch leaks.
describe("cooperative feedback privacy", () => {
  it("preserves output, counts and truncation while yielding on large multiline text", async () => {
    const input = ("ordinary workspace progress ✓\n".repeat(100) +
      "/Users/fixture-person fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls someone@example.test +1 (415) 555-1234\n").repeat(100);
    const before = redaction.createFeedbackRedactionState();
    const expected = redaction.sanitizeFeedbackText(input, before, "log", 100_000);
    const after = redaction.createFeedbackRedactionState();
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const output = await redaction.sanitizeFeedbackTextAsync(input, after, "log", 100_000, { sliceMs: 0 });
    expect(yielded).toBe(true);
    expect(output).toBe(expected);
    expect(redaction.finalizeFeedbackRedactionSummary(after)).toEqual(redaction.finalizeFeedbackRedactionSummary(before));
    expect(output).not.toContain("fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls");
    expect(output).not.toContain("someone@example.test");
    expect(after.counts.get("shared_secret")).toBe(1);
    expect(after.truncatedFields.has("log")).toBe(true);
  });

  it("retains crossline PEM, quoted assignment, whitespace labels and known-secret matching", async () => {
    const inputs = [
      "before\n-----BEGIN PRIVATE KEY-----\nsecretbody\n-----END PRIVATE KEY-----\nafter",
      'before\npassword="first line\nsecond line"\nafter',
      "before\npassword\n =\n unshaped-value\nafter",
      "before\nBearer\n fixtureToken44\nafter",
      "before\nfirst secret\nsecond secret\nafter",
    ];
    for (const input of inputs) {
      const before = redaction.createFeedbackRedactionState();
      const after = redaction.createFeedbackRedactionState();
      expect(await redaction.sanitizeFeedbackTextAsync(input, after, "log", 1_000_000, { sliceMs: 0 }))
        .toBe(redaction.sanitizeFeedbackText(input, before, "log", 1_000_000));
      expect(redaction.finalizeFeedbackRedactionSummary(after)).toEqual(redaction.finalizeFeedbackRedactionSummary(before));
    }
  });

  it("keeps escaped credentials inside parseable NDJSON and applies feedback PII rules", async () => {
    const input = Array.from({ length: 200 }, (_, seq) => JSON.stringify({ seq, stream: "stdout", chunk:
      'ordinary ✓\nAPI_KEY="ab\\cd\\\"ef-secret-123"\nfixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls someone@example.test\n',
    })).join("\n") + "\n";
    const state = redaction.createFeedbackRedactionState();
    const out = await redaction.sanitizeFeedbackNdjsonAsync(input, state, "log", 1_000_000, { sliceMs: 0 });
    const entries = out.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 200 }, (_, seq) => seq));
    expect(entries[0].chunk).toContain("ordinary ✓\n");
    expect(out).not.toContain("ef-secret-123");
    expect(out).not.toContain("someone@example.test");
    expect(out).not.toContain("fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls");
  });

  it("preserves structured values and their privacy summary", async () => {
    const value = { token: "hidden-value", nested: [{ note: "someone@example.test" }, { password: "hidden-too" }] };
    const before = redaction.createFeedbackRedactionState();
    const after = redaction.createFeedbackRedactionState();
    expect(await redaction.sanitizeFeedbackValueAsync(value, after, "value", 500, { sliceMs: 0 }))
      .toEqual(redaction.sanitizeFeedbackValue(value, before, "value", 500));
    expect(redaction.finalizeFeedbackRedactionSummary(after)).toEqual(redaction.finalizeFeedbackRedactionSummary(before));
    expect(after.counts.get("structured_secret")).toBe(1);
    expect(after.counts.get("email")).toBe(1);
  });

  it("truncates NDJSON at whole records and still accounts for later hidden values", async () => {
    const state = redaction.createFeedbackRedactionState();
    const input = '{"seq":0,"chunk":"ordinary"}\n{"seq":1,"chunk":"someone@example.test"}\n';
    const out = await redaction.sanitizeFeedbackNdjsonAsync(input, state, "log", 35, { sliceMs: 0 });
    expect(JSON.parse(out).seq).toBe(0);
    expect(state.truncatedFields.has("log")).toBe(true);
    expect(state.counts.get("email")).toBe(1);
  });

  it("retains whole-text crossline privacy on malformed legacy NDJSON", async () => {
    const input = 'prefix\nfirst secret\nsecond secret\n-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----\n';
    const before = redaction.createFeedbackRedactionState();
    const after = redaction.createFeedbackRedactionState();
    expect(await redaction.sanitizeFeedbackNdjsonAsync(input, after, "log", 10_000, { sliceMs: 0 }))
      .toBe(redaction.sanitizeFeedbackText(input, before, "log", 10_000));
    expect(redaction.finalizeFeedbackRedactionSummary(after)).toEqual(redaction.finalizeFeedbackRedactionSummary(before));
  });

  it("hides credentials and PII in JSON keys without leaking them in summary paths", async () => {
    const input = JSON.stringify({ "fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls": "ordinary", "someone@example.test": "other" });
    const state = redaction.createFeedbackRedactionState();
    const out = await redaction.sanitizeFeedbackNdjsonAsync(input, state, "log", 10_000, { sliceMs: 0 });
    const result = JSON.stringify({ output: JSON.parse(out), summary: redaction.finalizeFeedbackRedactionSummary(state) });
    expect(result).not.toContain("fixture-Zq8Rk2Vm7Tn4Wb9Xc3Ls");
    expect(result).not.toContain("someone@example.test");
    expect(out).toContain("ordinary");
  });

  it("rejects cancellation without publishing partial privacy counts", async () => {
    const state = redaction.createFeedbackRedactionState();
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await expect(redaction.sanitizeFeedbackTextAsync("someone@example.test\n".repeat(5000), state, "log", 100_000,
      { sliceMs: 0, signal: controller.signal })).rejects.toThrow();
    expect(state.counts.size).toBe(0);
  });
});
