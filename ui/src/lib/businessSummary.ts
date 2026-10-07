// AgentDash: the Business view's plain-language fallback. When a run has no
// harness-published milestone timeline (most companies), the Business view
// summarises AgentDash's own transcript: what the agent did, what it said or
// decided, how it ended and what it cost. It reuses the Readable model
// (readableTranscript.ts) and never invents milestone labels.
import type { ReadableBlock, ReadableToolItem, ReadableTranscript } from "./readableTranscript";
import { redactSecrets } from "./redactSecrets";
import { shortenInstancePaths } from "./instancePaths";

export type BusinessStepKind = "said" | "did" | "changed" | "problem" | "received";

export interface BusinessStep {
  key: string;
  ts: string;
  kind: BusinessStepKind;
  /** One plain-language line. */
  title: string;
  /** Optional longer text: the full message, or one line per action. */
  detail: string[];
  /** How many of this step's actions failed. */
  failed: number;
}

export type BusinessOutcomeState = "working" | "done" | "failed" | "stopped" | "unknown";

export interface BusinessOutcome {
  state: BusinessOutcomeState;
  label: string;
  /** Extra words: the stop reason, or the run's error. */
  note: string | null;
}

export interface BusinessCost {
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface BusinessSummary {
  steps: BusinessStep[];
  /** The agent's last message, shown as the result once the run is over. */
  finalMessage: string | null;
  outcome: BusinessOutcome;
  cost: BusinessCost | null;
}

export interface BusinessSummaryOptions {
  streaming?: boolean;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number; durationMs?: number | null } | null;
  stoppedReason?: string | null;
  /** The run record's status (succeeded, failed, timed_out, cancelled, running, queued). */
  runStatus?: string | null;
  /** The run record's error, used when the transcript has no result line. */
  runError?: string | null;
}

const EXCERPT_MAX = 220;

/** Markdown → one plain line, for a step title. */
export function plainExcerpt(markdown: string, max = EXCERPT_MAX): string {
  const text = shortenInstancePaths(redactSecrets(markdown))
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](\S[^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// Plain-language phrases for the Readable tool verbs: [one, many].
const VERB_PHRASES: Record<string, [string, (n: number) => string]> = {
  Read: ["read a file", (n) => `read ${n} files`],
  Edit: ["edited a file", (n) => `edited ${n} files`],
  Write: ["wrote a file", (n) => `wrote ${n} files`],
  Wrote: ["wrote a file", (n) => `wrote ${n} files`],
  Patched: ["changed a file", (n) => `changed files ${n} times`],
  Ran: ["ran a command", (n) => `ran ${n} commands`],
  Searched: ["searched the files", (n) => `searched the files ${n} times`],
  "Found files": ["looked for files", (n) => `looked for files ${n} times`],
  Listed: ["looked in a folder", (n) => `looked in ${n} folders`],
  Fetched: ["opened a web page", (n) => `opened ${n} web pages`],
  "Searched web": ["searched the web", (n) => `searched the web ${n} times`],
  Delegated: ["handed off a task", (n) => `handed off ${n} tasks`],
  "Updated plan": ["updated its plan", (n) => `updated its plan ${n} times`],
  Skill: ["used a skill", (n) => `used ${n} skills`],
  "Checked shell output": ["checked a command's output", (n) => `checked command output ${n} times`],
  "Stopped shell": ["stopped a command", (n) => `stopped ${n} commands`],
};

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function upperFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function phraseForVerb(verb: string, count: number): string {
  const known = VERB_PHRASES[verb];
  if (known) return count === 1 ? known[0] : known[1](count);
  if (verb.startsWith("MCP: ")) {
    const tool = verb.slice(5).replace(/[_-]+/g, " ").trim();
    return count === 1 ? `used ${tool}` : `used ${tool} ${count} times`;
  }
  // AgentDash API actions already read as plain words ("Updated issue").
  const phrase = lowerFirst(verb);
  return count === 1 ? phrase : `${phrase} (${count} times)`;
}

/** "Read 2 files, ran a command and updated issue" for one group of tool calls. */
export function describeToolGroup(items: readonly Pick<ReadableToolItem, "summary">[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const verb = item.summary.verb || "Used a tool";
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  const phrases = [...counts.entries()].map(([verb, count]) => phraseForVerb(verb, count));
  if (phrases.length === 0) return "Worked";
  if (phrases.length === 1) return upperFirst(phrases[0]!);
  return upperFirst(`${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`);
}

function stepFromBlock(block: ReadableBlock): BusinessStep | null {
  if (block.type === "message") {
    const title = plainExcerpt(block.text);
    if (!title) return null;
    return {
      key: block.key,
      ts: block.ts,
      kind: block.role === "user" ? "received" : "said",
      title,
      detail: [],
      failed: 0,
    };
  }
  if (block.type === "tools") {
    const failed = block.items.filter((item) => item.status === "error").length;
    return {
      key: block.key,
      ts: block.ts,
      kind: "did",
      title: describeToolGroup(block.items),
      detail: block.items.map((item) => redactSecrets(item.summary.label)),
      failed,
    };
  }
  if (block.type === "diff") {
    const file = block.filePath ? shortenInstancePaths(block.filePath) : "a file";
    return { key: block.key, ts: block.ts, kind: "changed", title: `Changed ${file}`, detail: [], failed: 0 };
  }
  const first = block.lines.find((line) => line.trim())?.trim() ?? "";
  return {
    key: block.key,
    ts: block.ts,
    kind: "problem",
    title: first ? `Ran into a problem: ${plainExcerpt(first, 160)}` : "Ran into a problem",
    detail: block.lines.length > 1 ? block.lines.map((line) => redactSecrets(line)) : [],
    failed: 1,
  };
}

export function buildBusinessSummary(
  readable: ReadableTranscript,
  options: BusinessSummaryOptions = {},
): BusinessSummary {
  const streaming = options.streaming ?? false;
  const stopped = options.stoppedReason != null;

  // Once the run is over, the agent's last message is the result; it is
  // shown on its own rather than repeated as a step.
  let finalIndex = -1;
  if (!streaming) {
    for (let i = readable.blocks.length - 1; i >= 0; i -= 1) {
      const block = readable.blocks[i]!;
      if (block.type === "message" && block.role === "assistant") {
        finalIndex = i;
        break;
      }
    }
  }
  const finalBlock = finalIndex >= 0 ? readable.blocks[finalIndex] : null;
  const finalMessage =
    finalBlock && finalBlock.type === "message" ? shortenInstancePaths(redactSecrets(finalBlock.text)).trim() || null : null;

  const steps: BusinessStep[] = [];
  readable.blocks.forEach((block, index) => {
    if (index === finalIndex) return;
    // A stopped run's error lines are kill noise; the outcome says it stopped.
    if (block.type === "error" && stopped) return;
    const step = stepFromBlock(block);
    if (step) steps.push(step);
  });

  // The run record's status wins over the transcript: a crashed or
  // timed-out run often never writes a result line.
  const footer = readable.footer;
  const status = options.runStatus ?? null;
  const footerError = footer?.isError ? (footer.errors[0] ?? footer.text ?? null) : null;
  const errorNote = (value: string | null | undefined) => (value ? plainExcerpt(redactSecrets(value), 300) : null);
  let outcome: BusinessOutcome;
  if (stopped || status === "cancelled") {
    outcome = { state: "stopped", label: "Stopped", note: options.stoppedReason || null };
  } else if (status === "timed_out") {
    outcome = { state: "failed", label: "Ran out of time", note: errorNote(options.runError ?? footerError) };
  } else if (status === "failed") {
    outcome = { state: "failed", label: "Did not finish", note: errorNote(footerError ?? options.runError) };
  } else if (status === "succeeded") {
    outcome = { state: "done", label: "Finished", note: null };
  } else if (streaming || status === "running" || status === "queued") {
    outcome = { state: "working", label: "Still working", note: null };
  } else if (footer?.isError) {
    outcome = { state: "failed", label: "Did not finish", note: errorNote(footerError) };
  } else if (footer) {
    outcome = { state: "done", label: "Finished", note: null };
  } else {
    outcome = { state: "unknown", label: "No result recorded", note: null };
  }

  const usage = options.usage ?? null;
  let cost: BusinessCost | null = null;
  if (usage) {
    cost = {
      durationMs: usage.durationMs ?? footer?.durationMs ?? null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd ?? 0,
    };
  } else if (footer) {
    cost = {
      durationMs: footer.durationMs,
      inputTokens: footer.inputTokens,
      outputTokens: footer.outputTokens,
      costUsd: footer.costUsd,
    };
  }

  return { steps, finalMessage, outcome, cost };
}
