import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "codex_local";
export const label = "Codex (local)";

/**
 * The model a new codex_local agent starts on.
 *
 * `gpt-5.3-codex` until 2026-08-19, which a Codex login backed by a ChatGPT
 * account rejects outright: `The 'gpt-5.3-codex' model is not supported when
 * using Codex with a ChatGPT account` (400). Every codex agent created on such
 * an install was therefore born unable to run, and the failure arrived as a
 * model error from OpenAI rather than as anything about configuration —
 * measured on the MKThink Mini, where the same probe agent went green the
 * moment the model changed.
 *
 * Terra is the balanced member of the current family and is accepted under both
 * auth modes, so it is the honest default. The `-codex` models remain in the
 * list below for API-key installs that want the coding-tuned lane.
 */
export const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.6-terra";
export const DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX = true;
/**
 * Fast mode is allowed for these known models -- and, via
 * `isCodexLocalFastModeSupported`, for any model typed in by hand.
 *
 * That second rule is why this list has to be updated in the SAME commit that
 * adds a model to `models` below. An unknown model counts as manual and gets
 * fast mode; the moment it is added to `models` it stops being manual, and if
 * it is not named here it silently LOSES fast mode. Adding the gpt-5.6 family
 * to the picker did exactly that: the models became selectable and became
 * fast-mode-ineligible in the same change, which is the opposite of what
 * refreshing the list was for.
 */
export const CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-cyber",
  "gpt-5.4",
] as const;

function normalizeModelId(model: string | null | undefined): string {
  return typeof model === "string" ? model.trim() : "";
}

export function isCodexLocalKnownModel(model: string | null | undefined): boolean {
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel) return false;
  return models.some((entry) => entry.id === normalizedModel);
}

export function isCodexLocalManualModel(model: string | null | undefined): boolean {
  const normalizedModel = normalizeModelId(model);
  return Boolean(normalizedModel) && !isCodexLocalKnownModel(normalizedModel);
}

export function isCodexLocalFastModeSupported(model: string | null | undefined): boolean {
  if (isCodexLocalManualModel(model)) return true;
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  return CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.includes(
    normalizedModel as (typeof CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS)[number],
  );
}

/**
 * IDs verified against OpenAI's own model documentation, not inferred from a
 * version number. The family is three tiers plus a specialised model, and the
 * bare `gpt-5.6` is an ALIAS for Sol rather than a fourth model -- listing it
 * separately would offer the same thing twice under two names.
 *
 * Nothing validates this list server-side: `codex-args.ts` passes whatever it
 * is given straight through as `--model`. So this array is a convenience, and
 * being out of date makes new models unreachable from the UI without making
 * them unsupported.
 */
export const models = [
  { id: "gpt-5.6-sol", label: "gpt-5.6 Sol — deepest reasoning" },
  { id: "gpt-5.6-terra", label: "gpt-5.6 Terra — balanced" },
  { id: "gpt-5.6-luna", label: "gpt-5.6 Luna — fastest, cheapest" },
  { id: "gpt-5.6-cyber", label: "gpt-5.6 Cyber — specialised" },
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: "gpt-5.3-codex", label: "gpt-5.3-codex (API-key installs; a ChatGPT account rejects it)" },
  { id: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
  { id: "gpt-5", label: "gpt-5" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "gpt-5-mini", label: "gpt-5-mini" },
  { id: "gpt-5-nano", label: "gpt-5-nano" },
  { id: "o3-mini", label: "o3-mini" },
  { id: "codex-mini-latest", label: "Codex Mini" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use the lowest-cost known Codex local model lane without changing the primary model.",
    adapterConfig: {
      model: "gpt-5.3-codex-spark",
      modelReasoningEffort: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# codex_local agent configuration

Adapter: codex_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to stdin prompt at runtime
- model (string, optional): Codex model id
- modelReasoningEffort (string, optional): reasoning effort override (minimal|low|medium|high|xhigh) passed via -c model_reasoning_effort=...
- promptTemplate (string, optional): run prompt template
- search (boolean, optional): run codex with --search
- fastMode (boolean, optional): enable Codex Fast mode; supported on GPT-5.4 and passed through for manual model IDs
- dangerouslyBypassApprovalsAndSandbox (boolean, optional): run with bypass flag
- command (string, optional): defaults to "codex"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Prompts are piped via stdin (Codex receives "-" prompt argument).
- If instructionsFilePath is configured, Paperclip prepends that file's contents to the stdin prompt on every run.
- Codex exec automatically applies repo-scoped AGENTS.md instructions from the active workspace. Paperclip cannot suppress that discovery in exec mode, so repo AGENTS.md files may still apply even when you only configured an explicit instructionsFilePath.
- Paperclip injects desired local skills into the effective CODEX_HOME/skills/ directory at execution time so Codex can discover "$paperclip" and related skills without polluting the project working directory. In managed-home mode (the default) this is ~/.paperclip/instances/<id>/companies/<companyId>/codex-home/skills/; when CODEX_HOME is explicitly overridden in adapter config, that override is used instead.
- Unless explicitly overridden in adapter config, Paperclip runs Codex with a per-company managed CODEX_HOME under the active Paperclip instance and seeds auth/config from the shared Codex home (the CODEX_HOME env var, when set, or ~/.codex).
- Some model/tool combinations reject certain effort levels (for example minimal with web search enabled).
- Fast mode is supported on GPT-5.4 and manual model IDs. When enabled for those models, Paperclip applies \`service_tier="fast"\` and \`features.fast_mode=true\`.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;
