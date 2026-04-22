// AgentDash (AGE-53): route the assistant chat through the Chief of Staff
// agent's own adapter. No parallel LLM call path — chat is just an
// interactive agent run. The adapter is already configured with the
// operator's OAuth / CLI / subscription auth (claude_local, codex_local,
// gemini_local, …) so chat inherits that auth automatically — no
// ASSISTANT_API_KEY required.
//
// Prompt: we flatten the system prompt + conversation history + the
// operator's newest message into a single prose prompt and pass it to the
// adapter via `config.promptTemplate`. Each chat turn is one
// `adapter.execute()` invocation; session resume across turns is not
// required because we always feed the full history.
//
// Tool calls: adapters like claude_local/codex_local emit prose, not
// Anthropic-style structured tool-use events, so we use a marker
// protocol:
//
//   TOOL_CALL: <tool_name>
//   {"arg": "value"}
//   END_TOOL_CALL
//
// Server-side we scan the accumulated stdout for markers, emit a
// `tool_use` chunk, and (back in assistant.ts) execute the tool via the
// existing registry.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { agents } from "@agentdash/db";
import { getServerAdapter } from "../adapters/index.js";
import { secretService } from "./secrets.js";
import { logger } from "../middleware/logger.js";
import type {
  AssistantChunk,
  AssistantMessage,
  ChiefOfStaffAgent,
  ContentBlock,
  ToolDefinition,
} from "./assistant-llm.js";

// ── Prompt composition ────────────────────────────────────────────────

function flattenContent(content: AssistantMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block: ContentBlock) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") {
        return `[TOOL CALL ${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
      }
      if (block.type === "tool_result") {
        return `[TOOL RESULT]\n${block.content}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function buildToolProtocolSection(tools: ToolDefinition[]): string {
  if (!tools || tools.length === 0) return "";
  const toolBlock = tools
    .map((t) => {
      const schema = JSON.stringify(t.input_schema, null, 2);
      return `**${t.name}** — ${t.description}\nInput schema:\n\`\`\`json\n${schema}\n\`\`\``;
    })
    .join("\n\n");
  return `

---

## Tool-calling protocol (AgentDash)

You have these tools available:

${toolBlock}

When you want to invoke a tool, emit EXACTLY this on its own lines (no backticks, no prose around it):

    TOOL_CALL: <tool_name>
    {"arg":"value"}
    END_TOOL_CALL

The JSON must be valid between the markers. After END_TOOL_CALL, stop and wait for a TOOL_RESULT block to arrive in the next turn.`;
}

function buildChatPrompt(
  systemPrompt: string,
  messages: AssistantMessage[],
  tools: ToolDefinition[],
): string {
  const toolProtocol = buildToolProtocolSection(tools);
  const history = messages
    .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${flattenContent(m.content)}`)
    .join("\n\n");
  return `${systemPrompt}${toolProtocol}

---

# Conversation

${history}

ASSISTANT:`;
}

// ── Tool-call marker parser ──────────────────────────────────────────

interface ParsedMarker {
  toolName: string;
  input: Record<string, unknown>;
  raw: string;
}

export function extractToolCalls(stdout: string): ParsedMarker[] {
  const results: ParsedMarker[] = [];
  const re = /TOOL_CALL:\s*([\w_-]+)\s*\n([\s\S]*?)\nEND_TOOL_CALL/g;
  let match;
  while ((match = re.exec(stdout)) !== null) {
    const toolName = match[1].trim();
    const jsonBlob = match[2].trim();
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(jsonBlob);
    } catch (err) {
      logger.warn(
        { toolName, raw: jsonBlob, err },
        "assistant-llm-adapter: failed to parse TOOL_CALL payload as JSON",
      );
    }
    results.push({ toolName, input, raw: match[0] });
  }
  return results;
}

// ── Queue bridge: callback → async generator ─────────────────────────

class ChunkQueue {
  private chunks: AssistantChunk[] = [];
  private waiter: (() => void) | null = null;
  private done = false;

  push(chunk: AssistantChunk) {
    this.chunks.push(chunk);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  close() {
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  async *drain(): AsyncGenerator<AssistantChunk> {
    while (true) {
      while (this.chunks.length > 0) {
        yield this.chunks.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

// ── Public entrypoint ────────────────────────────────────────────────

export async function* streamChatViaAdapter(
  db: Db,
  cosAgent: ChiefOfStaffAgent,
  systemPrompt: string,
  messages: AssistantMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): AsyncGenerator<AssistantChunk> {
  // 1. Load full agent row (we need adapterConfig).
  const rows = await db
    .select({ id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.id, cosAgent.id), eq(agents.companyId, cosAgent.companyId)))
    .limit(1);
  if (rows.length === 0) {
    yield { type: "error", code: "cos_not_found", message: "Chief of Staff agent not found" };
    return;
  }
  const agentRow = rows[0];
  const adapterType = agentRow.adapterType;
  if (!adapterType || adapterType === "process") {
    yield {
      type: "error",
      code: "no_adapter",
      message:
        "Chief of Staff has no runtime adapter configured. Open the agent and pick an adapter (Claude Code, Codex, Gemini, …).",
    };
    return;
  }

  // 2. Resolve adapter config (decrypts any secrets).
  const agentConfig = (agentRow.adapterConfig as Record<string, unknown> | null) ?? {};
  const { config: resolvedConfig } = await secretService(db).resolveAdapterConfigForRuntime(
    cosAgent.companyId,
    agentConfig,
  );

  // 3. Build the chat prompt and inject as `promptTemplate` so every
  //    adapter that honors the field (claude_local, codex_local, …) picks
  //    it up. Also set `bootstrapPromptTemplate` to empty so resume
  //    delta logic doesn't override on first run.
  const fullPrompt = buildChatPrompt(systemPrompt, messages, tools);
  const chatConfig: Record<string, unknown> = {
    ...resolvedConfig,
    promptTemplate: fullPrompt,
    bootstrapPromptTemplate: "",
  };

  // 4. Get the adapter.
  let adapter: ReturnType<typeof getServerAdapter>;
  try {
    adapter = getServerAdapter(adapterType);
  } catch (err) {
    yield {
      type: "error",
      code: "adapter_not_found",
      message: `Adapter '${adapterType}' not registered: ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  // 5. Set up queue bridge so adapter.execute()'s onLog callback feeds an
  //    async generator we can yield from.
  const queue = new ChunkQueue();
  const stdoutParts: string[] = [];
  const runId = randomUUID();

  const executePromise = adapter
    .execute({
      runId,
      agent: {
        id: cosAgent.id,
        companyId: cosAgent.companyId,
        name: cosAgent.name,
        adapterType,
        adapterConfig: agentRow.adapterConfig,
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: chatConfig,
      context: { assistantChat: true, chatRunId: runId },
      onLog: async (stream, chunk) => {
        if (stream === "stdout") {
          stdoutParts.push(chunk);
          queue.push({ type: "text", text: chunk });
        }
      },
    })
    .then((result) => {
      // Adapter finished. Parse accumulated stdout for tool-call markers
      // and emit tool_use events.
      const full = stdoutParts.join("");
      const toolCalls = extractToolCalls(full);
      for (const tc of toolCalls) {
        queue.push({
          type: "tool_use",
          id: `marker-${randomUUID()}`,
          name: tc.toolName,
          input: tc.input,
        });
      }
      const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
      if (result.errorMessage) {
        queue.push({
          type: "error",
          code: result.errorCode ?? "adapter_error",
          message: result.errorMessage,
        });
      }
      queue.push({ type: "done", usage });
      queue.close();
    })
    .catch((err) => {
      logger.warn({ err, adapterType, agentId: cosAgent.id }, "adapter.execute threw");
      queue.push({
        type: "error",
        code: "adapter_threw",
        message: err instanceof Error ? err.message : String(err),
      });
      queue.close();
    });

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        queue.close();
      },
      { once: true },
    );
  }

  try {
    for await (const chunk of queue.drain()) {
      if (signal?.aborted) return;
      yield chunk;
    }
  } finally {
    // Don't orphan the promise — await its settlement.
    await executePromise.catch(() => {});
  }
}
