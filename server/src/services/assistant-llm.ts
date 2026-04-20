/**
 * LLM call layer for the Assistant Chatbot.
 * V1: Anthropic Messages API (Claude) with streaming + function-calling.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface AssistantLLMConfig {
  apiKey: string;
  model: string;           // default: "claude-sonnet-4-20250514"
  baseUrl?: string;        // default: "https://api.anthropic.com"
  maxTokens?: number;      // default: 4096
}

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

// ── Config Resolution ──────────────────────────────────────────────────

export function resolveAssistantConfig(): AssistantLLMConfig {
  const apiKey = process.env.ASSISTANT_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(
      new Error("ASSISTANT_API_KEY is not configured. Set it in .env.local to enable the assistant."),
      { statusCode: 503 },
    );
  }
  return {
    apiKey,
    model: process.env.ASSISTANT_MODEL ?? "claude-sonnet-4-20250514",
    baseUrl: process.env.ASSISTANT_BASE_URL ?? "https://api.anthropic.com",
    maxTokens: Number(process.env.ASSISTANT_MAX_TOKENS) || 4096,
  };
}

// ── Streaming Chat ─────────────────────────────────────────────────────

export async function* streamChat(
  config: AssistantLLMConfig,
  systemPrompt: string,
  messages: AssistantMessage[],
  tools?: ToolDefinition[],
  signal?: AbortSignal,
): AsyncGenerator<AssistantChunk> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens ?? 4096,
    system: systemPrompt,
    messages,
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    yield { type: "error", code: "fetch_error", message: err instanceof Error ? err.message : "Network error" };
    return;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    yield { type: "error", code: `http_${res.status}`, message: `Anthropic API error ${res.status}: ${errText}` };
    return;
  }

  // Parse SSE stream
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  // Track tool_use blocks being built incrementally
  let currentToolUse: { id: string; name: string; inputJson: string } | null = null;

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        switch (event.type) {
          case "message_start":
            if (event.message?.usage) {
              inputTokens = event.message.usage.input_tokens ?? 0;
            }
            break;

          case "content_block_start":
            if (event.content_block?.type === "tool_use") {
              currentToolUse = {
                id: event.content_block.id,
                name: event.content_block.name,
                inputJson: "",
              };
            }
            break;

          case "content_block_delta":
            if (event.delta?.type === "text_delta" && event.delta.text) {
              yield { type: "text", text: event.delta.text };
            } else if (event.delta?.type === "input_json_delta" && currentToolUse) {
              currentToolUse.inputJson += event.delta.partial_json ?? "";
            }
            break;

          case "content_block_stop":
            if (currentToolUse) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(currentToolUse.inputJson || "{}");
              } catch { /* use empty */ }
              yield {
                type: "tool_use",
                id: currentToolUse.id,
                name: currentToolUse.name,
                input,
              };
              currentToolUse = null;
            }
            break;

          case "message_delta":
            if (event.usage) {
              outputTokens = event.usage.output_tokens ?? 0;
            }
            break;

          case "message_stop":
            yield { type: "done", usage: { inputTokens, outputTokens } };
            return;

          case "error":
            yield { type: "error", code: "stream_error", message: event.error?.message ?? "Unknown stream error" };
            return;
        }
      }
    }

    // If we exit without message_stop, still yield done
    yield { type: "done", usage: { inputTokens, outputTokens } };
  } finally {
    reader.releaseLock();
  }
}
