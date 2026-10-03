import { describe, expect, it, vi } from "vitest";
import { redactForDisplay } from "../services/redact-for-display.js";

// dispatch-llm's import graph reaches execFile at module load via the codex
// adapter — mock child_process so importing describeAdapterFailure is cheap.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { describeAdapterFailure } from "../services/dispatch-llm.js";

/**
 * Structural performance guard for the server-side display redactor — the
 * sibling of packages/shared/src/redact-secrets-perf.test.ts, which covers
 * the shared batch and stream redactors. The display redactor runs over
 * unbounded adapter stdout/stderr (dispatch-llm, cos-dispatch-failure), so a
 * superlinear pattern there stalls the event loop on hostile adapter output.
 * The generator table mirrors the shared file: every adversarial unit the
 * reviews have produced plus one `a<sep>` unit per separator class.
 */

const KB = 1024;

const ADVERSARIAL_UNITS: Array<[string, string]> = [
  ["dot run", "a."],
  ["dash run", "a-"],
  ["jwt prefix run", "eyJ-"],
  ["sk- run", "sk-"],
  ["base64 tail run", `${"a".repeat(24)}+===`],
  ["scheme run", "a://"],
  ["userinfo run", "https://a:b"],
  ["dotted-long-token run", `${"a".repeat(25)}.`],
  ["mysql -pa run", `mysql ${"-pa".repeat(8)} `],
  ["escaped-dquote run", `API_KEY="${"\\\"".repeat(512)}`],
  ["escaped-squote run", `client_secret: '${"\\'".repeat(512)}`],
  ["colon label run", `https://${"a:".repeat(512)}`],
  ["unterminated PEM markers", "-----BEGIN A PRIVATE KEY-----"],
  ["masked-key run", "abcd****efgh"],
  ["star run", "****"],
  ["hex run", "a".repeat(40)],
  ["base64 run", `${"A".repeat(30)}+/`],
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

function fillTo(unit: string, bytes: number): string {
  const out = unit.repeat(Math.ceil(bytes / unit.length));
  return out.length > bytes ? out.slice(0, bytes) : out;
}

function timed(fn: (input: string) => void, input: string): number {
  fn(input);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 2; i++) {
    const start = performance.now();
    fn(input);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("redactForDisplay structural performance", () => {
  for (const [name, unit] of ADVERSARIAL_UNITS) {
    // 6 timed calls per case; bounded-but-deep regex scans can take a few
    // seconds on a slow shared runner — well past the 5s default timeout.
    it(`${name} scales to 256KB`, { timeout: 60_000 }, () => {
      const t64 = timed((input) => void redactForDisplay(input), fillTo(unit, 64 * KB));
      const t256 = timed((input) => void redactForDisplay(input), fillTo(unit, 256 * KB));
      // Same contract as the shared guard: sublinear scaling and a hard 2s
      // ceiling at 256KB (a quadratic regression is tens of seconds).
      expect(t256).toBeLessThan(2000);
      expect(t256).toBeLessThan(t64 * 6 + 250);
    });
  }

  it("caps describeAdapterFailure input so unbounded adapter output stays cheap", { timeout: 60_000 }, () => {
    // Adapter output has no length limit — the redactor must only ever scan
    // a bounded tail, so a 8MB hostile stderr is not scanned end to end.
    const hostile = `xxxx ${"a.".repeat(4 * 1024 * 1024)}`;
    const start = performance.now();
    const detail = describeAdapterFailure(hostile, hostile);
    const elapsed = performance.now() - start;
    expect(detail.length).toBeLessThanOrEqual(600);
    expect(elapsed).toBeLessThan(2000);
  });
});
