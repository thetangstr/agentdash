import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact-secrets.js";

/**
 * Adversarial-input performance. Issue comments and run logs have no length
 * limit, so a quadratic regex freezes every reader for minutes on a single
 * hostile string. Each case must finish in well under a second at ~1MB and
 * scale roughly linearly (a 4x input must not cost ~16x).
 */

const MB = 1024 * 1024;

function bestOf(input: string, runs = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    redactSecrets(input);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

const CASES: Array<[string, () => string]> = [
  // Unterminated double-quoted value: the lazy JSON_KV key used to retry to
  // end-of-input from every `\"` — O(N^2).
  ["unterminated double-quoted run", () => `API_KEY="` + `\\"`.repeat(MB / 2)],
  // Same for the single-quoted JSON_KV branch.
  ["unterminated single-quoted run", () => `client_secret: '` + `\\'`.repeat(MB / 2)],
  // `a:`×N: each rejected `a:` label used to rewind and rescan its whole
  // value tail — O(N^2) until the rewind was gated on a following `=`.
  ["colon-separated label run", () => `https://` + `a:`.repeat(MB / 2)],
  // Unterminated PEM markers: the lazy [\s\S]*? body used to scan to
  // end-of-input from every `-----BEGIN` marker.
  ["unterminated PEM markers", () => `-----BEGIN A PRIVATE KEY-----`.repeat(Math.ceil(MB / 29))],
];

describe("redactSecrets adversarial input", () => {
  for (const [name, build] of CASES) {
    it(`${name} at ~1MB completes linearly`, () => {
      const text = build();
      expect(text.length).toBeGreaterThanOrEqual(MB);
      const full = bestOf(text);
      const quarter = bestOf(text.slice(0, MB / 4));
      // Generous CI bound; a quadratic regression is minutes, not ~1s.
      expect(full).toBeLessThan(1000);
      // 4x input must cost roughly 4x, not ~16x — slack for CI noise.
      expect(full).toBeLessThan(quarter * 8 + 250);
    });
  }
});
