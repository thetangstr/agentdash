import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The public site must not carry placeholder copy, invented proof, or calls
 * to action the product cannot honour. This scans every marketing source file
 * so a regression fails loudly instead of shipping to the homepage.
 */
const ROOT = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /placeholder:? replace|\[Founder|\[Title\]|Logo [1-5]\b|FILL IN/i, why: "placeholder copy" },
  { pattern: /agentdash\.example|@agentdash\.com\b/, why: "mailbox that does not exist (agentdash.com is parked)" },
  { pattern: /Start free|No credit card|free trial/i, why: "self-serve signup is not available" },
  { pattern: /Skills Registry|Smart Model Routing|Policy Engine|HubSpot/i, why: "capability dropped from v2" },
  { pattern: /customers? (love|trust)|trusted by|\b\d+\+? (companies|customers|teams) (use|run)/i, why: "adoption claim without evidence" },
  { pattern: /\$\d+\s*\/\s*(seat|month|mo)\b/i, why: "pricing is not decided for the hosted offering" },
];

describe("marketing copy guardrails", () => {
  const files = walk(ROOT);
  it("scans a meaningful set of files", () => {
    expect(files.length).toBeGreaterThan(20);
  });
  for (const { pattern, why } of FORBIDDEN) {
    it(`never contains ${pattern} (${why})`, () => {
      const hits = files
        .map((f) => ({ f, text: readFileSync(f, "utf8") }))
        .filter(({ f, text }) => pattern.test(text) && !f.endsWith("LiveBriefing.tsx"))
        .map(({ f }) => f.replace(ROOT, "marketing"));
      expect(hits).toEqual([]);
    });
  }
  it("every simulated surface says so", () => {
    for (const f of ["demo/StewardDemo.tsx", "sections/HeroPlayer.tsx", "video/parts.tsx"]) {
      expect(readFileSync(join(ROOT, f), "utf8")).toMatch(/Simulated/);
    }
  });
});
