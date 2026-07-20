// AgentDash: real Hermes-agent decision runner for the Agent Trust Handshake demo.
//
// Extracted from the manual driver (server/scripts/handshake-demo-agentdriven.mts)
// into a reusable, injectable service. `runDecision` provisions the agent's
// per-agent Hermes profile, writes its role AGENTS.md into a fresh temp cwd,
// invokes the REAL hermes_local adapter `execute()` (which spawns `hermes chat`),
// and extracts the agent's verbatim decision line + a trimmed reasoning excerpt.
//
// The underlying `execute` fn is injectable (default: hermes-paperclip-adapter/
// server) so the decision-extraction logic is unit-testable WITHOUT spawning a
// real Hermes.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { ensureAgentProfileCommand } from "./hermes-profile.js";

/** One decision the demo asks a real agent to make. */
export interface HandshakeAgentDecisionInput {
  agentId: string;
  name: string;
  companyId: string;
  role: string;
  /** Role AGENTS.md written into the run cwd so the agent reasons in-character. */
  agentsMd: string;
  /** The prompt (adapterConfig.promptTemplate) the agent must answer with one line. */
  task: string;
}

export interface HandshakeAgentDecision {
  /** The verbatim decision line the agent emitted (e.g. "APPROVE: within cap"). */
  decision: string;
  /** true when the line begins APPROVE or ACCEPT. */
  approved: boolean;
  /** A trimmed, human-readable excerpt of the agent's reasoning. */
  reasoning: string;
  /** The fuller cleaned transcript (for a drill-down "what actually happened" view). */
  fullReasoning: string;
  /** The full concatenated adapter log output (for evidence/debugging). */
  raw: string;
}

/** The adapter execute seam — matches hermes-paperclip-adapter/server's `execute`. */
export type HandshakeExecuteFn = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

export interface HandshakeAgentRunnerDeps {
  /** Real adapter invocation. Default lazily imports hermes-paperclip-adapter/server. */
  execute?: HandshakeExecuteFn;
  /** Resolve/provision the agent's per-agent hermes profile command. */
  ensureCommand?: (agentId: string) => Promise<string | undefined>;
  /** Fallback command when profile provisioning fails. */
  defaultHermesCommand?: string;
  /** Make a fresh temp cwd for the run (returns its path). */
  mkdtemp?: (prefix: string) => string;
  /** Write the role AGENTS.md into the run cwd. */
  writeFile?: (path: string, content: string) => void;
}

// Lazily import the real adapter so callers that inject `execute` (tests, the
// flag-off product path) never load the spawn-capable module.
let cachedExecute: HandshakeExecuteFn | undefined;
async function defaultExecute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  if (!cachedExecute) {
    const mod = await import("hermes-paperclip-adapter/server");
    cachedExecute = mod.execute as HandshakeExecuteFn;
  }
  return cachedExecute(ctx);
}

/** Extract the one decision line (APPROVE/DECLINE/ACCEPT/REJECT) from adapter output. */
export function extractDecision(raw: string): { decision: string; approved: boolean } {
  const m = raw.match(/^\s*(APPROVE|DECLINE|ACCEPT|REJECT)\b.*$/im);
  const decision = m ? m[0].trim() : "(no explicit decision line)";
  const approved = /^(APPROVE|ACCEPT)\b/i.test(decision);
  return { decision, approved };
}

/**
 * A clean, display-friendly excerpt of the agent's reasoning. The raw hermes
 * output is terminal-formatted (box-drawing frame, ANSI codes, CRs) and often
 * prints the reasoning twice (boxed, then inline) — strip the decoration and
 * de-duplicate so the demo shows readable prose.
 */
export function extractReasoning(raw: string, maxLen = 600): string {
  const idx = raw.indexOf("Reasoning");
  let chunk = (idx >= 0 ? raw.slice(idx) : raw)
    .replace(/\[hermes\][^\n]*\n?/g, "")       // hermes log lines
    .replace(/session_id:[\s\S]*$/m, "")        // trailing session id + anything after
    .replace(/\[[0-9;]*m/g, "")           // ANSI color codes
    .replace(/[\u2500-\u257f]/g, "")            // box-drawing characters
    .replace(/^Reasoning\s*/i, "")              // the "Reasoning" header word
    .replace(/\r/g, "")                          // carriage returns
    .replace(/[ \t]{2,}/g, " ")                 // collapse runs of spaces
    .replace(/\n{2,}/g, "\n")                   // collapse blank lines
    .trim();
  // Hermes echoes the reasoning twice — cut at the start of the repeat.
  const probe = chunk.slice(0, 48).trim();
  if (probe.length > 20) {
    const repeat = chunk.indexOf(probe, 48);
    if (repeat > 0) chunk = chunk.slice(0, repeat).trim();
  }
  return chunk.slice(0, maxLen).trim();
}

export function handshakeAgentRunner(deps: HandshakeAgentRunnerDeps = {}) {
  const execute = deps.execute ?? defaultExecute;
  const ensureCommand = deps.ensureCommand ?? ((agentId: string) => ensureAgentProfileCommand(agentId));
  const defaultHermesCommand =
    deps.defaultHermesCommand ?? process.env.AGENTDASH_HERMES_COMMAND ?? "hermes";
  const mkdtemp = deps.mkdtemp ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)));
  const writeFile = deps.writeFile ?? ((path: string, content: string) => writeFileSync(path, content));

  async function runDecision(input: HandshakeAgentDecisionInput): Promise<HandshakeAgentDecision> {
    // Resolve the agent's own hermes profile; fall back to the default command
    // if provisioning is unavailable (non-fatal — the adapter still runs).
    const hermesCommand = (await ensureCommand(input.agentId).catch(() => undefined)) ?? defaultHermesCommand;

    const cwd = mkdtemp(`hermes-${input.name.toLowerCase()}-`);
    writeFile(join(cwd, "AGENTS.md"), input.agentsMd);

    const logs: string[] = [];
    await execute({
      runId: `run-${input.agentId}`,
      agent: {
        id: input.agentId,
        name: input.name,
        companyId: input.companyId,
        adapterType: "hermes_local",
        adapterConfig: {
          hermesCommand,
          cwd,
          maxTurnsPerRun: 2,
          promptTemplate: input.task,
          quiet: true,
        },
      },
      config: {},
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      context: {},
      onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
        logs.push(chunk);
      },
      onMeta: async () => {},
    });

    const raw = logs.join("");
    const { decision, approved } = extractDecision(raw);
    return { decision, approved, reasoning: extractReasoning(raw), fullReasoning: extractReasoning(raw, 4000), raw };
  }

  return { runDecision };
}

export type HandshakeAgentRunner = ReturnType<typeof handshakeAgentRunner>;
