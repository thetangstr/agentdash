import type { PaperclipApiClient } from "../client.js";
import type { ToolDefinition } from "../tools.js";
import { AssistantContext } from "./context.js";
import { assistantTools } from "./tools.js";

/**
 * AgentDash assistant MCP (M1, GH #676): the person-facing read toolset —
 * nine task-shaped tools over the control-plane API. Selected by
 * `toolset: "assistant"` (stdio: AGENTDASH_TOOLSET=assistant).
 */
export function createAssistantToolDefinitions(
  client: PaperclipApiClient,
  config: { companyId: string | null },
): ToolDefinition[] {
  return assistantTools(client, new AssistantContext(client, config.companyId));
}

export { AssistantContext } from "./context.js";
export { assistantTools } from "./tools.js";
export {
  assistantOutputSchema,
  clampLimit,
  clip,
  CANDIDATE_LIMIT,
  FREE_TEXT_LIMIT,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  SUMMARY_LIMIT,
} from "./envelope.js";
export { findForbiddenPaths, redactAssistantValue } from "./redact.js";
export { itemCard } from "./cards.js";
export { resolveAgentRef, resolveIssueRef, resolveProjectRef } from "./resolve.js";
