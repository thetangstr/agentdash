// AgentDash: when a new issue starts, and who starts it.
import { and, asc, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";

/**
 * The status contract: `backlog` parks work and wakes nobody; `todo` means
 * "start now" and wakes the assignee.
 *
 * Two rules follow from it, both applied when an issue is created:
 *
 *  1. An issue created with no status gets the company's default — `todo`
 *     when `companies.newIssuesStartAsTodo` is on, `backlog` otherwise. An
 *     explicit status is never changed.
 *  2. A `todo` with no assignee breaks the contract silently — there is nobody
 *     to wake, so it sits until someone happens to find it (MK, 2026-09: a
 *     board-created issue waited six days). It is handed to the company's
 *     Chief of Staff, whose job is triage: do it, or delegate it. Backlog stays
 *     unowned on purpose, and an explicit assignee — agent or human — is never
 *     overridden. Routing assigns the CoS and wakes it with text the creator
 *     wrote, so `issueService.create` only routes when its caller says the
 *     creator holds `tasks:assign`, and never routes a CoS's own issue back to
 *     it (it would wake itself for work it just filed).
 */

export type NewIssueStatus = "backlog" | "todo";

/** Rule 1: the status for a new issue whose creator named none. */
export async function defaultStatusForNewIssue(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<NewIssueStatus> {
  const row = await db
    .select({ newIssuesStartAsTodo: companies.newIssuesStartAsTodo })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return row?.newIssuesStartAsTodo ? "todo" : "backlog";
}

/** Statuses in which an agent cannot own new work. */
const UNROUTABLE_AGENT_STATUSES = ["terminated", "pending_approval"] as const;

export async function resolveChiefOfStaffAgentId(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<string | null> {
  const row = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.role, "chief_of_staff"),
        notInArray(agents.status, [...UNROUTABLE_AGENT_STATUSES]),
      ),
    )
    .orderBy(asc(agents.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.id ?? null;
}

export function needsTriageOwner(input: {
  status?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}): boolean {
  return input.status === "todo" && !input.assigneeAgentId && !input.assigneeUserId;
}

/**
 * Returns the agent id to assign, or null when the issue already has an owner,
 * is not `todo`, or the company has no Chief of Staff who can take it (then the
 * issue is created unowned, exactly as before).
 */
export async function triageOwnerForNewIssue(
  db: Pick<Db, "select">,
  companyId: string,
  input: { status?: string | null; assigneeAgentId?: string | null; assigneeUserId?: string | null },
): Promise<string | null> {
  if (!needsTriageOwner(input)) return null;
  return resolveChiefOfStaffAgentId(db, companyId);
}
