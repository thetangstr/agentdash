// AgentDash native adapter — in-process tool-calling loop.
//
// Runs the agent loop INSIDE the server process (no child process → no EPIPE /
// orphan-pid / reaper class) against the managed inference gateway over the
// OpenAI chat-completions protocol (which the gateway/OpenRouter normalizes for
// any provider that supports tools). Hard budgets (max turns + wall-clock
// AbortController) prevent the runaway timeouts seen with the external harnesses.

import { findTool, toolSchemas, type Tool } from "./tools.js";

export interface LoopMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface LoopUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export type LoopStopReason = "completed" | "max_turns" | "timeout" | "error";

export interface LoopResult {
  finalText: string;
  usage: LoopUsage;
  turns: number;
  toolCalls: number;
  stopReason: LoopStopReason;
  errorMessage?: string;
}

export interface RunLoopInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: Tool[];
  maxTurns: number;
  timeoutMs: number;
  /** stream readable events to the run log */
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: LoopMessage; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string } | string;
}

function emptyUsage(): LoopUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

export async function runAgentLoop(input: RunLoopInput): Promise<LoopResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const log = async (chunk: string) => {
    if (input.onLog) await input.onLog("stdout", chunk.endsWith("\n") ? chunk : `${chunk}\n`);
  };

  const messages: LoopMessage[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.userPrompt },
  ];
  const schemas = toolSchemas(input.tools);
  const usage = emptyUsage();
  let toolCalls = 0;
  let finalText = "";

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    for (let turn = 0; turn < input.maxTurns; turn++) {
      let res: Response;
      try {
        res = await fetchImpl(`${input.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: input.model,
            messages,
            tools: schemas,
            tool_choice: "auto",
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          return { finalText, usage, turns: turn, toolCalls, stopReason: "timeout" };
        }
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[native] gateway request failed: ${msg}`);
        return { finalText, usage, turns: turn, toolCalls, stopReason: "error", errorMessage: msg };
      }

      const data = (await res.json().catch(() => null)) as ChatCompletionResponse | null;
      if (!res.ok || !data || data.error) {
        const msg =
          (data?.error && typeof data.error === "object" ? data.error.message : (data?.error as string)) ??
          `gateway HTTP ${res.status}`;
        await log(`[native] gateway error: ${msg}`);
        return { finalText, usage, turns: turn, toolCalls, stopReason: "error", errorMessage: msg };
      }

      // accumulate usage
      usage.inputTokens += data.usage?.prompt_tokens ?? 0;
      usage.outputTokens += data.usage?.completion_tokens ?? 0;
      usage.cachedInputTokens += data.usage?.prompt_tokens_details?.cached_tokens ?? 0;

      const message = data.choices?.[0]?.message;
      if (!message) {
        return { finalText, usage, turns: turn + 1, toolCalls, stopReason: "error", errorMessage: "gateway returned no message" };
      }
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        finalText = message.content ?? "";
        if (finalText) await log(`[native] ${finalText}`);
        return { finalText, usage, turns: turn + 1, toolCalls, stopReason: "completed" };
      }

      // execute each tool call and feed results back
      for (const call of calls) {
        toolCalls++;
        const name = call.function?.name ?? "";
        let args: Record<string, unknown> = {};
        try {
          args = call.function?.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          // malformed args — let the tool report the validation error
          args = {};
        }
        await log(`[native] → ${name}(${call.function?.arguments ?? "{}"})`);
        const tool = findTool(input.tools, name);
        const result = tool
          ? await tool.execute(args)
          : { content: JSON.stringify({ error: `unknown tool: ${name}` }), isError: true };
        await log(`[native] ← ${name}: ${result.isError ? "error " : ""}${result.content.slice(0, 400)}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      }
    }

    return { finalText, usage, turns: input.maxTurns, toolCalls, stopReason: "max_turns" };
  } finally {
    clearTimeout(deadline);
  }
}
