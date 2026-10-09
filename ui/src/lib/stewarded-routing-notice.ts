/**
 * AgentDash: assigning a person who stewards an agent gives the issue to that
 * agent (server/src/services/stewarded-agent-routing.ts). The server says so
 * in `routedToStewardedAgent`; this is the one line the UI shows for it, so
 * the person who made the assignment is not surprised by the assignee.
 */
export interface StewardedAgentRouteNotice {
  fromUserId: string;
  toAgentId: string;
}

export function stewardedRoutingNotice(
  routed: StewardedAgentRouteNotice | null | undefined,
  agents: ReadonlyMap<string, { name: string }>,
  people: ReadonlyMap<string, string> | null | undefined,
): string | null {
  if (!routed) return null;
  const agentName = agents.get(routed.toAgentId)?.name ?? "their agent";
  const personName = people?.get(routed.fromUserId) ?? "this person";
  return `Assigned to ${agentName}, ${personName}'s agent`;
}
