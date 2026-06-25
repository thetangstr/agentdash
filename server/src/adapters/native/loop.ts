// AgentDash native adapter — in-process tool-calling loop.
//
// Runs the agent loop INSIDE the server process (no child process → no EPIPE /
// orphan-pid / reaper class) against any configured model via a ChatProtocol
// (OpenAI or Anthropic wire format). Hard budgets (max turns + wall-clock
// AbortController) prevent the runaway timeouts seen with external harnesses.

import { findTool, toolSchemas, type Tool } from "./tools.js";
import type { ChatProtocol, NeutralMessage } from "./protocols.js";

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
  protocol: ChatProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: Tool[];
  maxTurns: number;
  timeoutMs: number;
  maxTokens?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  fetchImpl?: typeof fetch;
}

function emptyUsage(): LoopUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

export async function runAgentLoop(input: RunLoopInput): Promise<LoopResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const { protocol } = input;
  const schemas = toolSchemas(input.tools);
  const maxTokens = input.maxTokens ?? 4096;
  const log = async (chunk: string) => {
    if (input.onLog) await input.onLog("stdout", chunk.endsWith("\n") ? chunk : `${chunk}\n`);
  };

  const history: NeutralMessage[] = [{ role: "user", text: input.userPrompt }];
  const usage = emptyUsage();
  let toolCalls = 0;
  let finalText = "";

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    for (let turn = 0; turn < input.maxTurns; turn++) {
      const body = protocol.buildBody({ model: input.model, systemPrompt: input.systemPrompt, history, toolSchemas: schemas, maxTokens });

      let res: Response;
      try {
        res = await fetchImpl(protocol.endpoint(input.baseUrl), {
          method: "POST",
          headers: protocol.headers(input.apiKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return { finalText, usage, turns: turn, toolCalls, stopReason: "timeout" };
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[native] gateway request failed: ${msg}`);
        return { finalText, usage, turns: turn, toolCalls, stopReason: "error", errorMessage: msg };
      }

      const data = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
      if (!res.ok || !data || data.error) {
        const msg =
          (data?.error && typeof data.error === "object" ? data.error.message : (data?.error as string)) ?? `gateway HTTP ${res.status}`;
        await log(`[native] gateway error: ${msg}`);
        return { finalText, usage, turns: turn, toolCalls, stopReason: "error", errorMessage: msg };
      }

      const parsed = protocol.parse(data);
      usage.inputTokens += parsed.usage.inputTokens;
      usage.outputTokens += parsed.usage.outputTokens;
      usage.cachedInputTokens += parsed.usage.cachedInputTokens;

      if (parsed.toolCalls.length === 0) {
        finalText = parsed.text;
        if (finalText) await log(`[native] ${finalText}`);
        return { finalText, usage, turns: turn + 1, toolCalls, stopReason: "completed" };
      }

      history.push({ role: "assistant", text: parsed.text || null, toolCalls: parsed.toolCalls });

      const results: Array<{ id: string; content: string }> = [];
      for (const call of parsed.toolCalls) {
        toolCalls++;
        let args: Record<string, unknown> = {};
        try {
          args = call.argsJson ? (JSON.parse(call.argsJson) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        await log(`[native] → ${call.name}(${call.argsJson || "{}"})`);
        const tool = findTool(input.tools, call.name);
        const result = tool
          ? await tool.execute(args)
          : { content: JSON.stringify({ error: `unknown tool: ${call.name}` }), isError: true };
        await log(`[native] ← ${call.name}: ${result.isError ? "error " : ""}${result.content.slice(0, 400)}`);
        results.push({ id: call.id, content: result.content });
      }
      history.push({ role: "tool_results", results });
    }

    return { finalText, usage, turns: input.maxTurns, toolCalls, stopReason: "max_turns" };
  } finally {
    clearTimeout(deadline);
  }
}
