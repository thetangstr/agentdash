// AgentDash: run Hermes in its structured output mode so run logs read as a
// transcript instead of a wall of text.
//
// With `-Q` alone (the vendored adapter's default) Hermes prints only its final
// answer, so a run log shows no tool calls, no tool results and no usage, and
// the UI parser has to guess at line boundaries in the answer. Hermes
// v2026.9.21+ also offers `--format stream-json`: one JSON event per stdout line
// (`system/init`, `text` deltas, `tool_use`, `tool_result`, one terminal
// `result` with token counts). The UI parser (ui/src/adapters/hermes-local)
// turns those into structured transcript entries.
//
// Older Hermes builds reject the flag ("unrecognized arguments"), and the
// hosted image pins one of those today, so the flag is only added when the
// binary's own `chat --help` lists it. The probe is cached per command.
// Kill switch: AGENTDASH_HERMES_STREAM_JSON=false.
//
// The vendored adapter parses stdout as plain text for the run summary, so in
// stream-json mode that summary would be raw JSONL. The capture below reads
// the stream as it goes by and puts the real answer, session id, usage and
// error back on the execution result.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);

export const HERMES_STREAM_JSON_ARGS = ["--format", "stream-json"] as const;

const PROBE_TIMEOUT_MS = 15_000;
const MAX_CAPTURED_TEXT = 200_000;

type ProbeRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;

/** A probe answer is trusted this long, so an upgrade or downgrade of Hermes is noticed without a restart. */
export const HERMES_STREAM_JSON_PROBE_TTL_MS = 10 * 60 * 1000;

interface ProbeEntry {
  promise: Promise<boolean>;
  /** Set once the probe settled with an answer worth caching. */
  settledAt: number | null;
}

const probeCache = new Map<string, ProbeEntry>();

/** Test hook: forget cached probe results. */
export function resetHermesStreamJsonProbeCache(): void {
  probeCache.clear();
}

/** Forget one command's probe answer, e.g. after Hermes rejected the flag. */
export function invalidateHermesStreamJsonProbe(command: string): void {
  probeCache.delete(command.trim());
}

/**
 * Hermes that predates stream-json fails with argparse's
 * "unrecognized arguments: --format stream-json" (or an invalid-choice error).
 */
export function hermesRejectedStreamJsonFlag(stderr: string): boolean {
  return /unrecognized arguments?:[^\n]*--format|argument --format: invalid choice/i.test(stderr);
}

export function hermesStreamJsonDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AGENTDASH_HERMES_STREAM_JSON?.trim().toLowerCase();
  return raw === "false" || raw === "0" || raw === "off" || raw === "no";
}

/** True when `<command> chat --help` advertises `--format … stream-json`. */
export function hermesHelpAdvertisesStreamJson(helpText: string): boolean {
  return /--format\b[^\n]*stream-json/.test(helpText);
}

/**
 * Whether `<command> chat --help` lists stream-json. Concurrent callers share
 * one in-flight probe; a definite answer is cached for the TTL; a probe that
 * timed out or failed is answered `false` for that run only and retried by the
 * next one, so a slow first start does not pin a command to text output.
 */
export function hermesSupportsStreamJson(
  command: string,
  run?: ProbeRunner,
  now: () => number = Date.now,
): Promise<boolean> {
  const key = command.trim();
  if (!key) return Promise.resolve(false);
  const cached = probeCache.get(key);
  if (cached) {
    if (cached.settledAt === null) return cached.promise;
    if (now() - cached.settledAt < HERMES_STREAM_JSON_PROBE_TTL_MS) return cached.promise;
    probeCache.delete(key);
  }
  const runner: ProbeRunner =
    run ??
    ((cmd, args) =>
      execFileAsync(cmd, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }).then((r) => ({
        stdout: String(r.stdout),
      })));
  const entry: ProbeEntry = { promise: Promise.resolve(false), settledAt: null };
  entry.promise = runner(key, ["chat", "--help"]).then(
    ({ stdout }) => {
      entry.settledAt = now();
      return hermesHelpAdvertisesStreamJson(stdout);
    },
    () => {
      // Timeout, missing binary, crash: not an answer. Do not cache it.
      if (probeCache.get(key) === entry) probeCache.delete(key);
      return false;
    },
  );
  probeCache.set(key, entry);
  return entry.promise;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Whether the agent's own config already chose an output style that
 * stream-json would override: `quiet: false` (verbose text), or an explicit
 * `--format` / `--tui` in its extra args.
 */
export function hermesConfigPinsOutputFormat(adapterConfig: Record<string, unknown>): boolean {
  if (adapterConfig.quiet === false) return true;
  const extraArgs = [...readStringArray(adapterConfig.extraArgs), ...readStringArray(adapterConfig.args)];
  return extraArgs.some((arg) => arg === "--format" || arg.startsWith("--format=") || arg === "--tui");
}

export function withHermesStreamJsonArgs(adapterConfig: Record<string, unknown>): Record<string, unknown> {
  return {
    ...adapterConfig,
    extraArgs: [...readStringArray(adapterConfig.extraArgs), ...HERMES_STREAM_JSON_ARGS],
  };
}

/**
 * Hermes prints `session_id: …` on stderr in both -Q and stream-json mode. It
 * is bookkeeping, not an error; routing it to stdout lets the transcript show
 * it as a system line and gives the UI parser a boundary between Hermes' live
 * display and the final answer that follows.
 */
export function isHermesSessionIdChunk(chunk: string): boolean {
  return /^\s*session_id:\s*\S+\s*$/.test(chunk);
}

/** Stderr chunks that are bookkeeping rather than errors: `session_id:` and blank padding. */
export function isHermesBookkeepingStderr(chunk: string): boolean {
  return chunk.trim().length === 0 || isHermesSessionIdChunk(chunk);
}

interface HermesStreamResultEvent {
  session_id?: unknown;
  exit_code?: unknown;
  text?: unknown;
  tokens?: unknown;
  error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The human-readable text inside one stream event: text deltas, and a tool
 * result's output with Hermes' own JSON envelope unwrapped. The run log holds
 * these JSON-escaped, so anything scanning for phrases (the human-question
 * guard) has to look at this decoded text instead.
 */
function decodedEventText(event: Record<string, unknown>): string {
  if (event.type === "text") return typeof event.text === "string" ? event.text : "";
  if (event.type === "tool_result") {
    const output = typeof event.output === "string" ? event.output : "";
    const trimmed = output.trim();
    if (trimmed.startsWith("{")) {
      try {
        const envelope = asRecord(JSON.parse(trimmed));
        if (envelope) {
          const parts = [envelope.output, envelope.error].filter((part): part is string => typeof part === "string");
          if (parts.length > 0) return `\n${parts.join("\n")}\n`;
        }
      } catch {
        // not an envelope
      }
    }
    return `\n${output}\n`;
  }
  if (event.type === "result") return typeof event.error === "string" ? `\n${event.error}\n` : "";
  return "";
}

/** The stream's own per-run token counts, kept off the result unless the ledger fails. */
export interface HermesStreamUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export function createHermesStreamJsonCapture() {
  let buffer = "";
  let text = "";
  let sawEvent = false;
  let sessionId: string | null = null;
  let resultEvent: HermesStreamResultEvent | null = null;

  /** Returns the decoded text of the event, if the line was one. */
  const consumeLine = (line: string): string => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return "";
    let parsed: Record<string, unknown> | null;
    try {
      parsed = asRecord(JSON.parse(trimmed));
    } catch {
      return "";
    }
    if (!parsed || typeof parsed.type !== "string") return "";
    sawEvent = true;
    if (parsed.type === "system" && parsed.subtype === "init") {
      sessionId = asNonEmptyString(parsed.session_id) ?? sessionId;
    } else if (parsed.type === "text" && typeof parsed.text === "string") {
      if (text.length < MAX_CAPTURED_TEXT) text += parsed.text;
    } else if (parsed.type === "result") {
      resultEvent = parsed;
      sessionId = asNonEmptyString(parsed.session_id) ?? sessionId;
    }
    return decodedEventText(parsed);
  };

  const flush = (): string => {
    if (!buffer.trim()) return "";
    const decoded = consumeLine(buffer);
    buffer = "";
    return decoded;
  };

  return {
    /** Consume a stdout chunk; returns the decoded text of the events it completed. */
    feed(chunk: string): string {
      const lines = (buffer + chunk).split(/\r?\n/);
      buffer = lines.pop() ?? "";
      return lines.map(consumeLine).join("");
    },
    /** Consume a trailing partial line; returns its decoded text. */
    flush,
    /** Whether any stream-json event was seen (a run that rejected the flag sees none). */
    sawStreamEvents(): boolean {
      return sawEvent;
    },
    /**
     * The stream's per-run token counts. Never put on `result.usage` directly:
     * the session ledger reports cumulative totals and heartbeat diffs those
     * across runs, so a per-run number there would under-bill resumed
     * sessions. See applyHermesStreamUsageFallback.
     */
    streamUsage(): HermesStreamUsage | null {
      const tokens = asRecord((resultEvent as HermesStreamResultEvent | null)?.tokens);
      if (!tokens) return null;
      const usage = {
        inputTokens: asNumber(tokens.input),
        outputTokens: asNumber(tokens.output),
        cachedInputTokens: asNumber(tokens.cache_read),
      };
      return usage.inputTokens > 0 || usage.outputTokens > 0 ? usage : null;
    },
    /**
     * Put the stream's answer, session and error on the result. A run that
     * never produced a stream event (old Hermes, or it died before init) is
     * returned untouched. Usage is left to the ledger.
     */
    apply(result: AdapterExecutionResult, options: { persistSession: boolean }): AdapterExecutionResult {
      flush();
      if (!sawEvent) return result;
      const final = resultEvent as HermesStreamResultEvent | null;
      const finalText = (asNonEmptyString(final?.text) ?? text).trim();
      const error = asNonEmptyString(final?.error);
      const exitCode = typeof final?.exit_code === "number" ? final.exit_code : null;

      const patched: AdapterExecutionResult = { ...result };
      if (finalText) {
        patched.summary = finalText.slice(0, 2000);
      } else {
        delete patched.summary;
      }
      // The vendored adapter regex-scans stdout for token counts; over JSONL
      // that is noise. The session ledger is the source of truth.
      delete patched.usage;

      if (sessionId && options.persistSession) {
        patched.sessionParams = { ...(asRecord(result.sessionParams) ?? {}), sessionId };
        patched.sessionDisplayId = sessionId.slice(0, 16);
      }

      if (error && !patched.errorMessage && (exitCode ?? result.exitCode ?? 0) !== 0) {
        patched.errorMessage = error;
      }

      const existingJson = asRecord(result.resultJson) ?? {};
      patched.resultJson = {
        ...existingJson,
        result: finalText,
        session_id: sessionId ?? existingJson.session_id ?? null,
        usage: null,
        output_format: "stream-json",
      };
      return patched;
    },
  };
}

/**
 * After the ledger read: if the ledger produced no usage, fall back to the
 * stream's per-run counts, marked `usageBasis: "per_run"` so heartbeat bills
 * them as this run's own usage instead of diffing them against the session's
 * cumulative baseline (heartbeat.ts resolvePerRunUsage).
 */
export function applyHermesStreamUsageFallback(
  result: AdapterExecutionResult,
  streamUsage: HermesStreamUsage | null,
): AdapterExecutionResult {
  if (result.usage || !streamUsage) return result;
  const resultJson = asRecord(result.resultJson) ?? {};
  return {
    ...result,
    usage: { ...streamUsage },
    resultJson: {
      ...resultJson,
      usage: { ...streamUsage },
      usageBasis: "per_run",
      meteringStatus: "adapter_reported",
      ledgerMeteringStatus: resultJson.meteringStatus ?? null,
    },
  };
}
