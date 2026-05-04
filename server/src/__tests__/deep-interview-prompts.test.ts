// AgentDash (Phase C): unit tests for deep-interview prompt composition.
//
// HARD acceptance gates (Phase C #7):
//   - composePrompt({ adapter: "claude_api" }).system contains SKILL_MD_FULL
//   - composePrompt({ adapter: "hermes_local" }).system contains SKILL_MD_SUMMARY
// Both checks are string-equality assertions — comments / "should" hand-waves
// are not acceptable.

import { describe, it, expect } from "vitest";
import {
  SKILL_MD_FULL,
  SKILL_MD_SUMMARY,
} from "@paperclipai/shared/deep-interview-skill";
import {
  composePrompt,
  selectPromptDepth,
  type DeepInterviewStateRow,
} from "../services/deep-interview-prompts.js";

function makeState(
  overrides?: Partial<DeepInterviewStateRow>,
): DeepInterviewStateRow {
  return {
    scope: "cos_onboarding",
    scopeRefId: "11111111-1111-1111-1111-111111111111",
    currentRound: 1,
    ambiguityScore: null,
    dimensionScores: null,
    ontologySnapshots: [],
    challengeModesUsed: [],
    transcript: [],
    brownfield: false,
    initialIdea: "Build a CRM for dentists.",
    ...overrides,
  };
}

describe("selectPromptDepth", () => {
  it("returns 'full' only for claude_api", () => {
    expect(selectPromptDepth("claude_api")).toBe("full");
  });

  it("returns 'summary' for hermes_local", () => {
    expect(selectPromptDepth("hermes_local")).toBe("summary");
  });

  it("returns 'summary' for claude_local", () => {
    expect(selectPromptDepth("claude_local")).toBe("summary");
  });

  it("returns 'summary' for codex_local / gemini_local / cursor", () => {
    expect(selectPromptDepth("codex_local")).toBe("summary");
    expect(selectPromptDepth("gemini_local")).toBe("summary");
    expect(selectPromptDepth("cursor")).toBe("summary");
  });

  it("returns 'summary' for an unknown adapter (default-safe)", () => {
    expect(selectPromptDepth("nonexistent_adapter_xyz")).toBe("summary");
  });
});

describe("composePrompt — Phase C acceptance #7 (HARD)", () => {
  it("claude_api ships SKILL_MD_FULL verbatim", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state: makeState(),
    });
    expect(composed.system.includes(SKILL_MD_FULL)).toBe(true);
    // And does NOT regress to the summary.
    expect(composed.system.startsWith(SKILL_MD_FULL)).toBe(true);
  });

  it("hermes_local ships SKILL_MD_SUMMARY verbatim", () => {
    const composed = composePrompt({
      adapter: "hermes_local",
      phase: "ask_question",
      state: makeState(),
    });
    expect(composed.system.includes(SKILL_MD_SUMMARY)).toBe(true);
    expect(composed.system.startsWith(SKILL_MD_SUMMARY)).toBe(true);
    // And the system prompt must NOT contain the full SKILL.md (the
    // distinguishing token-budget invariant — Pre-mortem #4).
    // Use the fingerprint of SKILL_MD_FULL that does NOT also appear in the
    // summary: the bracketed "next-skill-args" front-matter line is unique
    // to the full corpus.
    expect(composed.system).not.toContain("next-skill-args: --consensus --direct");
  });

  it("claude_local ships SKILL_MD_SUMMARY (also a spawn adapter)", () => {
    const composed = composePrompt({
      adapter: "claude_local",
      phase: "ask_question",
      state: makeState(),
    });
    expect(composed.system.includes(SKILL_MD_SUMMARY)).toBe(true);
  });
});

describe("composePrompt — challenge modes", () => {
  it("does not inject any challenge fragment when challengeMode is omitted", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state: makeState({ currentRound: 4, challengeModesUsed: [] }),
    });
    expect(composed.system).not.toContain("[CHALLENGE — Contrarian]");
    expect(composed.system).not.toContain("[CHALLENGE — Simplifier]");
    expect(composed.system).not.toContain("[CHALLENGE — Ontologist]");
  });

  it("injects the contrarian fragment when challengeMode='contrarian'", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state: makeState({ currentRound: 4, challengeModesUsed: [] }),
      challengeMode: "contrarian",
    });
    expect(composed.system).toContain("[CHALLENGE — Contrarian]");
  });

  it("injects the simplifier fragment when challengeMode='simplifier'", () => {
    const composed = composePrompt({
      adapter: "hermes_local",
      phase: "ask_question",
      state: makeState({ currentRound: 6, challengeModesUsed: ["contrarian"] }),
      challengeMode: "simplifier",
    });
    expect(composed.system).toContain("[CHALLENGE — Simplifier]");
  });

  it("injects the ontologist fragment when challengeMode='ontologist'", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state: makeState({
        currentRound: 8,
        ambiguityScore: 0.45,
        challengeModesUsed: ["contrarian", "simplifier"],
      }),
      challengeMode: "ontologist",
    });
    expect(composed.system).toContain("[CHALLENGE — Ontologist]");
  });
});

describe("composePrompt — scope framing", () => {
  it("brownfield mode states the 35/25/25/15 weighting", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state: makeState({ brownfield: true }),
    });
    const modeLine = composed.system
      .split("\n")
      .find((line) => line.startsWith("[Mode]"));
    expect(modeLine).toBeDefined();
    expect(modeLine).toContain("Brownfield");
    expect(modeLine).toContain("0.35");
    expect(modeLine).toContain("0.25");
    expect(modeLine).toContain("0.15");
  });

  it("greenfield mode states the 40/30/30 weighting and drops context", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state: makeState({ brownfield: false }),
    });
    // Pull out only the [Mode] line; SKILL.md itself mentions various
    // numbers (including 0.15) so we have to scope the assertion to the
    // engine's own scope-framing fragment.
    const modeLine = composed.system
      .split("\n")
      .find((line) => line.startsWith("[Mode]"));
    expect(modeLine).toBeDefined();
    expect(modeLine).toContain("Greenfield");
    expect(modeLine).toContain("0.40");
    expect(modeLine).toContain("0.30");
    expect(modeLine).not.toContain("0.15");
  });
});

describe("composePrompt — messages", () => {
  it("seeds the conversation with the user's initial idea", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state: makeState({ initialIdea: "I want to build X" }),
    });
    expect(composed.messages.length).toBe(1);
    expect(composed.messages[0]!.role).toBe("user");
    expect(composed.messages[0]!.content).toBe("I want to build X");
  });

  it("rebuilds prior turns as alternating assistant/user messages", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state: makeState({
        currentRound: 2,
        transcript: [
          {
            round: 1,
            question: "Q1?",
            targetDimension: "goal",
            answer: "A1",
            ambiguityAfter: 0.7,
          },
        ],
      }),
    });
    // [user: idea, assistant: Q1, user: A1]
    expect(composed.messages.length).toBe(3);
    expect(composed.messages[1]!.role).toBe("assistant");
    expect(composed.messages[1]!.content).toBe("Q1?");
    expect(composed.messages[2]!.role).toBe("user");
    expect(composed.messages[2]!.content).toBe("A1");
  });
});

describe("composePrompt — phase-specific tasks", () => {
  it("ask_question phase appends the response trailer contract", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "ask_question",
      state: makeState(),
    });
    expect(composed.system).toContain("[Response contract]");
    expect(composed.system).toContain("ambiguity_score");
    expect(composed.system).toContain("ontology_delta");
  });

  it("score phase asks for trailer-only output", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "score",
      state: makeState(),
    });
    expect(composed.system).toContain("Score the user's most recent answer");
    expect(composed.system).toContain("[Response contract]");
  });

  it("crystallize phase asks for the final spec", () => {
    const composed = composePrompt({
      adapter: "claude_api",
      phase: "crystallize",
      state: makeState(),
    });
    expect(composed.system).toContain("converged");
    expect(composed.system).toContain("non_goals");
  });
});
