// AgentDash (scan 3 lane L): one definition of "tokens" for every DISPLAY
// figure the product shows (Home, Shipped, the run page, the Companies card).
// Home counted cached input and Shipped did not, so the same month read
// "1.9M" on one page and "221.2k" on the next.
//
// Display only. Enforcement is separate and unchanged: the agent token-ceiling
// checks on the server still count cached input, because cached tokens are
// still processed and billed. Do not reuse this definition for a limit.
//
// The definition: input + output tokens. Cached input (the prompt the model
// re-reads from its cache on every turn) is excluded; it dwarfs the rest and
// is billed at a fraction of the price, so counting it makes usage look
// many times larger than the work it paid for.
import { formatTokens } from "./utils";

/** Tooltip for every token figure, so the number says what it counts. */
export const TOKENS_COUNTED_NOTE =
  "Input + output tokens. Cached input the model re-reads is not counted.";

/**
 * Tooltip for the daily token ceiling's own count. Enforcement counts cached
 * input, so this figure is larger than every display figure; say so.
 */
export const TOKEN_CEILING_COUNT_NOTE =
  "The daily ceiling counts cached input the model re-reads, so this is larger than the token figures on Home, Shipped and the run page (input + output only).";

/** Shown where usage is real but this workspace is not charged for it. */
export const BILLED_BY_PROVIDER_NOTE = "Billed by your model provider";

/**
 * The spend figure where work ran but usage was never recorded — unmetered
 * runs write no cost events. Honest where "$0.00" would read as "free".
 */
export const NOT_MEASURED_TEXT = "Not measured";

/** The line under `NOT_MEASURED_TEXT`: why there is no number. */
export const UNMEASURED_USAGE_NOTE = "Runs didn't record usage";

export function countedTokens(usage: { inputTokens?: number | null; outputTokens?: number | null }): number {
  return Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
}

/** "221.2k tokens". */
export function formatCountedTokens(tokens: number): string {
  return `${formatTokens(tokens)} tokens`;
}
