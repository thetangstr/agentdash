import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { executionWorkspaces, issueTreeHolds, issueTreeHoldMembers, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

// AgentDash: caller holds company mutex on this actual transaction before discovery.
export async function prepareIssueDeletion(tx: Pick<Db, "select">, companyId: string, issueIds: string[]) {
  const ids = [...new Set(issueIds)].sort();
  if (ids.length === 0) return { companyId, issueIds: ids };
  const targets = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
  if (targets.length !== ids.length) throw conflict("Issue topology is unavailable for deletion");
  const children = await tx.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(inArray(issues.parentId, ids));
  const sources = await tx.select({ id: executionWorkspaces.id, companyId: executionWorkspaces.companyId }).from(executionWorkspaces).where(inArray(executionWorkspaces.sourceIssueId, ids));
  if (children.some(row => row.companyId !== companyId) || sources.some(row => row.companyId !== companyId)) throw conflict("Issue topology is unavailable for deletion");
  // AgentDash: ID-only historical FKs can cross companies in legacy rows.
  // Include the entire cascade closure, and owners of surviving member rows.
  const rootedHolds = await tx.select().from(issueTreeHolds).where(inArray(issueTreeHolds.rootIssueId, ids));
  const rootedIds = rootedHolds.map(row => row.id);
  const members = await tx.select().from(issueTreeHoldMembers).where(or(
    inArray(issueTreeHoldMembers.issueId, ids), inArray(issueTreeHoldMembers.parentIssueId, ids),
    ...(rootedIds.length ? [inArray(issueTreeHoldMembers.holdId, rootedIds)] : []),
  ));
  const ownerIds = [...new Set([...rootedIds, ...members.map(row => row.holdId)])];
  const owners = ownerIds.length ? await tx.select().from(issueTreeHolds).where(inArray(issueTreeHolds.id, ownerIds)) : [];
  const ownersById = new Map(owners.map(row => [row.id, row]));
  if (owners.some(row => row.companyId !== companyId) || members.some(row =>
    row.companyId !== companyId || ownersById.get(row.holdId)?.companyId !== row.companyId)) {
    throw conflict("Issue topology is unavailable for deletion");
  }
  const cascadingSources = [...new Set(members.filter(row => rootedIds.includes(row.holdId) || ids.includes(row.issueId))
    .flatMap(row => [row.issueId, ...(row.parentIssueId ? [row.parentIssueId] : [])]))];
  if (cascadingSources.length) {
    const current = await tx.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(inArray(issues.id, cascadingSources));
    if (current.length !== cascadingSources.length || current.some(row => row.companyId !== companyId)) {
      throw conflict("Issue topology is unavailable for deletion");
    }
  }
  // Resource rows precede issues, including self-origin workspaces and surviving sources.
  if (sources.length) await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(inArray(executionWorkspaces.id, sources.map(row => row.id))).orderBy(asc(executionWorkspaces.id)).for("update");
  const affected = [...new Set([...ids, ...children.map(row => row.id)])].sort();
  await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, affected))).orderBy(asc(issues.id)).for("update");
  return { companyId, issueIds: ids };
}

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
 * @param context exact targets validated by prepareIssueDeletion on this executor,
 *                while the owning company mutex remains held.
 */
export async function clearIssueDependents(
  tx: { execute: (query: SQL) => Promise<unknown> },
  context: { companyId: string; issueIds: string[] },
): Promise<void> {
  if (!context.issueIds.length) return;
  const match = sql`in (${sql.join(context.issueIds.map(id => sql`${id}`), sql`, `)})`;
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
  await tx.execute(sql`update issues set parent_id = null where company_id = ${context.companyId} and parent_id ${match}`);
}
