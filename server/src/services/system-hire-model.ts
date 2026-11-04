// AgentDash (#1122): choose a model for system hires without copying a peer's
// credentials, command, workspace, or instruction bundle.
import { resolveCodexChatModel } from "../adapters/codex-models.js";
import { hermesModelTierStamp } from "./hermes-model-tiers.js";

interface ModelPeer {
  id: string;
  companyId: string;
  adapterType: string;
  status: string;
  role: string;
  adapterConfig: Record<string, unknown> | null;
}

export interface SystemHireModelSelection {
  source: "company_agent" | "instance_default" | "interview_model" | "model_tier" | "host_default";
  model: string | null;
  agentId?: string;
  warning?: string;
}

const MODEL_ADAPTERS = new Set([
  "claude_local", "codex_local", "gemini_local", "hermes_local",
  "opencode_local", "pi_local", "cursor",
]);

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveSystemHireModel(input: {
  companyId: string;
  adapterType: string;
  role: string;
  title?: string | null;
  peers: ModelPeer[];
  env?: NodeJS.ProcessEnv;
}): { adapterConfig: Record<string, unknown>; selection: SystemHireModelSelection | null } {
  if (!MODEL_ADAPTERS.has(input.adapterType)) return { adapterConfig: {}, selection: null };
  const env = input.env ?? process.env;
  // Preserve existing opt-in role tiers: inheriting a leadership model must
  // not silently move every Hermes worker onto the leadership tier.
  const tier = hermesModelTierStamp({ ...input, env });
  if (tier) {
    // Let agentService.create apply the tier and its metadata as before.
    return { adapterConfig: {}, selection: { source: "model_tier", model: tier.model } };
  }
  const peer = input.peers.filter((candidate) =>
    candidate.companyId === input.companyId && candidate.adapterType === input.adapterType
    && ["active", "idle", "running"].includes(candidate.status)
    && nonEmpty(candidate.adapterConfig?.model),
  ).sort((a, b) =>
    Number(b.role === "chief_of_staff") - Number(a.role === "chief_of_staff") || a.id.localeCompare(b.id),
  )[0];
  if (peer) {
    const model = nonEmpty(peer.adapterConfig?.model)!;
    const provider = nonEmpty(peer.adapterConfig?.provider);
    return {
      adapterConfig: { model, ...(provider ? { provider } : {}) },
      selection: { source: "company_agent", agentId: peer.id, model },
    };
  }
  // API interview models are not local CLI model defaults. Only Codex has an
  // explicit, shared chat-model selection; never borrow a different adapter's.
  if (input.adapterType === "codex_local" && env.AGENTDASH_DEFAULT_ADAPTER?.trim() === "codex_local") {
    const model = resolveCodexChatModel(env);
    return {
      adapterConfig: { model },
      selection: { source: nonEmpty(env.AGENTDASH_CODEX_CHAT_MODEL) ? "instance_default" : "interview_model", model },
    };
  }
  const warning = input.adapterType === "codex_local"
    ? "This agent will use the host's Codex default. No active company agent has a model configured for this runtime."
    : "No model was selected for this agent. It will use the runtime's default, if available. Select a model before approving if the runtime requires one.";
  return {
    adapterConfig: {},
    selection: { source: "host_default", model: null, warning },
  };
}
