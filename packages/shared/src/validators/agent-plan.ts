// Closes #234, #231: single canonical type guard for AgentPlanProposalV1Payload.
// Previously duplicated in server/src/services/cos-replier.ts (as
// isPlanPayload) and server/src/routes/onboarding-v2.ts (as
// isAgentPlanPayload) — same defect shape as #168. Both copies must grow
// in lock-step (e.g. adapterType allowlisting per #231), so the only safe
// place to land it is here, in @paperclipai/shared.
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
  "opencode_local",
  "pi_local",
]);

function isValidAgent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.role === "string" &&
    a.role.length > 0 &&
    typeof a.name === "string" &&
    a.name.length > 0 &&
    typeof a.adapterType === "string" &&
    ALLOWED_ADAPTER_TYPES.has(a.adapterType) &&
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
