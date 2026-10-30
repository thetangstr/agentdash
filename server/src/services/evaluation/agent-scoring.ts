import {
  AGENT_CARD_SCORECARD_KIND,
  AGENT_CARD_VERSION,
  AGENT_FATAL_CLASSES,
  AGENT_JUDGE_KINDS,
  AGENT_METRICS_VERSION,
  AGENT_OBLIGATION_END_STATES,
  agentCardReplayInputsSchema,
  EVALUATION_AGENT_SOURCE_EVENT_TYPES,
  EVALUATOR_READ_ONLY_REASON,
  evaluationCriterionAttestBindingSchema,
  evaluationCriterionRefKey,
  evaluationCriterionRefSchema,
  evaluationTypedPredicate,
  evaluationWorkItemRefSchema,
  type AgentCardAccountableResult,
  type AgentCardContractSummary,
  type AgentCardCriterionRow,
  type AgentCardDependencyCitation,
  type AgentCardDisagreement,
  type AgentCardException,
  type AgentCardFactCount,
  type AgentCardFatalFlag,
  type AgentCardGap,
  type AgentCardJudgeTally,
  type AgentCardObligationRow,
  type AgentCardReviewerSection,
  type AgentCardStoredSection,
  type AgentCardV1,
  type AgentAcceptanceFact,
  type AgentJudgeKind,
  type AgentJudgmentResult,
  type AgentObligationEndState,
  type AgentObligationOccurrence,
  type AgentObligationOccurrenceKind,
  type AgentPerformanceWindow,
  type EvaluationAccessClass,
  type EvaluationContractV2,
  type EvaluationCoverageClass,
  type EvaluationCriterionRef,
  type EvaluationMilestoneRef,
  type EvaluationSourceTier,
  type EvaluationTypedPredicate,
  type EvaluationWorkItemRef,
} from "@paperclipai/shared";
import { hashCanonical, orderEvents, type EvaluationEventRow } from "./ledger.js";
import { calibrationSampleFrom, criterionToken, type CalibrationSampleItem } from "./calibration.js";
import {
  agentContractOf,
  buildAgentObligationTimeline,
  generateOwedOccurrences,
  producerAtDelivery,
  QUESTION_KINDS,
  type AgentObligationTimeline,
  type DeliverableRunFact,
  type ProfileInForce,
} from "./agent-obligations.js";
import { cardHash } from "./scoring/card.js";
import { resolveContract } from "./scoring/contract.js";
import { evidenceForItem, type ClassResult, type ItemEvidence } from "./scoring/evidence.js";
import { isSyntheticUser, REVIEW_CLASS_HANDOFFS, reviewIndependence } from "./scoring/independence.js";
import {
  assigneeAt,
  buildTimeline,
  doneAt,
  isEvaluatorOutput,
  latestGoal,
  latestProject,
  latestSnapshot,
  membership,
  median,
  num,
  obj,
  projectAt,
  snapshotAt,
  str,
  terminalAt,
  TERMINAL_STATUSES,
  type ItemTimeline,
  type Payload,
  type Timeline,
} from "./scoring/timeline.js";
import type { ScoredCard } from "./scoring/types.js";
import type { StoredAgentCase } from "./agent-cards.js";

/**
 * AgentDash: Agent Performance Management gate 3 — the agent card's scoring
 * (evaluation LLD §5–§8, formula version `agent-metrics/1`). P3.1 froze the
 * signatures; P3.3 implements them.
 *
 * Pure and replayable: a card is a function of the ledger rows `seq ≤
 * throughSeq` and the stored replay inputs (`throughSeq`, `asOf`, `window`,
 * `dependencies`). No wall clock, no live table, no stored card is read.
 * Roles are re-derived from the timeline (`subject_agent_id` is only a lookup
 * hint). Agent semantics differ from the milestone formulas where LLD §6.3
 * says so (P6 split into refused / repeated / unauthorized; P1 respects
 * `expectedHumanSteps`; judge independence apart from source diversity;
 * rework charged to the producer). Milestone formulas are untouched.
 *
 * Judgments carry the judge who decided, not the reader of the record: a
 * criterion such as `verdict.passed` is still satisfied by any qualified
 * independent judge, but a person's verdict is a person judgment and an
 * independent agent's verdict an independent-agent one, so automated and human
 * acceptance stay separate facts (LLD §1; found by the gate 3 walkthrough,
 * fixed before `agent-metrics/1` was ever released, so the version stays).
 *
 * Facts dated after `asOf` are not yet observed and are left out, so a replay
 * at the stored `asOf` sees exactly what the snapshot saw.
 *
 * A criterion checked by `use.confirmed` is about use, not acceptance: its
 * judgments (the evaluator's reading of the disposition, a bound attestation)
 * feed the use fact only, never automated or human acceptance (LLD §1; found
 * in P3.7 polish, before `agent-metrics/1` was released, so the version stays).
 */

/** A milestone card the caller recomputed with `scoreMilestone` from the SAME rows and cut, with its pinned citation. */
export interface AgentCardDependencyInput {
  citation: AgentCardDependencyCitation;
  card: ScoredCard;
}

export interface ScoreAgentInput {
  companyId: string;
  agentId: string;
  /**
   * Ledger rows of the company with `seq ≤ throughSeq`, any order (scoring
   * applies the rule-5 order). For a viewer projection, only the rows that
   * viewer may read (`viewerClassFilter`); for a stored card, all of them.
   */
  events: EvaluationEventRow[];
  throughSeq: number;
  /** ISO observation time: decides what is overdue. */
  asOf: string;
  /** `from ≤ to ≤ asOf`. */
  window: AgentPerformanceWindow;
  /** One per `accountableMilestoneRefs` result, sorted by kind then id; each cut at `throughSeq`. */
  dependencies: AgentCardDependencyInput[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO_PROJECT = "00000000-0000-4000-8000-000000000000";
const MAX_DELIVERED_ITEMS = 5000;

function payloadOf(e: EvaluationEventRow): Payload {
  return (e.payload ?? {}) as Payload;
}

function sortStrings(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort();
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function itemKey(ref: EvaluationWorkItemRef): string {
  return `${ref.kind}:${ref.id}`;
}

function sameItem(a: unknown, b: EvaluationWorkItemRef): boolean {
  const parsed = evaluationWorkItemRefSchema.safeParse(a);
  return parsed.success && parsed.data.kind === b.kind && parsed.data.id === b.id;
}

function checkHashOf(check: unknown): string {
  return hashCanonical({ check: check ?? null }).slice(0, 16);
}

/** The project and goal lead/owner intervals of one agent inside the window, from roster snapshots (not the end of the window). */
function holderIntervals(
  snapshots: Array<{ time: Date; holder: string | null }>,
  agentId: string,
  wFrom: number,
  wTo: number,
): Array<{ from: string; to: string | null }> {
  const out: Array<{ from: string; to: string | null }> = [];
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i]!;
    if (s.holder !== agentId) continue;
    if (i > 0 && snapshots[i - 1]!.holder === agentId) continue; // merged into the interval that started earlier
    let j = i + 1;
    while (j < snapshots.length && snapshots[j]!.holder === agentId) j++;
    const from = s.time.getTime();
    const to = j < snapshots.length ? snapshots[j]!.time.getTime() : null;
    if (from > wTo || (to !== null && to < wFrom)) continue;
    out.push({ from: new Date(Math.max(from, wFrom)).toISOString(), to: to === null || to > wTo ? null : new Date(to).toISOString() });
  }
  return out;
}

function leadIntervals(tl: Timeline, agentId: string, ref: EvaluationMilestoneRef, wFrom: number, wTo: number) {
  if (ref.kind === "project") {
    const list = (tl.projects.get(ref.id) ?? []).map((s) => ({ time: s.time, holder: s.leadAgentId }));
    return holderIntervals(list, agentId, wFrom, wTo).map((x) => ({ role: "lead" as const, ...x }));
  }
  const list = (tl.goals.get(ref.id) ?? []).map((s) => ({ time: s.time, holder: s.ownerAgentId }));
  return holderIntervals(list, agentId, wFrom, wTo).map((x) => ({ role: "owner" as const, ...x }));
}

/**
 * The projects the agent led and goals it owned at any time inside the
 * window, from roster snapshots in the rows (intervals, not the end of the
 * window). Pure. Sorted by kind, then id. The caller scores each with
 * `scoreMilestone` at the same cut to build `dependencies`.
 */
export function accountableMilestoneRefs(events: EvaluationEventRow[], agentId: string, window: AgentPerformanceWindow, throughSeq: number): EvaluationMilestoneRef[] {
  const tl = buildTimeline(orderEvents(events.filter((e) => Number(e.seq) <= throughSeq)));
  const wFrom = Date.parse(window.from);
  const wTo = Date.parse(window.to);
  const out: EvaluationMilestoneRef[] = [];
  for (const id of [...tl.goals.keys()].sort()) if (leadIntervals(tl, agentId, { kind: "goal", id }, wFrom, wTo).length > 0) out.push({ kind: "goal", id });
  for (const id of [...tl.projects.keys()].sort()) if (leadIntervals(tl, agentId, { kind: "project", id }, wFrom, wTo).length > 0) out.push({ kind: "project", id });
  return out.filter((r) => UUID_RE.test(r.id)).sort((a, b) => cmp(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
}

/**
 * Every ledger row a milestone card rests on: the rows scoped to it and every
 * event of its member items. A viewer may see a cited milestone result only
 * when they can read all of these (LLD §8, §9.1).
 */
export function milestoneDependencyRowIds(rows: EvaluationEventRow[], tl: Timeline, ref: EvaluationMilestoneRef): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (ref.kind === "project" ? r.projectId === ref.id : r.goalId === ref.id && r.projectId === null) ids.add(r.id);
  }
  for (const m of membership(tl, ref).members) for (const id of m.eventIds) ids.add(id);
  return [...ids].sort();
}

/**
 * Score one agent. Pure. The result carries the replay inputs it was given
 * (`replay`), the access classes each section rests on, fatal flags first,
 * the worker and reviewer sections apart, and no headline composite. Throws
 * when a dependency was not cut at `throughSeq` or `window.to > asOf`.
 */
export function scoreAgent(input: ScoreAgentInput): AgentCardV1 {
  return computeAgent(input).card;
}

/** The drill-down rows behind every number of the card `scoreAgent(input)` returns, each with the classes it rests on. Pure. */
export function agentCaseRows(input: ScoreAgentInput): StoredAgentCase[] {
  return computeAgent(input).cases;
}

/** sha256 of the canonical card JSON — the same hash domain as the milestone `cardHash`; verify compares these byte for byte. */
export function agentCardHash(card: AgentCardV1): string {
  return hashCanonical(card);
}

/** Two cards that differ only in `replay.asOf` and `replay.window` (the snapshot reuse rule). */
export function agentCardsEquivalent(a: AgentCardV1, b: AgentCardV1): boolean {
  const strip = (c: AgentCardV1) => ({ ...c, replay: { ...c.replay, asOf: null, window: null } });
  return hashCanonical(strip(a)) === hashCanonical(strip(b));
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

interface ContractInForce {
  eventId: string;
  at: Date;
  contract: EvaluationContractV2;
}

interface DeliveredItem {
  ref: EvaluationWorkItemRef;
  label: string | null;
  at: number;
  issue: ItemTimeline | null;
  run: DeliverableRunFact | null;
  producerAgentId: string | null;
  keys: string[];
  profileRevisionId: string | null;
  contract: ContractInForce | null;
  closeEventId: string | null;
}

interface Judgment {
  judge: AgentJudgeKind;
  result: Exclude<AgentJudgmentResult, "unknown">;
  eventId: string;
  at: string;
  tier: EvaluationSourceTier;
  refs: string[];
  /** A reviewer's decision the evaluator read off a record (a verdict, an escalation, the named approvals), attributed to that reviewer. */
  viaRecord?: true;
}

class ClassSet {
  private readonly set = new Set<string>();
  constructor(private readonly byId: Map<string, EvaluationEventRow>) {}
  row(id: string | null | undefined): void {
    if (!id) return;
    const r = this.byId.get(id);
    if (!r) return;
    this.set.add(typeof r.accessClass === "string" ? r.accessClass : "company");
    // the live restricted-project rule: a row of a project stays behind that project, whatever its stored class
    const pid = r.projectId?.toLowerCase() ?? null;
    if (pid && UUID_RE.test(pid)) this.set.add(`project:${pid}`);
  }
  rows(ids: Iterable<string | null | undefined>): void {
    for (const id of ids) this.row(id);
  }
  merge(other: ClassSet): void {
    for (const c of other.list()) this.set.add(c);
  }
  list(): EvaluationAccessClass[] {
    return [...this.set].sort() as EvaluationAccessClass[];
  }
}

function emptyByEndState(): Record<AgentObligationEndState, number> {
  return Object.fromEntries(AGENT_OBLIGATION_END_STATES.map((s) => [s, 0])) as Record<AgentObligationEndState, number>;
}

function emptyJudgeTallies(): Record<AgentJudgeKind, AgentCardJudgeTally> {
  return Object.fromEntries(AGENT_JUDGE_KINDS.map((k) => [k, { pass: 0, fail: 0, unknown: 0 }])) as Record<AgentJudgeKind, AgentCardJudgeTally>;
}

function fromClass(cls: ClassResult | undefined): { result: AgentJudgmentResult; refs: string[] } {
  if (!cls) return { result: "unknown", refs: [] };
  return { result: cls.state === "satisfied" ? "pass" : cls.state === "failed" ? "fail" : "unknown", refs: cls.refs };
}

const DELIVERED_STATES = new Set<AgentObligationEndState>(["delivered_on_time", "delivered_late"]);
const SEVERITY_RANK: Record<string, number> = { immediate: 0, material: 1, routine: 2 };

function computeAgent(input: ScoreAgentInput): { card: AgentCardV1; cases: StoredAgentCase[] } {
  const { companyId, agentId, throughSeq, asOf, window } = input;
  const replayParsed = agentCardReplayInputsSchema.safeParse({ throughSeq, asOf, window, dependencies: input.dependencies.map((d) => d.citation) });
  if (!replayParsed.success) throw new Error(`scoreAgent: invalid replay inputs: ${replayParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  for (const d of input.dependencies) {
    if (d.card.throughSeq !== throughSeq) throw new Error(`scoreAgent: dependency ${d.citation.kind}:${d.citation.id} was not cut at ${throughSeq}`);
    if (cardHash(d.card) !== d.citation.hash) throw new Error(`scoreAgent: dependency ${d.citation.kind}:${d.citation.id} does not match its citation hash`);
  }
  const replay = replayParsed.data;
  const now = Date.parse(asOf);
  const wFrom = Date.parse(window.from);
  const wTo = Date.parse(window.to);
  const inWindow = (t: number) => t >= wFrom && t <= wTo;

  const rows = orderEvents(input.events.filter((e) => Number(e.seq) <= throughSeq && e.eventTime.getTime() <= now));
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const base = buildTimeline(rows);
  const otl: AgentObligationTimeline = buildAgentObligationTimeline(rows, base, agentId);
  const occurrences = generateOwedOccurrences(window, otl, asOf);
  const cases: StoredAgentCase[] = [];

  // Rows about an issue or a deliverable run, across both folds (generous: the classes of a case or section).
  const issueRows = new Map<string, string[]>();
  const runRows = new Map<string, string[]>();
  const receiptsByIssue = new Map<string, EvaluationEventRow[]>();
  const decisionsByIssue = new Map<string, EvaluationEventRow[]>();
  for (const r of rows) {
    const p = payloadOf(r);
    const issue = str(p, "issueId");
    if (issue && r.eventType === "assessment.automated") receiptsByIssue.set(issue, [...(receiptsByIssue.get(issue) ?? []), r]);
    if (issue && r.eventType === "issue.execution_decision") decisionsByIssue.set(issue, [...(decisionsByIssue.get(issue) ?? []), r]);
    for (const k of ["issueId", "linkedIssueId"]) {
      const id = str(p, k);
      if (id) issueRows.set(id, [...(issueRows.get(id) ?? []), r.id]);
    }
    const run = str(p, "deliverableRunId");
    if (run) runRows.set(run, [...(runRows.get(run) ?? []), r.id]);
  }
  const rowsOfItem = (ref: EvaluationWorkItemRef | null): string[] => (!ref ? [] : ref.kind === "issue" ? (issueRows.get(ref.id) ?? []) : (runRows.get(ref.id) ?? []));
  const classesOf = (ids: Iterable<string | null | undefined>): EvaluationAccessClass[] => {
    const c = new ClassSet(byId);
    c.rows(ids);
    return c.list();
  };

  // ---- contracts and profiles ----
  const contracts: ContractInForce[] = [];
  for (const e of base.contracts) {
    const c = agentContractOf(e, agentId);
    if (c) contracts.push({ eventId: e.id, at: e.eventTime, contract: c });
  }
  const contractByRevision = new Map<string, ContractInForce>();
  for (const c of contracts) contractByRevision.set(c.contract.profileRevisionId, c);
  const latestContract = contracts[contracts.length - 1] ?? null;
  const profileAt = (t: number): ProfileInForce | null => otl.profiles.find((p) => p.from.getTime() <= t && (p.to === null || p.to.getTime() > t)) ?? null;
  const contractAt = (t: number): ContractInForce | null => {
    const p = profileAt(t);
    if (p) return contractByRevision.get(p.profileRevisionId) ?? null;
    if (otl.profiles.length > 0) return null;
    // no application on record: the latest contract declared by then is the one in force
    let found: ContractInForce | null = null;
    for (const c of contracts) if (c.at.getTime() <= t) found = c;
    return found;
  };
  const contractsInWindow: ContractInForce[] = [];
  {
    const seen = new Set<string>();
    for (const p of otl.profiles) {
      if (p.from.getTime() > wTo || (p.to !== null && p.to.getTime() <= wFrom)) continue;
      const c = contractByRevision.get(p.profileRevisionId);
      if (c && !seen.has(c.eventId)) {
        seen.add(c.eventId);
        contractsInWindow.push(c);
      }
    }
    if (otl.profiles.length === 0) {
      const c = contractAt(wTo);
      if (c) contractsInWindow.push(c);
    }
  }
  const accountableUserId = latestContract?.contract.accountableUserId ?? base.agents.get(agentId)?.accountableUserId ?? null;
  const criterionRef = (c: ContractInForce, key: string, criterion: { id: string; check?: unknown }): EvaluationCriterionRef => ({
    contractEventId: c.eventId,
    responsibilityKey: key,
    criterionId: criterion.id,
    checkHash: checkHashOf(criterion.check),
  });

  const contractSummary: AgentCardContractSummary = latestContract
    ? {
        source: "declared",
        contractVersion: "v2",
        contractEventId: latestContract.eventId,
        profileRevisionId: latestContract.contract.profileRevisionId,
        declaredAt: latestContract.at.toISOString(),
        accountableUserId: latestContract.contract.accountableUserId,
        responsibilities: latestContract.contract.responsibilities.map((r) => ({
          key: r.key,
          criteria: r.criteria.map((c) => ({ ref: criterionRef(latestContract, r.key, c), text: c.text, predicate: evaluationTypedPredicate(c.check) })),
          coverage: [...r.coverage],
          expectedHumanSteps: [...r.expectedHumanSteps],
          humanJudge: r.judges.human ? { ...r.judges.human } : null,
        })),
      }
    : { source: "none", contractVersion: "none", contractEventId: null, profileRevisionId: null, declaredAt: null, accountableUserId: null, responsibilities: [] };

  // ---- items and roles ----
  const items = [...base.items.values()].filter((it) => !isEvaluatorOutput(it)).sort((a, b) => cmp(a.issueId, b.issueId));
  const mappingsByIssue = new Map<string, typeof otl.mappings>();
  for (const m of otl.mappings) mappingsByIssue.set(m.issueId, [...(mappingsByIssue.get(m.issueId) ?? []), m]);
  const mappingsOf = (issueId: string) => mappingsByIssue.get(issueId) ?? [];
  const keysAt = (issueId: string, t: number) => sortStrings(mappingsOf(issueId).filter((m) => m.from.getTime() <= t && (m.to === null || m.to.getTime() >= t)).map((m) => m.responsibilityKey));
  const delivered: DeliveredItem[] = [];
  for (const it of items) {
    const d = doneAt(it);
    if (!d || !inWindow(d.getTime())) continue;
    const prod = producerAtDelivery(it);
    if (!prod || prod.agentId !== agentId) continue;
    const t = d.getTime();
    const occKeys = occurrences.filter((o) => o.matched?.issueId === it.issueId && DELIVERED_STATES.has(o.endState)).map((o) => o.responsibilityKey);
    const contract = contractAt(t);
    delivered.push({
      ref: { kind: "issue", id: it.issueId },
      label: it.identifier,
      at: t,
      issue: it,
      run: null,
      producerAgentId: agentId,
      keys: sortStrings([...occKeys, ...keysAt(it.issueId, t)]),
      profileRevisionId: profileAt(t)?.profileRevisionId ?? contract?.contract.profileRevisionId ?? null,
      contract,
      closeEventId: prod.eventId,
    });
  }
  for (const run of otl.deliverableRuns) {
    if (!run.shippedAt || !inWindow(run.shippedAt.getTime()) || run.assemblerAgentId !== agentId) continue;
    const t = run.shippedAt.getTime();
    const occKeys = occurrences.filter((o) => o.matched?.deliverableRunId === run.deliverableRunId).map((o) => o.responsibilityKey);
    const contract = contractAt(t);
    delivered.push({
      ref: { kind: "deliverable_run", id: run.deliverableRunId },
      label: run.runKey,
      at: t,
      issue: null,
      run,
      producerAgentId: agentId,
      keys: sortStrings(occKeys),
      profileRevisionId: profileAt(t)?.profileRevisionId ?? contract?.contract.profileRevisionId ?? null,
      contract,
      closeEventId: run.eventId,
    });
  }
  delivered.sort((a, b) => a.at - b.at || cmp(itemKey(a.ref), itemKey(b.ref)));
  const deliveredByKey = new Map(delivered.map((d) => [itemKey(d.ref), d] as const));

  /** The agent did recorded work on the item in the window: runs, non-review moves and hand-offs, taking the assignment. Not comments or views. */
  const workedOn = (it: ItemTimeline): boolean =>
    it.runs.some((r) => r.agentId === agentId && inWindow(r.time.getTime())) ||
    it.transitions.some((t) => t.actorType === "agent" && t.actorId === agentId && t.to !== "done" && inWindow(t.time.getTime())) ||
    it.handoffs.some((h) => h.actorType === "agent" && h.actorId === agentId && !REVIEW_CLASS_HANDOFFS.has(h.type) && inWindow(h.time.getTime())) ||
    it.assignments.some((a) => a.toAgentId === agentId && inWindow(a.time.getTime()));

  // ---- evidence helpers ----
  const evidenceCache = new Map<string, ItemEvidence>();
  const evidenceOf = (it: ItemTimeline): ItemEvidence => {
    let ev = evidenceCache.get(it.issueId);
    if (!ev) {
      const close = doneAt(it) ?? terminalAt(it)?.time ?? new Date(now);
      const projectId = projectAt(it, close);
      const goalId = snapshotAt(it, close)?.goalId ?? null;
      const ref: EvaluationMilestoneRef = projectId ? { kind: "project", id: projectId } : goalId ? { kind: "goal", id: goalId } : { kind: "project", id: ZERO_PROJECT };
      ev = evidenceForItem(it, base, resolveContract(base, ref, [it], companyId));
      evidenceCache.set(it.issueId, ev);
    }
    return ev;
  };
  const dispositions = base.dispositions.filter((d) => d.eventType === "evaluation.disposition");
  const dispositionKind = (d: EvaluationEventRow) => str(payloadOf(d), "kind");
  const useConfirmed = (ref: EvaluationWorkItemRef) =>
    dispositions.filter((d) => {
      const p = payloadOf(d);
      return dispositionKind(d) === "use_confirmed" && d.actorType === "user" && obj(p, "subjectRef")?.id === agentId && sameItem(p.item, ref);
    });
  const deliveredOccurrence = new Map<string, AgentObligationOccurrence>();
  for (const o of occurrences) {
    if (!DELIVERED_STATES.has(o.endState)) continue;
    const k = o.matched?.issueId ? `issue:${o.matched.issueId}` : o.matched?.deliverableRunId ? `deliverable_run:${o.matched.deliverableRunId}` : null;
    if (k && !deliveredOccurrence.has(k)) deliveredOccurrence.set(k, o);
  }
  const occurrenceFor = (ref: EvaluationWorkItemRef) => deliveredOccurrence.get(itemKey(ref)) ?? null;
  const receiptsOf = (issueId: string) => receiptsByIssue.get(issueId) ?? [];
  const executionDecisionsOf = (issueId: string) => decisionsByIssue.get(issueId) ?? [];
  const runPayload = (run: DeliverableRunFact): Payload => payloadOf(byId.get(run.eventId) ?? ({ payload: {} } as EvaluationEventRow));

  const responsibilityOf = (c: ContractInForce | null, key: string) => c?.contract.responsibilities.find((r) => r.key === key) ?? null;

  /** The records any case about a delivered item can cite, judged or not: its delivery, the issue record, its verdicts, its deliverable run. */
  const itemEvidence = (item: DeliveredItem): string[] => {
    const ids: Array<string | null | undefined> = [item.closeEventId];
    if (item.issue) {
      ids.push(latestSnapshot(item.issue)?.eventId);
      for (const v of item.issue.verdicts) ids.push(v.eventId);
    }
    if (item.run) ids.push(item.run.eventId);
    return [...new Set(ids.filter((id): id is string => !!id && byId.has(id)))];
  };

  /** The evaluator's reading of a typed predicate for one item; null when another judge owns the predicate. */
  const evaluatorJudgment = (pred: EvaluationTypedPredicate, item: DeliveredItem): { result: AgentJudgmentResult; refs: string[]; tier: EvaluationSourceTier } | null => {
    const unknown = { result: "unknown" as const, refs: [] as string[], tier: "T0" as EvaluationSourceTier };
    switch (pred.kind) {
      case "record": {
        const it = item.issue;
        switch (pred.predicate) {
          // the milestone predicates read exactly the evidence class they resolve to today
          case "verdict.passed":
            return it ? { ...fromClass(evidenceOf(it).classes.neutral_verdict), tier: "T0" } : unknown;
          case "pr.merged":
            return it ? { ...fromClass(evidenceOf(it).classes.delivery_ref), tier: "T2" } : unknown;
          case "ci.green":
            return it ? { ...fromClass(evidenceOf(it).classes.ci_green), tier: "T2" } : unknown;
          case "dod.present":
            return it ? { ...fromClass(evidenceOf(it).classes.dod_present), tier: "T0" } : unknown;
          // the agent predicates read only their own records: a shipped deliverable never satisfies pr.merged
          case "deliverable.shipped": {
            const run = item.run;
            if (!run) return unknown;
            if (run.shippedAt && run.shippedAt.getTime() <= now) return { result: "pass", refs: [run.eventId], tier: "T0" };
            return run.status === "abandoned" ? { result: "fail", refs: [run.eventId], tier: "T0" } : unknown;
          }
          case "deliverable.checks_passed": {
            const run = item.run;
            if (!run || run.checkPassed === null) return unknown;
            return { result: run.checkPassed ? "pass" : "fail", refs: [run.eventId], tier: "T0" };
          }
          case "deliverable.approved": {
            const run = item.run;
            if (!run) return unknown;
            const p = runPayload(run);
            const ok = (at: string, who: string) => !!str(p, at) && !!str(p, who) && !isSyntheticUser(str(p, who));
            if (ok("firstApprovedAt", "firstApproverUserId") && ok("secondApprovedAt", "secondApproverUserId")) return { result: "pass", refs: [run.eventId], tier: "T0" };
            return run.status === "abandoned" ? { result: "fail", refs: [run.eventId], tier: "T0" } : unknown;
          }
          case "harness.criterion_passed":
            return null;
          case "obligation.on_time": {
            const o = occurrenceFor(item.ref);
            if (!o) return unknown;
            return { result: o.endState === "delivered_on_time" ? "pass" : "fail", refs: o.evidenceRefs.slice(0, 5), tier: "T0" };
          }
          case "use.confirmed": {
            const uses = useConfirmed(item.ref);
            return uses.length > 0 ? { result: "pass", refs: [uses[uses.length - 1]!.id], tier: "T0" } : unknown;
          }
        }
        return unknown;
      }
      case "status": {
        const id =
          pred.subject === "project"
            ? item.issue
              ? projectAt(item.issue, new Date(item.at))
              : null
            : item.issue
              ? (snapshotAt(item.issue, new Date(item.at))?.goalId ?? null)
              : null;
        if (!id) return unknown;
        const snap = pred.subject === "project" ? latestProject(base, id) : latestGoal(base, id);
        if (!snap) return unknown;
        return { result: snap.status === pred.value ? "pass" : "fail", refs: [snap.eventId], tier: "T0" };
      }
      case "goal_metric": {
        const snaps = (base.goals.get(pred.goalId) ?? []).filter((s) => {
          const u = s.lastUpdatedAt ? Date.parse(s.lastUpdatedAt) : Number.NaN;
          return typeof s.currentValue === "number" && Number.isFinite(u) && inWindow(u);
        });
        const last = snaps[snaps.length - 1];
        if (!last) return unknown;
        return { result: (last.currentValue as number) >= pred.target ? "pass" : "fail", refs: [last.eventId], tier: "T0" };
      }
      case "human_attest":
        return null;
      default:
        return unknown;
    }
  };

  /**
   * `verdict.passed` by who decided. The record still reads the milestone `neutral_verdict` class unchanged (any
   * independent passed verdict before close satisfies the criterion), but each decision is its reviewer's: a real
   * person's verdict or approved escalation is a person judgment, an independent agent's verdict an
   * independent-agent judgment. A kind that decided independently before close (the `independent_review` refs)
   * without passing fails, even when another kind passed: both stay, as a disagreement.
   */
  const verdictReviewerJudgments = (it: ItemTimeline, tier: EvaluationSourceTier): Judgment[] => {
    const { neutral_verdict: nv, independent_review: ir } = evidenceOf(it).classes;
    const passed = new Set(nv?.state === "satisfied" ? nv.refs : []);
    const decided = new Set(ir?.state === "satisfied" ? ir.refs : []);
    const by = new Map<"person" | "independent_agent", { pass: Array<{ id: string; at: Date }>; fail: Array<{ id: string; at: Date }> }>();
    const add = (kind: "person" | "independent_agent", result: "pass" | "fail", id: string, at: Date) => {
      const d = by.get(kind) ?? { pass: [], fail: [] };
      d[result].push({ id, at });
      by.set(kind, d);
    };
    for (const v of it.verdicts) {
      const kind = v.reviewerAgentId ? "independent_agent" : "person";
      if (passed.has(v.eventId)) add(kind, "pass", v.eventId, v.time);
      else if (decided.has(v.eventId) && (v.outcome === "failed" || v.outcome === "revision_requested")) add(kind, "fail", v.eventId, v.time);
    }
    for (const a of it.approvals) {
      if (a.kind !== "decided" || a.actorType !== "user" || a.type !== "verdict_escalation") continue;
      if (passed.has(a.eventId)) add("person", "pass", a.eventId, a.time);
      else if (decided.has(a.eventId) && (a.decision === "rejected" || a.decision === "revision_requested")) add("person", "fail", a.eventId, a.time);
    }
    const out: Judgment[] = [];
    for (const kind of ["person", "independent_agent"] as const) {
      const d = by.get(kind);
      if (!d) continue;
      const list = d.pass.length > 0 ? d.pass : d.fail;
      out.push({ judge: kind, result: d.pass.length > 0 ? "pass" : "fail", eventId: list[0]!.id, at: list[0]!.at.toISOString(), tier, refs: list.map((x) => x.id), viaRecord: true });
    }
    return out;
  };

  /**
   * The judgments a typed predicate yields for one item, each with the judge who actually decided (LLD §1: automated
   * and human acceptance stay separate facts, and the acceptance section reads them by judge). The evaluator reads
   * every record; when the record is a reviewer's decision the judgment is that reviewer's (`verdict.passed` above;
   * `deliverable.approved` passes only on two real people's approvals, so its pass is a person judgment). The
   * evaluator keeps a judgment of its own for machine records, and for a reviewer record that failed with no
   * reviewer to attribute it to (no verdict, only a self-review or a late one, an abandoned run).
   */
  const recordJudgments = (pred: EvaluationTypedPredicate, item: DeliveredItem): Judgment[] => {
    const ev = evaluatorJudgment(pred, item);
    if (!ev || ev.result === "unknown") return [];
    const evaluator: Judgment = { judge: "evaluator", result: ev.result, eventId: ev.refs[0] ?? item.closeEventId ?? item.ref.id, at: new Date(item.at).toISOString(), tier: ev.tier, refs: ev.refs };
    if (pred.kind === "record" && pred.predicate === "deliverable.approved" && ev.result === "pass") return [{ ...evaluator, judge: "person", viaRecord: true }];
    if (pred.kind !== "record" || pred.predicate !== "verdict.passed" || !item.issue) return [evaluator];
    const reviewers = verdictReviewerJudgments(item.issue, ev.tier);
    if (reviewers.length > 0) return reviewers;
    return ev.result === "fail" ? [evaluator] : [];
  };

  /** Bound person judgments: `criterion_attest` naming this tuple, subject and item, by a named attester who is independent of the item. */
  const independenceTally = { independent: 0, notIndependent: 0, unknown: 0 };
  const personJudgment = (ref: EvaluationCriterionRef, item: DeliveredItem, attesters: Set<string>): { judgment: Judgment | null; eventIds: string[] } => {
    const key = evaluationCriterionRefKey(ref);
    let found: EvaluationEventRow | null = null;
    const ids: string[] = [];
    for (const d of dispositions) {
      if (dispositionKind(d) !== "criterion_attest" || d.actorType !== "user" || !d.actorId) continue;
      const binding = evaluationCriterionAttestBindingSchema.safeParse(payloadOf(d).binding);
      if (!binding.success) continue;
      const b = binding.data;
      if (b.subjectRef.id !== agentId || evaluationCriterionRefKey(b.criterion) !== key || b.item.kind !== item.ref.kind || b.item.id !== item.ref.id) continue;
      if (!attesters.has(d.actorId)) continue;
      ids.push(d.id);
      found = d;
    }
    if (!found) return { judgment: null, eventIds: ids };
    const independent =
      !isSyntheticUser(found.actorId) &&
      (!item.issue || reviewIndependence({ actorType: "user", actorId: found.actorId }, item.issue, base, null, { entityType: "issue", at: found.eventTime, closeAt: terminalAt(item.issue)?.time ?? null }).independent);
    if (!independent) {
      independenceTally.notIndependent++;
      return { judgment: null, eventIds: ids };
    }
    independenceTally.independent++;
    const result = str(payloadOf(found), "result") === "satisfied" ? "pass" : "fail";
    return { judgment: { judge: "person", result, eventId: found.id, at: found.eventTime.toISOString(), tier: "T0", refs: [found.id] }, eventIds: ids };
  };

  /** Bound harness checks: a receipt check naming this criterion id under the contract in force when the receipt arrived. */
  const boundCheckKeys = new Set<string>();
  const harnessJudgment = (ref: EvaluationCriterionRef, item: DeliveredItem): Judgment | null => {
    if (!item.issue) return null;
    let foundRow: EvaluationEventRow | null = null;
    let foundOutcome: "pass" | "fail" | null = null;
    for (const r of receiptsOf(item.issue.issueId)) {
      const c = contractAt(r.eventTime.getTime());
      if (!c || c.eventId !== ref.contractEventId) continue;
      // the criterion id must name exactly one criterion among the item's responsibilities, or the check is ambiguous
      const named = item.keys.filter((k) => responsibilityOf(c, k)?.criteria.some((x) => x.id === ref.criterionId));
      if (named.length !== 1 || named[0] !== ref.responsibilityKey) continue;
      const checks = Array.isArray(payloadOf(r).checks) ? (payloadOf(r).checks as Payload[]) : [];
      for (let idx = 0; idx < checks.length; idx++) {
        const check = checks[idx]!;
        if (str(check, "criterionId") !== ref.criterionId) continue;
        boundCheckKeys.add(`${r.id}:${idx}`);
        const outcome = str(check, "outcome");
        if (outcome === "pass" || outcome === "fail") {
          foundRow = r;
          foundOutcome = outcome;
        }
      }
    }
    if (!foundRow || !foundOutcome) return null;
    return { judge: "harness", result: foundOutcome, eventId: foundRow.id, at: foundRow.eventTime.toISOString(), tier: "T2", refs: [foundRow.id] };
  };

  // ---- 1. obligations ----
  const obligationClasses = new ClassSet(byId);
  const rowKey = (key: string, rev: string | null) => `${key}\u0000${rev ?? ""}`;
  const obligationRows = new Map<string, AgentCardObligationRow & { _delivered: Map<string, EvaluationWorkItemRef> }>();
  const ensureRow = (key: string, rev: string | null) => {
    const k = rowKey(key, rev);
    let row = obligationRows.get(k);
    if (!row) {
      const profile = otl.profiles.find((p) => p.profileRevisionId === rev) ?? null;
      const r = profile?.responsibilities.find((x) => x.key === key) ?? null;
      let kind: AgentObligationOccurrenceKind | null = null;
      let note: string | null = null;
      if (r?.obligation.kind === "routine") {
        const versions = r.obligation.routineTriggerId ? (otl.triggers.get(r.obligation.routineTriggerId) ?? []) : [];
        kind = versions.length === 0 ? null : versions[versions.length - 1]!.kind === "schedule" ? "scheduled" : "received";
        if (versions.length === 0) note = "no trigger definition for this routine is in the records";
      } else if (r?.obligation.kind === "deliverable") {
        kind = "deliverable";
        note = "runs opened are owed; periods with no run are unknown (the cadence is free text)";
      } else if (r?.obligation.kind === "assigned") kind = "assigned";
      else if (r?.obligation.kind === "goal") {
        kind = "goal";
        if (r.deadline?.kind !== "by_date") note = "no contract date: a goal owes nothing countable without one";
      }
      row = { responsibilityKey: key, title: null, profileRevisionId: rev, kind, owed: kind === "deliverable" ? null : 0, byEndState: emptyByEndState(), deliveredByOtherProducer: 0, deliveredItems: [], deliveredItemCount: 0, note, _delivered: new Map() };
      obligationRows.set(k, row);
      if (profile) obligationClasses.row(profile.eventId);
    }
    return row;
  };
  for (const p of otl.profiles) {
    if (p.from.getTime() > wTo || (p.to !== null && p.to.getTime() <= wFrom)) continue;
    for (const r of p.responsibilities) ensureRow(r.key, p.profileRevisionId);
  }
  if (otl.profiles.length === 0) for (const c of contractsInWindow) for (const r of c.contract.responsibilities) ensureRow(r.key, c.contract.profileRevisionId);
  for (const o of occurrences) {
    const row = ensureRow(o.responsibilityKey, o.profileRevisionId);
    if (row.owed !== null) row.owed++;
    row.byEndState[o.endState]++;
    const itemRef: EvaluationWorkItemRef | null = o.matched?.issueId ? { kind: "issue", id: o.matched.issueId } : o.matched?.deliverableRunId ? { kind: "deliverable_run", id: o.matched.deliverableRunId } : null;
    if (DELIVERED_STATES.has(o.endState)) {
      if (o.producerAgentId && o.producerAgentId !== o.responsibleAgentId) row.deliveredByOtherProducer++;
      if (itemRef) row._delivered.set(itemKey(itemRef), itemRef);
    }
    const ids = [...o.evidenceRefs, ...rowsOfItem(itemRef)];
    obligationClasses.rows(ids);
    const label = itemRef?.kind === "issue" ? (base.items.get(itemRef.id)?.identifier ?? null) : itemRef ? (otl.deliverableRuns.find((x) => x.deliverableRunId === itemRef.id)?.runKey ?? null) : null;
    cases.push({
      caseId: o.occurrenceId,
      section: "obligations",
      responsibilityKey: o.responsibilityKey,
      state: o.endState,
      role: "responsible",
      item: itemRef,
      itemLabel: label,
      occurrenceId: o.occurrenceId,
      criterion: null,
      judge: null,
      at: o.deliveredAt ?? o.owedAt,
      evidenceRefs: [...o.evidenceRefs],
      note: o.note,
      accessClasses: classesOf(ids),
    });
  }
  for (const d of delivered) {
    for (const key of d.keys) {
      const row = ensureRow(key, d.profileRevisionId);
      row._delivered.set(itemKey(d.ref), d.ref);
    }
  }
  // unmapped work: what the agent produced or worked on in the window with no responsibility behind it
  const unmapped: EvaluationWorkItemRef[] = [];
  for (const it of items) {
    const produced = deliveredByKey.has(`issue:${it.issueId}`);
    if (!produced && !workedOn(it)) continue;
    const mapped = mappingsOf(it.issueId).some((m) => m.from.getTime() <= wTo && (m.to === null || m.to.getTime() >= wFrom));
    const owed = occurrences.some((o) => o.matched?.issueId === it.issueId);
    if (mapped || owed) continue;
    unmapped.push({ kind: "issue", id: it.issueId });
    obligationClasses.rows(it.eventIds);
    const ref: EvaluationWorkItemRef = { kind: "issue", id: it.issueId };
    const terminal = terminalAt(it);
    const state: AgentObligationEndState =
      terminal?.status === "done" ? "delivered_on_time" : terminal?.status === "cancelled" ? "cancelled" : it.transitions.some((t) => t.to === "in_progress") ? "in_progress" : "not_started";
    cases.push({
      caseId: `obligations:unmapped:${it.issueId}`,
      section: "obligations",
      responsibilityKey: null,
      state,
      role: produced ? "producer" : "contributor",
      item: ref,
      itemLabel: it.identifier,
      occurrenceId: null,
      criterion: null,
      judge: null,
      at: (terminal?.time ?? it.lastActivity ?? new Date(now)).toISOString(),
      evidenceRefs: it.eventIds.slice(-5),
      note: "work in this window that maps to no responsibility (no deadline applies)",
      accessClasses: classesOf(rowsOfItem(ref)),
    });
  }
  const obligationList: AgentCardObligationRow[] = [...obligationRows.values()]
    .sort((a, b) => cmp(a.responsibilityKey, b.responsibilityKey) || cmp(a.profileRevisionId ?? "", b.profileRevisionId ?? ""))
    .map(({ _delivered, ...row }) => {
      const list = [..._delivered.values()].sort((a, b) => cmp(itemKey(a), itemKey(b)));
      return { ...row, deliveredItems: list.slice(0, MAX_DELIVERED_ITEMS), deliveredItemCount: list.length };
    });

  // ---- 2. quality ----
  const qualityClasses = new ClassSet(byId);
  const criteriaRows: AgentCardCriterionRow[] = [];
  const disagreements: AgentCardDisagreement[] = [];
  const allJudgments = new Map<string, Judgment[]>(); // per item: every bound judgment across criteria, except use criteria
  const useJudgments = new Map<string, Judgment[]>(); // per item: judgments of `use.confirmed` criteria — they feed the use fact only
  const tierTally: Partial<Record<EvaluationSourceTier, number>> = {};
  const personByCriterionItem = new Map<string, Judgment>();
  const judgmentsByCriterionItem = new Map<string, Judgment[]>();
  for (const c of contractsInWindow) {
    qualityClasses.row(c.eventId);
    for (const r of c.contract.responsibilities) {
      const scope = delivered.filter((d) => d.contract?.eventId === c.eventId && d.keys.includes(r.key));
      for (const criterion of r.criteria) {
        const ref = criterionRef(c, r.key, criterion);
        const predicate = evaluationTypedPredicate(criterion.check);
        const usesOnly = predicate.kind === "record" && predicate.predicate === "use.confirmed";
        const tallies = emptyJudgeTallies();
        const attesters = new Set<string>();
        if (criterion.check?.kind === "human_attest") attesters.add(criterion.check.attesterUserId);
        if (r.judges.human) attesters.add(r.judges.human.userId);
        const token = criterionToken(ref);
        for (const item of scope) {
          qualityClasses.rows(rowsOfItem(item.ref));
          const judgments: Judgment[] = recordJudgments(predicate, item);
          const person = personJudgment(ref, item, attesters);
          qualityClasses.rows(person.eventIds);
          if (person.judgment) judgments.push(person.judgment);
          const harness = harnessJudgment(ref, item);
          if (harness) judgments.push(harness);
          // one count per judge kind per item: a person's verdict and a person's attestation are both person judgments
          const byKind = new Map<AgentJudgeKind, "pass" | "fail">();
          for (const j of judgments) byKind.set(j.judge, byKind.get(j.judge) === "pass" || j.result === "pass" ? "pass" : "fail");
          for (const [k, result] of byKind) tallies[k][result]++;
          const cite = itemEvidence(item);
          for (const j of judgments) {
            tierTally[j.tier] = (tierTally[j.tier] ?? 0) + 1;
            qualityClasses.rows(j.refs);
            const refs = j.refs.length > 0 ? [...j.refs] : cite;
            const caseIds = [...refs, ...rowsOfItem(item.ref)];
            cases.push({
              caseId: `quality:${token}:${item.ref.kind}:${item.ref.id}:${j.judge}${j.viaRecord ? ":record" : ""}`,
              section: "quality",
              responsibilityKey: r.key,
              state: j.result,
              role: "producer",
              item: item.ref,
              itemLabel: item.label,
              occurrenceId: occurrenceFor(item.ref)?.occurrenceId ?? null,
              criterion: ref,
              judge: j.judge,
              at: j.at,
              evidenceRefs: refs,
              note: null,
              accessClasses: classesOf(caseIds),
            });
          }
          if (judgments.length === 0) {
            cases.push({
              caseId: `quality:${token}:${item.ref.kind}:${item.ref.id}:unknown`,
              section: "quality",
              responsibilityKey: r.key,
              state: "unknown",
              role: "producer",
              item: item.ref,
              itemLabel: item.label,
              occurrenceId: occurrenceFor(item.ref)?.occurrenceId ?? null,
              criterion: ref,
              judge: null,
              at: new Date(item.at).toISOString(),
              // the item's own records, so the named attester has something to cite
              evidenceRefs: cite,
              note: predicate.kind === "none" ? "the criterion has no check" : "no bound judgment of this criterion",
              accessClasses: classesOf([...cite, ...rowsOfItem(item.ref)]),
            });
          }
          const ck = `${evaluationCriterionRefKey(ref)}|${itemKey(item.ref)}`;
          judgmentsByCriterionItem.set(ck, judgments);
          if (person.judgment) personByCriterionItem.set(ck, person.judgment);
          const bucket = usesOnly ? useJudgments : allJudgments;
          bucket.set(itemKey(item.ref), [...(bucket.get(itemKey(item.ref)) ?? []), ...judgments]);
          if (judgments.some((j) => j.result === "pass") && judgments.some((j) => j.result === "fail")) {
            const noted = dispositions.filter((d) => {
              const p = payloadOf(d);
              const crit = evaluationCriterionRefSchema.safeParse(p.criterion);
              return dispositionKind(d) === "disagreement_noted" && obj(p, "subjectRef")?.id === agentId && sameItem(p.item, item.ref) && crit.success && evaluationCriterionRefKey(crit.data) === evaluationCriterionRefKey(ref);
            });
            qualityClasses.rows(noted.map((d) => d.id));
            disagreements.push({
              criterion: ref,
              item: item.ref,
              judgments: judgments.map((j) => ({ judge: j.judge, result: j.result, eventId: j.eventId, at: j.at })),
              notedEventId: noted[noted.length - 1]?.id ?? null,
            });
          }
        }
        for (const k of AGENT_JUDGE_KINDS) tallies[k].unknown = scope.length - tallies[k].pass - tallies[k].fail;
        criteriaRows.push({ criterion: ref, text: criterion.text, predicate, items: scope.length, byJudge: tallies });
      }
    }
  }
  // judge independence over every review of the delivered work (who judged, related to the producer or not)
  for (const d of delivered) {
    const it = d.issue;
    if (!it) continue;
    const ctx = (at: Date) => ({ entityType: "issue" as const, at, closeAt: terminalAt(it)?.time ?? null, projectId: projectAt(it, at), goalId: snapshotAt(it, at)?.goalId ?? null });
    const judge = (actorType: string, actorId: string | null, at: Date, id: string) => {
      qualityClasses.row(id);
      if (!actorId) {
        independenceTally.unknown++;
        return;
      }
      const ind = reviewIndependence({ actorType, actorId }, it, base, null, ctx(at));
      if (ind.independent) independenceTally.independent++;
      else if (ind.reason === "no_actor") independenceTally.unknown++;
      else independenceTally.notIndependent++;
    };
    for (const v of it.verdicts) judge(v.reviewerAgentId ? "agent" : "user", v.reviewerAgentId ?? v.reviewerUserId, v.time, v.eventId);
    for (const h of it.handoffs) if (REVIEW_CLASS_HANDOFFS.has(h.type)) judge(h.actorType, h.actorId, h.time, h.eventId);
    for (const a of it.approvals) if (a.kind === "decided" && a.actorType === "user") judge("user", a.actorId, a.time, a.eventId);
    for (const x of executionDecisionsOf(it.issueId)) {
      const p = payloadOf(x);
      judge(str(p, "actorAgentId") ? "agent" : "user", str(p, "actorAgentId") ?? str(p, "actorUserId"), x.eventTime, x.id);
    }
    for (const r of receiptsOf(it.issueId)) {
      qualityClasses.row(r.id);
      independenceTally.unknown++; // a harness endpoint's relation to the producer is not on record
    }
  }
  // unbound automated observations: receipts on the agent's work that bind no criterion tuple
  let unboundObservations = 0;
  for (const it of items) {
    const produced = deliveredByKey.has(`issue:${it.issueId}`) || assigneeAt(it, new Date(now)).agentId === agentId;
    for (const r of receiptsOf(it.issueId)) {
      if (!inWindow(r.eventTime.getTime())) continue;
      const p = payloadOf(r);
      const paired = str(p, "pairedAgentId");
      if (!produced && paired !== agentId) continue;
      const checks = Array.isArray(p.checks) ? (p.checks as Payload[]) : [];
      // bound = some check names a criterion of the contract in force when the receipt arrived (LLD §5.3)
      const inForce = contractAt(r.eventTime.getTime());
      const criterionIds = new Set(inForce?.contract.responsibilities.flatMap((x) => x.criteria.map((y) => y.id)) ?? []);
      const bound = checks.some((check, idx) => boundCheckKeys.has(`${r.id}:${idx}`) || criterionIds.has(str(check, "criterionId") ?? "\u0000"));
      const role = produced ? ("producer" as const) : ("feedback_recipient" as const);
      if (produced && !bound) {
        unboundObservations++;
        qualityClasses.row(r.id);
      }
      if (!bound) {
        cases.push({
          caseId: `quality:${r.id}`,
          section: "quality",
          responsibilityKey: null,
          state: "unknown",
          role,
          item: { kind: "issue", id: it.issueId },
          itemLabel: it.identifier,
          occurrenceId: null,
          criterion: null,
          judge: "harness",
          at: r.eventTime.toISOString(),
          evidenceRefs: [r.id],
          note: role === "producer" ? "unbound automated observation: it names no criterion tuple, so it satisfies no criterion" : "harness feedback to this agent on work it did not produce: not a performance fact",
          accessClasses: classesOf([r.id, ...rowsOfItem({ kind: "issue", id: it.issueId })]),
        });
      }
    }
  }
  // rework is charged to the producer, never to a reviewer of the item (LLD §6.3)
  let reworkItems = 0;
  let reopened = 0;
  for (const d of delivered) {
    const it = d.issue;
    if (!it) continue;
    const firstDone = it.transitions.find((t) => t.to === "done")?.time ?? null;
    const reopens = it.transitions.filter((t) => t.from === "done" && !TERMINAL_STATUSES.has(t.to) && (!firstDone || t.time >= firstDone)).length;
    const revisions = it.verdicts.filter((v) => v.outcome === "revision_requested").length + it.handoffs.filter((h) => (num(h.payload, "fix_attempt") ?? 0) > 1).length;
    if (reopens + revisions > 0) reworkItems++;
    reopened += reopens;
  }

  // ---- 3. acceptance, use, outcome ----
  const acceptanceClasses = new ClassSet(byId);
  const facts = {
    automatedAcceptance: { yes: 0, no: 0, unknown: 0, of: 0 } as AgentCardFactCount,
    humanAcceptance: { yes: 0, no: 0, unknown: 0, of: 0 } as AgentCardFactCount,
    use: { yes: 0, no: 0, unknown: 0, of: 0 } as AgentCardFactCount,
    outcome: { yes: 0, no: 0, unknown: 0, of: 0 } as AgentCardFactCount,
  };
  const byResponsibility: Record<string, number> = {};
  const tallyFact = (f: AgentCardFactCount, v: "yes" | "no" | "unknown") => {
    f[v]++;
    f.of++;
  };
  const FACT_NOTE: Record<AgentAcceptanceFact, string> = { automated: "automated acceptance", human: "human acceptance", use: "use", outcome: "outcome" };
  const factCase = (fact: AgentAcceptanceFact, d: DeliveredItem, v: "yes" | "no" | "unknown", refs: string[]) => {
    cases.push({
      caseId: `acceptance:${FACT_NOTE[fact]}:${d.ref.kind}:${d.ref.id}`,
      section: "acceptance",
      responsibilityKey: d.keys[0] ?? null,
      state: v === "yes" ? "pass" : v === "no" ? "fail" : "unknown",
      role: "producer",
      item: d.ref,
      itemLabel: d.label,
      occurrenceId: occurrenceFor(d.ref)?.occurrenceId ?? null,
      criterion: null,
      judge: null,
      fact,
      at: new Date(d.at).toISOString(),
      evidenceRefs: refs,
      note: FACT_NOTE[fact],
      accessClasses: classesOf([...refs, ...rowsOfItem(d.ref)]),
    });
  };
  for (const d of delivered) {
    acceptanceClasses.rows(rowsOfItem(d.ref));
    for (const k of d.keys) byResponsibility[k] = (byResponsibility[k] ?? 0) + 1;
    // `use.confirmed` criteria are not in `js`: they decide use, never acceptance (LLD §1)
    const js = allJudgments.get(itemKey(d.ref)) ?? [];
    // judge-type-specific (LLD §1): automated acceptance reads only automated judges, so a person's verdict that
    // satisfies a `verdict.passed` criterion is a human acceptance and never an automated one
    const automated = js.filter((j) => j.judge === "evaluator" || j.judge === "harness" || j.judge === "independent_agent");
    const auto = automated.some((j) => j.result === "fail") ? "no" : automated.some((j) => j.result === "pass") ? "yes" : "unknown";
    tallyFact(facts.automatedAcceptance, auto);
    factCase("automated", d, auto, automated.map((j) => j.eventId));
    // human acceptance: the latest human decision on the item decides (a real, non-synthetic person's; never an agent's)
    const human: Array<{ at: number; yes: boolean; id: string }> = [];
    // person judgments read off a verdict, escalation or the named approvals are the decisions read directly below
    for (const j of js) if (j.judge === "person" && !j.viaRecord) human.push({ at: Date.parse(j.at), yes: j.result === "pass", id: j.eventId });
    if (d.issue) {
      const it = d.issue;
      for (const v of it.verdicts) {
        if (v.reviewerAgentId || !v.reviewerUserId || isSyntheticUser(v.reviewerUserId)) continue;
        if (!reviewIndependence({ actorType: "user", actorId: v.reviewerUserId }, it, base, null, { entityType: "issue", at: v.time }).independent) continue;
        if (v.outcome === "passed") human.push({ at: v.time.getTime(), yes: true, id: v.eventId });
        else if (v.outcome === "failed" || v.outcome === "revision_requested") human.push({ at: v.time.getTime(), yes: false, id: v.eventId });
      }
      for (const a of it.approvals) {
        if (a.kind !== "decided" || a.actorType !== "user" || isSyntheticUser(a.actorId)) continue;
        if (a.decision === "approved") human.push({ at: a.time.getTime(), yes: true, id: a.eventId });
        else if (a.decision === "rejected" || a.decision === "revision_requested") human.push({ at: a.time.getTime(), yes: false, id: a.eventId });
      }
      for (const x of executionDecisionsOf(it.issueId)) {
        const p = payloadOf(x);
        const user = str(p, "actorUserId");
        if (str(p, "actorAgentId") || !user || isSyntheticUser(user)) continue;
        const outcome = str(p, "outcome");
        if (outcome === "approved") human.push({ at: x.eventTime.getTime(), yes: true, id: x.id });
        else if (outcome === "changes_requested") human.push({ at: x.eventTime.getTime(), yes: false, id: x.id });
      }
    } else if (d.run) {
      const ev = evaluatorJudgment({ kind: "record", predicate: "deliverable.approved", coverage: "human_acceptance" }, d);
      if (ev?.result === "pass") human.push({ at: d.at, yes: true, id: d.run.eventId });
    }
    human.sort((a, b) => a.at - b.at || cmp(a.id, b.id));
    const lastHuman = human[human.length - 1];
    const hv = lastHuman ? (lastHuman.yes ? "yes" : "no") : "unknown";
    tallyFact(facts.humanAcceptance, hv);
    acceptanceClasses.rows(human.map((h) => h.id));
    factCase("human", d, hv, human.map((h) => h.id));
    // use: a person's `use_confirmed`, or a judgment of a `use.confirmed` criterion (a bound "not used" attestation is a no)
    const uses = useConfirmed(d.ref);
    const useJs = useJudgments.get(itemKey(d.ref)) ?? [];
    const useRefs = [...new Set([...uses.map((u) => u.id), ...useJs.map((j) => j.eventId)])];
    acceptanceClasses.rows(useRefs);
    const uv = uses.length > 0 || useJs.some((j) => j.result === "pass") ? "yes" : useJs.some((j) => j.result === "fail") ? "no" : "unknown";
    tallyFact(facts.use, uv);
    factCase("use", d, uv, useRefs);
    // outcome: a goal the responsibility links to reached its result (context, not a causal share)
    const goals = sortStrings(d.keys.flatMap((k) => responsibilityOf(d.contract, k)?.outcomeLinks.map((l) => l.goalId) ?? []));
    let ov: "yes" | "no" | "unknown" = "unknown";
    const outcomeRefs: string[] = [];
    for (const g of goals) {
      const snap = latestGoal(base, g);
      if (!snap) continue;
      outcomeRefs.push(snap.eventId);
      if (snap.status === "achieved") ov = "yes";
      else if (snap.status === "cancelled" && ov === "unknown") ov = "no";
    }
    acceptanceClasses.rows(outcomeRefs);
    tallyFact(facts.outcome, ov);
    factCase("outcome", d, ov, outcomeRefs);
  }
  const accountable: AgentCardAccountableResult[] = [];
  for (const dep of input.dependencies) {
    const ref: EvaluationMilestoneRef = { kind: dep.citation.kind, id: dep.citation.id };
    acceptanceClasses.rows(milestoneDependencyRowIds(rows, base, ref));
    accountable.push({
      ref,
      name: ref.kind === "project" ? (latestProject(base, ref.id)?.name ?? null) : (latestGoal(base, ref.id)?.title ?? null),
      intervals: leadIntervals(base, agentId, ref, wFrom, wTo),
      citation: { ...dep.citation },
      outcome: { ...dep.card.outcome },
    });
  }

  // ---- 4. cost and burden ----
  const costClasses = new ClassSet(byId);
  const agentRuns = [...items.flatMap((it) => it.runs), ...base.unattributedRuns].filter((r) => r.agentId === agentId && inWindow(r.time.getTime()));
  const agentCosts = [...items.flatMap((it) => it.costs), ...base.unattributedCosts].filter((c) => c.agentId === agentId && inWindow(c.time.getTime()));
  const anyCostInWindow = rows.find((r) => r.eventType === "cost.recorded" && inWindow(r.eventTime.getTime())) ?? null;
  costClasses.row(anyCostInWindow?.id);
  costClasses.rows(agentRuns.map((r) => r.eventId));
  costClasses.rows(agentCosts.map((c) => c.eventId));
  const sumCents = (xs: Array<{ costCents: number | null }>) => xs.reduce((n, c) => n + (c.costCents ?? 0), 0);
  const unattributed = base.unattributedCosts.filter((c) => c.agentId === agentId && inWindow(c.time.getTime()));
  const runsWithoutIssue = base.unattributedRuns.filter((r) => r.agentId === agentId && inWindow(r.time.getTime())).length;
  const questions = new Map<string, { status: string | null; pendingMs: number | null; eventId: string; resolver: string | null }>();
  for (const it of items) {
    for (const x of it.interactions) {
      if (x.createdByAgentId !== agentId || !x.kind || !QUESTION_KINDS.has(x.kind)) continue;
      const created = x.createdAt?.getTime() ?? x.time.getTime();
      if (!inWindow(created)) continue;
      const raw = byId.get(x.eventId);
      questions.set(x.interactionId ?? x.eventId, { status: x.status, pendingMs: x.pendingMs, eventId: x.eventId, resolver: raw ? str(payloadOf(raw), "resolvedByUserId") : null });
    }
  }
  costClasses.rows([...questions.values()].map((q) => q.eventId));
  const answered = [...questions.values()].filter((q) => q.status !== null && q.status !== "pending");
  const waits = answered.map((q) => q.pendingMs).filter((m): m is number => typeof m === "number").map((m) => m / 60_000);
  const medianWait = median(waits);
  const byPerson = new Map<string, { questions: number; reviews: number; corrections: number }>();
  const person = (u: string) => {
    let x = byPerson.get(u);
    if (!x) {
      x = { questions: 0, reviews: 0, corrections: 0 };
      byPerson.set(u, x);
    }
    return x;
  };
  for (const q of answered) if (q.resolver) person(q.resolver).questions++;
  // P1 (LLD §6.3): steps the contract expects are not interventions; only unplanned human edits, corrections or completions are
  let humanReviewActions = 0;
  let humanCorrections = 0;
  for (const d of delivered) {
    const it = d.issue;
    if (!it) continue;
    const expected = new Set(d.keys.flatMap((k) => responsibilityOf(d.contract, k)?.expectedHumanSteps ?? []));
    const review = (u: string | null, id: string) => {
      humanReviewActions++;
      costClasses.row(id);
      if (u) person(u).reviews++;
    };
    const correction = (u: string | null, id: string) => {
      humanCorrections++;
      costClasses.row(id);
      if (u) person(u).corrections++;
    };
    for (const v of it.verdicts) if (!v.reviewerAgentId && v.reviewerUserId) review(v.reviewerUserId, v.eventId);
    for (const a of it.approvals) if (a.kind === "decided" && a.actorType === "user") review(a.actorId, a.eventId);
    for (const x of executionDecisionsOf(it.issueId)) {
      const p = payloadOf(x);
      if (!str(p, "actorAgentId") && str(p, "actorUserId")) review(str(p, "actorUserId"), x.id);
    }
    for (const j of [...(allJudgments.get(itemKey(d.ref)) ?? []), ...(useJudgments.get(itemKey(d.ref)) ?? [])]) if (j.judge === "person") review(byId.get(j.eventId)?.actorId ?? null, j.eventId);
    const ownedFrom = it.assignments.find((a) => a.toAgentId === agentId)?.time ?? it.snapshots[0]?.time ?? new Date(0);
    const until = new Date(d.at);
    const during = (t: Date) => t >= ownedFrom && t <= until;
    const wasInReview = (t: Date) => it.transitions.some((x) => x.to === "in_review" && x.time <= t);
    for (const tr of it.transitions) {
      if (tr.actorType !== "user" || !during(tr.time)) continue;
      if (tr.to === "done" && wasInReview(tr.time) && expected.has("sign_off")) review(tr.actorId, tr.eventId);
      else correction(tr.actorId, tr.eventId);
    }
    for (const a of it.assignments) {
      if (a.actorType !== "user" || !during(a.time)) continue;
      if (a.toAgentId === agentId && !a.fromAgentId) continue; // the initial hand to the agent is not an intervention
      correction(a.actorId, a.eventId);
    }
    for (const b of it.blockers) if (b.actorType === "user" && during(b.time)) correction(b.actorId, b.eventId);
    for (const c of it.comments) if (c.actorType === "user" && c.reopened && during(c.time)) correction(c.actorId, c.eventId);
  }
  for (const r of rows) {
    if (r.eventType !== "correction.recorded" || !inWindow(r.eventTime.getTime())) continue;
    const p = payloadOf(r);
    if (str(p, "agentId") !== agentId || r.actorType !== "user") continue;
    humanCorrections++;
    costClasses.row(r.id);
    if (r.actorId) person(r.actorId).corrections++;
  }

  // ---- 5. bounds ----
  const boundsClasses = new ClassSet(byId);
  const byDimension: Record<string, { refused: number; repeated: number; wouldRefuse: number; unauthorized: number }> = {};
  const dim = (d: string) => (byDimension[d] ??= { refused: 0, repeated: 0, wouldRefuse: 0, unauthorized: 0 });
  const refusalKey = (p: Payload) => {
    const d = str(p, "dimension");
    const target = p.target === undefined || p.target === null ? null : hashCanonical(p.target);
    return d ? `${d}|${target ?? str(p, "rule") ?? ""}` : `legacy|${str(p, "reasonCode") ?? ""}|${str(p, "method") ?? ""} ${str(p, "routePath") ?? ""}`;
  };
  const refusals = base.authzRefused.filter((r) => r.actorType === "agent" && r.actorId === agentId && str(r.payload, "reasonCode") !== EVALUATOR_READ_ONLY_REASON);
  let refusedAttempts = 0;
  let repeatedAfterRefusal = 0;
  const exceptions: AgentCardException[] = [];
  const seenRefusal = new Map<string, string>();
  for (const r of refusals) {
    const k = refusalKey(r.payload);
    const prior = seenRefusal.get(k) ?? null;
    if (!seenRefusal.has(k)) seenRefusal.set(k, r.eventId);
    boundsClasses.row(r.eventId);
    if (!inWindow(r.time.getTime())) continue;
    const d = str(r.payload, "dimension") ?? "legacy";
    refusedAttempts++;
    dim(d).refused++;
    const item: EvaluationWorkItemRef | null = r.issueId ? { kind: "issue", id: r.issueId } : null;
    const ids = [r.eventId, ...(prior ? [prior] : []), ...rowsOfItem(item)];
    if (prior) {
      repeatedAfterRefusal++;
      dim(d).repeated++;
      exceptions.push({
        kind: "repeated_after_refusal",
        key: `repeated_after_refusal:${agentId}:${r.eventId}`,
        severity: "material",
        routeToUserId: accountableUserId,
        item,
        criterion: null,
        raisedAt: r.time.toISOString(),
        evidenceRefs: [prior, r.eventId],
        note: "the same request was made again after it was refused",
      });
    }
    cases.push({
      caseId: `bounds:${r.eventId}`,
      section: "bounds",
      responsibilityKey: null,
      state: prior ? "repeated_after_refusal" : "refused",
      role: "producer",
      item,
      itemLabel: item ? (base.items.get(item.id)?.identifier ?? null) : null,
      occurrenceId: null,
      criterion: null,
      judge: null,
      at: r.time.toISOString(),
      evidenceRefs: prior ? [prior, r.eventId] : [r.eventId],
      note: prior ? "repeated after a refusal of the same request" : "a refused attempt (an attempt, not misconduct)",
      accessClasses: classesOf(ids),
    });
  }
  let wouldRefuse = 0;
  let unauthorizedExecution = 0;
  const fatal: AgentCardFatalFlag[] = [];
  for (const r of rows) {
    if (r.eventType !== "access.would_refuse" || !inWindow(r.eventTime.getTime())) continue;
    const p = payloadOf(r);
    if (str(p, "agentId") !== agentId) continue;
    boundsClasses.row(r.id);
    const d = str(p, "dimension") ?? "unknown";
    const issueId = str(p, "issueId");
    const item: EvaluationWorkItemRef | null = issueId ? { kind: "issue", id: issueId } : null;
    // A violation the check found while the policy in force was `enforce`, logged and not refused: the action ran outside it.
    const executed = str(p, "policyMode") === "enforce";
    if (executed) {
      unauthorizedExecution++;
      dim(d).unauthorized++;
      exceptions.push({ kind: "unauthorized_execution", key: `unauthorized_execution:${agentId}:${r.id}`, severity: "immediate", routeToUserId: accountableUserId, item, criterion: null, raisedAt: r.eventTime.toISOString(), evidenceRefs: [r.id], note: "an action ran outside the access policy in force" });
      fatal.push({ fatalClass: "unauthorized_execution", key: `fatal:unauthorized_execution:${agentId}:${r.id}`, status: "potential", item, raisedAt: r.eventTime.toISOString(), evidenceRefs: [r.id], note: "an action ran outside the access policy in force (audit record)" });
    } else {
      wouldRefuse++;
      dim(d).wouldRefuse++;
    }
    cases.push({
      caseId: `bounds:${r.id}`,
      section: "bounds",
      responsibilityKey: null,
      state: executed ? "unauthorized_execution" : "would_refuse",
      role: "producer",
      item,
      itemLabel: item ? (base.items.get(item.id)?.identifier ?? null) : null,
      occurrenceId: null,
      criterion: null,
      judge: null,
      at: r.eventTime.toISOString(),
      evidenceRefs: [r.id],
      note: executed ? "ran outside the access policy in force" : "shadow mode: the access policy would have refused this",
      accessClasses: classesOf([r.id, ...rowsOfItem(item)]),
    });
  }

  // ---- fatal flags (shown first, whatever the averages; LLD §6.4) ----
  const fatalClasses = new ClassSet(byId);
  for (const it of items) {
    for (const h of it.handoffs) {
      if (h.actorType !== "agent" || h.actorId !== agentId || !inWindow(h.time.getTime())) continue;
      // a delivery claim whose own timestamp the record contradicts (the P3 E2 rule, material for delivery claims)
      if ((h.type === "tpm_merge_report" || h.type === "reviewer_to_tpm") && h.timestampSuspicious) {
        fatal.push({ fatalClass: "false_execution_claim", key: `fatal:false_execution_claim:${agentId}:${h.eventId}`, status: "potential", item: { kind: "issue", id: it.issueId }, raisedAt: h.time.toISOString(), evidenceRefs: [h.eventId], note: `${h.type} claims a delivery time its comment's arrival contradicts` });
      }
    }
  }
  const fatalOrder = (f: AgentCardFatalFlag) => AGENT_FATAL_CLASSES.indexOf(f.fatalClass);
  fatal.sort((a, b) => fatalOrder(a) - fatalOrder(b) || cmp(a.key, b.key));
  for (const f of fatal) {
    fatalClasses.rows([...f.evidenceRefs, ...rowsOfItem(f.item)]);
    cases.push({
      caseId: `fatal:${f.key}`,
      section: "fatal",
      responsibilityKey: null,
      state: f.status,
      role: "producer",
      item: f.item,
      itemLabel: f.item?.kind === "issue" ? (base.items.get(f.item.id)?.identifier ?? null) : null,
      occurrenceId: null,
      criterion: null,
      judge: null,
      at: f.raisedAt,
      evidenceRefs: [...f.evidenceRefs],
      note: f.note,
      accessClasses: classesOf([...f.evidenceRefs, ...rowsOfItem(f.item)]),
    });
  }

  // ---- 6. decisions ----
  const decisionsClasses = new ClassSet(byId);
  for (const dg of disagreements) {
    exceptions.push({
      kind: "disagreement",
      key: `disagreement:${agentId}:${criterionToken(dg.criterion)}:${dg.item.kind}:${dg.item.id}`,
      severity: "routine",
      routeToUserId: accountableUserId,
      item: dg.item,
      criterion: dg.criterion,
      raisedAt: [...dg.judgments].map((j) => j.at).sort().at(-1) ?? new Date(now).toISOString(),
      evidenceRefs: sortStrings(dg.judgments.map((j) => j.eventId)),
      note: "bound judgments disagree on this criterion; both stay, nothing is settled by vote",
    });
    decisionsClasses.rows([...dg.judgments.map((j) => j.eventId), dg.notedEventId, ...rowsOfItem(dg.item)]);
  }
  exceptions.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || cmp(a.key, b.key));
  for (const e of exceptions) decisionsClasses.rows([...e.evidenceRefs, ...rowsOfItem(e.item)]);
  const sample = new Map<string, CalibrationSampleItem>();
  for (const c of contractsInWindow) {
    for (const x of calibrationSampleFrom({ agentId, windowFrom: window.from, obligations: obligationList, disagreements, fatal, contract: c.contract })) if (!sample.has(x.key)) sample.set(x.key, x);
  }
  let closed = 0;
  const agreementByJudge: Partial<Record<AgentJudgeKind, { agree: number; of: number }>> = {};
  for (const x of sample.values()) {
    decisionsClasses.rows(rowsOfItem(x.item));
    const attested = dispositions.some((d) => {
      if (dispositionKind(d) !== "criterion_attest" || d.actorType !== "user" || d.actorId !== x.routeToUserId) return false;
      const b = evaluationCriterionAttestBindingSchema.safeParse(payloadOf(d).binding);
      return b.success && b.data.subjectRef.id === agentId && b.data.item.kind === x.item.kind && b.data.item.id === x.item.id && (!x.criterion || evaluationCriterionRefKey(b.data.criterion) === evaluationCriterionRefKey(x.criterion));
    });
    if (attested) closed++;
  }
  for (const [ck, p] of personByCriterionItem) {
    const itemPart = ck.slice(ck.lastIndexOf("|") + 1);
    if (![...sample.values()].some((x) => itemKey(x.item) === itemPart)) continue;
    for (const j of judgmentsByCriterionItem.get(ck) ?? []) {
      if (j.judge === "person") continue;
      const a = (agreementByJudge[j.judge] ??= { agree: 0, of: 0 });
      a.of++;
      if (j.result === p.result) a.agree++;
    }
  }

  // ---- reviewer (separate from the worker sections) ----
  const reviewerClasses = new ClassSet(byId);
  const reviewer: AgentCardReviewerSection = { reviews: { total: 0, bound: 0, unbound: 0, byOutcome: {} }, independence: { independent: 0, notIndependent: 0, unknown: 0 }, agreementWithPeople: { agree: 0, disagree: 0, of: 0 } };
  for (const it of items) {
    const producer = producerAtDelivery(it)?.agentId ?? null;
    if (producer === agentId) continue;
    const reviewsHere: Array<{ at: Date; outcome: string; id: string }> = [];
    for (const v of it.verdicts) if (v.reviewerAgentId === agentId && inWindow(v.time.getTime())) reviewsHere.push({ at: v.time, outcome: v.outcome ?? "unknown", id: v.eventId });
    for (const h of it.handoffs) if (REVIEW_CLASS_HANDOFFS.has(h.type) && h.actorType === "agent" && h.actorId === agentId && inWindow(h.time.getTime())) reviewsHere.push({ at: h.time, outcome: str(h.payload, "verdict") ?? h.type, id: h.eventId });
    for (const x of executionDecisionsOf(it.issueId)) {
      const p = payloadOf(x);
      if (str(p, "actorAgentId") === agentId && inWindow(x.eventTime.getTime())) reviewsHere.push({ at: x.eventTime, outcome: str(p, "outcome") ?? "decision", id: x.id });
    }
    for (const rv of reviewsHere) {
      reviewer.reviews.total++;
      reviewer.reviews.unbound++; // an agent's review names no criterion tuple today
      reviewer.reviews.byOutcome[rv.outcome] = (reviewer.reviews.byOutcome[rv.outcome] ?? 0) + 1;
      const ind = reviewIndependence({ actorType: "agent", actorId: agentId }, it, base, null, { entityType: "issue", at: rv.at, closeAt: terminalAt(it)?.time ?? null, projectId: projectAt(it, rv.at), goalId: snapshotAt(it, rv.at)?.goalId ?? null });
      if (ind.independent) reviewer.independence.independent++;
      else if (ind.reason === "no_actor") reviewer.independence.unknown++;
      else reviewer.independence.notIndependent++;
      const ids = [rv.id, ...it.eventIds];
      reviewerClasses.rows(ids);
      const state: AgentJudgmentResult = ["passed", "pass", "approved"].includes(rv.outcome) ? "pass" : ["failed", "fail", "revision_requested", "changes_requested"].includes(rv.outcome) ? "fail" : "unknown";
      cases.push({
        caseId: `reviewer:${rv.id}`,
        section: "reviewer",
        responsibilityKey: null,
        state,
        role: "reviewer",
        item: { kind: "issue", id: it.issueId },
        itemLabel: it.identifier,
        occurrenceId: null,
        criterion: null,
        judge: ind.independent ? "independent_agent" : null,
        at: rv.at.toISOString(),
        evidenceRefs: [rv.id],
        note: ind.independent ? null : "not independent of the producer",
        accessClasses: classesOf(ids),
      });
    }
  }
  reviewer.reviews.byOutcome = Object.fromEntries(Object.entries(reviewer.reviews.byOutcome).sort(([a], [b]) => cmp(a, b)));

  // ---- gaps ----
  const gapClasses = new ClassSet(byId);
  const gaps: AgentCardGap[] = [];
  for (const c of contractsInWindow) gapClasses.row(c.eventId);
  if (!latestContract) gaps.push({ code: "NO_APPLIED_PROFILE", section: "quality", message: "No operating profile has been applied: there are no criteria, so acceptance can't be decided." });
  if (unmapped.length > 0) gaps.push({ code: "UNMAPPED_WORK", section: "obligations", message: "Some work in this window maps to no responsibility." });
  const coverageSource = coverageSources(rows);
  for (const c of contractsInWindow) {
    for (const r of c.contract.responsibilities) {
      for (const criterion of r.criteria) {
        if (!criterion.check) gaps.push({ code: "CRITERION_WITHOUT_CHECK", section: "quality", message: `A criterion of ${r.key} has no check, so it can never be decided.`, responsibilityKey: r.key });
      }
      for (const cov of r.coverage) {
        const src = coverageSource.get(cov) ?? null;
        if (src) gapClasses.row(src);
        else gaps.push({ code: "COVERAGE_WITHOUT_SOURCE", section: "quality", message: `No source in this company records ${cov.replace(/_/g, " ")}.`, responsibilityKey: r.key, coverageClass: cov });
      }
    }
  }
  if (unboundObservations > 0) gaps.push({ code: "UNBOUND_JUDGMENTS", section: "quality", message: "Automated observations that name no criterion are shown in the drill-down and satisfy no criterion." });
  for (const row of obligationList) if (row.kind === "deliverable") gaps.push({ code: "OWED_PERIODS_UNKNOWN", section: "obligations", message: "Deliverable periods with no run are unknown: the cadence is free text.", responsibilityKey: row.responsibilityKey });
  const agentSourceTypes = new Set<string>(EVALUATION_AGENT_SOURCE_EVENT_TYPES);
  const firstAgentSource = rows.find((r) => agentSourceTypes.has(r.eventType)) ?? null;
  const earliestSource = rows.filter((r) => agentSourceTypes.has(r.eventType)).reduce((m, r) => Math.min(m, r.ingestTime.getTime()), Number.POSITIVE_INFINITY);
  gapClasses.row(firstAgentSource?.id);
  const historyGap = !firstAgentSource || earliestSource > wFrom;
  if (historyGap) gaps.push({ code: "HISTORY_BEFORE_SOURCE", section: "obligations", message: "Part of this window predates the records owed work and corrections come from; that history is unknown." });
  const dedupGaps = new Map<string, AgentCardGap>();
  for (const g of gaps) dedupGaps.set(`${g.code}|${g.section}|${g.responsibilityKey ?? ""}|${g.coverageClass ?? ""}|${g.message}`, g);
  const gapList = [...dedupGaps.values()].sort((a, b) => cmp(`${a.code}|${a.responsibilityKey ?? ""}|${a.coverageClass ?? ""}`, `${b.code}|${b.responsibilityKey ?? ""}|${b.coverageClass ?? ""}`));

  const markers: string[] = [];
  if (!latestContract) markers.push("no applied profile — acceptance can't be decided");
  if (historyGap) markers.push("history before the agent-side records is unknown");

  // ---- assemble ----
  const section = <T>(classes: ClassSet, body: T): AgentCardStoredSection<T> => ({ accessClasses: classes.list(), body });
  const all = new ClassSet(byId);
  for (const c of [obligationClasses, qualityClasses, acceptanceClasses, costClasses, boundsClasses, decisionsClasses, fatalClasses, reviewerClasses, gapClasses]) all.merge(c);
  // generous on purpose: the card-level set decides whether a viewer may be served the stored card as-is
  all.rows(rows.filter((r) => r.subjectAgentId === agentId).map((r) => r.id));
  const card: AgentCardV1 = {
    kind: "agent_card",
    cardVersion: AGENT_CARD_VERSION,
    formulaVersion: AGENT_METRICS_VERSION,
    scorecardKind: AGENT_CARD_SCORECARD_KIND,
    companyId,
    subjectRef: { kind: "agent", id: agentId },
    agentName: base.agents.get(agentId)?.name ?? null,
    contract: contractSummary,
    replay,
    accessClasses: all.list(),
    fatal: section(fatalClasses, fatal),
    worker: {
      obligations: section(obligationClasses, { responsibilities: obligationList, unmapped: { items: unmapped.length } }),
      quality: section(qualityClasses, {
        criteria: criteriaRows,
        judgeIndependence: { ...independenceTally },
        sourceDiversity: Object.fromEntries(Object.entries(tierTally).sort(([a], [b]) => cmp(a, b))),
        unboundObservations,
        rework: { items: reworkItems, reopened },
      }),
      acceptance: section(acceptanceClasses, { facts, accountable, delivered: { items: delivered.length, byResponsibility: Object.fromEntries(Object.entries(byResponsibility).sort(([a], [b]) => cmp(a, b))) } }),
      cost: section(costClasses, {
        spendCents: anyCostInWindow ? sumCents(agentCosts) : null,
        unattributedSpendCents: anyCostInWindow ? sumCents(unattributed) : null,
        runs: {
          total: agentRuns.length,
          succeeded: agentRuns.filter((r) => r.status === "succeeded").length,
          failed: agentRuns.filter((r) => r.status === "failed" || r.status === "timed_out").length,
          withoutIssue: runsWithoutIssue,
        },
        questionsToPeople: { asked: questions.size, answered: answered.length, medianWaitMinutes: medianWait === null ? null : Math.round(medianWait * 10) / 10 },
        humanReviewActions,
        humanCorrections,
        selfReportedMinutes: null,
        byPerson: [...byPerson.entries()].sort(([a], [b]) => cmp(a, b)).map(([userId, x]) => ({ userId, ...x })),
      }),
      bounds: section(boundsClasses, {
        allowedUse: null,
        refusedAttempts,
        repeatedAfterRefusal,
        wouldRefuse,
        unauthorizedExecution,
        byDimension: Object.fromEntries(Object.entries(byDimension).sort(([a], [b]) => cmp(a, b))),
      }),
      decisions: section(decisionsClasses, {
        exceptions,
        disagreements,
        calibration: { sampled: sample.size, closed, agreementByJudge: Object.fromEntries(Object.entries(agreementByJudge).sort(([a], [b]) => cmp(a, b))) },
        unownedWork: unmapped.length,
      }),
    },
    reviewer: section(reviewerClasses, reviewer),
    gaps: section(gapClasses, gapList),
    markers,
  };
  cases.sort((a, b) => cmp(a.section, b.section) || cmp(a.at, b.at) || cmp(a.caseId, b.caseId));
  return { card, cases };
}

/** For each coverage class, the first row that shows the company has a source for it (null = none). */
function coverageSources(rows: EvaluationEventRow[]): Map<EvaluationCoverageClass, string | null> {
  const out = new Map<EvaluationCoverageClass, string | null>();
  const set = (c: EvaluationCoverageClass, id: string) => {
    if (!out.get(c)) out.set(c, id);
  };
  for (const r of rows) {
    const p = payloadOf(r);
    const kept = obj(p, "payload") ?? {};
    switch (r.eventType) {
      case "verdict.recorded":
        if (str(p, "issueId")) {
          set("neutral_verdict", r.id);
          set("independent_review", r.id);
        }
        break;
      case "approval.decided":
        if (str(p, "issueId")) {
          set("neutral_verdict", r.id);
          set("independent_review", r.id);
        }
        break;
      case "handoff.tester_to_reviewer":
      case "handoff.reviewer_to_tpm":
        set("independent_review", r.id);
        if (obj(kept, "pr")) set("delivery_ref", r.id);
        if (obj(kept, "regression_gates")) set("ci_green", r.id);
        break;
      case "handoff.tpm_merge_report":
      case "handoff.builder_to_ci":
      case "handoff.pm_to_builder":
        if (obj(kept, "pr") || str(kept, "merge_result")) set("delivery_ref", r.id);
        if (obj(kept, "regression_gates")) set("ci_green", r.id);
        break;
      case "issue.dod_set":
        set("dod_present", r.id);
        break;
      case "issue.snapshot":
        if ((num(p, "dodCriteria") ?? 0) > 0) set("dod_present", r.id);
        break;
      case "deliverable.run_changed":
        set("deliverable_shipped", r.id);
        set("independent_check", r.id);
        set("human_acceptance", r.id);
        break;
      case "assessment.automated":
        if ((num(p, "boundChecks") ?? 0) > 0) set("automated_acceptance", r.id);
        break;
      case "evaluation.disposition":
        if (str(p, "kind") === "use_confirmed") set("use_recorded", r.id);
        if (str(p, "kind") === "criterion_attest" && p.binding) set("human_acceptance", r.id);
        break;
      default:
        break;
    }
  }
  return out;
}

