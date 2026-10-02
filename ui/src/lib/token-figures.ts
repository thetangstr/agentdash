// AgentDash (scan 3 lane L): one definition of "tokens" for every figure the
// product shows. Home counted cached input and Shipped did not, so the same
// month read "1.9M" on one page and "221.2k" on the next.
//
// The definition: input + output tokens. Cached input (the prompt the model
// re-reads from its cache on every turn) is excluded; it dwarfs the rest and
// is billed at a fraction of the price, so counting it makes usage look
// many times larger than the work it paid for.
import { formatTokens } from "./utils";

/** Tooltip for every token figure, so the number says what it counts. */
export const TOKENS_COUNTED_NOTE =
  "Input + output tokens. Cached input the model re-reads is not counted.";

/** Shown where usage is real but this workspace is not charged for it. */
export const BILLED_BY_PROVIDER_NOTE = "Billed by your model provider";

export function countedTokens(usage: { inputTokens?: number | null; outputTokens?: number | null }): number {
  return Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
}

/** "221.2k tokens". */
export function formatCountedTokens(tokens: number): string {
  return `${formatTokens(tokens)} tokens`;
}
