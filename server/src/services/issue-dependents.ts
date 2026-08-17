import { sql, type SQL } from "drizzle-orm";

/**
 * Clear everything that would block deleting a set of issues.
 *
 * Ten tables reference `issues` with NO ACTION. Before this existed, deleting
 * an issue that had ever been commented on raised a foreign-key violation that
 * both routes reported as `500 Internal server error` — so in practice no
 * issue an agent had touched could be removed, and neither could any project
 * containing one. Two separate delete paths hit the same wall, which is why
 * this is one function rather than two copies that will drift.
 *
 * The dependents are NOT all the same kind of thing, and the distinction is
 * the whole point of this file:
 *
 *   **Owned** — rows that exist only as part of the issue. They go with it.
 *
 *   **Ledger** — `cost_events`, `finance_events`, `skill_usage_events`,
 *     `experiments`. These are the answer to "what did this cost" and "what
 *     did we use". Deleting them because somebody tidied a board would quietly
 *     falsify the books, and the loss would be invisible — a spend total that
 *     silently drops is far worse than a delete that refuses. The reference is
 *     cleared; the row survives without an issue to point at.
 *
 *   **Children** — detached, never deleted. Removing a parent must not
 *     silently destroy work filed underneath it.
 *
 * `feedback_votes` looks like ledger and is not: its `issue_id` is NOT NULL, so
 * it cannot be detached, and a vote about an issue that no longer exists
 * carries no meaning. It is owned.
 *
 * @param tx    a transaction — every caller must already be inside one, or a
 *              failure part-way leaves dependents cleared and issues standing.
 * @param match SQL matching the issue ids, e.g. `sql\`= ${id}\`` or
 *              `sql\`in (select id from issues where project_id = ${p})\``.
 */
export async function clearIssueDependents(
  tx: { execute: (query: SQL) => Promise<unknown> },
  match: SQL,
): Promise<void> {
  // Owned — deleted with the issue.
  await tx.execute(sql`delete from issue_comments where issue_id ${match}`);
  await tx.execute(sql`delete from issue_read_states where issue_id ${match}`);
  await tx.execute(sql`delete from issue_inbox_archives where issue_id ${match}`);
  await tx.execute(sql`delete from issue_thread_interactions where issue_id ${match}`);
  await tx.execute(sql`delete from feedback_votes where issue_id ${match}`);

  // Ledger — the record outlives the issue it was about.
  await tx.execute(sql`update cost_events set issue_id = null where issue_id ${match}`);
  await tx.execute(sql`update finance_events set issue_id = null where issue_id ${match}`);
  await tx.execute(sql`update skill_usage_events set issue_id = null where issue_id ${match}`);
  await tx.execute(sql`update experiments set issue_id = null where issue_id ${match}`);

  // Children — detached, so deleting a parent never destroys them.
  await tx.execute(sql`update issues set parent_id = null where parent_id ${match}`);
}
