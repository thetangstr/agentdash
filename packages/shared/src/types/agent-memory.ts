// AgentDash: durable per-agent memory — what an agent has learned and wants to
// still know next time it wakes.
//
// Deliberately the agent-authored twin of `agent-directives.ts`, and it inherits
// that module's load-bearing rule: **memory informs, it never grants.** Nothing
// here is an input to an authorization decision, and no enforcement point may
// import it for one. The rule matters more here than for directives, because
// directives are written by a human and memory is written by the agent itself:
// an agent that could widen its own permissions by writing a sentence about
// them would be an agent with no permissions at all.
//
// It is also NOT the other three things that look like it:
//   - the adapter session — ephemeral, dies on adapter switch or cwd change
//   - the issue continuation summary — issue-scoped, mechanical, per-run
//   - the instructions bundle (AGENTS.md) — the mandate, board-authored
// Memory is agent-scoped, agent-authored, and survives all of the above.

/** Who wrote a version. Memory is agent-authored; humans correct it. */
export type AgentMemoryAuthorKind = "agent" | "steward" | "admin";

/** One version of an agent's memory, as stored and as served. */
export interface AgentMemory {
  id: string;
  companyId: string;
  agentId: string;
  /** Monotonic per agent, starting at 1. Also the optimistic-concurrency anchor. */
  version: number;
  content: string;
  authorKind: AgentMemoryAuthorKind;
  /** Set when the agent wrote its own memory; null for human edits. */
  authorAgentId: string | null;
  /** Set when a human wrote it; null for agent writes. */
  authorUserId: string | null;
  writtenAt: string;
  /** Null exactly while this version is the active one. */
  supersededAt: string | null;
}

/** The read shape: what applies now, plus every version that ever did. */
export interface AgentMemoryHistory {
  active: AgentMemory | null;
  history: AgentMemory[];
}

/**
 * The runtime projection handed to the agent's context. Narrower than the row
 * for the same reason directives are: the model has no use for primary keys,
 * and a small shape is a hard shape to grow into a capability channel.
 */
export interface AgentMemoryRuntimeContext {
  version: number;
  content: string;
  writtenAt: string;
  authorKind: AgentMemoryAuthorKind;
}

/** Context key carrying {@link AgentMemoryRuntimeContext} into an agent run. */
export const AGENT_MEMORY_CONTEXT_KEY = "paperclipAgentMemory";

/**
 * Upper bound on a memory document, in characters.
 *
 * Deliberately small, and deliberately smaller than directives' 20k. The cap is
 * the feature: memory is re-injected on EVERY run, so an unbounded document is
 * an unbounded per-wake tax, and — more importantly — a document that can always
 * grow is never curated. When an agent hits this limit it has to decide what no
 * longer matters, which is the only mechanism that keeps memory true over time.
 * Matches the continuation summary's budget.
 */
export const AGENT_MEMORY_MAX_LENGTH = 8_000;
