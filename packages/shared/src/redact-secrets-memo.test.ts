// AgentDash: the known-secrets matcher is memoized on the exact secret list
// (2026-10-07 HQ stall: rebuilding encodings + every 14-char fragment on each
// call made a 624 KB run-log read take 25–35 s). The cache must never change
// what gets redacted — these tests pin the output to the pre-memoization
// implementation and bound the per-call cost.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  __knownSecretsRegexCacheSizeForTests,
  containsSecrets,
  createSecretStreamRedactor,
  REDACTED,
  redactSecrets,
  redactSecretsInValue,
} from "./redact-secrets.js";
import { buildRedactionCorpus, evaluateCorpusCase } from "./__fixtures__/redact-secrets-corpus.js";

const impl = { redactSecrets, containsSecrets, redactSecretsInValue, createSecretStreamRedactor };

const expected = JSON.parse(
  readFileSync(new URL("./__fixtures__/redact-secrets-corpus.expected.json", import.meta.url), "utf8"),
) as { cases: number; sha256Prefix20: string[] };

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);

const token = (n: number, seed: number) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let s = "";
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += chars[x % chars.length];
  }
  return s;
};

describe("known-secrets memoization", () => {
  const corpus = buildRedactionCorpus();

  it("redacts the corpus exactly like the pre-memoization implementation", () => {
    expect(corpus.length).toBe(expected.cases);
    const mismatches: number[] = [];
    corpus.forEach((c, i) => {
      if (digest(evaluateCorpusCase(impl, c)) !== expected.sha256Prefix20[i]) mismatches.push(i);
    });
    expect(mismatches).toEqual([]);
  });

  it("gives identical output on a warm cache (second pass over the corpus)", () => {
    for (let pass = 0; pass < 2; pass++) {
      corpus.forEach((c, i) => {
        expect(digest(evaluateCorpusCase(impl, c)), `case ${i} pass ${pass}`).toBe(expected.sha256Prefix20[i]);
      });
    }
  });

  it("still hides a known secret and its encoded forms and fragments after the cache is warm", () => {
    const secret = token(48, 7);
    const secrets = [secret];
    redactSecrets("warm", secrets);
    const b64 = Buffer.from(secret).toString("base64");
    const hex = Buffer.from(secret).toString("hex");
    for (const form of [secret, b64, hex, [...secret].reverse().join(""), secret.slice(5, 19)]) {
      const out = redactSecrets(`value ${form} end`, secrets);
      expect(out).toContain(REDACTED);
      expect(out).not.toContain(form);
    }
  });

  it("does not let a cached list leak into a different list", () => {
    const a = token(40, 11);
    const b = token(40, 12);
    expect(redactSecrets(`x ${a} y`, [a])).toBe(`x ${REDACTED} y`);
    // Same cache, different list: `a` is no longer a known secret.
    expect(redactSecrets(`x ${a} y`, [b])).toBe(`x ${a} y`);
  });

  it("keeps the cache bounded", () => {
    for (let i = 0; i < 200; i++) redactSecrets("text", [token(32, 1000 + i)]);
    expect(__knownSecretsRegexCacheSizeForTests()).toBeLessThanOrEqual(32);
  });

  it("makes repeated calls with the same secrets cheap (regression bound)", () => {
    const secrets = Array.from({ length: 12 }, (_, i) => token(36 + i * 5, 100 + i));
    redactSecrets("warm", secrets);
    const start = performance.now();
    for (let i = 0; i < 11_000; i++) redactSecrets("stdout", secrets);
    const elapsed = performance.now() - start;
    // Pre-fix: ~6 s on a dev box (each call rebuilt ~700 fragments). Post-fix:
    // ~40 ms. Generous bound for loaded CI runners.
    expect(elapsed).toBeLessThan(1_500);
  });

  it("redacts a ~600 KB NDJSON log with 12 secrets well under the old cost", () => {
    const secrets = Array.from({ length: 12 }, (_, i) => token(36 + i * 5, 200 + i));
    const lines: string[] = [];
    let bytes = 0;
    for (let i = 0; bytes < 600_000; i++) {
      const chunk = `${"the agent ran a shell command ".repeat(i % 400 === 0 ? 1000 : 3)}${i % 97 === 0 ? secrets[i % 12] : ""}`;
      const line = JSON.stringify({ ts: "2026-10-07T00:00:00.000Z", stream: "stdout", chunk, seq: i });
      lines.push(line);
      bytes += line.length + 1;
    }
    const start = performance.now();
    const out = lines.map((line) => JSON.stringify(redactSecretsInValue(JSON.parse(line), secrets))).join("\n");
    const elapsed = performance.now() - start;
    for (const secret of secrets) expect(out).not.toContain(secret);
    // Pre-fix: ~3.8 s on a dev box, 25–35 s on the HQ mini. Post-fix: ~0.1 s.
    expect(elapsed).toBeLessThan(2_000);
  });
});
