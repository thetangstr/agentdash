// Closes #234, #231: single canonical type guard for AgentPlanProposalV1Payload.
// Previously duplicated in server/src/services/cos-replier.ts (as
// isPlanPayload) and server/src/routes/onboarding-v2.ts (as
// isAgentPlanPayload) — same defect shape as #168. Both copies must grow
// in lock-step (e.g. adapterType allowlisting per #231), so the only safe
// place to land it is here, in @paperclipai/shared.
import { workforceTemplateIdSchema } from "./workforce.js";
import { supportsWorkforcePrompt } from "../types/workforce.js";
import type { AgentPlanProposalV1Payload } from "../cards.js";

// Closes #231: adapterType allowlist enforced at the trust boundary so a
// prompt-injected or misbehaving LLM cannot smuggle an unknown adapter
// through /confirm-plan. Must match the values the CoS prompts ask for
// in cos-replier.ts and onboarding-v2.ts (revise-plan prompt). Kept in
// sync manually; tests below assert each allowed entry round-trips.
const ALLOWED_ADAPTER_TYPES: ReadonlySet<string> = new Set([
  "claude_local",
  "codex_local",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

// AgentDash (scan 4, lane N): the CoS-written role title lands on the card,
// the agent's title and the "## Role" line of its AGENTS.md, so it is one
// line of at most 80 characters.
export const PLAN_AGENT_TITLE_MAX_LENGTH = 80;

function isValidPlanAgentTitle(value: unknown): boolean {
  return typeof value === "string" && !/[\r\n\u2028\u2029]/.test(value) && value.length <= PLAN_AGENT_TITLE_MAX_LENGTH;
}

/**
 * Tidy model-written titles before validation: control characters and line
 * breaks become spaces, whitespace collapses, and the title is trimmed. A
 * title that is still longer than 80 characters, empty or not a string is
 * dropped (the card falls back to the role). Anything that is not a plan is
 * returned unchanged for isAgentPlanPayload to judge.
 */
export function normalizeAgentPlanTitles<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const plan = value as unknown as Record<string, unknown>;
  if (!Array.isArray(plan.agents)) return value;
  const agents = plan.agents.map((agent: unknown) => {
    if (!agent || typeof agent !== "object" || !("title" in (agent as object))) return agent;
    const { title, ...rest } = agent as Record<string, unknown>;
    const clean = typeof title === "string"
      ? title.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim()
      : "";
    return clean && clean.length <= PLAN_AGENT_TITLE_MAX_LENGTH ? { ...rest, title: clean } : rest;
  });
  return { ...plan, agents } as unknown as T;
}

function isValidAgent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    (a.workforceTemplateId === undefined || workforceTemplateIdSchema.safeParse(a.workforceTemplateId).success) &&
    typeof a.role === "string" &&
    a.role.length > 0 &&
    typeof a.name === "string" &&
    a.name.length > 0 &&
    (a.title === undefined || isValidPlanAgentTitle(a.title)) &&
    typeof a.adapterType === "string" &&
    (a.workforceTemplateId === undefined ? ALLOWED_ADAPTER_TYPES.has(a.adapterType) : supportsWorkforcePrompt(a.adapterType)) &&
    Array.isArray(a.responsibilities) &&
    Array.isArray(a.kpis)
  );
}

export function isAgentPlanPayload(
  value: unknown,
): value is AgentPlanProposalV1Payload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.rationale !== "string") return false;
  if (!Array.isArray(v.agents) || v.agents.length === 0) return false;
  if (typeof v.alignmentToShortTerm !== "string") return false;
  if (typeof v.alignmentToLongTerm !== "string") return false;
  // Every agent must pass the per-agent validator. One bad agent = whole
  // plan rejected (we don't silently strip and continue).
  return v.agents.every(isValidAgent);
}
