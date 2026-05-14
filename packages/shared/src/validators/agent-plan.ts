// Closes #234: single canonical type guard for AgentPlanProposalV1Payload.
// Previously duplicated in server/src/services/cos-replier.ts (as
// isPlanPayload) and server/src/routes/onboarding-v2.ts (as
// isAgentPlanPayload) — same defect shape as #168. Both copies must grow
// in lock-step (e.g. when we add adapterType allowlisting per #231), so
// the only safe place to land it is here, in @paperclipai/shared.
import type { AgentPlanProposalV1Payload } from "../cards.js";

export function isAgentPlanPayload(
  value: unknown,
): value is AgentPlanProposalV1Payload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.rationale === "string" &&
    Array.isArray(v.agents) &&
    v.agents.length > 0 &&
    typeof v.alignmentToShortTerm === "string" &&
    typeof v.alignmentToLongTerm === "string"
  );
}
