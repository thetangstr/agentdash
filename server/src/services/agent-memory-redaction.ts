// AgentDash: keep an agent's memory out of the run records.
//
// Memory is readable only by the agent itself, its active steward and
// administrators (routes/agent-memory.ts). But every run carries two copies of
// it: the context key `paperclipAgentMemory`, and the `## Your Memory` section
// the claude/codex adapters render into the prompt. Both used to be persisted
// with the run — the context snapshot on the run row, and the prompt plus
// context on the `adapter.invoke` event — and served to anyone who can read
// the run, streamed on the live bus, and packed into feedback trace bundles.
//
// So both copies are withheld wherever a run is recorded or served: at write
// time (heartbeat.ts), and at read time for rows written before this existed.
// The adapter still receives the full context; only the records lose it. The
// one place to read memory is its own route.
import { renderAgentMemoryPrompt } from "@paperclipai/adapter-utils/server-utils";
import { AGENT_MEMORY_CONTEXT_KEY } from "@paperclipai/shared";

export const AGENT_MEMORY_WITHHELD_TEXT =
  "[agent memory withheld: readable only by the agent, its steward and admins]";

/** The heading line renderAgentMemoryPrompt starts with, at the start of a line. */
const MEMORY_SECTION_START_RE =
  /(^|\n)## Your Memory(?: \(v\d+[^\n]*\))?(?: — last edited by your [^\n]+)?\n\nThis is what you chose to remember/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The context without its memory key; the same object when there is none. */
export function withoutAgentMemoryContext<T>(context: T): T {
  if (!isRecord(context) || !(AGENT_MEMORY_CONTEXT_KEY in context)) return context;
  const { [AGENT_MEMORY_CONTEXT_KEY]: _memory, ...rest } = context;
  return rest as T;
}

/**
 * The prompt with its memory section replaced by a placeholder.
 *
 * Exact match first, from the memory the prompt was rendered with. Failing
 * that (a stored prompt can be truncated, or the context copy missing), the
 * section is found by its heading and everything from there to the end is
 * withheld: losing the tail of an old prompt is the safe direction.
 */
export function withholdAgentMemoryFromPrompt(prompt: string, memory: unknown): string {
  const rendered = memory ? renderAgentMemoryPrompt(memory) : "";
  if (rendered && prompt.includes(rendered)) {
    return prompt.split(rendered).join(AGENT_MEMORY_WITHHELD_TEXT);
  }
  const match = MEMORY_SECTION_START_RE.exec(prompt);
  if (!match) return prompt;
  const start = match.index + match[1]!.length;
  return `${prompt.slice(0, start)}${AGENT_MEMORY_WITHHELD_TEXT}`;
}

/** An `adapter.invoke` payload with memory gone from its context and prompt. */
export function withholdAgentMemoryFromInvocationPayload<T extends Record<string, unknown>>(payload: T): T {
  const context = isRecord(payload.context) ? payload.context : null;
  const memory = context ? context[AGENT_MEMORY_CONTEXT_KEY] : undefined;
  const next: Record<string, unknown> = { ...payload };
  if (context && memory !== undefined) next.context = withoutAgentMemoryContext(context);
  if (typeof payload.prompt === "string") next.prompt = withholdAgentMemoryFromPrompt(payload.prompt, memory);
  return next as T;
}

/** Rewrites the `adapter.invoke` events of a run's event list; others pass through. */
export function withholdAgentMemoryFromRunEvents<T extends { eventType: string; payload: unknown }>(events: T[]): T[] {
  return events.map((event) =>
    event.eventType === "adapter.invoke" && isRecord(event.payload)
      ? { ...event, payload: withholdAgentMemoryFromInvocationPayload(event.payload) }
      : event,
  );
}
