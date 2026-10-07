// AgentDash: the run page's Business view reads a harness-published milestone
// timeline (`ac.milestone-timeline/v1`, see doc/RUN-BUSINESS-VIEW.md). The
// harness owns the taxonomy and the JSON; AgentDash only validates and renders
// it, and never edits it. Everything here is pure so it can be unit-tested.
//
// Contract rules enforced here:
//   - the `schema` string is the contract; only major version 1 is rendered,
//     any other major falls back to the plain summary;
//   - additive unknown fields are ignored;
//   - `simulated` is preserved verbatim (never dropped);
//   - `basis: "inferred"` is flagged;
//   - `source.ref = "seq=<n>"` points at AgentDash's own run-log row `seq`;
//   - the timeline must name this run (`agentdash.heartbeatRunId`);
//   - harness text goes through AgentDash's secret redaction like every
//     other transcript view.
import { redactSecrets } from "./redactSecrets";

export const MILESTONE_TIMELINE_SCHEMA_PREFIX = "ac.milestone-timeline/";
export const MILESTONE_TIMELINE_SUPPORTED_MAJOR = 1;

/**
 * Issue document key the harness writes the timeline under, one per run:
 * `milestone-timeline-<heartbeatRunId>` (55 chars for a UUID, inside the
 * 64-char `[a-z0-9][a-z0-9_-]*` document-key rule).
 */
export const MILESTONE_TIMELINE_DOCUMENT_KEY_PREFIX = "milestone-timeline-";

export function milestoneTimelineDocumentKey(heartbeatRunId: string): string {
  return `${MILESTONE_TIMELINE_DOCUMENT_KEY_PREFIX}${heartbeatRunId.trim().toLowerCase()}`;
}

/** Order and labels copied from the harness taxonomy (taxonomy.ts MILESTONES / MILESTONE_LABEL). */
export const TIMELINE_MILESTONES = ["discover", "proposal", "negotiation", "agreement", "execution", "settlement"] as const;
export type TimelineMilestone = (typeof TIMELINE_MILESTONES)[number];

export const TIMELINE_MILESTONE_LABEL: Readonly<Record<TimelineMilestone, string>> = {
  discover: "Discover",
  proposal: "Proposal",
  negotiation: "Negotiation",
  agreement: "Agreement",
  execution: "Execution",
  settlement: "Settlement",
};

export type TimelineLane = "traveler" | "agency";
export type TimelineOutcome = "ok" | "refused" | "error";

export interface TimelineEvent {
  id: string;
  ts: string;
  lane: TimelineLane;
  actor: string;
  kind: string;
  milestone: TimelineMilestone;
  basis: string;
  /** True when the milestone was inferred (narration placed by its nearest tool call). */
  inferred: boolean;
  subtype: string | null;
  tool: string | null;
  summary: string;
  detail: string | null;
  outcome: TimelineOutcome | null;
  /** The harness's SIMULATED / "Stripe TEST mode" label, verbatim. */
  simulated: string | null;
  /** `seq` of AgentDash's own heartbeat-run log row, from `source.ref = "seq=<n>"`. */
  sourceSeq: number | null;
  sourceRef: string | null;
}

export interface TimelineMilestoneLog {
  /** e.g. "not-yet-logged" (the only value Track C writes today). */
  status: string;
  /** Forward-compatible: shown only when the harness sends them. */
  ledgerId: string | null;
  blockHeight: string | null;
  /** Existing anchors that already cover the stage (`coveredBy: ["ledger:<id>"]`). */
  coveredBy: string[];
}

export interface TimelineAnchor {
  milestone: TimelineMilestone;
  summary: string;
  ledgerId: string | null;
  blockHeight: string | null;
}

export interface TimelineMilestoneSummary {
  milestone: TimelineMilestone;
  label: string;
  log: TimelineMilestoneLog | null;
}

export interface MilestoneTimelineJoinKeys {
  companyId: string | null;
  agentId: string | null;
  heartbeatRunId: string | null;
  issueId: string | null;
}

export interface MilestoneTimeline {
  schema: string;
  label: string | null;
  runId: string | null;
  agentdash: MilestoneTimelineJoinKeys | null;
  startedAt: string | null;
  endedAt: string | null;
  terminal: string | null;
  milestones: TimelineMilestoneSummary[];
  events: TimelineEvent[];
  anchors: TimelineAnchor[];
  honesty: string[];
  /** Events skipped because a required field was missing or not understood. */
  droppedEvents: number;
}

export type MilestoneTimelineParseFailure = "not-json" | "not-a-timeline" | "unsupported-version" | "invalid";

export type MilestoneTimelineParseResult =
  | { ok: true; timeline: MilestoneTimeline }
  | { ok: false; reason: MilestoneTimelineParseFailure; detail: string };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Harness free text, redacted like the rest of the run page. */
function text(value: unknown): string | null {
  const raw = str(value);
  return raw === null ? null : redactSecrets(raw);
}

function idLike(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value);
}

function isMilestone(value: unknown): value is TimelineMilestone {
  return typeof value === "string" && (TIMELINE_MILESTONES as readonly string[]).includes(value);
}

/**
 * The document body is the timeline JSON, either bare or inside one fenced
 * ```json block (the fence keeps the issue's Documents tab readable).
 * Returns undefined when no JSON can be read.
 */
export function extractTimelineJson(body: string): unknown {
  const trimmed = body.trim();
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  const json = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(json);
  } catch {
    // Documents stored before the server stopped unescaping `\n` inside
    // code have raw line breaks inside JSON strings; escape those and retry.
    try {
      return JSON.parse(escapeControlCharsInStrings(json));
    } catch {
      return undefined;
    }
  }
}

/**
 * Escape raw U+0000–U+001F inside JSON string literals only (newlines
 * between tokens stay as they are, so pretty-printed JSON is untouched).
 */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** `"seq=42"` → 42; anything else → null. */
export function parseSourceSeq(ref: unknown): number | null {
  if (typeof ref !== "string") return null;
  const match = ref.trim().match(/^seq=(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/** Major version of an `ac.milestone-timeline/vN[.x]` schema string, or null when it is not one. */
export function timelineSchemaMajor(schema: unknown): number | null {
  if (typeof schema !== "string") return null;
  const match = schema.trim().match(/^ac\.milestone-timeline\/v(\d+)(?:\.\d+)*$/);
  return match ? Number(match[1]) : null;
}

function parseOutcome(value: unknown): TimelineOutcome | null {
  return value === "ok" || value === "refused" || value === "error" ? value : null;
}

function parseSimulated(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  // Not in the contract, but a bare `true` must never be dropped either.
  if (value === true) return "SIMULATED";
  return null;
}

function parseEvent(raw: unknown): TimelineEvent | null {
  if (!isObject(raw)) return null;
  const id = idLike(raw.id);
  const lane = raw.lane === "agency" || raw.lane === "traveler" ? raw.lane : null;
  const kind = str(raw.kind);
  const summary = text(raw.summary);
  if (!id || !lane || !kind || !summary || !isMilestone(raw.milestone)) return null;
  const source = isObject(raw.source) ? raw.source : null;
  const sourceRef = source ? str(source.ref) : null;
  const basis = str(raw.basis) ?? "exact";
  return {
    id,
    ts: typeof raw.ts === "string" ? raw.ts : "",
    lane,
    actor: str(raw.actor) ?? lane,
    kind,
    milestone: raw.milestone,
    basis,
    inferred: basis === "inferred",
    subtype: str(raw.subtype),
    tool: str(raw.tool),
    summary,
    detail: text(raw.detail),
    outcome: parseOutcome(raw.outcome),
    simulated: parseSimulated(raw.simulated) ? redactSecrets(parseSimulated(raw.simulated)!) : null,
    sourceSeq: parseSourceSeq(sourceRef),
    sourceRef,
  };
}

function parseLog(raw: unknown): TimelineMilestoneLog | null {
  if (!isObject(raw)) return null;
  const status = str(raw.status);
  if (!status) return null;
  const ledger = isObject(raw.ledger) ? raw.ledger : null;
  const coveredBy = Array.isArray(raw.coveredBy)
    ? raw.coveredBy
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.replace(/^ledger:/, "").trim())
    : [];
  return {
    status,
    ledgerId: idLike(raw.ledgerId) ?? idLike(ledger?.id) ?? null,
    blockHeight: idLike(raw.blockHeight) ?? idLike(raw.block) ?? idLike(ledger?.blockHeight) ?? null,
    coveredBy,
  };
}

function parseJoinKeys(raw: Json): MilestoneTimelineJoinKeys | null {
  // The contract adds `agentdash` at the top level; the harness's evidence
  // shape also carries it under `agency.agentdash`. Accept either.
  const agency = isObject(raw.agency) ? raw.agency : null;
  const source = isObject(raw.agentdash) ? raw.agentdash : isObject(agency?.agentdash) ? agency!.agentdash : null;
  if (!isObject(source)) return null;
  return {
    companyId: str(source.companyId),
    agentId: str(source.agentId),
    heartbeatRunId: str(source.heartbeatRunId),
    issueId: str(source.issueId),
  };
}

export function parseMilestoneTimeline(input: unknown): MilestoneTimelineParseResult {
  const raw = typeof input === "string" ? extractTimelineJson(input) : input;
  if (raw === undefined) return { ok: false, reason: "not-json", detail: "The document is not JSON." };
  if (!isObject(raw)) return { ok: false, reason: "not-a-timeline", detail: "The document is not a JSON object." };
  const major = timelineSchemaMajor(raw.schema);
  if (major === null) {
    return { ok: false, reason: "not-a-timeline", detail: `Unknown schema ${JSON.stringify(raw.schema ?? null)}.` };
  }
  if (major !== MILESTONE_TIMELINE_SUPPORTED_MAJOR) {
    return { ok: false, reason: "unsupported-version", detail: `Schema ${String(raw.schema)} is newer than this page understands.` };
  }
  if (!Array.isArray(raw.events)) {
    return { ok: false, reason: "invalid", detail: "The timeline has no events list." };
  }

  const events: TimelineEvent[] = [];
  let droppedEvents = 0;
  for (const item of raw.events) {
    const event = parseEvent(item);
    if (event) events.push(event);
    else droppedEvents += 1;
  }

  const logByMilestone = new Map<TimelineMilestone, TimelineMilestoneLog | null>();
  if (Array.isArray(raw.milestones)) {
    for (const item of raw.milestones) {
      if (isObject(item) && isMilestone(item.milestone)) logByMilestone.set(item.milestone, parseLog(item.log));
    }
  }
  const milestones = TIMELINE_MILESTONES.map((milestone) => ({
    milestone,
    label: TIMELINE_MILESTONE_LABEL[milestone],
    log: logByMilestone.get(milestone) ?? null,
  }));

  const anchors: TimelineAnchor[] = [];
  const clockchain = isObject(raw.clockchain) ? raw.clockchain : null;
  if (clockchain && Array.isArray(clockchain.existingAnchors)) {
    for (const item of clockchain.existingAnchors) {
      if (!isObject(item) || !isMilestone(item.milestone)) continue;
      const ids = isObject(item.ids) ? item.ids : {};
      anchors.push({
        milestone: item.milestone,
        summary: text(item.summary) ?? "Anchored on Clockchain",
        ledgerId: idLike(ids.ledgerId),
        blockHeight: idLike(ids.blockHeight),
      });
    }
  }

  return {
    ok: true,
    timeline: {
      schema: String(raw.schema),
      label: text(raw.label),
      runId: str(raw.runId),
      agentdash: parseJoinKeys(raw),
      startedAt: str(raw.startedAt),
      endedAt: str(raw.endedAt),
      terminal: str(raw.terminal),
      milestones,
      events,
      anchors,
      honesty: Array.isArray(raw.honesty)
        ? raw.honesty.filter((line): line is string => typeof line === "string" && line.trim().length > 0).map((line) => redactSecrets(line))
        : [],
      droppedEvents,
    },
  };
}

/**
 * A timeline belongs on this run's page only when it names this run:
 * `agentdash.heartbeatRunId` (or `agency.agentdash.heartbeatRunId`) must equal
 * the run id. A timeline with no join key, or one naming another run or
 * company, is not shown as this run's timeline.
 */
export function timelineMatchesRun(
  timeline: MilestoneTimeline,
  run: { id: string; companyId: string },
): boolean {
  const keys = timeline.agentdash;
  if (!keys?.heartbeatRunId) return false;
  if (keys.heartbeatRunId.toLowerCase() !== run.id.toLowerCase()) return false;
  if (keys.companyId && keys.companyId.toLowerCase() !== run.companyId.toLowerCase()) return false;
  return true;
}

/** Distinct SIMULATED labels across the whole timeline, in first-seen order. */
export function timelineSimulatedLabels(timeline: MilestoneTimeline): string[] {
  const labels: string[] = [];
  for (const event of timeline.events) {
    if (event.simulated && !labels.includes(event.simulated)) labels.push(event.simulated);
  }
  return labels;
}
