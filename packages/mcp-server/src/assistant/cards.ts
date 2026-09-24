import type { AssistantContext } from "./context.js";
import { clip, FREE_TEXT_LIMIT } from "./envelope.js";
import type { AgentRow, IssueRow, ProjectRow } from "./resolve.js";

/**
 * AgentDash assistant MCP (spec §5): the item card — the unit every list of
 * tasks returns. Small enough to read aloud: an identifier to refer to it by,
 * who owns it, one line of human-meaningful state, and the link to open it.
 */

export interface ItemCard {
  ref: string;
  title: string;
  status: string;
  priority: string | null;
  owner: { name: string; role: string | null } | null;
  project: string | null;
  updatedAt: string | null;
  /** Latest human-meaningful state, ≤200 chars. */
  oneLine: string;
  link: string;
}

/** First usable line of free text — the "what is this" for list cards. */
export function oneLiner(text: string | null | undefined, fallback: string): string {
  const first = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return clip(first ?? fallback, 200);
}

export async function itemCard(
  ctx: AssistantContext,
  issue: IssueRow,
  lookup: {
    agentById?: Map<string, AgentRow>;
    projectById?: Map<string, ProjectRow>;
    /** Human assignee names — `assigneeUserId` → display name. */
    userById?: Map<string, string>;
  } = {},
): Promise<ItemCard> {
  const ref = issue.identifier ?? issue.id;
  const agentOwner = issue.assigneeAgentId ? lookup.agentById?.get(issue.assigneeAgentId) : undefined;
  // A task can be assigned to a person, not only an agent — founder-decision
  // tasks are the common case. Without this branch they read as unowned.
  const userOwner = issue.assigneeUserId ? lookup.userById?.get(issue.assigneeUserId) : undefined;
  const projectRow = issue.projectId ? lookup.projectById?.get(issue.projectId) : undefined;
  const owner = agentOwner
    ? { name: agentOwner.name, role: agentOwner.role ?? null }
    : userOwner
      ? { name: userOwner, role: "person" as string | null }
      : null;
  return {
    ref,
    title: clip(issue.title, 120),
    status: issue.status,
    priority: issue.priority ?? null,
    owner,
    project: projectRow?.name ?? null,
    updatedAt: issue.updatedAt ?? null,
    oneLine: oneLiner(issue.description, `${issue.status} task`),
    link: await ctx.issueLink(ref),
  };
}

/** Text longer than FREE_TEXT_LIMIT never reaches the wire. */
export function freeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return clip(value, FREE_TEXT_LIMIT);
}
