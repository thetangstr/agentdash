import { spawn } from "node:child_process";
import { anthropicLLM } from "./anthropic-llm.js";
import { logger } from "../middleware/logger.js";

// Default hermes binary path — matches the mini's installation.
// Overridden by AGENTDASH_HERMES_COMMAND env var if set.
const DEFAULT_HERMES_COMMAND = "/Users/maxiaoer/.local/bin/hermes";

/** Timeout for local adapter spawns in milliseconds. */
const ADAPTER_TIMEOUT_MS = 45_000;

interface LLMInput {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Run a child process with a timeout, collecting stdout.
 * Rejects if the process exits non-zero or the timeout fires.
 */
function spawnWithTimeout(
  command: string,
  args: string[],
  stdinData?: string,
  timeoutMs = ADAPTER_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`[dispatch-llm] ${command} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`[dispatch-llm] ${command} exited ${code}: ${stderr.trim()}`));
        } else {
          resolve(stdout.trim());
        }
      }
    });

    if (stdinData !== undefined) {
      child.stdin.end(stdinData);
    }
  });
}

/**
 * Build a single-turn prompt string for local adapters that don't accept
 * structured message arrays. Concatenates the system prompt and the full
 * conversation history.
 */
function buildFlatPrompt(input: LLMInput): string {
  const parts: string[] = [];
  if (input.system) {
    parts.push(`[System]\n${input.system}`);
  }
  for (const msg of input.messages) {
    const role = msg.role === "assistant" ? "Assistant" : "User";
    parts.push(`[${role}]\n${msg.content}`);
  }
  parts.push("[Assistant]");
  return parts.join("\n\n");
}

/**
 * LLM dispatch for CoS replies.
 *
 * Reads AGENTDASH_DEFAULT_ADAPTER at call time (not module load) so
 * env changes after startup are respected.
 *
 * Supported adapters:
 *  - "claude_api" (default): calls Anthropic API via anthropicLLM
 *  - "hermes_local": spawns `hermes chat -q "<prompt>" -Q`
 *  - "claude_local": spawns `claude --print -` with prompt on stdin
 *  - everything else: falls back to claude_api with a TODO log
 */
export async function dispatchLLM(input: LLMInput): Promise<string> {
  const adapter = (process.env.AGENTDASH_DEFAULT_ADAPTER ?? "claude_api").trim();

  if (adapter === "claude_api" || adapter === "") {
    return anthropicLLM(input);
  }

  if (adapter === "hermes_local") {
    const hermesCmd =
      (process.env.AGENTDASH_HERMES_COMMAND ?? "").trim() || DEFAULT_HERMES_COMMAND;
    const prompt = buildFlatPrompt(input);
    logger.info({ adapter, hermesCmd }, "[dispatch-llm] routing CoS reply through hermes_local");
    try {
      const reply = await spawnWithTimeout(hermesCmd, ["chat", "-q", prompt, "-Q"]);
      if (!reply) {
        logger.warn({ adapter }, "[dispatch-llm] hermes_local returned empty reply, using fallback");
        return anthropicLLM(input);
      }
      return reply;
    } catch (err) {
      logger.error({ err, adapter }, "[dispatch-llm] hermes_local failed, falling back to claude_api");
      return anthropicLLM(input);
    }
  }

  if (adapter === "claude_local") {
    const prompt = buildFlatPrompt(input);
    logger.info({ adapter }, "[dispatch-llm] routing CoS reply through claude_local");
    try {
      const reply = await spawnWithTimeout("claude", ["--print", "-"], prompt);
      if (!reply) {
        logger.warn({ adapter }, "[dispatch-llm] claude_local returned empty reply, using fallback");
        return anthropicLLM(input);
      }
      return reply;
    } catch (err) {
      logger.error({ err, adapter }, "[dispatch-llm] claude_local failed, falling back to claude_api");
      return anthropicLLM(input);
    }
  }

  // TODO: add dispatch for gemini_local, codex_local, etc.
  logger.warn(
    { adapter },
    "[dispatch-llm] adapter not yet supported for CoS chat — falling back to claude_api",
  );
  return anthropicLLM(input);
}
