// AgentDash-MK: the agent-to-agent fact request.
//
// How a deliverable's numbers are collected when they do not live in a system a
// connector can read. The owner direction is **trigger, not automate**: the ask
// prompts whatever that person already does, rather than trying to replace their
// method. Retrieval-versus-reconstruction becomes a dial rather than a
// precondition.

import type { InboundFilterCategory } from "./inbound-filter.js";

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
  /**
   * The inbound filter escalated this answer instead of passing it.
   *
   * A distinct status rather than a flag on `answered`, because the difference
   * is whether the requesting agent may read the text — and a boolean that
   * decides that is a boolean somebody eventually forgets to check. `held` is
   * terminal for nothing: a human decision moves it to `answered` or
   * `declined`, and until then the fact is flagged so it cannot be mistaken for
   * a fact nobody needed.
   */
  "held",
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

/**
 * Why an answer is being held, and who is deciding.
 *
 * Present only while the inbound filter is holding the content. The categories
 * are here so the requesting agent can report "this figure is under review for
 * an elevated-risk reason" rather than discovering a silent gap — the same
 * commitment as marking a lapsed lease `missing` instead of dropping it.
 */
export interface AgentFactFilterHold {
  categories: InboundFilterCategory[];
  ruleIds: string[];
  /** The approval a human decides. There is no second decision path. */
  approvalId: string | null;
}

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
  /**
   * Always framed as untrusted content, on the way out as well as in — and
   * null while the answer is `held`, because framing tells a reader what it is
   * reading and filtering decides whether it reads it at all.
   */
  answer: string | null;
  /** Non-null only while the inbound filter is holding this answer. */
  filter: AgentFactFilterHold | null;
  provenance: AgentFactProvenance;
  declineReason: string | null;
  harnessReachable: boolean | null;
  leaseExpiresAt: string | null;
  flagged: boolean;
  createdAt: string;
  updatedAt: string;
}
