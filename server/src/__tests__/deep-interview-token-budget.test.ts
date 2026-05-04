// AgentDash (Phase G): Token-budget hard gate.
//
// Phase G acceptance gate #5:
//   bytes(hermes_local prompt) / bytes(claude_api prompt) ≤ 0.30
//
// This is a HARD expect() assertion — not a soft warning. It must pass in CI
// for Phase G to be considered complete. The check lives here at the unit level
// because collecting per-adapter bytes from a single E2E test run is fragile
// (requires both adapters to be exercised in the same run). The unit test is
// authoritative; the Hermes E2E spec (onboarding-deep-interview-hermes.spec.ts)
// is informational and skipped in CI.
//
// Method: import composePrompt (pure function, no I/O) and measure
// Buffer.byteLength(JSON.stringify(composed)) for each adapter against the same
// interview state. The ratio must be ≤ 0.30.
//
// Why this works: composePrompt uses SKILL_MD_FULL for claude_api and
// SKILL_MD_SUMMARY for hermes_local. SKILL_MD_FULL is ~16.7k tokens / ~67 KB;
// SKILL_MD_SUMMARY is ~3-4k tokens / ~12-16 KB. The ratio is ~0.18-0.24 which
// comfortably satisfies ≤ 0.30. The test will catch regressions if SKILL_MD_SUMMARY
// grows too large or if the adapter routing logic changes.

import { describe, it, expect } from "vitest";
import { composePrompt, type DeepInterviewStateRow } from "../services/deep-interview-prompts.js";

function makeState(overrides?: Partial<DeepInterviewStateRow>): DeepInterviewStateRow {
  return {
    scope: "cos_onboarding",
    scopeRefId: "test-company-id",
    currentRound: 3,
    ambiguityScore: 0.45,
    dimensionScores: { goal: 0.6, constraints: 0.5, criteria: 0.45, context: 0.4 },
    ontologySnapshots: [],
    challengeModesUsed: [],
    transcript: [
      {
        round: 1,
        question: "What's your primary goal for this rollout?",
        targetDimension: "goal",
        answer:
          "We want to reduce cycle time for engineering by 40% over two quarters. About 2,000 engineers across 14 squads spend too much time on incident triage and PR review bottlenecks.",
        ambiguityAfter: 0.75,
      },
      {
        round: 2,
        question: "What constraints matter most?",
        targetDimension: "constraints",
        answer:
          "SOC 2 Type II compliance — agents must stay in our VPC. $800K net budget. GitHub Enterprise and Jira integration required; no new auth silos.",
        ambiguityAfter: 0.45,
      },
    ],
    brownfield: false,
    initialIdea:
      "Deploy AI agents to our 2,000-engineer org to reduce incident MTTT by 40% and PR review time by 50%.",
    ...overrides,
  };
}

describe("Phase G token-budget hard gate (acceptance #5)", () => {
  it("hermes_local prompt bytes ≤ 0.30 × claude_api prompt bytes", () => {
    const state = makeState();

    const claudeComposed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state,
    });
    const hermesComposed = composePrompt({
      adapter: "hermes_local",
      phase: "ask_question",
      state,
    });

    const claudeBytes = Buffer.byteLength(
      JSON.stringify({ system: claudeComposed.system, messages: claudeComposed.messages }),
      "utf8",
    );
    const hermesBytes = Buffer.byteLength(
      JSON.stringify({ system: hermesComposed.system, messages: hermesComposed.messages }),
      "utf8",
    );

    const ratio = hermesBytes / claudeBytes;

    console.info(
      `[token-budget] claude_api=${claudeBytes} bytes, hermes_local=${hermesBytes} bytes, ratio=${ratio.toFixed(4)}`,
    );

    // HARD assertion — Phase G acceptance gate #5.
    expect(
      ratio,
      `hermes_local prompt (${hermesBytes} bytes) must be ≤ 30% of ` +
        `claude_api prompt (${claudeBytes} bytes). Got ratio=${ratio.toFixed(4)}. ` +
        `Check SKILL_MD_SUMMARY size and adapter routing in deep-interview-prompts.ts.`,
    ).toBeLessThanOrEqual(0.30);
  });

  it("claude_api and hermes_local prompts share the same messages array (only system differs)", () => {
    const state = makeState();

    const claudeComposed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state,
    });
    const hermesComposed = composePrompt({
      adapter: "hermes_local",
      phase: "ask_question",
      state,
    });

    // Messages should be identical — only the system prompt differs by SKILL corpus.
    expect(JSON.stringify(claudeComposed.messages)).toEqual(
      JSON.stringify(hermesComposed.messages),
    );

    // Systems MUST differ (one has SKILL_MD_FULL, one has SKILL_MD_SUMMARY).
    expect(claudeComposed.system).not.toEqual(hermesComposed.system);

    // claude_api system must be larger.
    expect(
      Buffer.byteLength(claudeComposed.system, "utf8"),
    ).toBeGreaterThan(Buffer.byteLength(hermesComposed.system, "utf8"));
  });

  it("ratio holds across different interview rounds (round 0, 5, 15)", () => {
    for (const round of [0, 5, 15]) {
      const state = makeState({ currentRound: round });

      const claudeComposed = composePrompt({ adapter: "claude_api", phase: "ask_question", state });
      const hermesComposed = composePrompt({ adapter: "hermes_local", phase: "ask_question", state });

      const claudeBytes = Buffer.byteLength(JSON.stringify(claudeComposed), "utf8");
      const hermesBytes = Buffer.byteLength(JSON.stringify(hermesComposed), "utf8");
      const ratio = hermesBytes / claudeBytes;

      expect(
        ratio,
        `round ${round}: ratio ${ratio.toFixed(4)} exceeds 0.30 limit`,
      ).toBeLessThanOrEqual(0.30);
    }
  });
});
