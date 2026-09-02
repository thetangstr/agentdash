// AgentDash: one answer to "does this adapter consume the managed instructions
// bundle?", shared by the agent routes (creation-time materialization, bundle
// location edits) and the instruction-refresh service (pre-dispatch backfill).
// It used to live only inside agentRoutes(), so the refresh service could not
// ask it and silently skipped agents that had no bundle at all (GH #554, AGE-8).
import { findActiveServerAdapter } from "./registry.js";

/**
 * Legacy hardcoded map — the fallback when an adapter module does not declare
 * capability flags explicitly. Adapters that declare `supportsInstructionsBundle`
 * (true or false) take precedence over this list.
 */
export const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
  acpx_local: "instructionsFilePath",
  claude_local: "instructionsFilePath",
  codex_local: "instructionsFilePath",
  droid_local: "instructionsFilePath",
  gemini_local: "instructionsFilePath",
  hermes_local: "instructionsFilePath",
  opencode_local: "instructionsFilePath",
  cursor: "instructionsFilePath",
  pi_local: "instructionsFilePath",
};

const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set(Object.keys(DEFAULT_INSTRUCTIONS_PATH_KEYS));

/** Whether agents on this adapter get (and consume) the managed instructions bundle. */
export function adapterSupportsInstructionsBundle(adapterType: string): boolean {
  const adapter = findActiveServerAdapter(adapterType);
  if (adapter?.supportsInstructionsBundle !== undefined) return adapter.supportsInstructionsBundle;
  return DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(adapterType);
}

/** The adapterConfig key that carries the bundle entry-file path for this adapter, if any. */
export function resolveInstructionsPathKey(adapterType: string): string | null {
  const adapter = findActiveServerAdapter(adapterType);
  if (adapter?.instructionsPathKey) return adapter.instructionsPathKey;
  if (adapter?.supportsInstructionsBundle === true) return "instructionsFilePath";
  if (adapter?.supportsInstructionsBundle === false) return null;
  return DEFAULT_INSTRUCTIONS_PATH_KEYS[adapterType] ?? null;
}
