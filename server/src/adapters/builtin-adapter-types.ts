/**
 * Adapter types shipped with Paperclip. External plugins may override these
 * types, but the original built-ins are preserved for pause/remove fallback.
 */
export const BUILTIN_ADAPTER_TYPES = new Set([
  "acpx_local",
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
  "hermes_local",
  "process",
  "http",
]);
