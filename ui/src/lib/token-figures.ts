// AgentDash (scan 3 lane L): one definition of "tokens" for every DISPLAY
// figure the product shows (Home, Shipped, the run page, the Companies card).
// Home counted cached input and Shipped did not, so the same month read
// "1.9M" on one page and "221.2k" on the next.
//
// Display only. Enforcement uses per-run adapter provenance to avoid counting
// Codex's cached subset twice and retain exclusive cached input on other adapters.
// Do not reuse this display definition for a limit.
//
// The display definition is the recorded input + output counters. No separate
// cache counter is added; Codex's input already includes cached reads.
import { formatTokens } from "./utils";

/** Tooltip for every token figure, so the number says what it counts. */
export const TOKENS_COUNTED_NOTE =
  "Recorded input + output tokens. No separate cached-input counter is added; Codex input already includes cached reads.";

/**
 * Tooltip for the daily ceiling's count, which respects per-run cache semantics.
 */
export const TOKEN_CEILING_COUNT_NOTE =
  "The daily ceiling counts input and output, including cached input once. Codex input already includes its cached subset; adapters with separate cached input add it. Older runs without adapter evidence keep the conservative additive count.";

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
