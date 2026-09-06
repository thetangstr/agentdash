import type {
  EvaluationConfidenceTier,
  EvaluationExceptionId,
  EvaluationExceptionRoute,
  EvaluationExceptionSeverity,
  EvaluationMetricKey,
  EvaluationMilestoneRef,
  EvaluationSourceTier,
} from "./evaluation.js";


/**
 * AgentDash: Company Evaluator — the stored card's shapes (spec §5, §7, §9),
 * shared so the Milestone 4 surfaces render exactly what the server stored.
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

/** What a metric's value is, decided by the engine so no surface has to infer it from the unit text. */
export const EVALUATION_METRIC_VALUE_KINDS = ["share", "index", "count", "duration", "currency", "status"] as const;
export type EvaluationMetricValueKind = (typeof EVALUATION_METRIC_VALUE_KINDS)[number];

export interface MetricResult {
  key: EvaluationMetricKey;
  /** The metric's name; the company row's metrics carry their own names even though they reuse agent keys. */
  name: string;
  /** share: 0–1 rendered as a percentage; index: events per item; count: an integer; duration: hours; currency: cents; status: words only. */
  valueKind: EvaluationMetricValueKind;
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
  /** Share of the included weight resting on decidable records (Σwᵢcᵢ / Σwᵢ); null when nothing is included. */
  coverage: number | null;
  included: Array<{ key: EvaluationMetricKey; weight: number; coverage: number; scaled: number; confidence: EvaluationConfidenceTier }>;
  excluded: Array<{ key: EvaluationMetricKey; reason: string }>;
  /** E3/E4 present in the window: a flag, never arithmetic (§5.3). */
  flags: string[];
  /** `reasons` is always present (empty when satisfied) and ordered most specific first; `reason` is the headline alias for `reasons[0]` and exists only when the guard failed. */
  guard: { minIncluded: number; coverageFloor: number; maxConcentration: number; concentration: number; satisfied: boolean; reasons: string[]; reason?: string };
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
  /** The agent the exception is about, when one is (routing target and per-actor flag). */
  actorAgentId: string | null;
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
  /** Declared versions that failed schema validation and were ignored (shown, never a rule-16 exception). */
  invalidVersions: number;
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
  /** Exact total; `exceptions` holds at most 500, immediate and material first. */
  exceptionsTotal: number;
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
  issueCount: number;
  actorKeys: string[];
  firstEventTime: string | null;
  lastEventTime: string | null;
  /** The flags the markers were derived from; `open` is pinned here for verify. */
  state: { open: boolean; retrospective: boolean };
}

/**
 * §5 in one sentence per metric: what the number is, so a reader can follow a
 * score to its formula without opening the spec. The card's `formulaVersion`
 * says which implementation produced the number.
 */
export const EVALUATION_METRIC_FORMULAS: Record<EvaluationMetricKey, string> = {
  O1: "Done items whose every applicable contract criterion has a satisfied disposition, divided by the decidable done items; items with unmeasurable criteria are undecidable.",
  O2: "Items and milestones closed on or before their target date, divided by those that carry a target date.",
  O3: "Consequences after close (reopen, a recovery issue, a blocker citing the item, and a revert when delivery evidence exists) per delivered item; an index, lower is better.",
  O4: "Goal status transitions and the contract's outcome target against the goal's measurements; shown, never scored.",
  O5: "Done items carrying every evidence class the contract requires, judged over the classes decidable for each item, divided by done items.",
  P1: "Agent-owned items that reached review or done with zero human interventions, divided by those items; the raw intervention count is shown too.",
  P2: "Escalations to a human that a later linked decision approved as raised, divided by escalations; unanswered questions past 48 hours are charged to the company.",
  P3: "One minus the checkable self-reported claims contradicted by a higher-tier record, divided by checkable claims; prose is neither credited nor penalised.",
  P4: "Handoffs with a valid payload, a derivable receiver and no bounce within 24 hours, divided by handoffs.",
  P5: "Failed runs and stranded items by how they recovered (automatically, by an explicit recovery, by a human, or not at all), with time to a valid action path; shown, never scored.",
  P6: "Detected authority violations shown as a count with the rule that fired (self-review, founder-lock, transition of an unassigned item, merge without gates, refused request); never a ratio.",
  P7: "Queue, work, review and total time per item as medians and 90th percentiles, bucketed by size only where a size signal exists; shown, never scored.",
  P8: "Metered cost per accepted item, tokens per run and cost anomalies above three times the actor's median; self-reported usage is marked; shown, never scored.",
  P9: "Duplicates (label, origin fingerprint or near-identical title within 15 minutes) plus rework (reopens, revision verdicts, repeated fix attempts) divided by delivered items.",
};

/** One row of the Milestone 4 overview: a milestone and what its latest stored card says. */
export interface EvaluationMilestoneSummary {
  ref: EvaluationMilestoneRef;
  name: string;
  status: string | null;
  latest: {
    version: number;
    storedAt: string;
    formulaVersion: string;
    throughSeq: number;
    outcome: { score: number | null; confidence: EvaluationConfidenceTier | null; coverage: number | null; reason: string | null };
    /** Agents with an operating composite on this card; never ordered by score. */
    operatingActors: number;
    exceptions: { total: number; immediate: number; material: number; routine: number };
    markers: string[];
    missingSources: number;
    /**
     * P1's raw intervention count summed across actors, the population it was counted over (agent-owned items
     * that reached review or done) and the card's own caveat (for example that synthetic identities make
     * interventions countable, not attributable). Null when no actor row carries P1.
     */
    interventions: { count: number; population: number; caveat: string | null } | null;
    /** P8's metered cost summed across actors, with how many of the runs were metered. Null when no actor row carries P8. */
    cost: { cents: number; meteredRuns: number; runs: number } | null;
    /** Outcome score per stored version, oldest first, for the trend. */
    trend: Array<{ version: number; score: number | null; storedAt: string }>;
  } | null;
}

export interface EvaluationOverview {
  milestones: EvaluationMilestoneSummary[];
  /** The review-items project, once it exists. */
  reviewProjectId: string | null;
  principal: { provisioned: boolean; agentId: string | null };
  ledger: { maxSeq: number };
}

/** One stored version of a milestone card, without the card body. */
export interface EvaluationScorecardVersionSummary {
  version: number;
  storedAt: string;
  formulaVersion: string;
  contractVersion: string;
  throughSeq: number;
  cardHash: string;
  outcome: { score: number | null; confidence: EvaluationConfidenceTier | null };
  exceptionsTotal: number;
}
