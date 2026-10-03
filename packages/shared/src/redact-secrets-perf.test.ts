import { describe, expect, it } from "vitest";
import { createSecretStreamRedactor, redactSecrets } from "./redact-secrets.js";

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
      const quarter = bestOf(text.slice(0, MB / 4));
      const full = bestOf(text);
      // Absolute bound with CI headroom (a slow shared runner can be ~2x a
      // dev box). A quadratic regression at 1MB is minutes, not ~3s, so this
      // still catches it decisively; the scaling check below is the real
      // linearity guard.
      expect(full).toBeLessThan(3000);
      // 4x input must cost roughly 4x, not ~16x — slack for CI noise.
      expect(full).toBeLessThan(quarter * 8 + 250);
    });
  }
});

// ---------------------------------------------------------------------------
// Structural guard: every regex in the redactor must tolerate mid-run starts
// and carry bounded quantifiers, so NO unit of repeated hostile bytes can push
// a call superlinear. Each generator is a repeating unit sized to exactly N
// bytes; each is driven through both public entry points (batch + stream).
// A regression here is quadratic or worse — the review that prompted this
// file measured ~190s on 256KB of `a.` through the stream path.

const KB = 1024;
const CHUNK = 64 * KB;

/**
 * Generators: every adversarial unit the reviews have produced plus one
 * `a<sep>` unit per separator the patterns treat specially. The unit is
 * repeated to exactly N bytes.
 */
export const ADVERSARIAL_UNITS: Array<[string, string]> = [
  // Re-review 2: mid-run restarts and unbounded scans.
  ["dot run", "a."],
  ["dash run", "a-"],
  ["jwt prefix run", "eyJ-"],
  ["sk- run", "sk-"],
  ["base64 tail run", `${"a".repeat(24)}+===`],
  ["scheme run", "a://"],
  ["userinfo run", "https://a:b"],
  ["dotted-long-token run", `${"a".repeat(25)}.`],
  ["mysql -pa run", `mysql ${"-pa".repeat(8)} `],
  // Round 1: lazy-scan-to-EOS shapes.
  ["escaped-dquote run", `API_KEY="${"\\\"".repeat(512)}`],
  ["escaped-squote run", `client_secret: '${"\\'".repeat(512)}`],
  ["colon label run", `https://${"a:".repeat(512)}`],
  ["unterminated PEM markers", "-----BEGIN A PRIVATE KEY-----"],
  // Server display redactor shapes (masked keys, hex, base64, Z.AI ids).
  ["masked-key run", "abcd****efgh"],
  ["star run", "****"],
  ["hex run", "a".repeat(40)],
  ["base64 run", `${"A".repeat(30)}+/`],
  // Generic separators — one unit per delimiter class the patterns consume.
  ["sep .", "a."],
  ["sep -", "a-"],
  ["sep +", "a+"],
  ["sep :", "a:"],
  ["sep /", "a/"],
  ["sep =", "a="],
  ["sep \\", "a\\"],
  ["sep %", "a%"],
  ['sep "', 'a"'],
  ["sep '", "a'"],
  ["sep @", "a@"],
  ["sep space", "a "],
];

export function fillTo(unit: string, bytes: number): string {
  const out = unit.repeat(Math.ceil(bytes / unit.length));
  return out.length > bytes ? out.slice(0, bytes) : out;
}

function redactStream(input: string, chunk = CHUNK): void {
  const stream = createSecretStreamRedactor();
  for (let i = 0; i < input.length; i += chunk) stream.push(input.slice(i, i + chunk));
  stream.flush();
}

function timed(fn: (input: string) => void, input: string): number {
  fn(input); // warm the JIT / regex caches outside the measured runs
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 2; i++) {
    const start = performance.now();
    fn(input);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("redactSecrets structural performance", () => {
  for (const [name, unit] of ADVERSARIAL_UNITS) {
    for (const [label, harness] of [
      ["batch", (input: string) => void redactSecrets(input)],
      ["stream", redactStream],
    ] as const) {
      it(`${name} via ${label} scales to 256KB`, () => {
        const t64 = timed(harness, fillTo(unit, 64 * KB));
        const t256 = timed(harness, fillTo(unit, 256 * KB));
        // Quadratic at 256KB is tens of seconds — the absolute bound catches
        // it outright. The scaling bound catches slower degradations; the
        // 250ms floor keeps GC/timer noise at 64KB from reading as a ratio.
        expect(t256).toBeLessThan(2000);
        expect(t256).toBeLessThan(t64 * 6 + 250);
      });
    }
  }
});
