import { describe, expect, it } from "vitest";
import { companyUsageLine, runsWithoutOutputLine } from "./company-card-figures";
import { countedTokens } from "./token-figures";
import { formatShippedUsage } from "./shipped";

describe("token figures share one definition", () => {
  it("counts input + output and never cached input", () => {
    expect(countedTokens({ inputTokens: 100_000, outputTokens: 5_000 })).toBe(105_000);
    expect(countedTokens({ inputTokens: null, outputTokens: undefined })).toBe(0);
  });

  it("Shipped uses the same count", () => {
    expect(
      formatShippedUsage({ metered: true, inputTokens: 200_000, outputTokens: 21_200, costCents: 0 } as never),
    ).toBe("221.2k tokens");
  });
});

describe("companyUsageLine", () => {
  it("shows unavailable rather than zero when spend is restricted", () => {
    expect(companyUsageLine({ spentMonthlyCents: null, budgetMonthlyCents: null, monthTokens: null })).toMatchObject({ text: "Unavailable", unmetered: false });
  });
  it("shows tokens billed by the provider on an unmetered (BYOK) workspace", () => {
    expect(companyUsageLine({ spentMonthlyCents: 0, budgetMonthlyCents: 0, monthTokens: 1_900_000 })).toEqual({
      text: "1.9M tokens",
      note: "billed by your model provider",
      unmetered: true,
    });
  });

  it("shows dollars against a budget when dollars are metered", () => {
    expect(companyUsageLine({ spentMonthlyCents: 1200, budgetMonthlyCents: 5000, monthTokens: 9_000 })).toEqual({
      text: "$12.00 / $50.00",
      note: "(24%)",
      unmetered: false,
    });
  });

  it("keeps the unlimited-budget wording only when nothing ran", () => {
    expect(companyUsageLine({ spentMonthlyCents: 0, budgetMonthlyCents: 0, monthTokens: 0 })).toMatchObject({
      text: "$0.00",
      note: "Unlimited budget",
    });
    // An older server that sends no token count behaves as before.
    expect(companyUsageLine({ spentMonthlyCents: 0, budgetMonthlyCents: 0 }).unmetered).toBe(false);
  });
});

describe("runsWithoutOutputLine", () => {
  it("says how many runs, not a percentage", () => {
    expect(runsWithoutOutputLine(4, 1)).toBe("1 of 4 runs produced no output");
    expect(runsWithoutOutputLine(1, 1)).toBe("1 of 1 run produced no output");
  });

  it("says nothing when every run produced something", () => {
    expect(runsWithoutOutputLine(4, 0)).toBeNull();
    expect(runsWithoutOutputLine(0, 0)).toBeNull();
  });
});
