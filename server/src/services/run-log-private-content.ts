// AgentDash: keep an agent's lessons out of its run log.
//
// Company members read an agent's run log (the /log route, the live
// `heartbeat.run.log` event, the run's `stdoutExcerpt`, feedback bundles), and
// that stays so. But the learning loop has every agent read and rewrite its
// memory on every task, and its corrections arrive in the wake: the memory
// tool traffic and any echo of the lessons land in stdout. Memory and
// corrections are readable only by the agent, its steward and admins, so the
// log withholds exactly that and nothing else:
//
//   1. Memory tool traffic, by shape. The input and the result of
//      `agentdashGetMyMemory` / `agentdashUpdateMyMemory`, of an `api_request`
//      to the memory route, and of a shell command that calls the memory route
//      (curl), in the JSON lines the CLIs emit:
//        - claude_local (stream-json): an `assistant` line with a `tool_use`
//          block (`name` like `mcp__<server>__agentdashGetMyMemory`, `input`),
//          then a `user` line with a `tool_result` block naming it by
//          `tool_use_id` (and a top-level `tool_use_result` copy);
//        - codex_local (`codex exec --json`): `item.started` /
//          `item.completed` with an `mcp_tool_call` item (`server`, `tool`,
//          `arguments`, `result`) or a `command_execution` item (`command`,
//          `aggregated_output`); also the `tool_use` / `tool_result` item
//          shapes the codex transcript parser accepts.
//   2. Echoes, by content: the agent's memory and its delivered corrections
//      (summaries and lessons), whole and line by line, raw and JSON-escaped
//      once or twice, wherever they appear in a line. A memory the agent
//      writes during the run is added as it is seen.
//
// Both are replaced by the same withheld markers the run records use.
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentCorrections, agentMemory } from "@paperclipai/db";
import { AGENT_CORRECTIONS_WITHHELD_TEXT, AGENT_MEMORY_WITHHELD_TEXT } from "./run-private-content.js";

const MEMORY_TOOL_RE = /(?:^|__|\.|\/)agentdash(?:Get|Update)MyMemory$/;
const MEMORY_ROUTE_RE = /\/agents\/[^/\s"'\\]+\/memory(?:\/history)?(?![\w-])/;
/** A line can only be memory traffic if it mentions one of these. */
const MEMORY_HINT_RE = /MyMemory|\/memory/;
/** Lines longer than this without a newline are passed on unparsed. */
const MAX_BUFFERED_LINE_CHARS = 1_000_000;
const MIN_MEMORY_LINE_CHARS = 16;
const MIN_LESSON_CHARS = 12;

export interface PrivateLogPiece {
  text: string;
  withheld: string;
}

export interface PrivateLogState {
  /** Raw pieces and their escaped forms, longest first. */
  pieces: PrivateLogPiece[];
  /** claude tool_use ids (and codex item ids) that are memory traffic. */
  memoryCallIds: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The text as it can appear in a log: raw, and JSON-escaped once (a CLI's JSON
 * line), twice (a tool result that is itself JSON, inside that line) or three
 * times (that line inside a stored NDJSON log entry).
 */
function escapedForms(text: string): string[] {
  const forms = [text];
  for (let i = 0; i < 3; i += 1) forms.push(JSON.stringify(forms[forms.length - 1]).slice(1, -1));
  return [...new Set(forms)];
}

function memoryLines(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length >= MIN_MEMORY_LINE_CHARS);
  return [trimmed, ...lines];
}

function addPieces(state: PrivateLogState, texts: string[], withheld: string) {
  const known = new Set(state.pieces.map((piece) => piece.text));
  for (const text of texts) {
    for (const form of escapedForms(text)) {
      if (form.length === 0 || known.has(form)) continue;
      known.add(form);
      state.pieces.push({ text: form, withheld });
    }
  }
  state.pieces.sort((a, b) => b.text.length - a.text.length);
}

/** The state for one run: what it must not echo, from its memory and corrections. */
export function createPrivateLogState(input: {
  memoryContents?: Array<string | null | undefined>;
  corrections?: Array<{ summary?: unknown; lessons?: unknown }>;
}): PrivateLogState {
  const state: PrivateLogState = { pieces: [], memoryCallIds: new Set() };
  addMemoryContent(state, ...(input.memoryContents ?? []));
  const correctionTexts: string[] = [];
  for (const correction of input.corrections ?? []) {
    if (typeof correction.summary === "string" && correction.summary.trim()) {
      const summary = correction.summary.trim();
      correctionTexts.push(summary);
      for (const line of summary.split(/\r?\n/)) {
        if (line.trim().length >= MIN_MEMORY_LINE_CHARS) correctionTexts.push(line.trim());
      }
      // What the person wrote is quoted inside the server's sentence; the
      // agent is likelier to repeat the quote than the sentence around it.
      for (const match of summary.matchAll(/"([^"\n]{12,})"/g)) correctionTexts.push(match[1]!.trim());
    }
    if (Array.isArray(correction.lessons)) {
      for (const lesson of correction.lessons) {
        if (typeof lesson === "string" && lesson.trim().length >= MIN_LESSON_CHARS) correctionTexts.push(lesson.trim());
      }
    }
  }
  addPieces(state, correctionTexts, AGENT_CORRECTIONS_WITHHELD_TEXT);
  return state;
}

/** Memory text the log must not echo from here on (e.g. a version written mid-run). */
export function addMemoryContent(state: PrivateLogState, ...contents: Array<string | null | undefined>) {
  const texts = contents.flatMap((content) => (typeof content === "string" ? memoryLines(content) : []));
  if (texts.length > 0) addPieces(state, texts, AGENT_MEMORY_WITHHELD_TEXT);
}

export function hasPrivateLogContent(state: PrivateLogState): boolean {
  return state.pieces.length > 0;
}

function isMemoryToolName(name: unknown): boolean {
  return typeof name === "string" && MEMORY_TOOL_RE.test(name);
}

function mentionsMemoryRoute(value: unknown): boolean {
  if (typeof value === "string") return MEMORY_ROUTE_RE.test(value);
  if (value === null || value === undefined) return false;
  try {
    return MEMORY_ROUTE_RE.test(JSON.stringify(value));
  } catch {
    return false;
  }
}

/** Is this tool call memory traffic: a memory tool, or anything that calls the memory route? */
function isMemoryCall(name: unknown, input: unknown): boolean {
  return isMemoryToolName(name) || mentionsMemoryRoute(input);
}

function rememberWrittenMemory(state: PrivateLogState, input: unknown) {
  const record = isRecord(input) ? input : null;
  if (!record) return;
  if (typeof record.content === "string") addMemoryContent(state, record.content);
  const body = isRecord(record.body) ? record.body : null;
  if (body && typeof body.content === "string") addMemoryContent(state, body.content);
}

const WITHHELD_INPUT = { withheld: AGENT_MEMORY_WITHHELD_TEXT };

/** claude_local stream-json: tool_use in assistant lines, tool_result in user lines. */
function withholdClaudeLine(obj: Record<string, unknown>, state: PrivateLogState): boolean {
  const message = isRecord(obj.message) ? obj.message : null;
  const content = message && Array.isArray(message.content) ? message.content : null;
  if (!content) return false;
  let changed = false;
  let resultWithheld = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_use" && isMemoryCall(block.name, block.input)) {
      if (typeof block.id === "string") state.memoryCallIds.add(block.id);
      rememberWrittenMemory(state, block.input);
      block.input = WITHHELD_INPUT;
      changed = true;
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string" && state.memoryCallIds.has(block.tool_use_id)) {
      block.content = AGENT_MEMORY_WITHHELD_TEXT;
      changed = true;
      resultWithheld = true;
    }
  }
  if (resultWithheld && "tool_use_result" in obj) obj.tool_use_result = AGENT_MEMORY_WITHHELD_TEXT;
  return changed;
}

/** codex_local `exec --json`: item events. */
function withholdCodexLine(obj: Record<string, unknown>, state: PrivateLogState): boolean {
  if (typeof obj.type !== "string" || !obj.type.startsWith("item.")) return false;
  const item = isRecord(obj.item) ? obj.item : null;
  if (!item) return false;
  const id = typeof item.id === "string" ? item.id : null;
  const known = id !== null && state.memoryCallIds.has(id);
  if (item.type === "mcp_tool_call" && (known || isMemoryCall(item.tool, item.arguments))) {
    if (id) state.memoryCallIds.add(id);
    rememberWrittenMemory(state, item.arguments);
    if ("arguments" in item) item.arguments = WITHHELD_INPUT;
    if (item.result !== null && item.result !== undefined) {
      item.result = { content: [{ type: "text", text: AGENT_MEMORY_WITHHELD_TEXT }] };
    }
    return true;
  }
  if (item.type === "command_execution" && (known || mentionsMemoryRoute(item.command))) {
    if (id) state.memoryCallIds.add(id);
    item.command = AGENT_MEMORY_WITHHELD_TEXT;
    if (typeof item.aggregated_output === "string") item.aggregated_output = AGENT_MEMORY_WITHHELD_TEXT;
    return true;
  }
  if (item.type === "tool_use" && (known || isMemoryCall(item.name, item.input))) {
    if (id) state.memoryCallIds.add(id);
    rememberWrittenMemory(state, item.input);
    if ("input" in item) item.input = WITHHELD_INPUT;
    for (const key of ["content", "output", "result"]) {
      if (key in item && item[key] !== null) item[key] = AGENT_MEMORY_WITHHELD_TEXT;
    }
    return true;
  }
  if (item.type === "tool_result" && typeof item.tool_use_id === "string" && state.memoryCallIds.has(item.tool_use_id)) {
    for (const key of ["content", "output", "result"]) {
      if (key in item && item[key] !== null) item[key] = AGENT_MEMORY_WITHHELD_TEXT;
    }
    return true;
  }
  return false;
}

function withholdPieces(text: string, state: PrivateLogState): string {
  let out = text;
  for (const piece of state.pieces) {
    if (out.includes(piece.text)) out = out.split(piece.text).join(piece.withheld);
  }
  return out;
}

/** One log line (no newline): memory traffic by shape, then echoes by content. */
export function withholdPrivateContentFromLogLine(line: string, state: PrivateLogState): string {
  let out = line;
  const trimmed = line.trimStart();
  const mayBeTraffic =
    MEMORY_HINT_RE.test(line) || (state.memoryCallIds.size > 0 && [...state.memoryCallIds].some((id) => line.includes(id)));
  if (mayBeTraffic && trimmed.startsWith("{")) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed) && (withholdClaudeLine(parsed, state) || withholdCodexLine(parsed, state))) {
      out = `${line.slice(0, line.length - trimmed.length)}${JSON.stringify(parsed)}`;
    }
  }
  return state.pieces.length > 0 ? withholdPieces(out, state) : out;
}

/** A block of text, line by line (the last line may be partial). */
export function withholdPrivateContentFromLogText(text: string, state: PrivateLogState): string {
  if (!text) return text;
  return text
    .split("\n")
    .map((line) => {
      const crlf = line.endsWith("\r");
      const body = crlf ? line.slice(0, -1) : line;
      return `${withholdPrivateContentFromLogLine(body, state)}${crlf ? "\r" : ""}`;
    })
    .join("\n");
}

/** Every string in a value (a run's resultJson), line by line. Returns a new value. */
export function withholdPrivateContentFromValue<T>(value: T, state: PrivateLogState, depth = 0): T {
  if (typeof value === "string") return withholdPrivateContentFromLogText(value, state) as T;
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => withholdPrivateContentFromValue(entry, state, depth + 1)) as T;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    next[key] = withholdPrivateContentFromValue(entry, state, depth + 1);
  }
  return next as T;
}

/**
 * The streaming form, for one stream of a live run: whole lines only, so a
 * JSON line split across chunks is still recognised. A line that grows past
 * {@link MAX_BUFFERED_LINE_CHARS} without a newline is passed on with the
 * content pass only.
 */
export function createPrivateLogStripper(state: PrivateLogState) {
  let pending = "";
  return {
    push(chunk: string): string {
      pending += chunk;
      const lastNewline = pending.lastIndexOf("\n");
      if (lastNewline < 0) {
        if (pending.length <= MAX_BUFFERED_LINE_CHARS) return "";
        const out = withholdPieces(pending, state);
        pending = "";
        return out;
      }
      const complete = pending.slice(0, lastNewline + 1);
      pending = pending.slice(lastNewline + 1);
      return withholdPrivateContentFromLogText(complete, state);
    },
    flush(): string {
      const rest = pending;
      pending = "";
      return rest ? withholdPrivateContentFromLogText(rest, state) : "";
    },
  };
}

/**
 * A stored run log page (NDJSON of `{ ts, stream, chunk }`), for logs written
 * before the live stripper existed. Each entry's chunk gets the line pass;
 * call ids carry across entries of the page. A line that is not an entry
 * (a page boundary cut it) gets the content pass only.
 */
export function withholdPrivateContentFromRunLogNdjson(content: string, state: PrivateLogState): string {
  if (!content) return content;
  return content
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return withholdPieces(line, state);
      }
      if (!isRecord(entry) || typeof entry.chunk !== "string") return withholdPieces(line, state);
      const chunk = withholdPrivateContentFromLogText(entry.chunk, state);
      return chunk === entry.chunk ? line : JSON.stringify({ ...entry, chunk });
    })
    .join("\n");
}

/**
 * The state for reading a stored log or excerpt of this agent's runs, from
 * every recent memory version and correction it has had: a stored log does not
 * say which version its run saw.
 */
export async function loadAgentPrivateLogState(db: Pick<Db, "select">, agentId: string): Promise<PrivateLogState> {
  const [memories, corrections] = await Promise.all([
    db
      .select({ content: agentMemory.content })
      .from(agentMemory)
      .where(eq(agentMemory.agentId, agentId))
      .orderBy(desc(agentMemory.version))
      .limit(50),
    db
      .select({ summary: agentCorrections.summary, details: agentCorrections.details })
      .from(agentCorrections)
      .where(eq(agentCorrections.agentId, agentId))
      .orderBy(desc(agentCorrections.createdAt))
      .limit(200),
  ]);
  return createPrivateLogState({
    memoryContents: memories.map((row) => row.content),
    corrections: corrections.map((row) => ({
      summary: row.summary,
      lessons: isRecord(row.details) ? row.details.lessons : undefined,
    })),
  });
}
