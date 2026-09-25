import type { PaperclipApiClient } from "../client.js";
import type { ToolDefinition } from "../tools.js";
import { ASSISTANT_SCOPE_WORK } from "@paperclipai/shared";
import { AssistantContext } from "./context.js";
import { assistantTools } from "./tools.js";
import { assistantWorkTools } from "./work.js";

/**
 * AgentDash assistant MCP (M1 reads GH #676, M3 work tools GH #678): the
 * person-facing toolset over the control-plane API — nine read tools plus
 * five work tools. Selected by `toolset: "assistant"` (stdio:
 * AGENTDASH_TOOLSET=assistant).
 *
 * GH #745 review: a grant WITHOUT `agentdash:work` does not see the work
 * tools at all — advertising writes it cannot take invites the model to
 * attempt them, and the read-only surface is the honest contract. When
 * `assistantScopes` is undefined (stdio against an operator key, not a
 * grant) the full surface is served.
 */
export function createAssistantToolDefinitions(
  client: PaperclipApiClient,
  config: { companyId: string | null; assistantScopes?: readonly string[] },
): ToolDefinition[] {
  const ctx = new AssistantContext(client, config.companyId);
  const readTools = assistantTools(client, ctx);
  if (config.assistantScopes && !config.assistantScopes.includes(ASSISTANT_SCOPE_WORK)) {
    return readTools;
  }
  return [...readTools, ...assistantWorkTools(client, ctx)];
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
