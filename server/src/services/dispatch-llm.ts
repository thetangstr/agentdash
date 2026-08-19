import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { anthropicLLM } from "./anthropic-llm.js";
import { minimaxLLM } from "./minimax-llm.js";
import { openaiCompatLLMDetailed, type OpenAICompatUsage } from "./openai-compat-llm.js";
import { costService } from "./costs.js";
import { logger } from "../middleware/logger.js";
import { readFallbackChain } from "../lib/adapter-fallback-chain.js";
import { HttpError } from "../errors.js";
import type { Db } from "@paperclipai/db";
import { parseCodexJsonl } from "@paperclipai/adapter-codex-local/server";

// Default to PATH so every Mac mini install can use its own Hermes location.
// Overridden by AGENTDASH_HERMES_COMMAND env var if set.
const DEFAULT_HERMES_COMMAND = "hermes";
const DEFAULT_CODEX_COMMAND = "codex";
/**
 * Chat replies go through a model a ChatGPT-account login can actually use.
 *
 * The `-codex` family is refused outright on such an install ("not supported
 * when using Codex with a ChatGPT account"), and a Chief of Staff that cannot
 * answer a question is not a Chief of Staff.
 */
const DEFAULT_CODEX_CHAT_MODEL = "gpt-5.6-terra";

/**
 * Toolsets granted to Hermes when it answers a chat turn. `clarify` (ask a
 * clarifying question) is the least-privilege set that still leaves it able to
 * do the job, which is to produce words. Override with
 * AGENTDASH_HERMES_TOOLSETS only with a clear reason — every name added here is
 * a capability handed to a model reading untrusted agent output.
 */
const DEFAULT_HERMES_TOOLSETS = "clarify";

// ---------------------------------------------------------------------------
// AgentDash (Phase G): token-budget instrumentation
//
// When AGENTDASH_TOKEN_BUDGET_LOG is set, emit a structured log line per
// LLM dispatch with the byte-length of the composed prompt (system + messages
// JSON-encoded). The Hermes E2E spec reads these to assert that
// bytes_hermes / bytes_claude_api ≤ 0.30.
//
// Format: [token-budget] adapter=<name> bytes=<n>
// Also writes to /tmp/agentdash-token-budget.json when enabled, for the
// test-spec sidecar collection pattern.
// ---------------------------------------------------------------------------

const TOKEN_BUDGET_LOG_ENABLED = Boolean(process.env.AGENTDASH_TOKEN_BUDGET_LOG);
const TOKEN_BUDGET_FILE = process.env.AGENTDASH_TOKEN_BUDGET_FILE ?? "/tmp/agentdash-token-budget.json";
const SUPPORTED_COS_CHAT_ADAPTERS = ["claude_api", "minimax", "openai_compat", "hermes_local", "claude_local", "codex_local"] as const;

function emitTokenBudget(adapterName: string, input: LLMInput): void {
  if (!TOKEN_BUDGET_LOG_ENABLED) return;
  const bytes = Buffer.byteLength(JSON.stringify({ system: input.system, messages: input.messages }), "utf8");
  const line = `[token-budget] adapter=${adapterName} bytes=${bytes}`;
  logger.info({ adapter: adapterName, bytes }, line);
  // Also append to the sidecar JSON file for test collection.
  try {
    let entries: Array<{ adapter: string; bytes: number; ts: number }> = [];
    if (fs.existsSync(TOKEN_BUDGET_FILE)) {
      try { entries = JSON.parse(fs.readFileSync(TOKEN_BUDGET_FILE, "utf8")); } catch { /* ignore */ }
    }
    entries.push({ adapter: adapterName, bytes, ts: Date.now() });
    fs.writeFileSync(TOKEN_BUDGET_FILE, JSON.stringify(entries), "utf8");
  } catch { /* non-fatal */ }
}

/** Timeout for local adapter spawns in milliseconds. */
/**
 * How long a locally-spawned adapter gets before it is killed.
 *
 * Was 45s, which a real `claude --print` exceeds on a busy machine — observed
 * during a cold end-to-end run, where the timeout was the first domino in an
 * agent posting placeholder text to a colleague. A local CLI doing genuine work
 * is routinely slower than a hosted API call, so the default is generous and the
 * env var exists for operators who would rather fail fast.
 */
const ADAPTER_TIMEOUT_MS = Number(process.env.AGENTDASH_ADAPTER_TIMEOUT_MS ?? 120_000);

interface LLMInput {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Optional metering context for the CoS-chat dispatch. When provided AND the
 * selected adapter surfaces token/cost usage (currently `openai_compat`), a
 * `cost_events` row is written for usage-based billing (Cloud SKU, G3/G4).
 * Recording is best-effort and never blocks or fails the chat reply.
 */
export interface DispatchMeter {
  db: Db;
  companyId: string;
  agentId: string;
}

/**
 * Best-effort write of a `cost_events` row for an OpenAI-compatible call.
 * Exact token counts are recorded; `costCents` is best-effort (sub-cent calls
 * round down) — usage billing (G4) prices from aggregated token counts, not
 * per-event cents, so rounding here does not lose billable signal.
 */
async function recordOpenAICompatUsage(
  meter: DispatchMeter,
  usage: OpenAICompatUsage,
): Promise<void> {
  try {
    let biller = "openrouter.ai";
    try {
      biller = new URL(process.env.OPENAI_COMPAT_BASE_URL ?? "https://openrouter.ai").hostname;
    } catch {
      /* keep default */
    }
    await costService(meter.db).createEvent(meter.companyId, {
      agentId: meter.agentId,
      provider: "openai_compat",
      biller,
      billingType: "usage",
      model: usage.model,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      costCents: usage.costUsd != null ? Math.round(usage.costUsd * 100) : 0,
      occurredAt: new Date(),
    });
  } catch (err) {
    logger.warn(
      { err, adapter: "openai_compat" },
      "[dispatch-llm] cost metering failed (non-fatal)",
    );
  }
}

/**
 * Run a child process with a timeout, collecting stdout.
 * Rejects if the process exits non-zero or the timeout fires.
 */
/**
 * A neutral working directory for locally-spawned adapters.
 *
 * `claude --print` starts a full Claude Code session, which reads the project it
 * is launched in: CLAUDE.md, the git branch, the files around it. Inheriting the
 * server's cwd therefore hands every agent the operator's repository as context.
 *
 * Observed for real: asked "what should I focus on this week?", an agent in a
 * consultancy workspace answered "getting license enforcement finished and
 * merged — it's the branch you're on". That is the server's git branch, not
 * anything about the company. Beyond being wrong, it means an agent answering a
 * colleague can quote whatever repository the server happens to run inside.
 *
 * An empty scratch directory gives the model nothing to absorb but the prompt it
 * was given — which is the mandate and the conversation, and should be all of it.
 */
function neutralSpawnCwd(): string {
  const dir = path.join(os.tmpdir(), "agentdash-adapter-cwd");
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.tmpdir();
  }
}

/**
 * The environment a locally-spawned adapter is allowed to see.
 *
 * `spawn` inherits the parent environment by default, and the parent here is
 * the AgentDash server. That handed every spawned CLI `PAPERCLIP_AGENT_JWT_SECRET`
 * (mint a token for any agent), `DATABASE_URL` with credentials, `BETTER_AUTH_SECRET`,
 * `AGENTDASH_LICENSE_KEY`, and every provider key — to a process whose prompt
 * contains text written by other agents, which this system explicitly treats as
 * untrusted and wraps in `<untrusted-agent-answer>` for exactly that reason.
 *
 * So the blast radius of a successful prompt injection was not "runs a command".
 * It was: read `env`, forge agent JWTs, connect to Postgres directly.
 *
 * Allowlist, not denylist. A denylist silently leaks the next secret someone
 * adds. These adapters need to find their binary and their own config, and
 * nothing else — the CLIs hold their own credentials under `$HOME` (`~/.hermes/.env`,
 * `~/.claude`), so no provider key needs to be passed through from here.
 */
function adapterChildEnv(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "TZ"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The harnesses' own knobs travel; AgentDash's secrets do not.
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("HERMES_") && value !== undefined) env[key] = value;
  }
  return env;
}

function spawnWithTimeout(
  command: string,
  args: string[],
  stdinData?: string,
  timeoutMs = ADAPTER_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: neutralSpawnCwd(),
      env: adapterChildEnv(),
    });

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

    // Close stdin either way.
    //
    // Leaving it open when there is nothing to send looks harmless and is not:
    // `codex exec` accepts a prompt on stdin, so a held-open pipe means it
    // waits for EOF that never comes and the call dies on the 120s timeout —
    // while the identical command run by hand answers in three seconds. Hermes
    // does not read stdin, which is why this went unnoticed until a second
    // adapter arrived. An adapter given no stdin should see EOF, not a promise
    // of input.
    child.stdin.end(stdinData ?? "");
  });
}

/**
 * Build a single-turn prompt string for local adapters that don't accept
 * structured message arrays. Concatenates the system prompt and the full
 * conversation history.
 */
/**
 * Drop Hermes's own chatter from the front of its stdout.
 *
 * Hermes writes status lines to STDOUT rather than stderr, even under `-Q`.
 * Observed for real: a CoS reply reached a colleague's thread reading
 * "⚠ tirith security scanner enabled but not available — command scanning will
 * use pattern matching only\r\nPut weekly revenue versus plan on the board
 * deck…". The answer was correct; it just arrived wearing a security warning,
 * because the adapter treats all of stdout as the agent's words.
 *
 * The specific warning is now off in Hermes config, which is the real fix. This
 * is the backstop, because the failure mode — arbitrary diagnostics posted as an
 * agent's answer — is one bad release away from returning, and the reader of a
 * board pack cannot tell our noise from the model's.
 *
 * Only a LEADING run is stripped, and only lines that carry a terminal-status
 * signature: a trailing carriage return (Hermes redraws these in place) or a
 * leading status glyph. Stripping stops at the first ordinary line, so a real
 * answer that happens to contain "⚠" further down is left alone.
 */
export function stripHermesChatter(stdout: string): string {
  const lines = stdout.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start] ?? "";
    const isStatusLine = line.endsWith("\r") || /^\s*[⚠✓✗→ℹ]/u.test(line);
    if (!isStatusLine) break;
    start += 1;
  }
  return lines.slice(start).join("\n").trim();
}

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

// ---------------------------------------------------------------------------
// AgentDash (Phase G): E2E stub responses for deterministic CI runs.
//
// When PAPERCLIP_E2E_SKIP_LLM=true, dispatchLLM returns canned responses
// keyed by call count (per-process, resets on restart). The deep-interview
// engine calls this once per round, so the sequence is:
//   call 0 → round-1 question
//   call 1 → round-2 question
//   call 2 → round-3 question (with ambiguity low enough to crystallize)
//   call 3+ → crystallize / plan response
// ---------------------------------------------------------------------------

let _e2eCallCount = 0;

function e2eStubResponse(callIndex: number): string {
  // Canned responses: first three are engine turn responses (question + trailer
  // with ambiguity decreasing toward crystallize threshold). Fourth+ is a
  // plan proposal used by the CoS reply path.
  if (callIndex === 0) {
    return `What's your primary goal for this rollout?

\`\`\`json
{
  "ambiguity_score": 0.75,
  "dimensions": { "goal": 0.3, "constraints": 0.2, "criteria": 0.15, "context": 0.2 },
  "ontology_delta": [],
  "next_phase": "continue",
  "action": "ask_next"
}
\`\`\``;
  }
  if (callIndex === 1) {
    return `What constraints matter most to you?

\`\`\`json
{
  "ambiguity_score": 0.45,
  "dimensions": { "goal": 0.7, "constraints": 0.5, "criteria": 0.3, "context": 0.4 },
  "ontology_delta": [],
  "next_phase": "continue",
  "action": "ask_next"
}
\`\`\``;
  }
  if (callIndex === 2) {
    return `How will you know this succeeded?

\`\`\`json
{
  "ambiguity_score": 0.12,
  "dimensions": { "goal": 0.92, "constraints": 0.88, "criteria": 0.91, "context": 0.85 },
  "ontology_delta": [],
  "next_phase": "crystallize",
  "action": "force_crystallize"
}
\`\`\``;
  }
  // call 3+: CoS plan proposal — a valid agent_plan_proposal_v1 JSON.
  return JSON.stringify({
    rationale: "Based on your interview, I recommend these three agents to accelerate engineering velocity.",
    alignmentToShortTerm: "Reduce incident MTTT by 40%",
    alignmentToLongTerm: "Scale engineering capacity without proportional headcount growth",
    agents: [
      {
        name: "Alex",
        role: "engineering_lead",
        adapterType: "claude_code",
        responsibilities: ["Lead technical design", "Unblock squads"],
        kpis: ["PR review time", "Incident MTTT"],
      },
      {
        name: "Morgan",
        role: "product_manager",
        adapterType: "claude_code",
        responsibilities: ["Prioritize backlog", "Stakeholder communication"],
        kpis: ["Feature delivery cadence", "Stakeholder satisfaction"],
      },
      {
        name: "Jordan",
        role: "data_analyst",
        adapterType: "claude_code",
        responsibilities: ["Monitor KPI dashboards", "Surface anomalies"],
        kpis: ["Data freshness", "Anomaly detection rate"],
      },
    ],
  });
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
 *  - everything else: throws 501 so unsupported adapters do not silently misroute
 */
/**
 * Optional per-call dispatch options.
 *
 * `adapter` forces a specific adapter for this call regardless of
 * AGENTDASH_DEFAULT_ADAPTER. The Test Drive trial uses this to pin every
 * anonymous run to the cheap `minimax` adapter while preserving metering.
 * Backward compatible: omit it to keep the env-driven default.
 */
export interface DispatchOptions {
  adapter?: string;
  /**
   * Model override for adapters that take one on the command line
   * (`hermes_local` via `-m`, `codex_local` via `--model`). Adapters with no
   * such flag ignore it. Set by fallback-chain hops so "same adapter,
   * different model" is a real hop rather than a no-op retry.
   */
  model?: string;
  /**
   * Internal: a fallback-chain hop must not itself fall back. The chain
   * walker in `runFallbackAdapter` owns iteration; each hop it dispatches
   * gets this flag so a failing hop returns to the walker (which tries the
   * next hop) instead of re-entering the chain from the top and ping-ponging.
   */
  disableFallback?: boolean;
}

/**
 * Try a second adapter after the configured one failed.
 *
 * This used to be hardwired to `claude_api`, which made Anthropic an implicit
 * dependency of every other adapter: a deployment that had deliberately chosen
 * MiniMax or Hermes still reached for Claude the moment its own provider
 * hiccuped. The fallback is now named by `AGENTDASH_FALLBACK_ADAPTER`, and
 * **unset means do not fall back** — a deployment that has not said where to go
 * next should fail loudly rather than silently route a colleague's question to a
 * provider nobody configured, on someone's credential.
 *
 * The hard part is not the routing, it is refusing to answer. An unconfigured
 * adapter that returns cheerful placeholder text turns a failure into a
 * plausible-looking agent turn in a team thread. Seen for real: `claude_local`
 * hit its 45s timeout on a busy machine, fell through to here, and an agent
 * replied "Got it. (stub reply — set ANTHROPIC_API_KEY…)" to a colleague's
 * question. Nothing surfaced the timeout, because the thread looked like it had
 * worked. Every adapter now throws on missing configuration for this reason.
 *
 * One hop only. If the fallback also fails it lands back here with
 * `failedAdapter` equal to the configured fallback, which is refused below —
 * so a misconfigured pair cannot ping-pong.
 */
async function runFallbackAdapter(
  input: LLMInput,
  failedAdapter: string,
  cause: unknown,
  options?: DispatchOptions,
): Promise<string> {
  const reason = cause instanceof Error ? cause.message : String(cause);

  // A chain hop that fails must surface to the chain walker, not start a
  // nested walk of its own.
  if (options?.disableFallback) {
    throw cause instanceof Error
      ? cause
      : new Error(`Adapter "${failedAdapter}" failed: ${reason}`);
  }

  // AgentDash: AGENTDASH_FALLBACK_CHAIN — ordered `adapter[:model]` hops.
  // Takes precedence over the single-hop AGENTDASH_FALLBACK_ADAPTER when set.
  const chain = readFallbackChain();
  if (chain.length > 0) {
    const errors: string[] = [`${failedAdapter}: ${reason}`];
    for (const hop of chain) {
      // A hop that names the failed adapter with no model override would be
      // the identical call again; skip it. A hop with a model is a different
      // call even on the same adapter — that is the k3 → glm-5.3 case.
      if (hop.adapter === failedAdapter && !hop.model) continue;
      logger.info(
        { failedAdapter, hopAdapter: hop.adapter, hopModel: hop.model ?? null },
        "[dispatch-llm] falling back via chain",
      );
      try {
        // Deliberately no meter, matching the single-hop path below: a
        // fallback reply is not the billable call the caller asked for.
        return await dispatchLLM(input, undefined, {
          adapter: hop.adapter,
          model: hop.model,
          disableFallback: true,
        });
      } catch (hopErr) {
        const hopReason = hopErr instanceof Error ? hopErr.message : String(hopErr);
        errors.push(`${hop.adapter}${hop.model ? `:${hop.model}` : ""}: ${hopReason}`);
      }
    }
    throw new Error(
      `All fallback-chain hops failed. Refusing to answer with placeholder text. Attempts — ${errors.join(" | ")}`,
    );
  }

  const fallback = (process.env.AGENTDASH_FALLBACK_ADAPTER ?? "").trim();

  if (!fallback) {
    throw new Error(
      `Adapter "${failedAdapter}" failed (${reason}) and no AGENTDASH_FALLBACK_ADAPTER ` +
        "is configured. Refusing to answer with placeholder text.",
    );
  }
  if (fallback === failedAdapter) {
    throw new Error(
      `Adapter "${failedAdapter}" failed (${reason}) and AGENTDASH_FALLBACK_ADAPTER ` +
        "names that same adapter, so there is nothing to fall back to. " +
        "Refusing to answer with placeholder text.",
    );
  }

  logger.info({ failedAdapter, fallback }, "[dispatch-llm] falling back");
  // Deliberately no meter: a fallback reply is not the billable call the caller
  // asked for, and double-metering one answer would overstate usage.
  return dispatchLLM(input, undefined, { adapter: fallback });
}

export async function dispatchLLM(
  input: LLMInput,
  meter?: DispatchMeter,
  options?: DispatchOptions,
): Promise<string> {
  // Default is `minimax`, not `claude_api`. Anthropic's consumer terms make a
  // subscription login individual-use only, and the Agent SDK docs are explicit
  // that products must authenticate with a Console API key rather than a
  // claude.ai login — so "Claude by default" quietly pushed every unconfigured
  // deployment toward either a key nobody had budgeted or a seat nobody should
  // have been sharing. `claude_api` remains fully supported; it is now a choice.
  // `|| "minimax"` rather than `?? "minimax"`: an env var set to the empty
  // string is an unconfigured deployment, not a request for a nameless adapter.
  const adapter =
    (options?.adapter ?? process.env.AGENTDASH_DEFAULT_ADAPTER ?? "").trim() || "minimax";

  // AgentDash (Phase G): E2E deterministic stub — bypass ALL real LLM calls
  // when PAPERCLIP_E2E_SKIP_LLM=true. The deep-interview engine and CoS
  // replier both route through this function, so one gate covers both paths.
  if (process.env.PAPERCLIP_E2E_SKIP_LLM === "true") {
    const idx = _e2eCallCount++;
    const stubReply = e2eStubResponse(idx);
    logger.info({ idx, adapter }, "[dispatch-llm] E2E stub — returning canned response");
    return stubReply;
  }

  // AgentDash (Phase G): emit token-budget instrumentation line.
  emitTokenBudget(adapter, input);

  if (adapter === "claude_api") {
    return anthropicLLM(input);
  }

  if (adapter === "minimax") {
    // MiniMax via its Anthropic-compatible Messages API (see minimax-llm.ts).
    logger.info({ adapter }, "[dispatch-llm] routing CoS reply through minimax");
    try {
      const reply = await minimaxLLM(input);
      if (!reply) {
        logger.warn({ adapter }, "[dispatch-llm] minimax returned empty reply, using fallback");
        return runFallbackAdapter(input, adapter, "empty reply", options);
      }
      return reply;
    } catch (err) {
      logger.error({ err, adapter }, "[dispatch-llm] minimax failed, falling back");
      return runFallbackAdapter(input, adapter, err, options);
    }
  }

  if (adapter === "openai_compat") {
    // Any OpenAI-compatible provider (OpenRouter, Fireworks, Together, Groq…).
    logger.info({ adapter }, "[dispatch-llm] routing CoS reply through openai_compat");
    try {
      const { text, usage } = await openaiCompatLLMDetailed(input);
      // Meter usage for the Cloud SKU (best-effort; never blocks the reply).
      if (meter && usage) {
        await recordOpenAICompatUsage(meter, usage);
      }
      if (!text) {
        logger.warn(
          { adapter },
          "[dispatch-llm] openai_compat returned empty reply, using fallback",
        );
        return runFallbackAdapter(input, adapter, "empty reply", options);
      }
      return text;
    } catch (err) {
      logger.error(
        { err, adapter },
        "[dispatch-llm] openai_compat failed, falling back",
      );
      return runFallbackAdapter(input, adapter, err, options);
    }
  }

  if (adapter === "hermes_local") {
    const hermesCmd =
      (process.env.AGENTDASH_HERMES_COMMAND ?? "").trim() || DEFAULT_HERMES_COMMAND;
    const prompt = buildFlatPrompt(input);
    logger.info({ adapter, hermesCmd }, "[dispatch-llm] routing CoS reply through hermes_local");
    try {
      // Answering a question needs no tools.
      //
      // Hermes ships `terminal`, `file`, `code_execution`, `browser` and
      // `computer_use` enabled by default. The prompt handed to it here contains
      // other agents' output — content this system wraps in
      // `<untrusted-agent-answer>` precisely because it may be adversarial. Full
      // tool access over untrusted text is arbitrary code execution on the
      // AgentDash host, one prompt injection away.
      //
      // `-t` is an allowlist of toolsets to ENABLE, so this grants a single
      // harmless one and nothing else; verified by asking a restricted Hermes to
      // run `id -un`, which answers that it cannot. `--ignore-rules` additionally
      // stops AGENTS.md, memory and preloaded skills being injected into a
      // context built from untrusted input.
      //
      // Deliberately NOT `--safe-mode`: it implies `--ignore-user-config`, which
      // would discard ~/.hermes/config.yaml and with it the provider settings
      // that make inference work at all.
      const toolsets =
        (process.env.AGENTDASH_HERMES_TOOLSETS ?? "").trim() || DEFAULT_HERMES_TOOLSETS;
      const hermesArgs = ["chat", "-q", prompt, "-Q", "-t", toolsets, "--ignore-rules"];
      // Fallback-chain hops carry a model so "hermes with k3" and "hermes
      // with glm" are distinct hops; without one, Hermes uses its own
      // configured default.
      const hermesModel = (options?.model ?? "").trim();
      if (hermesModel) hermesArgs.push("-m", hermesModel);
      const reply = stripHermesChatter(await spawnWithTimeout(hermesCmd, hermesArgs));
      if (!reply) {
        logger.warn({ adapter }, "[dispatch-llm] hermes_local returned empty reply, using fallback");
        return runFallbackAdapter(input, adapter, "empty reply", options);
      }
      return reply;
    } catch (err) {
      logger.error({ err, adapter }, "[dispatch-llm] hermes_local failed, falling back");
      return runFallbackAdapter(input, adapter, err, options);
    }
  }

  if (adapter === "codex_local") {
    const codexCmd = (process.env.AGENTDASH_CODEX_COMMAND ?? "").trim() || DEFAULT_CODEX_COMMAND;
    const model =
      (options?.model ?? "").trim() ||
      (process.env.AGENTDASH_CODEX_CHAT_MODEL ?? "").trim() ||
      DEFAULT_CODEX_CHAT_MODEL;
    const prompt = buildFlatPrompt(input);
    logger.info({ adapter, codexCmd, model }, "[dispatch-llm] routing CoS reply through codex_local");
    try {
      // Answering a question needs no tools, and this prompt carries other
      // agents' output — content this system wraps in
      // `<untrusted-agent-answer>` precisely because it may be adversarial.
      // `--sandbox read-only` is the same reasoning the hermes branch above
      // spells out: full tool access over untrusted text is arbitrary code
      // execution on the AgentDash host, one prompt injection away. Codex's own
      // agent runs pass `--dangerously-bypass-approvals-and-sandbox`; a chat
      // reply must not.
      const raw = await spawnWithTimeout(codexCmd, [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        model,
        prompt,
      ]);
      const parsed = parseCodexJsonl(raw);
      const reply = (parsed.summary ?? "").trim();
      if (!reply) {
        logger.warn(
          { adapter, error: parsed.errorMessage },
          "[dispatch-llm] codex_local returned no final message, using fallback",
        );
        return runFallbackAdapter(input, adapter, parsed.errorMessage ?? "empty reply", options);
      }
      return reply;
    } catch (err) {
      logger.error({ err, adapter }, "[dispatch-llm] codex_local failed, falling back");
      return runFallbackAdapter(input, adapter, err, options);
    }
  }

  if (adapter === "claude_local") {
    const prompt = buildFlatPrompt(input);
    logger.info({ adapter }, "[dispatch-llm] routing CoS reply through claude_local");
    try {
      const reply = await spawnWithTimeout("claude", ["--print", "-"], prompt);
      if (!reply) {
        logger.warn({ adapter }, "[dispatch-llm] claude_local returned empty reply, using fallback");
        return runFallbackAdapter(input, adapter, "empty reply", options);
      }
      return reply;
    } catch (err) {
      logger.error({ err, adapter }, "[dispatch-llm] claude_local failed, falling back");
      return runFallbackAdapter(input, adapter, err, options);
    }
  }

  logger.warn(
    { adapter },
    "[dispatch-llm] adapter not yet supported for CoS chat",
  );
  throw new HttpError(
    501,
    `Adapter "${adapter}" is not supported for CoS chat dispatch. Configure AGENTDASH_DEFAULT_ADAPTER to one of: ${SUPPORTED_COS_CHAT_ADAPTERS.join(", ")}.`,
    { adapter, supportedAdapters: SUPPORTED_COS_CHAT_ADAPTERS },
    "unsupported_cos_chat_adapter",
  );
}
