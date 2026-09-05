import type {
  EvaluationConfidenceTier,
  EvaluationExceptionId,
  EvaluationExceptionRoute,
  EvaluationExceptionSeverity,
  EvaluationMetricKey,
  EvaluationMilestoneRef,
  EvaluationSourceTier,
} from "@paperclipai/shared";

/**
 * AgentDash: Company Evaluator — Milestone 2 result shapes (spec §5, §7, §9).
 * Every number on a card is one of these; nothing is imputed and nothing is
 * shown at the Insufficient tier.
 */

export interface UndecidableReason {
  reason: string;
  count: number;
}

/** §5: `breakdown` is `{satisfied, failed, undecidable: [{reason, count}]}`; the headline prints it in words. */
export interface MetricBreakdown {
  satisfied: number;
  failed: number;
  undecidable: UndecidableReason[];
}

export interface MetricResult {
  key: EvaluationMetricKey;
  name: string;
  /** Null at the Insufficient tier (no value is shown). */
  value: number | null;
  unit: string;
  /** Population size. */
  n: number;
  /** Decidable population / population; 0 when the population is empty. */
  coverage: number;
  confidence: EvaluationConfidenceTier;
  confidenceLabel: string;
  breakdown: MetricBreakdown;
  /** The headline in words, never a bare percentage (§5). */
  headline: string;
  formulaVersion: string;
  /** Ledger event ids behind the number (capped; the count is the truth). */
  evidenceRefs: string[];
  evidenceRefCount: number;
  /** Source tiers that contributed decisive facts. */
  tiers: EvaluationSourceTier[];
  /** Lower is better (index metrics); the composite inverts these. */
  lowerIsBetter: boolean;
  /** Shown, never scored (P5–P8). */
  displayOnly: boolean;
  /** Free-form structured detail per metric (medians, per-actor rows, terms shown separately). */
  detail: Record<string, unknown>;
  /** Why the metric is at its tier, in words. */
  notes: string[];
}

export interface CompositeResult {
  kind: "outcome" | "operating";
  /** 0–100, null when a guard fails. */
  score: number | null;
  confidence: EvaluationConfidenceTier | null;
  included: Array<{ key: EvaluationMetricKey; weight: number; scaled: number; confidence: EvaluationConfidenceTier }>;
  excluded: Array<{ key: EvaluationMetricKey; reason: string }>;
  /** E3/E4 present in the window: a flag, never arithmetic (§5.3). */
  flags: string[];
  guard: { minIncluded: number; satisfied: boolean };
  formulaVersion: string;
}

export interface ExceptionRecord {
  id: EvaluationExceptionId;
  title: string;
  severity: EvaluationExceptionSeverity;
  routes: readonly EvaluationExceptionRoute[];
  /** Deterministic key for dedupe across recomputes: `E#:subjectKind:subjectId[:qualifier]`. */
  key: string;
  subject: { kind: "issue" | "agent" | "pair" | "milestone" | "company" | "comment"; id: string; identifier?: string | null };
  /** Resolved routing targets from the roster (§9.1): manager := reportsTo, null → accountable human. */
  routing: { accountableUserId: string | null; managerAgentIds: string[]; founderView: boolean };
  /** eventTime of the triggering event; the exception is dated by the fact, not by detection. */
  raisedAt: string;
  evidenceRefs: string[];
  note: string;
  markers: string[];
}

export interface ActorRow {
  actorKey: string;
  actorType: string;
  actorId: string | null;
  name: string | null;
  metrics: Partial<Record<EvaluationMetricKey, MetricResult>>;
  composite: CompositeResult | null;
}

export interface ContractSummary {
  source: "declared" | "derived" | "none";
  contractVersion: string;
  declaredAt: string | null;
  declaredBy: string | null;
  accountableUserId: string | null;
  leadAgentId: string | null;
  requiredEvidence: string[];
  criteriaCount: number;
  measurableCriteria: number;
  /** Rule 16: weak contract facts that need the founder's recorded acceptance. */
  exceptions: string[];
  founderLocks: string[];
  excludedReviewers: string[];
  targetDate: string | null;
  eventId: string | null;
}

export interface ScoredCard extends Record<string, unknown> {
  formulaVersion: string;
  milestoneRef: EvaluationMilestoneRef;
  milestoneName: string | null;
  throughSeq: number;
  throughEventId: string | null;
  /** The deterministic "now": the latest time the window knows about. */
  asOf: string;
  markers: string[];
  contract: ContractSummary;
  membership: { items: number; done: number; cancelled: number; open: number; excludedEvaluatorItems: number; movedIn: number; movedOut: number };
  outcome: Partial<Record<EvaluationMetricKey, MetricResult>>;
  outcomeComposite: CompositeResult;
  /** Per-agent operating rows plus the company row (`company:<id>`) for platform-owed items. */
  actors: ActorRow[];
  exceptions: ExceptionRecord[];
  exceptionCounts: Record<string, number>;
  flags: string[];
  /** Metrics absent from every composite, with the reason (§5.3: the card always lists them). */
  excludedMetrics: Array<{ key: EvaluationMetricKey; scope: string; reason: string }>;
  /** Sources the window has no record of at all (rule 10 undecidable causes). */
  missingSources: string[];
  /** Blind window: the maximum ingest lag observed in the window (rule 13). */
  maxIngestLagMs: number;
  // Milestone 1 digest, kept for drill-down.
  eventCount: number;
  byType: Record<string, number>;
  byActorType: Record<string, number>;
  bySource: Record<string, number>;
  issueIds: string[];
  actorKeys: string[];
  firstEventTime: string | null;
  lastEventTime: string | null;
  /** The flags the markers were derived from; `open` is pinned here for verify. */
  state: { open: boolean; retrospective: boolean };
}
