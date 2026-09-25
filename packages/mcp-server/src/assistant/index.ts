import type { PaperclipApiClient } from "../client.js";
import type { ToolDefinition } from "../tools.js";
import { AssistantContext } from "./context.js";
import { assistantTools } from "./tools.js";
import { assistantWorkTools } from "./work.js";

/**
 * AgentDash assistant MCP (M1 reads GH #676, M3 work tools GH #678): the
 * person-facing toolset over the control-plane API — nine read tools plus
 * five work tools. Selected by `toolset: "assistant"` (stdio:
 * AGENTDASH_TOOLSET=assistant). A grant without `agentdash:work` still sees
 * the work tools; the write fails politely at the loopback gate so the
 * assistant can explain the missing scope.
 */
export function createAssistantToolDefinitions(
  client: PaperclipApiClient,
  config: { companyId: string | null },
): ToolDefinition[] {
  const ctx = new AssistantContext(client, config.companyId);
  return [...assistantTools(client, ctx), ...assistantWorkTools(client, ctx)];
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
