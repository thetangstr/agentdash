/**
 * AgentDash (c4-polish): owner-facing names for raw model ids. The run header
 * showed "Model: k3" — a provider-side alias that means nothing to an owner.
 * Known aliases get a readable name; everything else falls back to the raw id
 * unchanged (guessing names would be worse than showing what was reported).
 */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  // Kimi (Moonshot) aliases served through token-plan providers.
  k3: "Kimi K3",
  "kimi-k3": "Kimi K3",
  "k2.5": "Kimi K2.5",
  "kimi-k2.5": "Kimi K2.5",
  // Alibaba Token Plan ids — keep in step with HERMES_MODEL_TIERS names.
  "qwen3.8-max-0902": "Qwen 3.8 Max",
  "deepseek-v4-flash": "DeepSeek V4.1 Flash",
};

export function modelDisplayName(model: string | null | undefined): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const direct = MODEL_DISPLAY_NAMES[trimmed.toLowerCase()];
  if (direct) return direct;
  // "kimi-coding/k3": the leaf carries the name; the provider prefix is noise
  // once the model has a readable name.
  const leaf = trimmed.split("/").pop() ?? trimmed;
  return MODEL_DISPLAY_NAMES[leaf.toLowerCase()] ?? trimmed;
}
