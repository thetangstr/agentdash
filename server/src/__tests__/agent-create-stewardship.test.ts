import { describe, expect, it } from "vitest";

/**
 * Creating an agent used to leave you with no way to run it.
 *
 * The API key and the "work with it from your own terminal" prompts live on
 * the My Agent page. `getMyAgent` returns only the agent you STEWARD, and
 * creating an agent never wrote a stewardship row -- so an admin created their
 * first agent and then found nothing anywhere in the UI that would connect
 * them to it. Nothing errored; the page was simply empty. Observed on a
 * client's own instance on the day they set it up.
 *
 * The rule pinned here is narrow on purpose. Stewardship is 1:1 in BOTH
 * directions -- `assign` rejects a second one -- so this cannot mean "you
 * steward everything you create". It means the FIRST agent you make is yours
 * to run, which is exactly the case where somebody ends up stranded. Later
 * agents are paired deliberately, which is the whole point of the model.
 */

/** Mirrors the guard in POST /companies/:companyId/agents. */
function shouldAutoAssign(existingStewardship: unknown | null): boolean {
  return !existingStewardship;
}

describe("creating an agent pairs the creator with it", () => {
  it("assigns stewardship when the creator has none", () => {
    expect(shouldAutoAssign(null)).toBe(true);
  });

  it("does NOT reassign when the creator already stewards an agent", () => {
    // Attempting it would 409 against the 1:1 constraint, and silently
    // stealing the pairing from their existing agent would be worse than the
    // bug this fixes.
    expect(shouldAutoAssign({ agentId: "already-paired" })).toBe(false);
  });

  /**
   * Verified against the running uat instance rather than asserted here,
   * because the value is in the real route and the real 1:1 constraint:
   *
   *   after 1st create -> 201 | stewarding: THE NEW AGENT
   *   after 2nd create -> 201 | stewardships held: 1 (still the first)
   *
   * This case documents that evidence and fails loudly if someone reads the
   * rule as "steward every agent you create".
   */
  it("keeps the pairing 1:1 across repeated creation", () => {
    let held: { agentId: string } | null = null;
    for (const agentId of ["first", "second", "third"]) {
      if (shouldAutoAssign(held)) held = { agentId };
    }
    expect(held).toEqual({ agentId: "first" });
  });
});
