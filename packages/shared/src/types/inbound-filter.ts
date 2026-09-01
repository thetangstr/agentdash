// AgentDash-MK: the inbound filter's vocabulary.
//
// The architecture's core security property is asymmetric trust. Outbound
// (harness → agent) is unrestricted, because the harness is the trusted party.
// Inbound (agent → harness, or agent → human) passes a gate, because an
// AgentDash agent lives in a shared organization and is continuously exposed to
// other people's agents' output.
//
// Until this slice that gate was per-action: the approvals service deciding
// individual actions. These names belong to the STANDING filter that sits on
// the return path itself, so content is evaluated whether or not it happens to
// be attached to an action someone thought to gate.

/**
 * What the filter decided. Two values on purpose: a filter with a "warn" verdict
 * is a filter that passes things, and the whole point of this control is that
 * the doubtful case does not travel.
 */
export const INBOUND_FILTER_VERDICTS = ["pass", "escalate"] as const;
export type InboundFilterVerdict = (typeof INBOUND_FILTER_VERDICTS)[number];

/**
 * Why it escalated.
 *
 * - `sensitive_update` — the content carries credential or identifier material.
 *   A figure is a figure; a private key travelling toward a laptop is not.
 * - `elevated_risk` — the content is shaped like an instruction to whatever
 *   reads it: a directive, a tool call, a permission grant, a forged system
 *   preamble, an attempt to close the untrusted frame around itself.
 * - `missing_context` — the content, or a field the caller declared required,
 *   is absent or a placeholder. "TBD" delivered as a figure is how a hole gets
 *   into a deliverable and stays there.
 *
 * A failure to classify at all is reported as `elevated_risk`, because content
 * whose true form we could not determine is not content we can certify.
 */
export const INBOUND_FILTER_CATEGORIES = [
  "sensitive_update",
  "elevated_risk",
  "missing_context",
] as const;
export type InboundFilterCategory = (typeof INBOUND_FILTER_CATEGORIES)[number];

/**
 * Where on the return path the content was travelling.
 *
 * Named after the edge, never after the party: this string reaches
 * `workflow_events`, where a rule enforced by both an allowlist and a database
 * constraint says a measurement records what kind of thing happened and never
 * who it happened to.
 */
export const INBOUND_FILTER_SURFACES = [
  /** An agent's answer travelling to the agent that asked for it. */
  "agent_fact_answer",
  /** An instruction travelling to a person's own machine. */
  "bridge_task_instruction",
] as const;
export type InboundFilterSurface = (typeof INBOUND_FILTER_SURFACES)[number];

/**
 * One classification.
 *
 * `ruleIds` names the specific decidable checks that fired, so a reviewer reads
 * "this contains a permission-grant shape" rather than "a model was uneasy".
 * That distinction is the design constraint of this whole component: a rule
 * binds only when it sits at a chokepoint with a decidable predicate.
 */
export interface InboundFilterDecision {
  verdict: InboundFilterVerdict;
  categories: InboundFilterCategory[];
  ruleIds: string[];
  contentChars: number;
}
