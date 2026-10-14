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
//   2. Echoes, by content: the agent's memory and its delivered corrections,
//      whole, and by line, lesson and quote, each only when it has at least
//      four words; raw and JSON-escaped up to three times, wherever they appear in
//      a line. Memory seen during the run is learned as it goes by: what a
//      write sends (tool input, `body.content`, a curl `-d` body) and what a
//      memory read returns (any `{ version, content, authorKind }` row).
//
// Live output is line-buffered per stream (a JSON line split across writes
// is still recognised), so a partial line without a newline reaches the live
// view only when its newline (or the end of the run) arrives.
//
// Both are replaced by the same withheld markers the run records use.
import { inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentCorrections, agentMemory } from "@paperclipai/db";
import { AGENT_CORRECTIONS_WITHHELD_TEXT, AGENT_MEMORY_WITHHELD_TEXT } from "./run-private-content.js";

const MEMORY_TOOL_RE = /(?:^|__|\.|\/)agentdash(?:Get|Update)MyMemory$/;
const MEMORY_ROUTE_RE = /\/agents\/[^/\s"'\\]+\/memory(?:\/history)?(?![\w-])/;
/** A line can only be memory traffic if it mentions one of these. */
const MEMORY_HINT_RE = /MyMemory|\/memory|authorKind/;
/** Lines longer than this without a newline are passed on unparsed. */
const MAX_BUFFERED_LINE_CHARS = 1_000_000;
/**
 * Any piece (the whole memory, a memory line, a whole summary, a summary line,
 * a lesson or a quote) is matched on its own only when it has at least this
 * many words: a short one ("git status --short", "done") is too likely to be
 * ordinary output or JSON syntax.
 */
const MIN_PIECE_WORDS = 4;

function hasEnoughWords(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= MIN_PIECE_WORDS;
}

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
    .filter((line) => hasEnoughWords(line));
  // The whole document too, under the same floor: a tiny memory ("done",
  // "text", '"}') would otherwise rewrite ordinary words and JSON keys. Its
  // memory calls and results are withheld by shape regardless.
  return [...(hasEnoughWords(trimmed) ? [trimmed] : []), ...lines];
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
      if (hasEnoughWords(summary)) correctionTexts.push(summary);
      for (const line of summary.split(/\r?\n/)) {
        if (hasEnoughWords(line)) correctionTexts.push(line.trim());
      }
      // What the person wrote is quoted inside the server's sentence; the
      // agent is likelier to repeat the quote than the sentence around it.
      for (const match of summary.matchAll(/"([^"\n]+)"/g)) {
        if (hasEnoughWords(match[1]!)) correctionTexts.push(match[1]!.trim());
      }
    }
    if (Array.isArray(correction.lessons)) {
      for (const lesson of correction.lessons) {
        if (typeof lesson === "string" && hasEnoughWords(lesson)) correctionTexts.push(lesson.trim());
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

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Memory documents in a value: anything shaped like the memory route's rows
 * (`{ version, content, authorKind }`), at any depth, including inside text that is
 * itself JSON (a tool result's text block, a command's output).
 */
function memoryDocuments(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === "string") return depth > 0 && value.length > 2 ? memoryDocuments(parseJson(value), depth + 1) : [];
  if (Array.isArray(value)) return value.flatMap((entry) => memoryDocuments(entry, depth + 1));
  if (!isRecord(value)) return [];
  const found: string[] = [];
  if (
    typeof value.content === "string" &&
    typeof value.version === "number" &&
    (value.authorKind === "agent" || value.authorKind === "steward" || value.authorKind === "admin")
  ) {
    found.push(value.content);
  }
  for (const entry of Object.values(value)) found.push(...memoryDocuments(entry, depth + 1));
  return found;
}

/** Learn every memory version a result carries; true when it carried one. */
function learnFromResult(state: PrivateLogState, value: unknown): boolean {
  const docs = memoryDocuments(value, 1);
  if (docs.length > 0) addMemoryContent(state, ...docs);
  return docs.length > 0;
}

/** The JSON bodies of `curl -d/--data/--data-raw/--data-binary '...'` in a command. */
function curlBodies(command: string): unknown[] {
  const bodies: unknown[] = [];
  const re = /(?:^|\s)(?:-d|--data(?:-raw|-binary|-ascii)?)(?:=|\s+)(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g;
  for (const match of command.matchAll(re)) {
    const raw = match[1] ?? (match[2] ?? "").replace(/\\(["\\$`])/g, "$1");
    const parsed = parseJson(raw);
    if (parsed !== null) bodies.push(parsed);
  }
  return bodies;
}

/** Learn the memory a call writes: tool input `content`, `body.content`, or a curl body. */
function rememberWrittenMemory(state: PrivateLogState, input: unknown) {
  const record = isRecord(input) ? input : null;
  if (!record) {
    if (typeof input === "string") rememberWrittenMemory(state, { command: input });
    return;
  }
  if (typeof record.content === "string") addMemoryContent(state, record.content);
  const body = isRecord(record.body) ? record.body : null;
  if (body && typeof body.content === "string") addMemoryContent(state, body.content);
  if (typeof record.command === "string") {
    for (const parsed of curlBodies(record.command)) {
      if (isRecord(parsed) && typeof parsed.content === "string") addMemoryContent(state, parsed.content);
    }
  }
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
    } else if (block.type === "tool_result") {
      const known = typeof block.tool_use_id === "string" && state.memoryCallIds.has(block.tool_use_id);
      // Learn the memory the result carries before withholding it, so a later
      // echo is caught. A result shaped like a memory row is memory traffic
      // even when its call is not known (it was on an earlier log page).
      const carriesMemory = learnFromResult(state, block.content);
      if (known || carriesMemory) {
        if ("tool_use_result" in obj) learnFromResult(state, obj.tool_use_result);
        block.content = AGENT_MEMORY_WITHHELD_TEXT;
        changed = true;
        resultWithheld = true;
      }
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
  if (item.type === "mcp_tool_call" && (known || isMemoryCall(item.tool, item.arguments) || learnFromResult(state, item.result))) {
    if (id) state.memoryCallIds.add(id);
    rememberWrittenMemory(state, item.arguments);
    learnFromResult(state, item.result);
    if ("arguments" in item) item.arguments = WITHHELD_INPUT;
    if (item.result !== null && item.result !== undefined) {
      item.result = { content: [{ type: "text", text: AGENT_MEMORY_WITHHELD_TEXT }] };
    }
    return true;
  }
  if (item.type === "command_execution" && (known || mentionsMemoryRoute(item.command))) {
    if (id) state.memoryCallIds.add(id);
    rememberWrittenMemory(state, item.command);
    learnFromResult(state, item.aggregated_output);
    item.command = AGENT_MEMORY_WITHHELD_TEXT;
    if (typeof item.aggregated_output === "string") item.aggregated_output = AGENT_MEMORY_WITHHELD_TEXT;
    return true;
  }
  if (item.type === "tool_use" && (known || isMemoryCall(item.name, item.input))) {
    if (id) state.memoryCallIds.add(id);
    rememberWrittenMemory(state, item.input);
    for (const key of ["content", "output", "result"]) learnFromResult(state, item[key]);
    if ("input" in item) item.input = WITHHELD_INPUT;
    for (const key of ["content", "output", "result"]) {
      if (key in item && item[key] !== null) item[key] = AGENT_MEMORY_WITHHELD_TEXT;
    }
    return true;
  }
  if (
    item.type === "tool_result" &&
    ((typeof item.tool_use_id === "string" && state.memoryCallIds.has(item.tool_use_id)) ||
      ["content", "output", "result"].some((key) => memoryDocuments(item[key], 1).length > 0))
  ) {
    for (const key of ["content", "output", "result"]) learnFromResult(state, item[key]);
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

const YIELD_SLICE_MS = 8;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Lines of text cleaned one by one, yielding to the event loop every few ms. */
async function withholdLinesAsync(lines: string[], state: PrivateLogState, signal?: AbortSignal): Promise<string[]> {
  let sliceStart = performance.now();
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const crlf = line.endsWith("\r");
    const body = crlf ? line.slice(0, -1) : line;
    out.push(`${withholdPrivateContentFromLogLine(body, state)}${crlf ? "\r" : ""}`);
    if (performance.now() - sliceStart >= YIELD_SLICE_MS && i + 1 < lines.length) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
      sliceStart = performance.now();
    }
  }
  return out;
}

/**
 * A stored run log page (NDJSON of `{ ts, stream, chunk }`), for logs written
 * before the live stripper existed.
 *
 * A process write is not a line: one JSON line can be split across two or
 * more entries, so each stream's chunks are joined in order, cleaned line by
 * line (call ids carry across the whole page), and re-framed: every cleaned
 * line goes to the entry where the original line ended, and an entry left
 * with nothing is dropped. A line that is not an entry (a page boundary cut
 * it) gets the content pass only; so does a split line whose other half is on
 * another page, where matching against every recent memory version and
 * correction of the agent is what catches it.
 */
export async function withholdPrivateContentFromRunLogNdjson(
  content: string,
  state: PrivateLogState,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  if (!content) return content;
  const lines = content.split("\n");
  type Entry = { index: number; entry: Record<string, unknown>; chunk: string };
  const byStream = new Map<string, Entry[]>();
  const output: Array<string | null> = lines.map((line) => line);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed) || typeof parsed.chunk !== "string") {
      output[index] = withholdPieces(line, state);
      continue;
    }
    const stream = typeof parsed.stream === "string" ? parsed.stream : "";
    const entries = byStream.get(stream) ?? [];
    entries.push({ index, entry: parsed, chunk: parsed.chunk });
    byStream.set(stream, entries);
  }
  for (const entries of byStream.values()) {
    const joined = entries.map((item) => item.chunk).join("");
    const cleanedLines = await withholdLinesAsync(joined.split("\n"), state, opts?.signal);
    if (cleanedLines.join("\n") === joined) continue;
    let cursor = 0;
    for (const [position, item] of entries.entries()) {
      const ended = item.chunk.split("\n").length - 1;
      let chunk = cleanedLines.slice(cursor, cursor + ended).map((line) => `${line}\n`).join("");
      cursor += ended;
      if (position === entries.length - 1) chunk += cleanedLines.slice(cursor).join("\n");
      output[item.index] = chunk ? JSON.stringify({ ...item.entry, chunk }) : null;
    }
  }
  return output.filter((line): line is string => line !== null).join("\n");
}

/**
 * Context key set on a run whose log was written through the live stripper
 * (heartbeat.ts). Its log, excerpts, result and error are already clean, so
 * reads skip the read-time pass (and its queries) for it.
 */
export const PRIVATE_LOG_STRIPPED_CONTEXT_KEY = "paperclipPrivateLogStripped";

export function runLogWasStripped(contextSnapshot: unknown): boolean {
  return isRecord(contextSnapshot) && contextSnapshot[PRIVATE_LOG_STRIPPED_CONTEXT_KEY] === true;
}

const MEMORY_VERSIONS_PER_AGENT = 50;
const CORRECTIONS_PER_AGENT = 200;

/**
 * The read-time state per agent, for stored logs or excerpts of its runs, from
 * every recent memory version and correction it has had: a stored log does not
 * say which version its run saw. Two queries for any number of agents.
 */
export async function loadAgentsPrivateLogStates(
  db: Pick<Db, "select">,
  agentIds: Iterable<string>,
): Promise<Map<string, PrivateLogState>> {
  const ids = [...new Set(agentIds)];
  const states = new Map<string, PrivateLogState>();
  if (ids.length === 0) return states;
  const rankedMemory = db
    .select({
      agentId: agentMemory.agentId,
      content: agentMemory.content,
      rank: sql<number>`row_number() over (partition by ${agentMemory.agentId} order by ${agentMemory.version} desc)`.as("rank"),
    })
    .from(agentMemory)
    .where(inArray(agentMemory.agentId, ids))
    .as("ranked_memory");
  const rankedCorrections = db
    .select({
      agentId: agentCorrections.agentId,
      summary: agentCorrections.summary,
      details: agentCorrections.details,
      rank: sql<number>`row_number() over (partition by ${agentCorrections.agentId} order by ${agentCorrections.createdAt} desc)`.as("rank"),
    })
    .from(agentCorrections)
    .where(inArray(agentCorrections.agentId, ids))
    .as("ranked_corrections");
  const [memories, corrections] = await Promise.all([
    db.select().from(rankedMemory).where(lte(rankedMemory.rank, MEMORY_VERSIONS_PER_AGENT)),
    db.select().from(rankedCorrections).where(lte(rankedCorrections.rank, CORRECTIONS_PER_AGENT)),
  ]);
  for (const id of ids) {
    states.set(
      id,
      createPrivateLogState({
        memoryContents: memories.filter((row) => row.agentId === id).map((row) => row.content),
        corrections: corrections
          .filter((row) => row.agentId === id)
          .map((row) => ({ summary: row.summary, lessons: isRecord(row.details) ? row.details.lessons : undefined })),
      }),
    );
  }
  return states;
}

/** {@link loadAgentsPrivateLogStates} for one agent. */
export async function loadAgentPrivateLogState(db: Pick<Db, "select">, agentId: string): Promise<PrivateLogState> {
  return (await loadAgentsPrivateLogStates(db, [agentId])).get(agentId)!;
}
