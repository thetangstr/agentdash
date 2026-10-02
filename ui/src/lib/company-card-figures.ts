// AgentDash (scan 3 lane L): the two numbers on a Companies card, in words a
// CEO reads correctly.
//
// A BYOK workspace meters tokens but no dollars (the customer's model provider
// bills them), so the card said "$0.00 Unlimited budget" next to real usage,
// and "25% of runs left nothing" read as an accusation without saying how
// many runs that was.
import { formatCents } from "./utils";
import { BILLED_BY_PROVIDER_NOTE, formatCountedTokens } from "./token-figures";

export interface CompanyUsageLine {
  /** "1.2M tokens" or "$12.00 / $50.00". */
  text: string;
  /** Smaller trailing note, e.g. "billed by your model provider" or "(24%)". */
  note: string | null;
  /** True when the line is tokens rather than dollars. */
  unmetered: boolean;
}

export function companyUsageLine(input: {
  spentMonthlyCents: number;
  budgetMonthlyCents: number;
  monthTokens?: number | null;
}): CompanyUsageLine {
  const tokens = Number(input.monthTokens ?? 0);
  if (input.spentMonthlyCents <= 0 && tokens > 0) {
    return {
      text: formatCountedTokens(tokens),
      note: BILLED_BY_PROVIDER_NOTE.toLowerCase(),
      unmetered: true,
    };
  }
  if (input.budgetMonthlyCents > 0) {
    const pct = Math.round((input.spentMonthlyCents / input.budgetMonthlyCents) * 100);
    return {
      text: `${formatCents(input.spentMonthlyCents)} / ${formatCents(input.budgetMonthlyCents)}`,
      note: `(${pct}%)`,
      unmetered: false,
    };
  }
  return { text: formatCents(input.spentMonthlyCents), note: "Unlimited budget", unmetered: false };
}

/**
 * "1 of 4 runs produced no output", or null when every run produced
 * something (nothing worth flagging).
 */
export function runsWithoutOutputLine(runsSucceeded: number, runsWithoutEvidence: number): string | null {
  if (runsSucceeded <= 0 || runsWithoutEvidence <= 0) return null;
  return `${runsWithoutEvidence} of ${runsSucceeded} run${runsSucceeded === 1 ? "" : "s"} produced no output`;
}
