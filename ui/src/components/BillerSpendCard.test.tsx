// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CostByBiller } from "@paperclipai/shared";
import { afterEach, describe, expect, it } from "vitest";
import { BillerSpendCard } from "./BillerSpendCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function billerRow(overrides: Partial<CostByBiller> = {}): CostByBiller {
  return {
    biller: "user_provided_key",
    costCents: 0,
    inputTokens: 36_100,
    cachedInputTokens: 50_000,
    outputTokens: 1_200,
    apiRunCount: 0,
    subscriptionRunCount: 3,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
    providerCount: 1,
    modelCount: 1,
    ...overrides,
  };
}

function render(props: {
  row?: CostByBiller;
  pricedSpend: boolean;
  weekSpendCents?: number;
  budgetMonthlyCents?: number;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <BillerSpendCard
        row={props.row ?? billerRow()}
        weekSpendCents={props.weekSpendCents ?? 0}
        budgetMonthlyCents={props.budgetMonthlyCents ?? 50_000}
        totalCompanySpendCents={4_200}
        providerRows={[]}
        pricedSpend={props.pricedSpend}
      />,
    );
  });
  return container.textContent ?? "";
}

// AgentDash (review-1004-2): a priced company with an unused biller must still
// see its 0% allocation bar — "hidden unless the row billed something" hid it
// for the honest case too.
describe("BillerSpendCard on a priced workspace", () => {
  it("keeps the allocation bar for a biller that spent $0", () => {
    const text = render({ pricedSpend: true });
    expect(text).toContain("0% of allocation");
    expect(text).toContain("$0.00 this week");
  });

  it("shows real spend and its share", () => {
    const text = render({ pricedSpend: true, row: billerRow({ costCents: 2_100 }), weekSpendCents: 900 });
    expect(text).toContain("$21.00");
    expect(text).toContain("of allocation");
    expect(text).toContain("$9.00 this week");
  });
});

describe("BillerSpendCard on a BYOK workspace", () => {
  it("shows tokens, never $0.00, and no allocation claim it cannot price", () => {
    const text = render({ pricedSpend: false });
    expect(text).not.toContain("$0.00");
    expect(text).not.toContain("of allocation");
    expect(text).not.toContain("this week");
    // The header falls back to the counted-token figure (in + out, no cache).
    expect(text).toContain("37.3k tokens");
    expect(text).toContain("50.0k cached reads");
  });
});
