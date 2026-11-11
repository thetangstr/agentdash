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
  it("links only the two releases' public notes pages", async () => {
    const { UPDATE_SOURCES } = await import("./updates");
    expect(UPDATE_SOURCES.map((s) => s.href)).toEqual(["/releases/v2026.1007.0", "/releases/v2026.1007.1"]);
  });
});

// The /how-it-works story is approved copy about shipped features (releases/v2026.1031.0.md). Its lines
// are pinned verbatim so a change is deliberate, and the illustration must not show money or say more
// than the copy does.
describe("how-it-works copy guardrails", () => {
  const APPROVED_LINES = [
    "Tell the Chief of Staff about the business. It drafts a team plan.",
    "You confirm the plan. Hires beyond it wait for your approval.",
    "Each agent has an operating profile: its job, written by a person.",
    "A change to a profile is a proposal. It applies only after it's approved.",
    "Access rules set what an agent can see, do, and who it can talk to.",
    "Start in shadow: AgentDash logs what it would refuse, and refuses nothing.",
    "Switch to enforce: out-of-scope actions are refused, with the reason.",
    "Its accountable person, steward and admins are always reachable.",
    "Every agent gets a scorecard from real records: work owed, quality, cost.",
    "What isn't known shows as unknown, not as a guess.",
    "A performance manager reads the scorecards and recommends changes.",
    "Only people decide. A pause recommendation never pauses an agent.",
    "Agents managed like staff. People stay in charge.",
  ];
  const storyFiles = [
    "how-it-works/story.ts", "how-it-works/StorySection.tsx", "how-it-works/scenes/cards.ts",
    "how-it-works/scenes/lanes.ts", "pages/HowItWorks.tsx",
  ];
  const storyCopy = storyFiles.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

  it("keeps the approved caption lines verbatim, every chapter live, and the example names", async () => {
    const { STORY, storyLines } = await import("../how-it-works/story");
    expect(storyLines()).toEqual(APPROVED_LINES);
    expect(STORY.chapters.map((c) => [c.label, c.status])).toEqual([
      ["Plan", "Live"], ["Profile", "Live"], ["Access", "Live"], ["Scorecard", "Live"], ["Decide", "Live"],
    ]);
    expect(STORY.names).toEqual({ you: "You", cos: "Chief of Staff", agents: ["Research", "Sales", "Support"] });
  });

  it("labels the illustration as one, directly under the stage", async () => {
    const { ILLUSTRATION_NOTE } = await import("../how-it-works/story");
    expect(ILLUSTRATION_NOTE).toBe("An illustration of how AgentDash works, not a recording. Names are examples.");
    expect(readFileSync(join(ROOT, "how-it-works/StorySection.tsx"), "utf8")).toMatch(/hiw-story__stage[\s\S]*ILLUSTRATION_NOTE[\s\S]*hiw-story__foot/);
  });

  it("shows no money, prices or budgets in the story or its visuals", () => {
    expect(storyCopy).not.toMatch(/\$\s?\d|\bUSD\b|\bbudget|\bspend|per[- ](seat|month)|\bprice/i);
  });

  it("never shows a pause taking effect or a refusal in shadow mode", () => {
    const scenes = ["how-it-works/scenes/cards.ts", "how-it-works/scenes/lanes.ts"].map((f) => readFileSync(join(ROOT, f), "utf8"));
    for (const s of scenes) {
      expect(s).toMatch(/not paused/);
      expect(s).not.toMatch(/["'>](Paused|Agent paused)\b/);
      expect(s).toMatch(/[Nn]othing refused/);
    }
  });

  it("states the qualifiers that keep the mechanism list honest", () => {
    const page = readFileSync(join(ROOT, "pages/HowItWorks.tsx"), "utf8");
    expect(page).toMatch(/Access rules stay off until an admin turns them on/);
    expect(page).toMatch(/depends\s+on the version its operator has installed/);
    expect(page).toMatch(/releases\/v2026\.1031\.0\.md/);
  });
});
