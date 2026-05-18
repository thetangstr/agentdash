import { spawn } from "node:child_process";
import fs from "node:fs";
import { anthropicLLM } from "./anthropic-llm.js";
import { logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";

// Default hermes binary path — matches the mini's installation.
// Overridden by AGENTDASH_HERMES_COMMAND env var if set.
const DEFAULT_HERMES_COMMAND = "/Users/maxiaoer/.local/bin/hermes";

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
const SUPPORTED_COS_CHAT_ADAPTERS = ["claude_api", "hermes_local", "claude_local"] as const;

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

function e2eCosGoalsResponse(): string {
  return `Got it. Short-term you want to launch the onboarding product quickly, long-term you want an AI operations team, and the main constraint is limited founder time. I have enough to draft the first team.

\`\`\`json
{
  "captured": {
    "shortTerm": "Launch an AI-assisted onboarding product in 90 days",
    "longTerm": "Build an AI operations team that can run customer onboarding without adding headcount",
    "constraints": {
      "teamSize": "tiny team",
      "founderTime": "under two hours per customer"
    }
  },
  "phase_decision": "advance_to_plan",
  "next_question": "Want me to propose the first agent team?"
}
\`\`\``;
}

function e2eCosPlanResponse(): string {
  return `I recommend a small launch pod: an implementation coordinator to run pilot onboarding, a compliance operator to maintain SOC 2 evidence workflows, and a customer support analyst to turn repeated questions into reusable answers. This keeps founder time low while creating the operating base for the long-term AI team. Want me to set them up, or revise?

\`\`\`json
{
  "phase_decision": "stay_in_plan",
  "plan": {
    "rationale": "A three-agent launch pod fits the 90-day onboarding goal while respecting the limited-founder-time constraint.",
    "agents": [
      {
        "name": "Iris",
        "role": "implementation_coordinator",
        "adapterType": "codex_local",
        "responsibilities": ["Turn pilot needs into onboarding checklists", "Coordinate document requests", "Track founder time per customer"],
        "kpis": ["Pilot customers onboarded", "Founder hours per customer"]
      },
      {
        "name": "Morgan",
        "role": "compliance_operator",
        "adapterType": "codex_local",
        "responsibilities": ["Maintain SOC 2 evidence workflows", "Identify missing customer documents", "Draft reusable compliance responses"],
        "kpis": ["Evidence requests completed", "Checklist reuse rate"]
      },
      {
        "name": "Nia",
        "role": "customer_support_analyst",
        "adapterType": "codex_local",
        "responsibilities": ["Summarize repeated customer questions", "Draft answer templates", "Escalate blockers to the founder"],
        "kpis": ["Repeated questions converted to templates", "Escalation response time"]
      }
    ],
    "alignmentToShortTerm": "Launch the SOC 2 onboarding pilot with repeatable checklists and document workflows.",
    "alignmentToLongTerm": "Create the first reusable operating loops for an AI customer-onboarding team."
  }
}
\`\`\``;
}

function e2eCosRevisionResponse(): string {
  return `Updated based on your feedback: I replaced the support analyst with a pilot onboarding coordinator and made the first milestone onboarding 3 pilot customers. Want me to set them up, or revise again?

\`\`\`json
{
  "plan": {
    "rationale": "The revised team focuses the first milestone on onboarding 3 pilot customers while preserving compliance and implementation coverage.",
    "agents": [
      {
        "name": "Iris",
        "role": "implementation_coordinator",
        "adapterType": "codex_local",
        "responsibilities": ["Turn pilot needs into onboarding checklists", "Coordinate document requests", "Track founder time per customer"],
        "kpis": ["Pilot customers onboarded", "Founder hours per customer"]
      },
      {
        "name": "Morgan",
        "role": "compliance_operator",
        "adapterType": "codex_local",
        "responsibilities": ["Maintain SOC 2 evidence workflows", "Identify missing customer documents", "Draft reusable compliance responses"],
        "kpis": ["Evidence requests completed", "Checklist reuse rate"]
      },
      {
        "name": "Piper",
        "role": "pilot_onboarding_coordinator",
        "adapterType": "codex_local",
        "responsibilities": ["Coordinate the first 3 pilot customers", "Track onboarding blockers", "Prepare weekly pilot status notes"],
        "kpis": ["3 pilot customers onboarded", "Blocked pilot requests resolved"]
      }
    ],
    "alignmentToShortTerm": "Focus the first milestone on onboarding 3 pilot customers with repeatable workflows.",
    "alignmentToLongTerm": "Build the operating loop for a broader AI customer-onboarding team."
  }
}
\`\`\``;
}

function e2eDeepInterviewRound(system: string): number | null {
  if (!system.includes("ask one question") || !system.includes("ambiguity_score")) {
    return null;
  }
  const match = system.match(/\[round\]\s*(\d+)/i);
  if (!match) return null;
  const round = Number.parseInt(match[1]!, 10);
  return Number.isFinite(round) ? round : null;
}

function e2eDeepInterviewResponse(round: number): string {
  if (round <= 0) {
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
  if (round === 1) {
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

function e2eStubResponse(callIndex: number, input: LLMInput): string {
  const system = input.system.toLowerCase();
  const deepInterviewRound = e2eDeepInterviewRound(system);
  if (deepInterviewRound !== null) {
    return e2eDeepInterviewResponse(deepInterviewRound);
  }
  if (system.includes("wants to revise") || system.includes("apply their feedback as a delta")) {
    return e2eCosRevisionResponse();
  }
  if (system.includes('"captured"') && system.includes("phase_decision")) {
    return e2eCosGoalsResponse();
  }
  if (system.includes("agent_plan_proposal_v1") || system.includes('"plan"')) {
    return e2eCosPlanResponse();
  }

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
export async function dispatchLLM(input: LLMInput): Promise<string> {
  const adapter = (process.env.AGENTDASH_DEFAULT_ADAPTER ?? "claude_api").trim();

  // AgentDash (Phase G): E2E deterministic stub — bypass ALL real LLM calls
  // when PAPERCLIP_E2E_SKIP_LLM=true. The deep-interview engine and CoS
  // replier both route through this function, so one gate covers both paths.
  if (process.env.PAPERCLIP_E2E_SKIP_LLM === "true") {
    const idx = _e2eCallCount++;
    const stubReply = e2eStubResponse(idx, input);
    logger.info({ idx, adapter }, "[dispatch-llm] E2E stub — returning canned response");
    return stubReply;
  }

  // AgentDash (Phase G): emit token-budget instrumentation line.
  emitTokenBudget(adapter || "claude_api", input);

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
