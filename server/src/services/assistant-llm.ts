/**
 * Types + Chief of Staff resolver for the assistant chat.
 *
 * AgentDash (AGE-53): the actual LLM call goes through the CoS agent's
 * own adapter (see assistant-llm-adapter.ts). This file no longer issues
 * HTTP requests to Anthropic — no ASSISTANT_API_KEY required. It stays
 * as the canonical home for the shared types + the CoS prompt resolver.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { agents } from "@agentdash/db";
import { logger } from "../middleware/logger.js";
import {
  loadDefaultAgentInstructionsBundle,
  formatInstructionsBundleAsSystemPrompt,
} from "./default-agent-instructions.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent;

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type AssistantChunk =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "error"; code: string; message: string }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number } };

// ── Chief of Staff Resolution ──────────────────────────────────────────

export interface ChiefOfStaffAgent {
  id: string;
  role: string;
  name: string;
  companyId: string;
}

export interface ChiefOfStaffPromptResolution {
  agent: ChiefOfStaffAgent | null;
  systemPrompt: string | null;
}

// AgentDash: Resolve the company's role='chief_of_staff' agent and build its
// system prompt by concatenating SOUL.md + AGENTS.md + HEARTBEAT.md + TOOLS.md.
// Returns { agent: null, systemPrompt: null } if no CoS agent exists; callers
// must log a warning and fall back to the generic prompt. Never crashes.
export async function resolveChiefOfStaffSystemPrompt(
  db: Db,
  companyId: string,
): Promise<ChiefOfStaffPromptResolution> {
  const rows = await db
    .select({
      id: agents.id,
      role: agents.role,
      name: agents.name,
      companyId: agents.companyId,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "chief_of_staff")))
    .limit(1);

  if (rows.length === 0) {
    return { agent: null, systemPrompt: null };
  }

  const cosAgent = rows[0];
  try {
    const bundle = await loadDefaultAgentInstructionsBundle(db, cosAgent);
    const systemPrompt = formatInstructionsBundleAsSystemPrompt(bundle);
    return { agent: cosAgent, systemPrompt };
  } catch (err) {
    logger.warn({ err, companyId, agentId: cosAgent.id }, "failed to load chief_of_staff instructions bundle");
    return { agent: cosAgent, systemPrompt: null };
  }
}
