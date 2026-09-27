/**
 * AgentDash consolidation PR-A (design Rev 3 §4.1, §4.4): provenance, the
 * attention list and the deterministic briefing for the assistant digest.
 *
 * Provenance is derived on the server from WHO ACTED, never copied from
 * input. Three kinds:
 *
 * - `human_or_system`: a person in the company or the server did it. Only a
 *   row whose author columns the server stamped can earn this: an activity
 *   row with `origin = "server"` (PR-C) and actor type `user` or `system`,
 *   or a server-stamped user column such as `approvals.requestedByUserId`.
 * - `agent_state`: an agent set a state or value, OR the server cannot tell
 *   who did. Anything unattributable is downgraded here, never upgraded.
 *   Manual rows (`origin = "manual"`) and rows from before PR-C
 *   (`origin = NULL`) are at most `agent_state`.
 * - `agent_text`: free text an agent wrote (titles, lead reports), quoted.
 *
 * A write that came through an assistant grant is still the person's
 * (`human_or_system`) but carries `via: "assistant"` so "did anyone check
 * that?" has an honest answer (review N1).
 */

export type SourceKind = "human_or_system" | "agent_state" | "agent_text";
export type SourceActorType = "user" | "agent" | "system" | "plugin" | "unknown";

export interface RowSource {
  kind: SourceKind;
  actor: { type: SourceActorType; name: string | null };
  via?: "assistant";
  entity: string;
  id: string;
  recordedAt: string | null;
}

export interface ActivityProvenanceInput {
  origin: string | null;
  actorType: string;
  details: Record<string, unknown> | null;
}

/** The kind an activity row may claim — see the module header. */
export function kindForActivity(row: ActivityProvenanceInput): { kind: SourceKind; via?: "assistant" } {
  if (row.origin !== "server") return { kind: "agent_state" };
  if (row.actorType !== "user" && row.actorType !== "system") return { kind: "agent_state" };
  // `details.via` is only trusted on server rows, where the server wrote it
  // (assistantGrantAttribution); manual rows never reach this line.
  const via = row.details?.via;
  if (typeof via === "string" && via.startsWith("assistant_grant")) {
    return { kind: "human_or_system", via: "assistant" };
  }
  return { kind: "human_or_system" };
}

export function normalizeActorType(value: string | null | undefined): SourceActorType {
  return value === "user" || value === "agent" || value === "system" || value === "plugin" ? value : "unknown";
}

/** Clip for the briefing; the sentence cap matters more than the words. */
function clipText(value: string, max: number) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Titles are agent-written; the briefing always quotes them. */
export function quoteTitle(value: string | null | undefined, max = 60) {
  return `“${clipText(value ?? "untitled", max)}”`;
}

/** "Marco marked it done" / "Kai marked it done via assistant" / honest unknown. */
export function attributionPhrase(source: RowSource, verb: string) {
  if (source.actor.type === "unknown" || !source.actor.name) return `${verb}, no recorded author`;
  const who = source.actor.type === "system" ? "AgentDash" : source.actor.name;
  const via = source.via === "assistant" ? " via assistant" : "";
  const claim = source.kind === "human_or_system" ? "" : " (agent-set)";
  return `${who} ${verb}${via}${claim}`;
}

export type AttentionReason = "decision_waiting" | "blocked" | "quiet" | "shipped";

export interface AttentionItem {
  reason: AttentionReason;
  label: string;
  target: { type: "issue" | "approval" | "project" | "company"; ref: string } | null;
  source: RowSource | null;
}

export const ATTENTION_LIMIT = 5;
export const BRIEFING_MAX_CHARS = 600;

export interface BriefingDecision {
  approvalId: string;
  type: string;
  scopeLabel: string;
  source: RowSource;
}

export interface BriefingIssue {
  issueId: string;
  identifier: string | null;
  title: string;
  source: RowSource;
  prTitle?: string | null;
}

export interface BriefingInput {
  scopeName: string;
  since: Date;
  asOf: Date;
  /**
   * `breakdown` (project calls): "1 linked to X, 1 company-level, not tied
   * to X" — so a company-level decision is never read as the project's.
   */
  decisions: { total: number; items: BriefingDecision[]; breakdown?: string };
  blocked: { total: number; items: BriefingIssue[] };
  shipped: { total: number; items: BriefingIssue[] };
  changedTotal: number;
  quiet: { quiet: boolean; reason: string | null };
  truncated: boolean;
}

function humanType(type: string) {
  return type.replace(/[_.]+/g, " ").trim();
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Ordered decisions → blocked → quiet → shipped, at most five. Every item
 * points at a row already in the response and carries that row's source.
 */
export function buildAttention(input: BriefingInput & { quietTarget: AttentionItem["target"] }): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const d of input.decisions.items) {
    out.push({
      reason: "decision_waiting",
      label: `${humanType(d.type)} decision (${d.scopeLabel})`,
      target: { type: "approval", ref: d.approvalId },
      source: d.source,
    });
  }
  for (const b of input.blocked.items) {
    out.push({
      reason: "blocked",
      label: `${b.identifier ?? "task"} blocked: ${quoteTitle(b.title)}`,
      target: { type: "issue", ref: b.identifier ?? b.issueId },
      source: b.source,
    });
  }
  if (input.quiet.quiet) {
    out.push({ reason: "quiet", label: input.quiet.reason ?? "quiet", target: input.quietTarget, source: null });
  }
  for (const s of input.shipped.items) {
    out.push({
      reason: "shipped",
      label: `${s.identifier ?? "task"} finished: ${quoteTitle(s.title)}`,
      target: { type: "issue", ref: s.identifier ?? s.issueId },
      source: s.source,
    });
  }
  return out.slice(0, ATTENTION_LIMIT);
}

/**
 * 2–4 deterministic sentences, ≤600 chars, no LLM. Titles are quoted as
 * agent text, every status is attributed to who set it, sections are capped
 * to one named example each, and truncation is stated, never implied away.
 */
export function buildBriefing(input: BriefingInput): string {
  const full = composeBriefing(input, true);
  if (full.length <= BRIEFING_MAX_CHARS) return full;
  // Too long: drop the named examples before cutting anything mid-sentence.
  return clipText(composeBriefing(input, false), BRIEFING_MAX_CHARS);
}

function composeBriefing(input: BriefingInput, withExamples: boolean): string {
  const since = input.since.toISOString().replace(/\.\d{3}Z$/, "Z");
  const asOf = input.asOf.toISOString().replace(/\.\d{3}Z$/, "Z");
  const clauses: string[] = [];

  if (input.decisions.total > 0) {
    const first = withExamples ? input.decisions.items[0] : undefined;
    const detail = input.decisions.breakdown
      ? ` (${input.decisions.breakdown})`
      : first
        ? ` (${humanType(first.type)}, ${first.scopeLabel})`
        : "";
    clauses.push(
      `${plural(input.decisions.total, "decision")} ${input.decisions.total === 1 ? "waits" : "wait"} for you${detail}`,
    );
  } else {
    clauses.push("no decisions wait for you");
  }
  if (input.blocked.total > 0) {
    const first = withExamples ? input.blocked.items[0] : undefined;
    clauses.push(
      `${input.blocked.total} blocked${first ? ` (${first.identifier ?? "task"} ${quoteTitle(first.title, 50)}: ${attributionPhrase(first.source, "marked it blocked")})` : ""}`,
    );
  }
  clauses.push(`${plural(input.changedTotal, "recorded change")}`);
  if (input.shipped.total > 0) {
    const first = withExamples ? input.shipped.items[0] : undefined;
    clauses.push(
      `${input.shipped.total} finished${first ? ` (${quoteTitle(first.title, 50)}${first.prTitle ? `, PR ${quoteTitle(first.prTitle, 40)}` : ""}: ${attributionPhrase(first.source, "marked it done")})` : ""}`,
    );
  } else {
    clauses.push("nothing finished");
  }

  const sentences: string[] = [`At ${clipText(input.scopeName, 60)} since ${since}: ${clauses.join("; ")}.`];
  if (input.quiet.quiet && input.quiet.reason) sentences.push(`Quiet: ${input.quiet.reason}.`);
  sentences.push(`As of ${asOf}${input.truncated ? "; lists are capped, counts are complete" : ""}.`);

  return sentences.join(" ");
}
