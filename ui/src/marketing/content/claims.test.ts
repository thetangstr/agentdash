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
  // SC-9 (GH #770): "Start free" is allowed now that /start exists (one free
  // workspace per email). Trial and card claims stay out: the trial runs
  // inside a workspace, and the site should not promise billing terms.
  { pattern: /No credit card|free trial/i, why: "billing terms belong to the product, not the homepage" },
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
  it("every Start free call to action goes to /start, and Sign in goes to /find", async () => {
    const { CTA } = await import("./site");
    expect(CTA.startFree).toEqual({ label: "Start free", href: "/start" });
    expect(CTA.signIn.href).toBe("/find");
    const hits = files.filter((f) => /["'`]\/auth["'`]/.test(readFileSync(f, "utf8"))).map((f) => f.replace(ROOT, "marketing"));
    expect(hits).toEqual([]);
  });
  it("every simulated surface says so", () => {
    for (const f of ["demo/StewardDemo.tsx", "sections/HeroPlayer.tsx", "video/parts.tsx"]) {
      expect(readFileSync(join(ROOT, f), "utf8")).toMatch(/Simulated/);
    }
  });
});

// Launch posts must stay within the release facts, without borrowing private
// customer proof or presenting an operator-enabled feature as a safety boundary.
describe("launch-week copy guardrails", () => {
  const launchFiles = ["content/updates.ts", "pages/WhatsNew.tsx", "pages/LaunchWeek.tsx", "updates/ReleaseIllustrations.tsx"];
  const launchCopy = launchFiles.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
  it("does not name customers or design partners, quote prices, or promise global availability", () => {
    expect(launchCopy).not.toMatch(/\bMKThink\b|\bTrack C\b|\bRoma\b|Italy Trips|Euro Tours|\bYarda\b|\bMultica\b/i);
    expect(launchCopy).not.toMatch(/\$\d|per[- ]seat|per[- ]month|free trial|no credit card/i);
    expect(launchCopy).not.toMatch(/live (everywhere|on every)|available (everywhere|to everyone)|guaranteed|few milliseconds/i);
    expect(launchCopy).not.toMatch(/secure isolation|SSH.{0,80}(isolat|budget.{0,20}enforc)/i);
  });
  it("keeps travel-specific work out of the launch highlights", () => {
    expect(launchCopy).not.toMatch(/Business view|milestones?|Negotiation|Settlement|ac\.milestone-timeline|RUN-BUSINESS-VIEW|harness|assignment[- ]only|wake[- ]policy|run[- ]window|instance identity|AGENT-WAKE-POLICY|travel/i);
  });
  it("labels both illustrations and avoids implying rollout to every instance", () => {
    expect(readFileSync(join(ROOT, "updates/ReleaseIllustrations.tsx"), "utf8").match(/Simulated illustration/g)).toHaveLength(2);
    expect(launchCopy).toMatch(/depends on the version your operator has installed/);
  });
  it("links only the two release-note source files", async () => {
    const { UPDATE_SOURCES } = await import("./updates");
    const { GITHUB_URL } = await import("./site");
    expect(UPDATE_SOURCES.map((s) => s.href)).toEqual([
      `${GITHUB_URL}/blob/main/releases/v2026.1007.0.md`,
      `${GITHUB_URL}/blob/main/releases/v2026.1007.1.md`,
    ]);
  });
});
