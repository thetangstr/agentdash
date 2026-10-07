// AgentDash: the sidebar's agent list grouped by team. There is no team
// entity — a team is an agent with direct reports (`reportsTo`), shown as a
// collapsible group with its reports nested beneath it. Each group's
// expanded state is remembered per user per company per lead agent;
// expanded is the default and storage failures fall back to it.

export type SidebarTeamAgent = { id: string; reportsTo?: string | null };

export type SidebarAgentTreeNode<T extends SidebarTeamAgent> = {
  agent: T;
  /** Reports nested under this agent. Non-empty means this agent heads a team group. */
  children: SidebarAgentTreeNode<T>[];
};

/**
 * Deepest indent level a row can sit at (top level is 0). A lead at this
 * level does not open another group: its whole subtree is listed after it at
 * the same level, inside the deepest group, so the sidebar never indents
 * past two steps.
 */
export const SIDEBAR_TEAM_MAX_DEPTH = 2;

/**
 * Build the team tree from agents already in display order (useAgentOrder).
 * Order within each level follows the input order. A manager that is not in
 * the list (terminated, other company, missing) or the agent itself makes the
 * agent top level; a reporting cycle is broken at the first agent of the
 * cycle in display order, which becomes top level.
 */
export function buildSidebarAgentTree<T extends SidebarTeamAgent>(
  orderedAgents: readonly T[],
  maxDepth: number = SIDEBAR_TEAM_MAX_DEPTH,
): SidebarAgentTreeNode<T>[] {
  const ids = new Set(orderedAgents.map((agent) => agent.id));
  const parentOf = (agent: T): string | null => {
    const parent = agent.reportsTo ?? null;
    return parent && parent !== agent.id && ids.has(parent) ? parent : null;
  };
  const reportsByManager = new Map<string, T[]>();
  for (const agent of orderedAgents) {
    const parent = parentOf(agent);
    if (!parent) continue;
    const list = reportsByManager.get(parent);
    if (list) list.push(agent);
    else reportsByManager.set(parent, [agent]);
  }

  const placed = new Set<string>();

  // Every not-yet-placed agent in this agent's subtree, in display order.
  const collectSubtree = (agent: T, out: T[]) => {
    for (const report of reportsByManager.get(agent.id) ?? []) {
      if (placed.has(report.id)) continue;
      placed.add(report.id);
      out.push(report);
      collectSubtree(report, out);
    }
  };

  // Returns the nodes this agent contributes to its parent's level: itself,
  // plus — at the depth cap — its flattened subtree as siblings.
  const build = (agent: T, depth: number): SidebarAgentTreeNode<T>[] => {
    if (depth >= maxDepth) {
      const flattened: T[] = [];
      collectSubtree(agent, flattened);
      return [{ agent, children: [] }, ...flattened.map((a) => ({ agent: a, children: [] }))];
    }
    const children: SidebarAgentTreeNode<T>[] = [];
    for (const report of reportsByManager.get(agent.id) ?? []) {
      if (placed.has(report.id)) continue;
      placed.add(report.id);
      children.push(...build(report, depth + 1));
    }
    return [{ agent, children }];
  };

  const roots: SidebarAgentTreeNode<T>[] = [];
  for (const agent of orderedAgents) {
    if (parentOf(agent) !== null || placed.has(agent.id)) continue;
    placed.add(agent.id);
    roots.push(...build(agent, 0));
  }
  // Whatever is left sits on a reporting cycle with no top-level ancestor.
  for (const agent of orderedAgents) {
    if (placed.has(agent.id)) continue;
    placed.add(agent.id);
    roots.push(...build(agent, 0));
  }
  return roots;
}

const STORAGE_PREFIX = "agentdash.sidebarTeamExpanded";
const ANONYMOUS_USER_ID = "anonymous";

export function getSidebarTeamGroupStorageKey(
  companyId: string,
  userId: string | null | undefined,
  leadAgentId: string,
): string {
  const trimmed = userId?.trim();
  return `${STORAGE_PREFIX}:${companyId}:${trimmed ? trimmed : ANONYMOUS_USER_ID}:${leadAgentId}`;
}

export function readSidebarTeamGroupExpanded(storageKey: string | null): boolean {
  if (!storageKey) return true;
  try {
    return localStorage.getItem(storageKey) !== "false";
  } catch {
    return true;
  }
}

export function writeSidebarTeamGroupExpanded(storageKey: string | null, expanded: boolean) {
  if (!storageKey) return;
  try {
    // Expanded is the default, so only an explicit collapse is stored.
    if (expanded) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, "false");
  } catch {
    // Ignore localStorage failures.
  }
}
