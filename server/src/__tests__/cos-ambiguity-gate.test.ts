// AgentDash (AGE-50 Phase 5): unit tests for the description-thinness
// ambiguity gate. Keeps the heuristic honest — if someone tunes the
// thresholds these tests make the new bar visible.

import { describe, it, expect } from "vitest";
import { isDescriptionSubstantive } from "../services/cos-orchestrator.js";

describe("isDescriptionSubstantive", () => {
  it("returns false for null, undefined, or empty input", () => {
    expect(isDescriptionSubstantive(null)).toBe(false);
    expect(isDescriptionSubstantive(undefined)).toBe(false);
    expect(isDescriptionSubstantive("")).toBe(false);
    expect(isDescriptionSubstantive("   \n\t  ")).toBe(false);
  });

  it("returns false for a one-liner even if long-ish", () => {
    // 199 chars, below the 200-char floor.
    const short = "a".repeat(199);
    expect(isDescriptionSubstantive(short)).toBe(false);
  });

  it("returns false for enough chars but too few words", () => {
    // 250 chars but one giant word — no real signal.
    const one_word = "x".repeat(250);
    expect(isDescriptionSubstantive(one_word)).toBe(false);
  });

  it("returns true for a substantive multi-sentence description", () => {
    const desc =
      "Launch the premium tier end-of-quarter with three concrete bets: " +
      "Stripe billing integration, a public pricing and packaging page, " +
      "and targeted outreach to existing B2B customers above $10k ARR. " +
      "Constraints: no cold outreach to net-new prospects, must preserve " +
      "our free tier.";
    expect(isDescriptionSubstantive(desc)).toBe(true);
  });

  it("returns false just below the word threshold even with many chars", () => {
    // Over 200 chars but only ~20 whitespace-separated words — padding
    // uses very long tokens so char count passes but word count fails.
    const longTokens =
      "supercalifragilisticexpialidocious-alpha supercalifragilisticexpialidocious-beta " +
      "supercalifragilisticexpialidocious-gamma supercalifragilisticexpialidocious-delta " +
      "supercalifragilisticexpialidocious-epsilon another-short-word";
    expect(longTokens.length).toBeGreaterThanOrEqual(200);
    const wordCount = longTokens.trim().split(/\s+/).length;
    expect(wordCount).toBeLessThan(30);
    expect(isDescriptionSubstantive(longTokens)).toBe(false);
  });
});
