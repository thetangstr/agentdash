// AgentDash (AGE-24): a key's provenance, in words a steward can act on.
//
// The auto-created "default" key looked like something a person had minted
// and forgotten; the steward's question was "who holds it?". The answer is
// the system, at agent creation, and the list now says so.
export interface AgentKeyProvenanceLike {
  source?: string | null;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
}

export function describeAgentKeyProvenance(key: AgentKeyProvenanceLike): string {
  const by = key.createdByUserId
    ? ` by user ${shortId(key.createdByUserId)}`
    : key.createdByAgentId
      ? ` by agent ${shortId(key.createdByAgentId)}`
      : "";
  switch (key.source) {
    case "agent_creation":
      return `created with the agent (system)${by}`;
    case "onboarding":
      return "created during onboarding (system)";
    case "connect_code":
      return `issued by a connect code${by}`;
    case "manual":
      return by ? `created${by}` : "created by a person";
    default:
      return key.source ? `source: ${key.source}` : "provenance unknown";
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
