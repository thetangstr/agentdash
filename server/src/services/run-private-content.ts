// AgentDash: keep an agent's lessons out of the run records.
//
// An agent's memory, and the corrections ("What changed") its memory is built
// from, are readable only by the agent itself, its active steward and
// administrators (routes/agent-memory.ts). But every run carries copies of
// both:
//
//   - context keys: `paperclipAgentMemory`, `paperclipAgentCorrections`,
//     `paperclipAgentCorrectionsRemaining`, and `corrections` /
//     `correctionsRemaining` inside the wake payload `paperclipWake`;
//   - rendered prompt sections: `## Your Memory` and
//     `## What changed (corrections to your work)` (Hermes gets the latter
//     template-escaped);
//   - the wake payload again, as JSON, in `PAPERCLIP_WAKE_PAYLOAD_JSON`.
//
// The run's context snapshot and its `adapter.invoke` event (prompt, context,
// env) used to keep all of it, served to anyone who can read the run, streamed
// on the live bus and packed into feedback trace bundles. So every copy is
// withheld wherever a run is recorded or served: at write time (heartbeat.ts),
// at read time, and once for old rows (migration 0152). The adapter still
// receives the full context; only the records lose it.
//
// Nothing reads corrections back from a saved run: delivery and redelivery
// live on `agent_corrections` (`deliveredRunId` + the run's status).
import {
  renderAgentCorrectionsPrompt,
  renderAgentMemoryPrompt,
} from "@paperclipai/adapter-utils/server-utils";
import { AGENT_MEMORY_CONTEXT_KEY } from "@paperclipai/shared";

export const AGENT_MEMORY_WITHHELD_TEXT =
  "[agent memory withheld: readable only by the agent, its steward and admins]";
export const AGENT_CORRECTIONS_WITHHELD_TEXT =
  "[corrections withheld: readable only by the agent, its steward and admins]";

const CORRECTIONS_CONTEXT_KEY = "paperclipAgentCorrections";
const CORRECTIONS_REMAINING_CONTEXT_KEY = "paperclipAgentCorrectionsRemaining";
const WAKE_PAYLOAD_KEY = "paperclipWake";
const PRIVATE_TOP_LEVEL_KEYS = [AGENT_MEMORY_CONTEXT_KEY, CORRECTIONS_CONTEXT_KEY, CORRECTIONS_REMAINING_CONTEXT_KEY];
const PRIVATE_WAKE_KEYS = ["corrections", "correctionsRemaining"];

/** Each heading at the start of a line, followed by the renderer's fixed first sentence. */
const SECTION_STARTS: Array<{ re: RegExp; withheld: string }> = [
  {
    re: /(^|\n)## Your Memory(?: \(v\d+[^\n]*\))?(?: — last edited by your [^\n]+)?\n\nThis is what you chose to remember/,
    withheld: AGENT_MEMORY_WITHHELD_TEXT,
  },
  {
    re: /(^|\n)## What changed \(corrections to your work\)\n\nA person or another agent changed/,
    withheld: AGENT_CORRECTIONS_WITHHELD_TEXT,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPrivateKeys(context: Record<string, unknown>): boolean {
  if (PRIVATE_TOP_LEVEL_KEYS.some((key) => key in context)) return true;
  const wake = context[WAKE_PAYLOAD_KEY];
  return isRecord(wake) && PRIVATE_WAKE_KEYS.some((key) => key in wake);
}

/** The context without memory or corrections; the same object when it has none. */
export function withoutPrivateRunContext<T>(context: T): T {
  if (!isRecord(context) || !hasPrivateKeys(context)) return context;
  const next: Record<string, unknown> = { ...context };
  for (const key of PRIVATE_TOP_LEVEL_KEYS) delete next[key];
  const wake = next[WAKE_PAYLOAD_KEY];
  if (isRecord(wake)) {
    const nextWake: Record<string, unknown> = { ...wake };
    for (const key of PRIVATE_WAKE_KEYS) delete nextWake[key];
    next[WAKE_PAYLOAD_KEY] = nextWake;
  }
  return next as T;
}

/** The exact texts the renderers produced from this context, longest first. */
function renderedPrivateSections(context: unknown): Array<{ text: string; withheld: string }> {
  if (!isRecord(context)) return [];
  const out: Array<{ text: string; withheld: string }> = [];
  const memory = renderAgentMemoryPrompt(context[AGENT_MEMORY_CONTEXT_KEY]);
  if (memory) out.push({ text: memory, withheld: AGENT_MEMORY_WITHHELD_TEXT });
  const wake = isRecord(context[WAKE_PAYLOAD_KEY]) ? (context[WAKE_PAYLOAD_KEY] as Record<string, unknown>) : null;
  const sources: Array<[unknown, unknown]> = [
    [wake?.corrections, wake?.correctionsRemaining],
    [context[CORRECTIONS_CONTEXT_KEY], context[CORRECTIONS_REMAINING_CONTEXT_KEY]],
  ];
  for (const [items, remaining] of sources) {
    const count = typeof remaining === "number" && Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0;
    const section = renderAgentCorrectionsPrompt(items, count);
    if (!section) continue;
    for (const form of [section, section.replace(/\{\{/g, "{ {")]) {
      if (!out.some((entry) => entry.text === form)) out.push({ text: form, withheld: AGENT_CORRECTIONS_WITHHELD_TEXT });
    }
  }
  return out.sort((a, b) => b.text.length - a.text.length);
}

function withholdText(text: string, sections: Array<{ text: string; withheld: string }>): string {
  let out = text;
  for (const section of sections) {
    if (out.includes(section.text)) out = out.split(section.text).join(section.withheld);
  }
  // A section the exact pass missed (a truncated stored prompt, or no context
  // copy to render from) is withheld from its heading to the end of the text:
  // losing the tail of an old record is the safe direction.
  for (const start of SECTION_STARTS) {
    // Already withheld (the exact pass above, or migration 0152, which keeps
    // the section's fixed frame and withholds only what was in it).
    if (out.includes(start.withheld)) continue;
    const match = start.re.exec(out);
    if (!match) continue;
    out = `${out.slice(0, match.index + match[1]!.length)}${start.withheld}`;
  }
  return out;
}

/** A text (a prompt, a template) with memory and corrections sections withheld. */
export function withholdPrivateContentFromText(text: string, context: unknown): string {
  return withholdText(text, renderedPrivateSections(context));
}

/** A JSON-encoded wake payload (`PAPERCLIP_WAKE_PAYLOAD_JSON`) without its corrections. */
function withholdFromWakePayloadJson(value: string): string {
  if (!value.includes('"corrections"')) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return value;
    const next = { ...parsed };
    for (const key of PRIVATE_WAKE_KEYS) delete next[key];
    return JSON.stringify(next);
  } catch {
    return AGENT_CORRECTIONS_WITHHELD_TEXT;
  }
}

function withholdDeep(value: unknown, sections: Array<{ text: string; withheld: string }>, depth: number): unknown {
  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if (trimmed.startsWith("{") && value.includes('"corrections"')) return withholdFromWakePayloadJson(value);
    return withholdText(value, sections);
  }
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((entry) => withholdDeep(entry, sections, depth + 1));
  if (isRecord(value)) {
    const source = withoutPrivateRunContext(value);
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) next[key] = withholdDeep(entry, sections, depth + 1);
    return next;
  }
  return value;
}

/**
 * An `adapter.invoke` payload with every copy withheld: private context keys
 * at any depth, rendered sections in any string (prompt, templates, args),
 * and the wake payload JSON in the env. Returns a new object.
 */
export function withholdPrivateContentFromInvocationPayload<T extends Record<string, unknown>>(payload: T): T {
  return withholdDeep(payload, renderedPrivateSections(payload.context), 0) as T;
}

/** Rewrites the `adapter.invoke` events of a run's event list; others pass through. */
export function withholdPrivateContentFromRunEvents<T extends { eventType: string; payload: unknown }>(events: T[]): T[] {
  return events.map((event) =>
    event.eventType === "adapter.invoke" && isRecord(event.payload)
      ? { ...event, payload: withholdPrivateContentFromInvocationPayload(event.payload) }
      : event,
  );
}
