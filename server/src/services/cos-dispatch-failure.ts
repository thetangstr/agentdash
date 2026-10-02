// AgentDash (P0, v2026.1002.0 CoS chat silence): a failed conversation
// dispatch used to end in a server log line and nothing else, so the chat sat
// on the person's message forever. Every failure now lands in the
// conversation as a card the UI renders as "CoS couldn't reply: <reason>.
// Retry", and posting it publishes `message.created` like any other message.

import { redactForDisplay } from "./redact-for-display.js";

export const DISPATCH_ERROR_CARD_KIND = "cos_dispatch_error_v1";

/**
 * A reply that has not arrived this long after the person's message is not
 * coming (the adapter timeout is 120s). The chat then offers "CoS hasn't
 * replied. Retry", which the Retry route accepts even though no error card
 * exists (the dispatch hung or the server restarted). Keep in step with
 * REPLY_PENDING_TIMEOUT_MS in ui/src/pages/ChatPanel.tsx.
 */
export const STALLED_REPLY_RETRY_AFTER_MS = 150_000;

export interface DispatchErrorCardPayload {
  /** Short, human-readable reason. Never contains secrets (adapter stderr is trimmed). */
  reason: string;
  /** The user message whose dispatch failed; Retry re-dispatches it. */
  retryMessageId: string;
  /** What to do about it, when the reason has a known fix (a model key with no balance). */
  hint?: string;
}

const MAX_REASON_LENGTH = 240;

/**
 * Turn a dispatch error into one short line for the chat.
 *
 * dispatch-llm's refusal wraps the adapter's own failure in a paragraph about
 * the adapter/model invariant; the person needs the inner failure, not the
 * policy. The full error stays in the server log.
 */
export function shortDispatchReason(err: unknown): string {
  let message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  message = message.trim();
  if (!message) return "the reply could not be generated";

  const wrapped = /^Adapter "([^"]+)" failed \(([\s\S]*)\) and the adapter\/model invariant/.exec(message);
  if (wrapped) message = `${wrapped[1]}: ${wrapped[2]}`;

  message = redactForDisplay(message)
    .replace(/\[dispatch-llm\]\s*/g, "")
    // The path of the adapter binary says nothing useful to a founder.
    .replace(/(^|\s)\/\S*\/([^\s/]+)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

  if (message.length > MAX_REASON_LENGTH) message = `${message.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…`;
  return message;
}

/**
 * Z.AI answers HTTP 429 for two different things: code 1113 "Insufficient
 * balance or no resource package" (the account is empty on that endpoint) and
 * rate limits (codes 1302/1305, "too many requests"). Only the first means the
 * balance is gone; a rate-limited key must not be reported, or re-pinned, as
 * out of balance.
 */
export function isNoBalanceFailure(text: string): boolean {
  return /insufficient balance|no resource package|billing or credits exhausted|\b1113\b/i.test(text);
}

export function isRateLimitFailure(text: string): boolean {
  return !isNoBalanceFailure(text) && /rate.?limit|too many requests|\b(1302|1305)\b|HTTP 429/i.test(text);
}

export function dispatchErrorHint(reason: string): string | undefined {
  if (isNoBalanceFailure(reason)) {
    return "Open Settings, re-save your model key so AgentDash can pick the endpoint that still has balance, then press Retry. If it keeps failing, top up the model account.";
  }
  if (isRateLimitFailure(reason)) {
    return "The model provider is limiting requests right now. Wait a minute, then press Retry.";
  }
  return undefined;
}

export function dispatchErrorBody(reason: string): string {
  return `CoS couldn't reply: ${reason.replace(/[.…\s]+$/, "")}. Retry`;
}

export async function postDispatchFailure(
  conversations: {
    postMessage: (input: {
      conversationId: string;
      authorKind: "user" | "agent";
      authorId: string;
      body: string;
      cardKind?: string | null;
      cardPayload?: Record<string, unknown> | null;
      companyId?: string;
    }) => Promise<unknown>;
  },
  input: { conversationId: string; companyId: string; authorId: string; retryMessageId: string; err: unknown },
): Promise<unknown> {
  const reason = shortDispatchReason(input.err);
  const hint = dispatchErrorHint(reason);
  const payload: DispatchErrorCardPayload = { reason, retryMessageId: input.retryMessageId, ...(hint ? { hint } : {}) };
  return conversations.postMessage({
    conversationId: input.conversationId,
    authorKind: "agent",
    authorId: input.authorId,
    body: dispatchErrorBody(reason),
    cardKind: DISPATCH_ERROR_CARD_KIND,
    cardPayload: payload as unknown as Record<string, unknown>,
    companyId: input.companyId,
  });
}
