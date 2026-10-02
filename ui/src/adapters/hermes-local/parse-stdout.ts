// AgentDash: Hermes run-log parser.
//
// Wraps the vendored `parseHermesStdoutLine` (hermes-paperclip-adapter/ui) so a
// Hermes run reads as a transcript in the run log. It understands two shapes:
//
// 1. `--format stream-json` (Hermes v2026.9.21+, enabled server-side by
//    server/src/adapters/hermes-stream-json.ts): one JSON event per line —
//    system/init, text deltas, tool_use, tool_result, result. Mapped to
//    init / assistant / tool_call / tool_result / result entries.
// 2. Plain `-Q` text (older Hermes, and every run log written before this
//    change): the final answer, plus whatever live display Hermes printed —
//    a "Reasoning" box, `┊ review diff` previews, approval notices. The answer
//    is merged into one markdown block instead of one entry per line, the
//    reasoning box becomes `thinking`, diff previews become `diff` entries, and
//    box borders / spinner remnants / ANSI codes are dropped.
//
// `┊` tool lines (Hermes' non-quiet output) still go through the vendored
// parser, so old logs keep rendering exactly as they did.
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseHermesStdoutLine as parseVendoredHermesLine } from "hermes-paperclip-adapter/ui";
import type { StatefulStdoutParser } from "../types";

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

const STREAM_JSON_TYPES = new Set(["system", "text", "tool_use", "tool_result", "result"]);

type Mode = "normal" | "reasoning" | "diff";
type LastEmitted = "assistant_text" | "thinking_text" | "other";

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseStreamJsonEvent(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{") || !line.endsWith("}")) return null;
  try {
    const parsed = asRecord(JSON.parse(line));
    if (!parsed || typeof parsed.type !== "string" || !STREAM_JSON_TYPES.has(parsed.type)) return null;
    // Every stream-json event carries a numeric `timestamp`; a bare JSON line
    // in an agent's text answer does not, so it stays text.
    if (typeof parsed.timestamp !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Hermes wraps a tool's output in its own JSON envelope
 * (`{"output": "...", "exit_code": 0, "error": null}`). Show the output itself
 * and treat a non-zero exit or an error as a failed call.
 */
function formatToolOutput(raw: string, isErrorFlag: boolean): { content: string; isError: boolean } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const envelope = asRecord(JSON.parse(trimmed));
      if (envelope && typeof envelope.output === "string") {
        const exitCode = typeof envelope.exit_code === "number" ? envelope.exit_code : 0;
        const error = asString(envelope.error).trim();
        const parts = [envelope.output];
        if (error) parts.push(error);
        if (exitCode !== 0) parts.push(`exit code ${exitCode}`);
        return {
          content: parts.filter((part) => part.length > 0).join("\n"),
          isError: isErrorFlag || exitCode !== 0 || error.length > 0,
        };
      }
    } catch {
      // not an envelope; show as-is
    }
  }
  return { content: raw, isError: isErrorFlag };
}

const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;
const BOX_BORDER_ONLY = /^[─━═┌┐└┘╭╮╰╯│┃\s]+$/;
const REASONING_OPEN = /^[┌╭]─+\s*Reasoning\b/;
const BOX_CLOSE = /^[└╰]─/;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const DIFF_FILE_HEADER = /^a\/.+\s→\s+b\/.+$/;
const DIFF_OMITTED = /^(?:…|\.\.\.)\s*omitted\b/;
const SPINNER_REMNANT = /^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u;
const HARNESS_NOTICE = /^(?:⚠️?|⏱)/u;
const SYSTEM_PREFIX = /^\[(?:hermes|paperclip|agentdash)\]/;
const TIMESTAMPED_LOG = /^\[\d{4}-\d{2}-\d{2}T/;
const SESSION_ID_LINE = /^session_id:\s*\S+$/;
// Hermes prints a diff preview line by line as it happens; the final answer
// comes once the run is done. In a log written before the session_id line was
// moved to stdout, nothing else separates the two, and the log drops the blank
// context lines that the hunk counts include. An unprefixed line that arrives
// this long after the previous diff line is the answer, not diff context.
// Only applies when the hunk is within a few (dropped blank) lines of done, so
// a slow, mid-hunk flush is still read as diff.
const DIFF_CONTEXT_GAP_MS = 1500;
const DIFF_BLANK_LINE_SLACK = 3;

function stripToolPrefix(line: string): string {
  return line.replace(/^\[done\]\s*/, "").replace(/^┊\s*/, "").trim();
}

export function createHermesStdoutParser(): StatefulStdoutParser {
  let mode: Mode = "normal";
  let lastEmitted: LastEmitted = "other";
  let previousTextLine = "";
  let inFence = false;
  let hunkRemaining: { old: number; new: number } | null = null;
  let lastDiffAt = Number.NaN;
  let syntheticToolCounter = 0;
  const pendingToolIds = new Map<string, string[]>();

  const reset = () => {
    mode = "normal";
    lastEmitted = "other";
    previousTextLine = "";
    inFence = false;
    hunkRemaining = null;
    lastDiffAt = Number.NaN;
    syntheticToolCounter = 0;
    pendingToolIds.clear();
  };

  const other = (entries: TranscriptEntry[]): TranscriptEntry[] => {
    if (entries.length > 0) lastEmitted = "other";
    return entries;
  };

  /** One line of the final answer, merged into the running markdown block. */
  const assistantLine = (line: string, ts: string): TranscriptEntry[] => {
    let separator = "";
    if (lastEmitted === "assistant_text") {
      // The run log drops blank lines, so paragraph breaks are restored here;
      // code fences, consecutive list items and table rows stay tight.
      const bothList = LIST_ITEM.test(line) && LIST_ITEM.test(previousTextLine);
      const bothTable = line.startsWith("|") && previousTextLine.startsWith("|");
      separator = inFence || bothList || bothTable ? "\n" : "\n\n";
    }
    if (line.startsWith("```")) inFence = !inFence;
    previousTextLine = line;
    lastEmitted = "assistant_text";
    return [{ kind: "assistant", ts, text: separator + line, delta: true }];
  };

  const thinkingLine = (line: string, ts: string): TranscriptEntry[] => {
    const separator = lastEmitted === "thinking_text" ? "\n" : "";
    lastEmitted = "thinking_text";
    return [{ kind: "thinking", ts, text: separator + line, delta: true }];
  };

  const nextToolId = (name: string, explicit: unknown): string => {
    const id = typeof explicit === "string" && explicit ? explicit : `hermes-tool-${++syntheticToolCounter}`;
    const queue = pendingToolIds.get(name) ?? [];
    queue.push(id);
    pendingToolIds.set(name, queue);
    return id;
  };

  const resolveToolId = (name: string, explicit: unknown): string => {
    const queue = pendingToolIds.get(name) ?? [];
    if (typeof explicit === "string" && explicit) {
      const index = queue.indexOf(explicit);
      if (index >= 0) queue.splice(index, 1);
      return explicit;
    }
    return queue.shift() ?? `hermes-tool-${++syntheticToolCounter}`;
  };

  const streamEvent = (event: Record<string, unknown>, ts: string): TranscriptEntry[] => {
    switch (event.type) {
      case "system": {
        if (event.subtype === "init") {
          return other([{ kind: "init", ts, model: asString(event.model), sessionId: asString(event.session_id) }]);
        }
        const subtype = asString(event.subtype) || "event";
        return other([{ kind: "system", ts, text: `hermes ${subtype}` }]);
      }
      case "text": {
        let text = asString(event.text);
        if (lastEmitted !== "assistant_text") text = text.replace(/^\s*\n/, "");
        if (!text) return [];
        lastEmitted = "assistant_text";
        previousTextLine = "";
        return [{ kind: "assistant", ts, text, delta: true }];
      }
      case "tool_use": {
        const name = asString(event.name) || "tool";
        const input = event.input === undefined ? {} : event.input;
        return other([{ kind: "tool_call", ts, name, input, toolUseId: nextToolId(name, event.tool_call_id) }]);
      }
      case "tool_result": {
        const name = asString(event.name) || "tool";
        const { content, isError } = formatToolOutput(asString(event.output), event.is_error === true);
        return other([
          { kind: "tool_result", ts, toolUseId: resolveToolId(name, event.tool_call_id), toolName: name, content, isError },
        ]);
      }
      case "result": {
        const tokens = asRecord(event.tokens) ?? {};
        const error = asString(event.error).trim();
        const exitCode = typeof event.exit_code === "number" ? event.exit_code : 0;
        const isError = exitCode !== 0 || error.length > 0;
        return other([
          {
            kind: "result",
            ts,
            text: asString(event.text),
            inputTokens: asNumber(tokens.input),
            outputTokens: asNumber(tokens.output),
            cachedTokens: asNumber(tokens.cache_read),
            // Hermes reports tokens, not dollars; cost is metered server-side.
            costUsd: 0,
            subtype: isError ? "error" : "success",
            isError,
            errors: error ? [error] : [],
          },
        ]);
      }
      default:
        return [];
    }
  };

  /** Inside a `┊ review diff` preview. Returns null when the preview has ended. */
  const diffLine = (line: string, ts: string): TranscriptEntry[] | null => {
    const at = Date.parse(ts);
    const previousAt = lastDiffAt;
    lastDiffAt = at;
    if (DIFF_FILE_HEADER.test(line)) {
      hunkRemaining = null;
      return other([{ kind: "diff", ts, changeType: "file_header", text: line }]);
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      hunkRemaining = { old: hunk[1] === undefined ? 1 : Number(hunk[1]), new: hunk[2] === undefined ? 1 : Number(hunk[2]) };
      return other([{ kind: "diff", ts, changeType: "hunk", text: line }]);
    }
    if (DIFF_OMITTED.test(line)) {
      mode = "normal";
      hunkRemaining = null;
      return other([{ kind: "diff", ts, changeType: "truncation", text: line }]);
    }
    if (line.startsWith("\\ No newline")) {
      return other([{ kind: "diff", ts, changeType: "context", text: line }]);
    }
    // Between hunks, anything that is not a header ends the preview: Hermes
    // goes straight on to its next output.
    const endDiff = (): null => {
      mode = "normal";
      hunkRemaining = null;
      return null;
    };
    if (!hunkRemaining) return endDiff();
    const remaining: { old: number; new: number } = hunkRemaining;
    // A "- item" bullet or "+1" in the answer looks like a change line, so the
    // arrival-gap rule applies to every line type once the hunk is nearly done.
    const hunkNearlyDone = remaining.old <= DIFF_BLANK_LINE_SLACK && remaining.new <= DIFF_BLANK_LINE_SLACK;
    const arrivedLater =
      hunkNearlyDone && Number.isFinite(at) && Number.isFinite(previousAt) && at - previousAt > DIFF_CONTEXT_GAP_MS;
    if (arrivedLater) return endDiff();
    // Never read past what the hunk header said is left: a line the remaining
    // counts cannot hold belongs to whatever Hermes printed next.
    let changeType: "add" | "remove" | "context";
    if (line.startsWith("+")) {
      if (remaining.new <= 0) return endDiff();
      changeType = "add";
      remaining.new -= 1;
    } else if (line.startsWith("-")) {
      if (remaining.old <= 0) return endDiff();
      changeType = "remove";
      remaining.old -= 1;
    } else {
      if (remaining.old <= 0 || remaining.new <= 0) return endDiff();
      changeType = "context";
      remaining.old -= 1;
      remaining.new -= 1;
    }
    if (remaining.old <= 0 && remaining.new <= 0) hunkRemaining = null;
    return other([{ kind: "diff", ts, changeType, text: line }]);
  };

  const parseLine = (rawLine: string, ts: string): TranscriptEntry[] => {
    const line = stripAnsi(rawLine).trim();
    if (!line) return [];

    const event = parseStreamJsonEvent(line);
    if (event) {
      mode = "normal";
      return streamEvent(event, ts);
    }

    // Harness bookkeeping. Any of these also ends Hermes' live display.
    if (SYSTEM_PREFIX.test(line) || SESSION_ID_LINE.test(line)) {
      mode = "normal";
      hunkRemaining = null;
      return other([{ kind: "system", ts, text: line }]);
    }
    if (TIMESTAMPED_LOG.test(line)) {
      return other([{ kind: "system", ts, text: line }]);
    }
    if (SPINNER_REMNANT.test(line)) return [];

    if (REASONING_OPEN.test(line)) {
      mode = "reasoning";
      return other([]);
    }
    if (BOX_CLOSE.test(line)) {
      if (mode === "reasoning") mode = "normal";
      return [];
    }
    if (BOX_BORDER_ONLY.test(line)) return [];

    if (line.includes("┊")) {
      mode = "normal";
      hunkRemaining = null;
      const body = stripToolPrefix(line);
      if (/^review diff\b/.test(body)) {
        mode = "diff";
        hunkRemaining = null;
        lastDiffAt = Date.parse(ts);
        lastEmitted = "other";
        return [];
      }
      const vendored = parseVendoredHermesLine(line, ts);
      return other(
        vendored.map((entry) => (entry.kind === "stdout" ? { kind: "system" as const, ts: entry.ts, text: entry.text } : entry)),
      );
    }

    if (HARNESS_NOTICE.test(line)) {
      mode = "normal";
      return other([{ kind: "stderr", ts, text: line }]);
    }

    if (mode === "diff") {
      const entries = diffLine(line, ts);
      if (entries) return entries;
    }
    if (mode === "reasoning") return thinkingLine(line, ts);

    const vendored = parseVendoredHermesLine(line, ts);
    if (vendored.length === 1 && vendored[0]!.kind === "assistant") return assistantLine(line, ts);
    return other(
      vendored.map((entry) => (entry.kind === "stdout" ? { kind: "system" as const, ts: entry.ts, text: entry.text } : entry)),
    );
  };

  return { parseLine, reset };
}

/** Stateless entry point: each call parses one line with a fresh parser. */
export function parseHermesStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return createHermesStdoutParser().parseLine(line, ts);
}
