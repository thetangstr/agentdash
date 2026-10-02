// AgentDash: "Readable" run transcript presentation, modelled on how Claude Code
// shows a session. Pure helpers shared by RunTranscriptView (agent run detail)
// and the issue chat run blocks (issue thread, LiveRunWidget, ActiveAgentsPanel)
// so a run reads the same everywhere:
//   - assistant text is prominent markdown, streaming deltas merged;
//   - each tool call is one line: a verb plus the key argument;
//   - consecutive tool calls with no assistant text between them fold together;
//   - thinking / init / system / stderr / unparsed stdout sit behind one
//     "Details" disclosure, except anything that looks like an error;
//   - the result entry becomes a compact footer.
import type { TranscriptEntry } from "../adapters";
import { shouldHideNiceModeStderr, summarizeToolResult } from "./transcriptPresentation";

// ---------------------------------------------------------------------------
// Tool-call one-line summaries
// ---------------------------------------------------------------------------

export interface ToolCallSummary {
  /** Leading verb, e.g. "Read", "Ran", "MCP: create_issue". */
  verb: string;
  /** The key argument (path, command, pattern, url...), already shortened. */
  target: string | null;
  /** `verb target` as plain text, for titles and tests. */
  label: string;
  /** True for shell-style tools whose target is a command line. */
  isCommand: boolean;
}

const TARGET_MAX = 96;

const SHELL_NAMES = new Set(["bash", "zsh", "sh", "/bin/bash", "/bin/zsh", "/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeToolKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Strip `bash -lc '...'`, `/bin/zsh -c "..."` and `cmd /c ...` wrappers. */
export function stripShellWrapper(command: string): string {
  let current = compactWhitespace(command);
  for (let i = 0; i < 2; i += 1) {
    const wrapped = current.match(
      /^(?:(?:\/usr)?\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/i,
    ) ?? current.match(/^cmd(?:\.exe)?(?:\s+\/[ds])*\s+\/c\s+([\s\S]+)$/i)
      ?? current.match(/^(?:pwsh|powershell)(?:\.exe)?(?:\s+-\w+)*\s+-c(?:ommand)?\s+([\s\S]+)$/i);
    if (!wrapped) break;
    current = wrapped[1].trim();
    const quoted = current.match(/^(['"])([\s\S]*)\1$/);
    if (quoted) current = quoted[2].trim();
  }
  return compactWhitespace(current);
}

function commandFromValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return stripShellWrapper(value);
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === "string");
    if (parts.length === 0) return null;
    // Codex shell tool: ["bash", "-lc", "<script>"]
    if (parts.length >= 3 && SHELL_NAMES.has(parts[0]) && /^-l?c$/.test(parts[1])) {
      return stripShellWrapper(parts.slice(2).join(" "));
    }
    return stripShellWrapper(parts.join(" "));
  }
  return null;
}

function unwrapInput(input: unknown): unknown {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return input;
      }
    }
    return input;
  }
  // Issue chat wraps non-object tool inputs as { value: ... }.
  const record = asRecord(input);
  if (record && Object.keys(record).length === 1 && "value" in record) {
    return record.value;
  }
  return input;
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return compactWhitespace(value);
  }
  return null;
}

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath", "target_file", "targetFile", "filename", "file"];
const GENERIC_KEYS = [
  ...PATH_KEYS,
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
  "skill",
  "name",
  "title",
  "issueId",
  "issue_id",
  "id",
  "target",
];

function patchFiles(text: string): string[] {
  const files: string[] = [];
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
    const file = match[1]?.trim();
    if (file && !files.includes(file)) files.push(file);
  }
  if (files.length === 0) {
    for (const match of text.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) {
      const file = match[1]?.trim();
      if (file && file !== "/dev/null" && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

function patchTarget(input: unknown): string | null {
  const record = asRecord(input);
  let text: string | null = typeof input === "string" ? input : null;
  for (const key of ["input", "patch", "diff", "content"]) {
    if (text) break;
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) text = value;
  }
  let files = text ? patchFiles(text) : [];
  if (files.length === 0 && record) {
    const changes = asRecord(record.changes);
    if (changes) files = Object.keys(changes);
    else if (Array.isArray(record.changes)) {
      files = record.changes
        .map((change) => firstString(asRecord(change), PATH_KEYS))
        .filter((file): file is string => Boolean(file));
    }
  }
  if (files.length === 0) return firstString(record, PATH_KEYS);
  if (files.length === 1) return files[0];
  return `${files[0]} +${files.length - 1} more`;
}

function countItems(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

type VerbRule = {
  keys: string[];
  verb: string;
  target: (input: unknown, record: Record<string, unknown> | null) => string | null;
  isCommand?: boolean;
};

const pathTarget: VerbRule["target"] = (input, record) =>
  typeof input === "string" ? compactWhitespace(input) : firstString(record, PATH_KEYS);

const commandTarget: VerbRule["target"] = (input, record) =>
  commandFromValue(input) ?? commandFromValue(record?.command) ?? commandFromValue(record?.cmd) ?? commandFromValue(record?.script);

const VERB_RULES: VerbRule[] = [
  { keys: ["read", "readfile", "view", "viewfile", "cat", "openfile"], verb: "Read", target: pathTarget },
  {
    keys: ["edit", "multiedit", "editfile", "strreplace", "strreplaceeditor", "strreplacebasededittool", "notebookedit", "searchreplace"],
    verb: "Edit",
    target: pathTarget,
  },
  { keys: ["write", "writefile", "createfile", "newfile"], verb: "Write", target: pathTarget },
  { keys: ["applypatch", "patch", "filechange"], verb: "Patched", target: (input) => patchTarget(input) },
  {
    keys: ["bash", "shell", "zsh", "commandexecution", "execcommand", "localshell", "shelltoolcall", "runterminalcmd", "runcommand", "terminal", "exec", "powershell"],
    verb: "Ran",
    target: commandTarget,
    isCommand: true,
  },
  {
    keys: ["grep", "rg", "ripgrep", "search", "searchfiles", "grepsearch", "codebasesearch", "searchcode"],
    verb: "Searched",
    target: (input, record) =>
      typeof input === "string" ? compactWhitespace(input) : firstString(record, ["pattern", "query", "regex", "q"]),
  },
  {
    keys: ["glob", "findfiles", "filesearch", "find"],
    verb: "Found files",
    target: (input, record) =>
      typeof input === "string" ? compactWhitespace(input) : firstString(record, ["pattern", "glob", "query", "name"]),
  },
  { keys: ["ls", "listdir", "listdirectory", "listfiles"], verb: "Listed", target: pathTarget },
  {
    keys: ["webfetch", "fetch", "fetchurl", "browse", "openurl"],
    verb: "Fetched",
    target: (input, record) => (typeof input === "string" ? compactWhitespace(input) : firstString(record, ["url", "uri", "href"])),
  },
  {
    keys: ["websearch", "searchweb", "googlesearch"],
    verb: "Searched web",
    target: (input, record) => (typeof input === "string" ? compactWhitespace(input) : firstString(record, ["query", "q", "search"])),
  },
  {
    keys: ["task", "agent", "dispatchagent", "spawnagent", "subagent"],
    verb: "Delegated",
    target: (input, record) =>
      typeof input === "string" ? compactWhitespace(input) : firstString(record, ["description", "subagent_type", "prompt"]),
  },
  {
    keys: ["todowrite", "todoread", "updateplan", "updatetodos", "todo"],
    verb: "Updated plan",
    target: (_input, record) => {
      const count = countItems(record, ["todos", "plan", "items"]);
      return count === null ? null : `${count} item${count === 1 ? "" : "s"}`;
    },
  },
  { keys: ["skill"], verb: "Skill", target: (input, record) => (typeof input === "string" ? input : firstString(record, ["skill", "name", "command"])) },
  { keys: ["bashoutput", "readshelloutput"], verb: "Checked shell output", target: () => null },
  { keys: ["killshell", "killbash"], verb: "Stopped shell", target: () => null },
];

const VERB_BY_KEY = new Map<string, VerbRule>();
for (const rule of VERB_RULES) {
  for (const key of rule.keys) VERB_BY_KEY.set(key, rule);
}

function finalize(verb: string, target: string | null, isCommand: boolean): ToolCallSummary {
  const shortTarget = target ? truncate(compactWhitespace(target), TARGET_MAX) : null;
  return {
    verb,
    target: shortTarget,
    label: shortTarget ? `${verb} ${shortTarget}` : verb,
    isCommand,
  };
}

/**
 * One-line summary of a tool call: a verb plus the key argument, derived from
 * the tool name and input. Covers Claude Code tools (Read, Edit, Write, Bash,
 * Grep, Glob, WebFetch, Task, mcp__*), Codex (shell, apply_patch,
 * command_execution) and falls back to the humanized tool name.
 */
export function summarizeToolCall(name: string, rawInput: unknown): ToolCallSummary {
  const toolName = (name || "tool").trim();
  const input = unwrapInput(rawInput);
  const record = asRecord(input);

  if (/^mcp__/i.test(toolName)) {
    const segments = toolName.split("__").filter(Boolean);
    const tool = segments.length >= 3 ? segments.slice(2).join("__") : segments[1] ?? toolName;
    return finalize(`MCP: ${tool}`, firstString(record, GENERIC_KEYS), false);
  }

  const rule = VERB_BY_KEY.get(normalizeToolKey(toolName));
  if (rule) {
    return finalize(rule.verb, rule.target(input, record), rule.isCommand === true);
  }

  // Unknown tool that still carries a shell command.
  const command = commandFromValue(record?.command) ?? commandFromValue(record?.cmd);
  if (command) return finalize("Ran", command, true);

  const target = typeof input === "string" ? compactWhitespace(input) : firstString(record, GENERIC_KEYS);
  return finalize(humanizeLabel(toolName), target || null, false);
}

// ---------------------------------------------------------------------------
// Tool outcome
// ---------------------------------------------------------------------------

export type ReadableToolStatus = "running" | "completed" | "error";

/** Status-line text for a tool result: first meaningful line or a short summary. */
export function summarizeToolOutcome(result: string | undefined, status: ReadableToolStatus): string {
  if (status === "running") return result ? summarizeToolResult(result, false, "compact") : "Running…";
  if (!result || !result.trim()) return status === "error" ? "Failed" : "Done";
  return summarizeToolResult(result, status === "error", "compact");
}

// ---------------------------------------------------------------------------
// Error-looking text (stderr lines that should stay visible)
// ---------------------------------------------------------------------------

export function isErrorLikeText(text: string): boolean {
  const normalized = compactWhitespace(text);
  if (!normalized) return false;
  if (/\b(?:0|no) (?:errors?|failures?)\b/i.test(normalized)) return false;
  if (/^\s*(?:warn(?:ing)?|info|debug|notice)\b[:\]]/i.test(normalized)) return false;
  return /\b(?:error|fatal|exception|traceback|panic(?:ked)?|failed|failure|denied|unauthori[sz]ed|forbidden|segmentation fault)\b/i.test(normalized)
    || /\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|EADDRINUSE)\b/.test(normalized);
}

// ---------------------------------------------------------------------------
// Readable transcript model
// ---------------------------------------------------------------------------

export interface ReadableToolItem {
  key: string;
  ts: string;
  endTs?: string;
  name: string;
  input: unknown;
  summary: ToolCallSummary;
  result?: string;
  status: ReadableToolStatus;
}

export type ReadableDetailKind = "thinking" | "init" | "system" | "stderr" | "stdout";

export interface ReadableDetailLine {
  ts: string;
  kind: ReadableDetailKind;
  text: string;
}

export interface ReadableResultFooter {
  ts: string;
  isError: boolean;
  outcome: string;
  /** Result text, only when it adds something beyond the final assistant message. */
  text: string | null;
  errors: string[];
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export type ReadableBlock =
  | { type: "message"; key: string; role: "assistant" | "user"; ts: string; text: string; streaming: boolean }
  | { type: "tools"; key: string; ts: string; items: ReadableToolItem[] }
  | {
      type: "diff";
      key: string;
      ts: string;
      filePath?: string;
      hunks: Array<{ changeType: Extract<TranscriptEntry, { kind: "diff" }>["changeType"]; text: string }>;
    }
  | { type: "error"; key: string; ts: string; lines: string[] };

export interface ReadableTranscript {
  blocks: ReadableBlock[];
  details: ReadableDetailLine[];
  footer: ReadableResultFooter | null;
}

function joinText(previous: string, next: string): string {
  return previous.endsWith("\n") || next.startsWith("\n") ? `${previous}${next}` : `${previous}\n${next}`;
}

/** Streaming deltas are fragments of one message and concatenate without a separator. */
function appendMessage(previous: string, next: string, delta: boolean): string {
  return delta ? `${previous}${next}` : joinText(previous, next);
}

function parseTime(ts: string | undefined): number | null {
  if (!ts) return null;
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : null;
}

function toolCallId(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  for (const key of ["toolUseId", "tool_use_id", "callId", "call_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function buildReadableTranscript(entries: readonly TranscriptEntry[], streaming = false): ReadableTranscript {
  const blocks: ReadableBlock[] = [];
  const details: ReadableDetailLine[] = [];
  let footer: ReadableResultFooter | null = null;
  const toolsById = new Map<string, ReadableToolItem>();
  let lastAssistantText = "";
  let blockSeq = 0;
  const nextKey = (prefix: string) => `${prefix}-${blockSeq++}`;

  const lastBlock = () => blocks[blocks.length - 1];
  const latestRunning = (predicate: (item: ReadableToolItem) => boolean = () => true) => {
    for (let b = blocks.length - 1; b >= 0; b -= 1) {
      const block = blocks[b];
      if (block.type !== "tools") continue;
      for (let i = block.items.length - 1; i >= 0; i -= 1) {
        const item = block.items[i];
        if (item.status === "running" && predicate(item)) return item;
      }
    }
    return undefined;
  };
  const pushTool = (item: ReadableToolItem) => {
    const previous = lastBlock();
    if (previous?.type === "tools") previous.items.push(item);
    else blocks.push({ type: "tools", key: nextKey("tools"), ts: item.ts, items: [item] });
  };

  const firstTs = entries.length > 0 ? parseTime(entries[0].ts) : null;

  for (const [index, entry] of entries.entries()) {
    switch (entry.kind) {
      case "assistant":
      case "user": {
        const previous = lastBlock();
        const isStreaming = streaming && entry.kind === "assistant" && entry.delta === true;
        if (previous?.type === "message" && previous.role === entry.kind) {
          previous.text = appendMessage(previous.text, entry.text, entry.kind === "assistant" && entry.delta === true);
          previous.ts = entry.ts;
          previous.streaming = previous.streaming || isStreaming;
        } else {
          blocks.push({ type: "message", key: nextKey("msg"), role: entry.kind, ts: entry.ts, text: entry.text, streaming: isStreaming });
        }
        if (entry.kind === "assistant") {
          const current = lastBlock();
          if (current?.type === "message") lastAssistantText = current.text;
        }
        break;
      }
      case "thinking": {
        const previous = details[details.length - 1];
        if (previous?.kind === "thinking" && entry.delta === true) {
          previous.text += entry.text;
          previous.ts = entry.ts;
        } else {
          details.push({ ts: entry.ts, kind: "thinking", text: entry.text });
        }
        break;
      }
      case "tool_call": {
        const id = entry.toolUseId ?? toolCallId(entry.input);
        const item: ReadableToolItem = {
          key: id ? `tool-${id}` : `tool-idx-${index}`,
          ts: entry.ts,
          name: entry.name,
          input: entry.input,
          summary: summarizeToolCall(entry.name, entry.input),
          status: "running",
        };
        if (id) toolsById.set(id, item);
        pushTool(item);
        break;
      }
      case "tool_result": {
        const matched = (entry.toolUseId ? toolsById.get(entry.toolUseId) : undefined) ?? latestRunning();
        if (matched) {
          matched.result = entry.content;
          matched.status = entry.isError ? "error" : "completed";
          matched.endTs = entry.ts;
          if (entry.toolUseId) toolsById.delete(entry.toolUseId);
        } else {
          const name = entry.toolName ?? "tool";
          pushTool({
            key: `tool-result-${entry.toolUseId || index}`,
            ts: entry.ts,
            endTs: entry.ts,
            name,
            input: null,
            summary: summarizeToolCall(name, null),
            result: entry.content,
            status: entry.isError ? "error" : "completed",
          });
        }
        break;
      }
      case "diff": {
        const previous = lastBlock();
        if (previous?.type === "diff") {
          if (entry.changeType === "file_header") previous.filePath = entry.text;
          previous.hunks.push({ changeType: entry.changeType, text: entry.text });
        } else {
          blocks.push({
            type: "diff",
            key: nextKey("diff"),
            ts: entry.ts,
            filePath: entry.changeType === "file_header" ? entry.text : undefined,
            hunks: [{ changeType: entry.changeType, text: entry.text }],
          });
        }
        break;
      }
      case "init":
        details.push({
          ts: entry.ts,
          kind: "init",
          text: `model ${entry.model}${entry.sessionId ? ` • session ${entry.sessionId}` : ""}`,
        });
        break;
      case "system":
        if (compactWhitespace(entry.text).toLowerCase() === "turn started") break;
        details.push({ ts: entry.ts, kind: "system", text: entry.text });
        break;
      case "stderr": {
        if (shouldHideNiceModeStderr(entry.text)) break;
        if (isErrorLikeText(entry.text)) {
          const previous = lastBlock();
          if (previous?.type === "error") previous.lines.push(entry.text);
          else blocks.push({ type: "error", key: nextKey("err"), ts: entry.ts, lines: [entry.text] });
        } else {
          details.push({ ts: entry.ts, kind: "stderr", text: entry.text });
        }
        break;
      }
      case "stdout": {
        // Output streamed while a shell command runs belongs to that command.
        const running = latestRunning((item) => item.summary.isCommand);
        if (running) {
          running.result = running.result ? joinText(running.result, entry.text) : entry.text;
          break;
        }
        const previous = details[details.length - 1];
        if (previous?.kind === "stdout") {
          previous.text = joinText(previous.text, entry.text);
          previous.ts = entry.ts;
        } else {
          details.push({ ts: entry.ts, kind: "stdout", text: entry.text });
        }
        break;
      }
      case "result": {
        const endTs = parseTime(entry.ts);
        const text = entry.text.trim();
        footer = {
          ts: entry.ts,
          isError: entry.isError,
          outcome: entry.isError ? "Failed" : "Completed",
          text: text && compactWhitespace(text) !== compactWhitespace(lastAssistantText) ? text : null,
          errors: entry.errors ?? [],
          durationMs: firstTs !== null && endTs !== null && endTs >= firstTs ? endTs - firstTs : null,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cachedTokens: entry.cachedTokens,
          costUsd: entry.costUsd,
        };
        break;
      }
      default:
        break;
    }
  }

  return { blocks, details, footer };
}

export function formatRunDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Group header for folded consecutive tool calls, e.g. "Ran 6 tools". */
export function toolGroupLabel(items: readonly Pick<ReadableToolItem, "status">[]): string {
  const running = items.some((item) => item.status === "running");
  const count = items.length;
  return `${running ? "Running" : "Ran"} ${count} tool${count === 1 ? "" : "s"}`;
}
