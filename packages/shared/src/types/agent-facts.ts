// AgentDash-MK: the agent-to-agent fact request.
//
// How a deliverable's numbers are collected when they do not live in a system a
// connector can read. The owner direction is **trigger, not automate**: the ask
// prompts whatever that person already does, rather than trying to replace their
// method. Retrieval-versus-reconstruction becomes a dial rather than a
// precondition.

/**
 * Where a fact request can end up.
 *
 * `missing` is the one that matters. A fact whose escalation lease lapsed is
 * marked missing and flagged — never quietly dropped, and never left
 * indistinguishable from a fact nobody needed. An assembled deliverable with a
 * silent hole in it is worse than one that says where the hole is.
 */
export const AGENT_FACT_REQUEST_STATUSES = [
  "asked",
  "answered",
  "declined",
  "escalated",
  "missing",
] as const;
export type AgentFactRequestStatus = (typeof AGENT_FACT_REQUEST_STATUSES)[number];

/**
 * How an answer was obtained — the provenance every figure carries.
 *
 * A closed set, because "where did this number come from" has to be answerable
 * without reading prose. `external` is the honest label for anything an agent
 * pulled from outside AgentDash; it is not a lesser kind, it is the kind that
 * makes the untrusted framing obviously necessary rather than incidental.
 */
export const AGENT_FACT_SOURCE_KINDS = [
  "connector",
  "harness",
  "human",
  "agent",
  "external",
] as const;
export type AgentFactSourceKind = (typeof AGENT_FACT_SOURCE_KINDS)[number];

/** Who answered, from what source, when. Attached to the fact, not to a person. */
export interface AgentFactProvenance {
  answeredByAgentId: string | null;
  sourceKind: AgentFactSourceKind | null;
  answeredAt: string | null;
}

export interface AgentFactRequestView {
  id: string;
  companyId: string;
  pipelineId: string;
  runId: string;
  factKey: string;
  question: string;
  requestedByAgentId: string;
  targetAgentId: string;
  status: AgentFactRequestStatus;
  /** Always framed as untrusted content, on the way out as well as in. */
  answer: string | null;
  provenance: AgentFactProvenance;
  declineReason: string | null;
  harnessReachable: boolean | null;
  leaseExpiresAt: string | null;
  flagged: boolean;
  createdAt: string;
  updatedAt: string;
}
