// AgentDash (AGE-52): codex-backed assistant chat. Spawns the operator's
// `codex -q` CLI (which authenticates via OAuth against ChatGPT Plus/Pro)
// instead of calling the Anthropic API directly. Lets the assistant chat
// run on the same subscription the CoS agent uses — no ASSISTANT_API_KEY
// required.
//
// Tool calls are translated via a marker protocol because codex streams
// prose, not Anthropic-style structured events:
//
//   TOOL_CALL: <tool_name>
//   {"arg": "value"}
//   END_TOOL_CALL
//
// The parser watches stdout line-by-line; when it sees a TOOL_CALL marker
// it buffers the JSON payload, then emits a tool_use chunk on END_TOOL_CALL.
// Everything else is emitted as text.

import { spawn } from "node:child_process";
import type {
  AssistantChunk,
  AssistantMessage,
  ToolDefinition,
} from "./assistant-llm.js";
import { logger } from "../middleware/logger.js";

interface CodexBackendConfig {
  command: string;   // default: "codex"
  model?: string;    // optional override; defaults to codex CLI default
  args?: string[];   // extra CLI args
}

// AgentDash (AGE-52): seed the system prompt with the marker protocol so
// codex knows how to emit tool calls in a format we can parse.
function buildCodexSystemPrompt(baseSystemPrompt: string, tools: ToolDefinition[]): string {
  if (tools.length === 0) return baseSystemPrompt;

  const toolBlock = tools
    .map((t) => {
      const schema = JSON.stringify(t.input_schema, null, 2);
      return `**${t.name}** — ${t.description}\nInput schema:\n\`\`\`json\n${schema}\n\`\`\``;
    })
    .join("\n\n");

  return `${baseSystemPrompt}

---

## Tool-calling protocol (AgentDash)

You have these tools available:

${toolBlock}

When you want to invoke a tool, emit EXACTLY this on its own lines:

    TOOL_CALL: <tool_name>
    {"arg":"value","other":123}
    END_TOOL_CALL

The JSON must be valid and on its own line(s) between the two markers. Do not wrap in backticks. After the END_TOOL_CALL line, stop and wait for the result, which will arrive as:

    TOOL_RESULT: <tool_name>
    {"ok":true,"data":...}
    END_TOOL_RESULT

Only invoke a tool when you have all the information needed. Prefer multiple small TOOL_CALLs over nesting.`;
}

// Flatten the assistant's Anthropic-shaped message history into a single
// prose prompt codex can consume. Tool results get injected as markers so
// the model can see them in-context.
function messagesToCodexPrompt(messages: AssistantMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      lines.push(`${msg.role === "user" ? "USER" : "ASSISTANT"}: ${msg.content}`);
      continue;
    }
    // Structured content blocks — tool results, etc.
    for (const block of msg.content) {
      if (block.type === "text") {
        lines.push(`${msg.role === "user" ? "USER" : "ASSISTANT"}: ${block.text}`);
      } else if (block.type === "tool_result") {
        lines.push(`TOOL_RESULT: (previous call)\n${block.content}\nEND_TOOL_RESULT`);
      } else if (block.type === "tool_use") {
        lines.push(
          `ASSISTANT (tool invocation):\nTOOL_CALL: ${block.name}\n${JSON.stringify(block.input)}\nEND_TOOL_CALL`,
        );
      }
    }
  }
  return lines.join("\n\n");
}

function resolveCodexBackendConfig(): CodexBackendConfig {
  return {
    command: process.env.ASSISTANT_CODEX_COMMAND?.trim() || "codex",
    model: process.env.ASSISTANT_CODEX_MODEL?.trim() || undefined,
    args: (process.env.ASSISTANT_CODEX_ARGS ?? "").trim()
      ? (process.env.ASSISTANT_CODEX_ARGS as string).split(/\s+/)
      : undefined,
  };
}

export async function* streamChatViaCodex(
  systemPrompt: string,
  messages: AssistantMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): AsyncGenerator<AssistantChunk> {
  const cfg = resolveCodexBackendConfig();
  const seeded = buildCodexSystemPrompt(systemPrompt, tools);
  const conversation = messagesToCodexPrompt(messages);

  // Compose one big prompt. Codex -q is stateless; we stuff the whole
  // history into stdin each round. For small conversations this is fine;
  // for long ones we'd want a proper session resume, tracked in AGE-52
  // follow-up work.
  const fullPrompt = `${seeded}\n\n===\n\n${conversation}\n\nASSISTANT:`;

  const baseArgs = ["-q", "--no-project-doc"];
  if (cfg.model) baseArgs.push("-m", cfg.model);
  if (cfg.args && cfg.args.length > 0) baseArgs.push(...cfg.args);
  baseArgs.push(fullPrompt);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cfg.command, baseArgs, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    yield {
      type: "error",
      code: "spawn_error",
      message: `Failed to spawn ${cfg.command}: ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  if (signal) {
    signal.addEventListener("abort", () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, { once: true });
  }

  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  // Line-buffered stdout with marker-based tool-call extraction.
  const decoder = new TextDecoder();
  let buffer = "";
  let inToolCall = false;
  let toolCallName = "";
  let toolCallJson = "";

  function* flushText(text: string): Generator<AssistantChunk> {
    if (text.length > 0) yield { type: "text", text };
  }

  try {
    for await (const chunk of child.stdout!) {
      if (signal?.aborted) return;
      buffer += decoder.decode(chunk as Buffer, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (inToolCall) {
          if (line.trim() === "END_TOOL_CALL") {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(toolCallJson.trim() || "{}");
            } catch (err) {
              logger.warn(
                { err, raw: toolCallJson, toolCallName },
                "assistant-llm-codex: failed to parse TOOL_CALL payload as JSON",
              );
            }
            yield {
              type: "tool_use",
              id: `codex-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: toolCallName,
              input,
            };
            inToolCall = false;
            toolCallName = "";
            toolCallJson = "";
          } else {
            toolCallJson += line + "\n";
          }
          continue;
        }

        const markerMatch = /^TOOL_CALL:\s*(.+)\s*$/.exec(line.trim());
        if (markerMatch) {
          inToolCall = true;
          toolCallName = markerMatch[1].trim();
          toolCallJson = "";
          continue;
        }

        yield* flushText(line + "\n");
      }
    }
    if (buffer.length > 0) yield* flushText(buffer);

    const exitCode: number | null = await new Promise((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.once("exit", (code) => resolve(code));
    });
    if (exitCode !== 0 && stderrBuf) {
      logger.warn({ exitCode, stderr: stderrBuf.slice(0, 500) }, "codex process exited non-zero");
      yield {
        type: "error",
        code: `codex_exit_${exitCode}`,
        message: `codex exited ${exitCode}: ${stderrBuf.slice(0, 300)}`,
      };
      return;
    }

    // Codex doesn't report token usage; yield zeros so callers don't break.
    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
  } catch (err) {
    if (signal?.aborted) return;
    yield {
      type: "error",
      code: "stream_error",
      message: err instanceof Error ? err.message : "Unknown codex stream error",
    };
  }
}
