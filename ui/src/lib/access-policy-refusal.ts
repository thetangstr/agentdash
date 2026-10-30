import { ACCESS_POLICY_REFUSED } from "@paperclipai/shared";
import { ApiError } from "@/api/client";

/**
 * AgentDash (APM gate 3, P3.4/P3.5): a `403 ACCESS_POLICY_REFUSED` — an agent's
 * own access rules refused something while the company enforces them. The
 * server answers the refusal at the top level of the body:
 * `{ error, code, dimension, rule, requested, allowedSummary, howToRequest }`.
 * `howToRequest` is written to the agent; a person reads `PERSON_NEXT_STEP`.
 */
export interface AccessPolicyRefusal {
  message: string;
  dimension: string;
  rule: string;
  requested: Record<string, unknown>;
  allowedSummary: string;
  howToRequest: string;
}

/** What each V2 dimension decides, in plain words (access LLD §4). */
const DIMENSION_TEXT: Record<string, string> = {
  "see.projects": "which projects it can see",
  "see.connections": "which connections it can read",
  "do.connections": "what it can do through connections",
  "do.skills": "which skills it can have",
  "talk.agents": "which agents it can contact or give work to",
  "talk.people": "which people it can contact",
  "talk.external": "who outside the company it can contact",
  "talk.inbound": "who can reach it",
};

export const PERSON_NEXT_STEP =
  "To change what it may do, propose a profile change on the agent's Profile tab; its accountable person, steward or a company admin decides.";

export function accessPolicyDimensionText(dimension: string): string {
  return DIMENSION_TEXT[dimension] ?? dimension;
}

/** The refusal carried by an API error, or null when the error is something else. */
export function accessPolicyRefusalOf(error: unknown): AccessPolicyRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null;
  const body = error.body as Record<string, unknown> | null;
  if (!body || body.code !== ACCESS_POLICY_REFUSED) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    message: error.message,
    dimension: text(body.dimension),
    rule: text(body.rule),
    requested: body.requested && typeof body.requested === "object" ? (body.requested as Record<string, unknown>) : {},
    allowedSummary: text(body.allowedSummary),
    howToRequest: text(body.howToRequest),
  };
}

/** One sentence for a refusal, for surfaces that show errors as a line of text. */
export function accessPolicyRefusalSentence(refusal: AccessPolicyRefusal): string {
  const what = refusal.dimension ? ` (${accessPolicyDimensionText(refusal.dimension)})` : "";
  const allowed = refusal.allowedSummary ? ` Allowed: ${refusal.allowedSummary.replace(/\.$/, "")}.` : "";
  return `Refused by this agent's access rules${what}.${allowed} ${PERSON_NEXT_STEP}`;
}

/** The text to show for any error from an agent action: a refusal in plain words, otherwise the server's message. */
export function agentActionErrorText(error: unknown, fallback: string): string {
  const refusal = accessPolicyRefusalOf(error);
  if (refusal) return accessPolicyRefusalSentence(refusal);
  return error instanceof Error && error.message ? error.message : fallback;
}
