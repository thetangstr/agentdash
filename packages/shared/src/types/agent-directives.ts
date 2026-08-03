// AgentDash-MK: harness-pushed operating directives.
//
// The counterpart to `agent-governance.ts` and deliberately kept apart from it.
// Governance is STRUCTURED and grants or revokes; directives are FREE TEXT and
// only shape behaviour. Nothing in this module is an input to an authorization
// decision, and no enforcement point may import it for one.

/** One version of an agent's directives, as stored and as served. */
export interface AgentDirective {
  id: string;
  companyId: string;
  agentId: string;
  /** Monotonic per agent, starting at 1. */
  version: number;
  directives: string;
  pushedByUserId: string;
  pushedAt: string;
  /** Null exactly while this version is the active one. */
  supersededAt: string | null;
}

/** The read shape: what applies now, plus every version that ever did. */
export interface AgentDirectiveHistory {
  active: AgentDirective | null;
  history: AgentDirective[];
}

/**
 * The runtime projection handed to the agent's context. Deliberately smaller
 * than the row — an agent has no use for the primary key, and the narrower the
 * shape the harder it is to accidentally grow this into a capability channel.
 */
export interface AgentDirectiveRuntimeContext {
  version: number;
  directives: string;
  pushedAt: string;
  pushedByUserId: string;
}

/** Context key carrying {@link AgentDirectiveRuntimeContext} into an agent run. */
export const AGENT_DIRECTIVES_CONTEXT_KEY = "paperclipAgentDirectives";

/** Upper bound on a single directives document, in characters. */
export const AGENT_DIRECTIVES_MAX_LENGTH = 20_000;
