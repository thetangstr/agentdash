/**
 * AgentDash AGE-113: the adapter/model invariant.
 *
 * Invariant: automatic recovery may retry, pause, block, or escalate, but it
 * may NOT change an agent's `adapterType`, its `adapterConfig.model` (or any
 * other adapter/model identity field), or route a run to a different
 * adapter/model than the agent's own configuration.
 *
 * Only a human with agent-configuration authority may change those. In this
 * codebase a "human with agent-configuration authority" means a
 * board-authenticated principal ("user") or the system's own internal flows
 * that a human drove ("system" wake paths created by board actions, the
 * onboarding flow a human completed, hire approvals a human approved). An
 * agent-authenticated principal — including the CEO agent — never qualifies.
 *
 * Rationale (observed in production): the run healer switched HAL, the MKThink
 * Chief-of-Staff, from hermes_local to claude_api without anyone asking, which
 * changed which provider billed the run and which model answered. Recovery is
 * there to restore service, not to re-negotiate configuration a customer
 * chose. The right response to "the configured adapter failed" is retry,
 * pause, or escalate — never "be someone else".
 */

export type ActorType = "board" | "agent" | "none" | "system";

/**
 * The actor kinds that may change an agent's adapter or model.
 *
 * - `board`: a signed-in human on the board UI / API — the configuration
 *   authority by construction (further narrowed by admin/steward checks in
 *   the routes).
 * - `system`: internal flows that originate from human action (onboarding a
 *   human completed, a hire approval a human approved, a wake a human
 *   requested). These do not switch adapters on their own; they PERSIST the
 *   human's choice. Keeping them allowed is what makes the HAL restoration
 *   (a human applying a config) work without special-casing.
 *
 * Everything else — `agent` (agent-key authenticated, including self-wakes
 * and CEO-agent flows) and unauthenticated (`none`) — is refused. This module
 * does not decide admin-vs-steward; the routes' existing authority checks
 * (`requireAgentConfigurationAuthority`, `assertStewardPatchScope`) stay
 * responsible for that. This module draws the coarser line: human-configured
 * vs automatic.
 */
export function mayChangeAdapterOrModel(actorType: string | null | undefined): boolean {
  return actorType === "board" || actorType === "system";
}

/**
 * Classification used in audit details so a log reader can tell a human
 * change from an automatic one without joining tables.
 */
export function adapterModelActorKind(actorType: string | null | undefined): "human" | "automatic" {
  return mayChangeAdapterOrModel(actorType) ? "human" : "automatic";
}
