/**
 * An agent that says it is blocked must not also close the issue.
 *
 * Observed on a real cold install: the Chief of Staff posted
 * "BLOCKED — cannot assemble a board pack yet: no contributions exist to
 * assemble", and then set the same issue to `done` in the next call. The board
 * pack was never assembled, and the board reads `done`.
 *
 * That is the worst failure this product can have. Every other defect found so
 * far was an agent that did not run; this is an agent that ran, reported
 * honestly, and had its report contradicted by the status next to it. A person
 * scanning the list sees four green rows and no reason to look further.
 *
 * `blocked` is already a first-class issue status, so nothing new is invented
 * here — the agent's own words are simply taken over its status field when the
 * two disagree.
 */

/** Leading markdown or list punctuation an agent may put before the word. */
const LEADING_NOISE = /^[\s>#*_\-`]*/;

/**
 * Does this comment open by declaring the work blocked?
 *
 * Anchored to the start deliberately. Agents write a verdict first — "BLOCKED —
 * …", "DONE: …" — and a mention of the word later in the body is almost always
 * narration ("this was blocked until Tuesday"), which must not close nothing
 * and must not block anything either.
 */
export function declaresBlocked(body: string | null | undefined): boolean {
  if (typeof body !== "string") return false;
  const head = body.replace(LEADING_NOISE, "");
  return /^blocked\b/i.test(head);
}

/**
 * The status an agent's update should actually take.
 *
 * Returns `"blocked"` only when an agent is closing an issue it has just
 * declared blocked. Everything else — humans, other statuses, agents that said
 * nothing — passes through untouched, because this exists to resolve one
 * specific contradiction and not to second-guess status changes generally.
 *
 * A human closing an issue an agent called blocked is left alone on purpose:
 * that is a person overruling a machine with full knowledge, which is the
 * decision this system is built to preserve.
 */
export function resolveAgentClosingStatus(input: {
  actorIsAgent: boolean;
  requestedStatus: string | undefined;
  /** The comment posted with this update, when there is one. */
  commentBody?: string | null;
  /** The agent's most recent comment on this issue, when posted separately. */
  latestOwnCommentBody?: string | null;
}): { status: string | undefined; overridden: boolean } {
  const requested = input.requestedStatus;
  if (!input.actorIsAgent || requested !== "done") {
    return { status: requested, overridden: false };
  }
  const blocked =
    declaresBlocked(input.commentBody) || declaresBlocked(input.latestOwnCommentBody);
  if (!blocked) return { status: requested, overridden: false };
  return { status: "blocked", overridden: true };
}
