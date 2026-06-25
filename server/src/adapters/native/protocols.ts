// AgentDash native adapter — chat protocol abstraction.
//
// The in-process loop keeps a neutral message history and delegates wire format
// to a ChatProtocol. Two are supported so an agent can use whichever LLM the
// operator configures (like Hermes): "openai" (OpenRouter / OpenAI / most
// OpenAI-compatible gateways) and "anthropic" (Anthropic + the MiniMax /anthropic
// endpoint). Adding a provider is a config change, not code.

import type { ToolSchema } from "./tools.js";

export type ProtocolName = "openai" | "anthropic";

export interface NeutralToolCall {
  id: string;
  name: string;
  /** raw JSON arguments string from the model */
  argsJson: string;
}

export type NeutralMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string | null; toolCalls: NeutralToolCall[] }
  | { role: "tool_results"; results: Array<{ id: string; content: string }> };

export interface ModelTurn {
  text: string;
  toolCalls: NeutralToolCall[];
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
}

export interface ChatProtocol {
  name: ProtocolName;
  endpoint(baseUrl: string): string;
  headers(apiKey: string): Record<string, string>;
  buildBody(input: {
    model: string;
    systemPrompt: string;
    history: NeutralMessage[];
    toolSchemas: ToolSchema[];
    maxTokens: number;
  }): Record<string, unknown>;
  parse(data: unknown): ModelTurn;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// ───────────────────────── OpenAI (chat/completions) ─────────────────────────
export const openaiProtocol: ChatProtocol = {
  name: "openai",
  endpoint: (baseUrl) => `${trimBase(baseUrl)}/chat/completions`,
  headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }),
  buildBody({ model, systemPrompt, history, toolSchemas }) {
    const messages: Record<string, unknown>[] = [{ role: "system", content: systemPrompt }];
    for (const m of history) {
      if (m.role === "user") {
        messages.push({ role: "user", content: m.text });
      } else if (m.role === "assistant") {
        messages.push({
          role: "assistant",
          content: m.text,
          ...(m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.argsJson },
                })),
              }
            : {}),
        });
      } else {
        for (const r of m.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
    }
    return { model, messages, tools: toolSchemas, tool_choice: "auto" };
  },
  parse(data) {
    const d = data as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const message = d.choices?.[0]?.message;
    return {
      text: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, argsJson: c.function.arguments })),
      usage: {
        inputTokens: d.usage?.prompt_tokens ?? 0,
        outputTokens: d.usage?.completion_tokens ?? 0,
        cachedInputTokens: d.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  },
};

// ───────────────────────── Anthropic (/v1/messages) ─────────────────────────
export const anthropicProtocol: ChatProtocol = {
  name: "anthropic",
  endpoint: (baseUrl) => `${trimBase(baseUrl)}/v1/messages`,
  headers: (apiKey) => ({
    // Anthropic standard is x-api-key; also send Bearer for compatible gateways
    // (e.g. MiniMax's /anthropic endpoint) that authenticate either way.
    "x-api-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  }),
  buildBody({ model, systemPrompt, history, toolSchemas, maxTokens }) {
    const messages: Record<string, unknown>[] = [];
    for (const m of history) {
      if (m.role === "user") {
        messages.push({ role: "user", content: [{ type: "text", text: m.text }] });
      } else if (m.role === "assistant") {
        const content: Record<string, unknown>[] = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const c of m.toolCalls) {
          let input: unknown = {};
          try {
            input = c.argsJson ? JSON.parse(c.argsJson) : {};
          } catch {
            input = {};
          }
          content.push({ type: "tool_use", id: c.id, name: c.name, input });
        }
        messages.push({ role: "assistant", content });
      } else {
        messages.push({
          role: "user",
          content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content })),
        });
      }
    }
    return {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      tools: toolSchemas.map((s) => ({
        name: s.function.name,
        description: s.function.description,
        input_schema: s.function.parameters,
      })),
    };
  },
  parse(data) {
    const d = data as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };
    const blocks = d.content ?? [];
    return {
      text: blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      toolCalls: blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id ?? "", name: b.name ?? "", argsJson: JSON.stringify(b.input ?? {}) })),
      usage: {
        inputTokens: d.usage?.input_tokens ?? 0,
        outputTokens: d.usage?.output_tokens ?? 0,
        cachedInputTokens: d.usage?.cache_read_input_tokens ?? 0,
      },
    };
  },
};

export function getProtocol(name: ProtocolName): ChatProtocol {
  return name === "anthropic" ? anthropicProtocol : openaiProtocol;
}
