import { z } from "zod";

/**
 * AgentDash (Ross launch M2): the governed question-to-Ross request.
 *
 * A request is exactly one person-authored issue comment whose body OPENS
 * with an anchored marker, `[ross-assessment-request:<requestKey>]`, followed
 * by the question. It travels the canonical comment accept/dispatch pipeline,
 * so company scope, project visibility, comment policy, activity attribution
 * and the assignee wake (with every heartbeat gate: budget, quota, holds,
 * the exhausted recovery budget) apply exactly as they do to any comment.
 *
 * The wire format is shared with `scripts/ross/assistant-assessment.mjs`, so
 * a request filed by either client coalesces with the other.
 */
export const ROSS_REQUEST_MARKER_PREFIX = "ross-assessment-request:";
export const ROSS_REQUEST_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
export const ROSS_REQUEST_QUESTION_LIMIT = 2000;
/** The issue document Ross's assigned agent publishes its assessment under. */
export const ROSS_REVIEW_DOCUMENT_KEY = "ross-review";
/** A stored review older than this is stale, never a current answer. */
export const ROSS_REVIEW_FRESH_MS = 60 * 60 * 1000;

export function rossRequestMarker(requestKey: string): string {
  return `[${ROSS_REQUEST_MARKER_PREFIX}${requestKey}]`;
}

export function buildRossRequestBody(requestKey: string, question: string): string {
  return `${rossRequestMarker(requestKey)}\n${question.trim()}`;
}

/**
 * The question an anchored request comment carries, or null when the body
 * does not OPEN with this key's marker. A mid-body mention is not a request.
 */
export function anchoredRossRequestQuestion(body: string, requestKey: string): string | null {
  const marker = rossRequestMarker(requestKey);
  if (!body.startsWith(marker)) return null;
  return body.slice(marker.length).replace(/^\n/, "").trim();
}

/**
 * Keep a request scoped to the task's assignee. The comment pipeline wakes
 * every agent a comment @-mentions (`@Name`, or an `agent://` / `user://`
 * mention link), so a Ross question must not carry mention syntax: links keep
 * their label text, and a mention-shaped `@` is removed (`@Priya` → `Priya`).
 * An email-like `a@b` is left alone — it is not mention syntax.
 */
export function stripRossRequestMentions(question: string): string {
  return question
    .replace(/\[([^\]]*)\]\((?:agent|user):\/\/[^)\s]*\)/gi, "$1")
    .replace(/\B@(?=[^\s@,!?.])/g, "");
}

export const submitRossRequestSchema = z
  .object({
    requestKey: z.string().regex(ROSS_REQUEST_KEY_PATTERN, "requestKey must be 8-64 of [a-z0-9-], starting alphanumeric"),
    question: z.string().trim().min(1).max(ROSS_REQUEST_QUESTION_LIMIT),
  })
  .strict();

export type SubmitRossRequest = z.infer<typeof submitRossRequestSchema>;

/** What a submit answers. `submitted`/`coalesced` carry a receipt; the rest change nothing. */
export const ROSS_REQUEST_SUBMIT_STATUSES = [
  "submitted",
  "coalesced",
  "conflict",
  "refused",
  "unavailable",
  "denied",
  "uncertain",
] as const;
export type RossRequestSubmitStatus = (typeof ROSS_REQUEST_SUBMIT_STATUSES)[number];

/** What a status read answers for one request key. */
export const ROSS_REQUEST_READ_STATUSES = [
  "answered",
  "stale",
  "pending",
  "refused",
  "conflict",
  "not_found",
] as const;
export type RossRequestReadStatus = (typeof ROSS_REQUEST_READ_STATUSES)[number];
