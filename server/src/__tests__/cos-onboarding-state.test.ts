import { describe, it, expect } from "vitest";
import { __test } from "../services/cos-onboarding-state.js";

describe("cosOnboardingStateService.mergeGoals", () => {
  it("merges shortTerm and longTerm without dropping siblings", () => {
    const merged = __test.mergeGoals(
      { shortTerm: "ship v2" },
      { longTerm: "self-running ops org" },
    );
    expect(merged).toEqual({
      shortTerm: "ship v2",
      longTerm: "self-running ops org",
    });
  });

  it("deep-merges constraints rather than replacing the whole bag", () => {
    const merged = __test.mergeGoals(
      { constraints: { teamSize: 12 } },
      { constraints: { budgetMonthly: 5000 } },
    );
    expect(merged.constraints).toEqual({ teamSize: 12, budgetMonthly: 5000 });
  });

  it("overrides primitive goal fields when the patch supplies them", () => {
    const merged = __test.mergeGoals(
      { shortTerm: "old" },
      { shortTerm: "new" },
    );
    expect(merged.shortTerm).toBe("new");
  });

  it("leaves goals untouched when the patch is empty", () => {
    const original = { shortTerm: "x", longTerm: "y", constraints: { a: 1 } };
    const merged = __test.mergeGoals(original, {});
    expect(merged).toEqual(original);
    // mergeGoals must not return the same reference (defensive copy keeps callers safe).
    expect(merged).not.toBe(original);
  });
});
