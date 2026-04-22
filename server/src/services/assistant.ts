/**
 * Core Assistant Chatbot service.
 * Orchestrates conversations, tool execution, and interview detection.
 * AgentDash: assistant chatbot core service
 */
import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { assistantConversations, assistantMessages, companyContext } from "@agentdash/db";
import { logger } from "../middleware/logger.js";
import {
  resolveChiefOfStaffSystemPrompt,
  type AssistantChunk,
  type AssistantMessage,
  type ContentBlock,
} from "./assistant-llm.js";
// AgentDash (AGE-53): assistant chat now runs through the CoS agent's own
// adapter (the same adapter heartbeat uses), not a parallel Anthropic API
// call. Removes the ASSISTANT_API_KEY dependency.
import { streamChatViaAdapter } from "./assistant-llm-adapter.js";
import {
  getAssistantTools,
  getToolDefinitions,
  executeTool,
  type ToolContext,
} from "./assistant-tools.js";
import { buildInterviewSystemPrompt, buildStandardSystemPrompt } from "./assistant-interview.js";
import { logActivity } from "./activity-log.js";

// ── Helpers ─────────────────────────────────────────────────────────────

// AgentDash (AGE-44): Assistant conversations are attributed to the company's
// role='chief_of_staff' agent. We no longer auto-create a per-user role='assistant'
// agent. If no CoS agent exists, `assistantAgentId` is left null and the caller
// uses the legacy generic prompt (with a warning).
async function getOrCreateConversation(
  db: Db,
  userId: string,
  companyId: string,
  assistantAgentId: string | null,
) {
  const existing = await db
    .select()
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.companyId, companyId),
        eq(assistantConversations.userId, userId),
        eq(assistantConversations.status, "active"),
      ),
    )
    .orderBy(desc(assistantConversations.createdAt))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const inserted = await db
    .insert(assistantConversations)
    .values({
      companyId,
      userId,
      assistantAgentId,
      status: "active",
    })
    .returning();

  return inserted[0];
}

async function getMessages(db: Db, conversationId: string, limit = 20) {
  const rows = await db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(desc(assistantMessages.createdAt))
    .limit(limit);

  // Return in chronological order
  return rows.reverse();
}

async function saveMessage(
  db: Db,
  conversationId: string,
  role: string,
  content: string,
  toolName?: string,
  toolInput?: Record<string, unknown>,
  tokenCount?: number,
) {
  const inserted = await db
    .insert(assistantMessages)
    .values({
      conversationId,
      role,
      content,
      toolName: toolName ?? null,
      toolInput: toolInput ?? null,
      tokenCount: tokenCount ?? null,
    })
    .returning();

  return inserted[0];
}

async function loadCompanyProfile(db: Db, companyId: string): Promise<string> {
  const rows = await db
    .select()
    .from(companyContext)
    .where(
      and(
        eq(companyContext.companyId, companyId),
        eq(companyContext.contextType, "agent_research"),
      ),
    );

  if (rows.length === 0) return "No company profile yet.";

  const parts = rows.map((r) => `${r.key}: ${r.value}`);
  return parts.join("\n");
}

// ── Chat orchestration ──────────────────────────────────────────────────

export interface ChatParams {
  userId: string;
  companyId: string;
  conversationId: string | null;
  message: string;
  userName: string;
  companyName?: string;
  toolContext: ToolContext;
}

export async function* chat(
  db: Db,
  params: ChatParams,
): AsyncGenerator<AssistantChunk & { conversationId?: string }> {
  const { userId, companyId, message, userName, companyName = "your company", toolContext } = params;

  // AgentDash (AGE-44): Resolve the company's Chief of Staff agent. Its id is the
  // assistantAgentId on new conversations and the actor for activity-log entries.
  // If no CoS agent exists we fall back to the legacy generic prompt and log a warning.
  const cosResolution = await resolveChiefOfStaffSystemPrompt(db, companyId);
  const cosAgentId = cosResolution.agent?.id ?? null;
  if (!cosAgentId) {
    logger.warn({ companyId }, "assistant.chat: no chief_of_staff agent found — falling back to generic prompt");
  }

  // Activity-log actor: attribute chat actions to the CoS agent when available.
  const logActor: { actorType: "agent" | "user"; actorId: string } = cosAgentId
    ? { actorType: "agent", actorId: cosAgentId }
    : { actorType: "user", actorId: userId };

  // 2. Get or create conversation
  let conversation: typeof assistantConversations.$inferSelect;
  if (params.conversationId) {
    const found = await db
      .select()
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.id, params.conversationId),
          eq(assistantConversations.companyId, companyId),
        ),
      )
      .limit(1);
    if (found.length === 0) {
      conversation = await getOrCreateConversation(db, userId, companyId, cosAgentId);
    } else {
      conversation = found[0];
    }
  } else {
    conversation = await getOrCreateConversation(db, userId, companyId, cosAgentId);
  }

  const conversationId = conversation.id;

  // 3. Save user message
  await saveMessage(db, conversationId, "user", message);

  // Telemetry: log user message (attributed to CoS agent when available).
  try {
    await logActivity(db, {
      companyId,
      actorType: logActor.actorType,
      actorId: logActor.actorId,
      agentId: cosAgentId,
      action: "assistant.message",
      entityType: "conversation",
      entityId: conversationId,
      details: { userId },
    });
  } catch (err) {
    logger.warn({ err }, "assistant.message telemetry failed");
  }

  // 4. Load last 20 messages and convert to AssistantMessage[]
  const storedMessages = await getMessages(db, conversationId, 20);
  const history: AssistantMessage[] = storedMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // 5. Load company profile
  const companyProfile = await loadCompanyProfile(db, companyId);

  // 6. Build system prompt.
  // If a Chief of Staff agent exists, use its SOUL/AGENTS/HEARTBEAT/TOOLS bundle
  // as the system prompt. Otherwise, fall back to the legacy interview / standard
  // prompts so behavior is preserved for companies without a CoS agent.
  const metadata = (conversation.metadata as Record<string, unknown> | null) ?? {};
  const interviewComplete = Boolean(metadata.interviewComplete);

  let systemPrompt: string;
  if (cosResolution.systemPrompt) {
    systemPrompt = cosResolution.systemPrompt;
  } else if (!interviewComplete) {
    systemPrompt = buildInterviewSystemPrompt(companyProfile, userName, companyName);
  } else {
    systemPrompt = buildStandardSystemPrompt(companyProfile, userName, companyName);
  }

  // 7. Get tool definitions. The adapter resolves its own config (auth,
  // CLI command, skills, CODEX_HOME, …) via the agent row — no separate
  // ASSISTANT_API_KEY needed. AGE-53.
  if (!cosResolution.agent) {
    yield {
      type: "error",
      code: "no_cos_agent",
      message:
        "This company has no Chief of Staff agent. Hire one first — the assistant chat runs through the CoS agent's own adapter.",
      conversationId,
    } as AssistantChunk & { conversationId?: string };
    return;
  }
  const cosAgent = cosResolution.agent;
  const tools = getAssistantTools(db);
  const toolDefs = getToolDefinitions(db);

  // 8 & 9 & 10. Stream LLM response with tool execution loop
  let roundsLeft = 5;
  let currentMessages = [...history];
  let fullResponseText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let firstChunk = true;

  while (roundsLeft > 0) {
    roundsLeft--;

    const pendingToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let roundText = "";

    for await (const chunk of streamChatViaAdapter(db, cosAgent, systemPrompt, currentMessages, toolDefs)) {
      if (chunk.type === "error") {
        const errorChunk: AssistantChunk & { conversationId?: string } = chunk;
        if (firstChunk) {
          errorChunk.conversationId = conversationId;
          firstChunk = false;
        }
        yield errorChunk;
        return;
      }

      if (chunk.type === "text") {
        roundText += chunk.text;
        fullResponseText += chunk.text;
        const outChunk: AssistantChunk & { conversationId?: string } = { type: "text", text: chunk.text };
        if (firstChunk) {
          outChunk.conversationId = conversationId;
          firstChunk = false;
        }
        yield outChunk;
      } else if (chunk.type === "tool_use") {
        pendingToolUses.push({ id: chunk.id, name: chunk.name, input: chunk.input });
        const outChunk: AssistantChunk & { conversationId?: string } = { type: "tool_use", id: chunk.id, name: chunk.name, input: chunk.input };
        if (firstChunk) {
          outChunk.conversationId = conversationId;
          firstChunk = false;
        }
        yield outChunk;
      } else if (chunk.type === "done") {
        totalInputTokens += chunk.usage.inputTokens;
        totalOutputTokens += chunk.usage.outputTokens;
      }
    }

    // Ensure conversationId is sent even if we had no chunks somehow
    if (firstChunk) {
      firstChunk = false;
    }

    if (pendingToolUses.length === 0) {
      // No tools — we're done
      break;
    }

    // Build the assistant turn as a content block array
    const assistantContentBlocks: ContentBlock[] = [];
    if (roundText) {
      assistantContentBlocks.push({ type: "text", text: roundText });
    }
    for (const tu of pendingToolUses) {
      assistantContentBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    }

    // Append assistant turn to messages
    currentMessages = [
      ...currentMessages,
      { role: "assistant" as const, content: assistantContentBlocks },
    ];

    // Execute each tool and build tool_result content blocks
    const toolResultBlocks: ContentBlock[] = [];
    for (const tu of pendingToolUses) {
      let resultStr: string;
      try {
        const result = await executeTool(tools, tu.name, tu.input, toolContext, db);
        resultStr = JSON.stringify(result, null, 2);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Tool execution failed";
        logger.warn({ toolName: tu.name, err }, "Assistant tool execution error");
        resultStr = `Error: ${msg}`;
      }

      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: resultStr,
      });

      // Yield tool_result chunk to client
      const trChunk: AssistantChunk & { conversationId?: string } = {
        type: "tool_use" as const,
        id: tu.id,
        name: `${tu.name}_result`,
        input: { result: resultStr },
      };
      yield trChunk;

      // Save tool usage to DB
      await saveMessage(
        db,
        conversationId,
        "assistant",
        resultStr,
        tu.name,
        tu.input,
      );

      // Telemetry: log tool call (attributed to CoS agent when available).
      try {
        await logActivity(db, {
          companyId,
          actorType: logActor.actorType,
          actorId: logActor.actorId,
          agentId: cosAgentId,
          action: "assistant.tool_call",
          entityType: "conversation",
          entityId: conversationId,
          details: { toolName: tu.name, userId },
        });
      } catch (err) {
        logger.warn({ err }, "assistant.tool_call telemetry failed");
      }

      // Telemetry: log interview completion when create_agent is called
      if (tu.name === "create_agent" && !interviewComplete) {
        try {
          await logActivity(db, {
            companyId,
            actorType: logActor.actorType,
            actorId: logActor.actorId,
            agentId: cosAgentId,
            action: "assistant.interview_complete",
            entityType: "conversation",
            entityId: conversationId,
            details: { userId },
          });
        } catch (err) {
          logger.warn({ err }, "assistant.interview_complete telemetry failed");
        }
      }
    }

    // Append user turn with all tool results
    currentMessages = [
      ...currentMessages,
      { role: "user" as const, content: toolResultBlocks },
    ];

    if (roundsLeft === 0) {
      logger.warn({ conversationId }, "Assistant tool execution loop hit max rounds");
      break;
    }
  }

  // 11. Save the final assistant message to DB
  if (fullResponseText) {
    await saveMessage(
      db,
      conversationId,
      "assistant",
      fullResponseText,
      undefined,
      undefined,
      totalOutputTokens > 0 ? totalOutputTokens : undefined,
    );
  }

  // Yield done
  const doneChunk: AssistantChunk & { conversationId?: string } = {
    type: "done",
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    conversationId,
  };
  yield doneChunk;
}

// ── Conversation management ─────────────────────────────────────────────

export async function listConversations(db: Db, userId: string, companyId: string) {
  return db
    .select()
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.companyId, companyId),
        eq(assistantConversations.userId, userId),
      ),
    )
    .orderBy(desc(assistantConversations.createdAt));
}

export async function getConversationMessages(
  db: Db,
  conversationId: string,
  companyId: string,
  userId: string,
) {
  const conversation = await db
    .select({ id: assistantConversations.id })
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.id, conversationId),
        eq(assistantConversations.companyId, companyId),
        eq(assistantConversations.userId, userId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!conversation) return [];
  return db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(assistantMessages.createdAt);
}

export async function archiveConversation(db: Db, conversationId: string, companyId: string) {
  await db
    .update(assistantConversations)
    .set({ status: "archived", updatedAt: new Date() })
    .where(
      and(
        eq(assistantConversations.id, conversationId),
        eq(assistantConversations.companyId, companyId),
      ),
    );
}
