// AgentDash: Agent Performance Management, gate 1 ("see what's true today").
//
// Read-only views of what an agent can access, what its operating profile looks
// like when derived from today's records, and how it has performed. Nothing in
// these contracts is a grant, an approval or a score: they describe records.
// Design: doc/plans/2026-10-29-agent-performance-management-lld.md (§9 gate 1),
// doc/plans/2026-10-29-agent-access-lld.md, doc/plans/2026-10-29-agent-evaluation-lld.md.
//
// Gate 2 widens three access-inventory fields so the same contract can carry an
// operating profile's request and the company's V2 enforcement mode. Gate 1
// values (`not_defined`, `false`, `off`) remain valid and mean what they meant.

import type { AgentAccessEnforcementMode } from "./agent-profile.js";
import type {
  AGENT_CARD_SCORECARD_KIND,
  AGENT_CARD_VERSION,
  AGENT_METRICS_VERSION,
  AgentAcceptanceFact,
  AgentCardDependencyCitation,
  AgentCardGapCode,
  AgentCardReplayInputs,
  AgentCardSectionKey,
  AgentExceptionKind,
  AgentFatalClass,
  AgentJudgeKind,
  AgentJudgmentResult,
  AgentObligationEndState,
  AgentObligationOccurrenceKind,
  AgentWorkRole,
  EvaluationAccessClass,
  EvaluationAgentSubjectRef,
  EvaluationCoverageClass,
  EvaluationCriterionRef,
  EvaluationExceptionSeverity,
  EvaluationExpectedHumanStep,
  EvaluationMilestoneRef,
  EvaluationOutcomeMetric,
  EvaluationSourceTier,
  EvaluationTypedPredicate,
  EvaluationWorkItemRef,
} from "../evaluation.js";
import type { MetricResult } from "../evaluation-card.js";

export interface AgentPerformanceWindow {
  /** ISO timestamps. `to` is the observation time (`asOf`) unless a caller asked for an earlier end. */
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Access inventory (access LLD §3.3, §8)
// ---------------------------------------------------------------------------

export const AGENT_ACCESS_DIMENSIONS = ["see", "do", "talk", "spend"] as const;
export type AgentAccessDimension = (typeof AGENT_ACCESS_DIMENSIONS)[number];

/** Where today's rule comes from. Plain names of existing mechanisms, never a new grant. */
export const AGENT_ACCESS_SOURCES = [
  "company_boundary",
  "project_visibility",
  "project_access",
  "agent_memory_privacy",
  "connector_resolution",
  "connector_autonomy",
  "permission_grant",
  "role_default",
  "governance_policy",
  "skill_sync",
  "runtime_skill_mentions",
  "budget_policy",
  "mandate",
  "issue_assignment",
  "mentions",
  "handoffs",
  "questions",
  "bridge",
  "host_runtime",
  "platform_default",
] as const;
export type AgentAccessSource = (typeof AGENT_ACCESS_SOURCES)[number];

export type AgentAccessEnforcement =
  /** The server checks this on every path we know of. */
  | "enforced"
  /** Checked on some paths only; `note` says which are not. */
  | "partial"
  /** Described somewhere but not checked by code. */
  | "not_enforced"
  /** Only enforced for companies on a specific product profile; `note` names it. */
  | "profile_only"
  | "unknown";

export interface AgentAccessItem {
  /** Stable key, e.g. `see.projects.open`, `see.project:<id>`, `talk.agents.assign`, `do.connection:<id>.send`. */
  id: string;
  dimension: AgentAccessDimension;
  /** Plain language, e.g. "Read issues in every project that isn't restricted". */
  label: string;
  target?: { kind: "company" | "project" | "connection" | "agent" | "person" | "skill" | "external" | "host" | "budget"; id?: string | null; label?: string | null; count?: number | null } | null;
  /**
   * What the active operating profile asks for. `not_defined` = no profile has
   * been applied (always so in gate 1); `requested` / `not_requested` name the
   * active revision they were read from.
   */
  requested: { state: "not_defined" | "requested" | "not_requested"; revisionId?: string | null };
  /**
   * What today's records allow. `unrestricted` = nothing narrows it inside the company.
   * `v2` (gate 2): what the stored V2 access policy allows for this item, when a
   * V2 dimension covers it; absent when V2 says nothing about it.
   */
  defined: {
    allowed: boolean | "unrestricted";
    source: AgentAccessSource;
    detail?: string | null;
    v2?: { allowed: boolean; rule?: string | null };
  };
  enforced: { state: AgentAccessEnforcement; note?: string | null };
  /** Live check at read time. */
  working: { state: "ok" | "not_working" | "not_applicable" | "unknown"; detail?: string | null };
  /** Observed in the window from activity records. Counts only; never inferred from silence. */
  used: { state: "used" | "refused" | "used_and_refused" | "not_observed" | "unknown"; uses?: number | null; refusals?: number | null; lastAt?: string | null };
}

export interface AgentHostEnvironment {
  adapterType: string;
  kind: "local_host" | "managed_environment" | "remote" | "unknown";
  /** `false` when the adapter runs with host permission prompts skipped (the local default). */
  hostPermissionsRestricted: boolean | "unknown";
  environmentId: string | null;
  /** Plain-language statement shown as a fact, e.g. "Local machine, host permissions not restricted". */
  detail: string;
}

export const AGENT_ACCESS_GAP_CODES = [
  "PROFILE_NOT_DEFINED",
  "GOVERNANCE_PROFILE_ONLY",
  "RUN_CONTEXT_UNCHECKED",
  "EXPORT_UNSCOPED",
  "WAKE_ANY_AGENT",
  "ASK_ANY_MEMBER",
  "SELF_ADD_SKILLS",
  "RUNTIME_SKILL_MENTIONS",
  "SELF_EDIT_CAPABILITIES",
  "HOST_UNRESTRICTED",
  "CONNECTION_NOT_WORKING",
  "UNREAD_PERMISSION_SCOPE",
] as const;
export type AgentAccessGapCode = (typeof AGENT_ACCESS_GAP_CODES)[number];

export interface AgentAccessGap {
  code: AgentAccessGapCode;
  message: string;
  itemId?: string | null;
}

/** One logged access-policy decision (a would-be refusal in shadow, a refusal in enforce), labelled for the Access tab. */
export interface AgentAccessRefusalRecord {
  at: string;
  dimension: string;
  /** Canonical `<dimension>.<reason>`. */
  rule: string | null;
  /** The matrix row that asked (access LLD §4). */
  site: string | null;
  /** The target by name only, never by email. */
  targetLabel: string | null;
}

/** AgentDash (APM gate 2): would-be refusals under `shadow`, for the Access tab. */
export interface AgentAccessShadowSummary {
  wouldRefuseTotal: number;
  byDimension: Record<string, number>;
  /** Newest first, at most 20. */
  recent: AgentAccessRefusalRecord[];
}

/** AgentDash (APM gate 3, P3.7): refusals the V2 policy made while the company ran `enforce`, for the Access tab. */
export interface AgentAccessEnforcedSummary {
  /** Recorded refusals in the window this viewer may see. */
  refusedTotal: number;
  /** Newest first, at most 20. */
  recent: AgentAccessRefusalRecord[];
}

export interface AgentAccessInventory {
  kind: "agent_access_inventory";
  version: "agent-access/0";
  companyId: string;
  agentId: string;
  agentName: string;
  generatedAt: string;
  window: AgentPerformanceWindow;
  /** Whether an applied operating profile defines this agent's access. Always false in gate 1. */
  profileDefined: boolean;
  /** The company's V2 enforcement mode (`companies.agent_access_enforcement`). Gate 1 reports `off`. */
  enforcementMode: AgentAccessEnforcementMode;
  /**
   * AgentDash (APM gate 4): on `GET /api/agents/me/access` only — whether the
   * calling agent is the company's effective performance manager.
   */
  performanceManager?: boolean;
  items: AgentAccessItem[];
  hostEnvironment: AgentHostEnvironment;
  /** Refused attempts in the window by code, including codes that map to no single item. */
  refusalsByCode: Record<string, number>;
  /** Always reachable for questions and approvals (access LLD §4 invariants). */
  alwaysReachable: Array<{ kind: "user" | "agent"; id: string; label: string; role: "accountable" | "steward" | "admin" }>;
  gaps: AgentAccessGap[];
  /**
   * AgentDash (APM gate 2): what V2 would have refused in the window while the
   * company ran `shadow` (`access.would_refuse` rows for this agent). Null when
   * the mode is `off`. Rows naming a project the viewer can't see are left out
   * of every count. `rule` is the canonical `<dimension>.<reason>`.
   */
  shadow?: AgentAccessShadowSummary | null;
  /**
   * AgentDash (APM gate 3, P3.7): what V2 refused in the window
   * (`authz.refused` rows with `ACCESS_POLICY_REFUSED` for this agent). Null
   * when the mode is `off`, as `shadow`. Rows naming a project the viewer
   * can't see are left out of every count.
   */
  enforced?: AgentAccessEnforcedSummary | null;
}

// ---------------------------------------------------------------------------
// Derived operating profile, revision 0 (overview LLD §3.3) — computed on read, never stored or applied
// ---------------------------------------------------------------------------

export type DerivedProvenance = "proposed" | "missing";

export interface DerivedField<T> {
  value: T;
  provenance: DerivedProvenance;
  /** Where the value came from, e.g. `agent.title`, `plan_card:<cardId>`, `workforce_enrollment`, `routine:<id>`. Null when missing. */
  source: string | null;
}

export interface DerivedResponsibility {
  /** Stable within this derivation: a slug of the title, de-duplicated. */
  key: string;
  title: string;
  source: string;
  obligation: { kind: "routine" | "assigned" | "unknown"; routineId?: string | null; routineTriggerIds?: string[] };
}

export interface AgentProfileDerived {
  kind: "agent_profile_derived";
  version: "agent-profile-derived/0";
  /** Always true in gate 1: an unconfirmed starting point, never applied automatically. */
  derived: true;
  companyId: string;
  agentId: string;
  generatedAt: string;
  identity: {
    name: DerivedField<string>;
    title: DerivedField<string | null>;
    role: DerivedField<string>;
    summary: DerivedField<string | null>;
  };
  objective: DerivedField<string | null>;
  responsibilities: DerivedResponsibility[];
  kpis: DerivedField<string[]>;
  rhythm: {
    heartbeat: { enabled: boolean; intervalSec: number | null; wakeOnDemand: boolean | null };
    routines: Array<{
      routineId: string;
      title: string;
      status: string;
      triggers: Array<{ id: string; kind: string; cronExpression: string | null; timezone: string | null; enabled: boolean }>;
    }>;
    reportsTo: { agentId: string | null; agentName: string | null };
    accountableUserId: string | null;
  };
  skills: DerivedField<string[]>;
  runtime: { adapterType: string; model: string | null; environmentId: string | null };
  gaps: Array<{ code: "NO_STRUCTURED_OBLIGATIONS" | "NO_CRITERIA" | "NO_ACCESS_REQUEST" | "NO_STYLE" | "NO_RESPONSIBILITIES" | "NO_PLAN_CARD" | "AMBIGUOUS_PLAN_MAPPING"; message: string }>;
}

// ---------------------------------------------------------------------------
// Agent performance projection (evaluation LLD §6, §11) — side-effect-free, gate 1 sources
// ---------------------------------------------------------------------------

export interface AgentProjectionCount {
  /** Null = unknown (no source), never zero. */
  value: number | null;
  /** The denominator this count is out of, when one exists. */
  of?: number | null;
  note?: string | null;
}

export interface AgentProjectionRoutineObligation {
  routineId: string;
  title: string;
  triggerId: string | null;
  triggerKind: string | null;
  cronExpression: string | null;
  timezone: string | null;
  enabled: boolean;
  /** Fire times in the window computed from the CURRENT definition. Null for webhook/api triggers. */
  owedInWindow: number | null;
  /** Why `owedInWindow` is null, or what it assumes (e.g. "trigger created inside the window"). */
  note?: string | null;
  runs: { total: number; issueCreated: number; completed: number; failed: number; skipped: number; coalesced: number };
  linkedIssues: { done: number; open: number; cancelled: number };
}

export interface AgentProjectionAccountableResult {
  kind: "project" | "goal";
  id: string;
  title: string;
  status: string | null;
  /** From a milestone projection at the same ledger cut, when the evaluator has records; else null with a note. */
  outcome: { acceptance: AgentProjectionCount; onTime: AgentProjectionCount; rework: AgentProjectionCount; evidence: AgentProjectionCount } | null;
  note?: string | null;
}

export interface AgentPerformanceProjection {
  kind: "agent_performance_projection";
  version: "agent-projection/0";
  companyId: string;
  agentId: string;
  generatedAt: string;
  asOf: string;
  window: AgentPerformanceWindow;
  /** Highest ledger sequence read, or null when the evaluator ledger has no events for this company. */
  throughSeq: number | null;
  sideEffectFree: true;
  /** Q1 — is the work it owes getting done? */
  owed: {
    source: "current_definitions";
    historyKnown: false;
    routines: AgentProjectionRoutineObligation[];
    assigned: { open: number; inProgress: number; inReview: number; blocked: number; done: number; cancelled: number };
  };
  /** Q2 — is the work good? Verdicts on work this agent was assigned when judged. */
  quality: {
    verdicts: { passed: number; failed: number; changesRequested: number; escalated: number; other: number };
    byJudge: { person: number; independentAgent: number; nonIndependent: number };
  };
  /** Q3 — accepted, used, moving the result. The four facts stay separate. */
  acceptance: {
    automated: AgentProjectionCount;
    human: AgentProjectionCount;
    use: AgentProjectionCount;
    outcome: AgentProjectionCount;
    accountable: AgentProjectionAccountableResult[];
  };
  /** Q4 — cost in money and people's time (proxies, labelled). */
  cost: {
    /** Null when the viewer may not see this agent's spend (the existing spend-redaction rule); listed in `withheld`. */
    spendCents: number | null;
    runs: { total: number; succeeded: number; failed: number; withoutIssue: number };
    peopleProxies: { questionsAsked: number; questionsAnswered: number; medianAnswerWaitMinutes: number | null; humanCorrections: AgentProjectionCount };
  };
  /** Q5 — boundaries. Refused attempts are attempts, not misconduct (access LLD §4). */
  bounds: { refusedAttempts: number; byCode: Record<string, number> };
  /** Q6 — what needs a decision. */
  decisions: { pendingApprovals: number; openQuestionsToPeople: number };
  gaps: Array<{ code: string; message: string }>;
  /** Sections not shown to this viewer, or not available until a later gate. No counts leak here. */
  withheld: Array<{ section: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// AgentDash: Agent Performance Management gate 3, P3.1 freeze — owed work, the
// agent card and its drill-down (evaluation LLD §5–§8, §10–§12). The vocabulary
// (classes, predicates, end states, versions, replay-input schema) lives in
// `evaluation.ts`; these are the shapes the server stores and serves.
// ---------------------------------------------------------------------------

// ---- Owed work (LLD §7) -----------------------------------------------------

/** Where an occurrence came from. Each kind's identifying parts form `occurrenceId` (`agentObligationOccurrenceId`). */
export type AgentObligationOccurrenceSource =
  | {
      kind: Extract<AgentObligationOccurrenceKind, "scheduled">;
      routineId: string;
      triggerId: string;
      /** ISO fire time computed from the trigger definition in force (cron + timezone), never from execution records. */
      scheduledFor: string;
      cronExpression: string;
      timezone: string;
      /** The `routine.trigger_snapshot` ledger event the definition came from. */
      definitionEventId: string;
    }
  | { kind: Extract<AgentObligationOccurrenceKind, "received">; routineId: string; triggerId: string; routineRunId: string }
  | { kind: Extract<AgentObligationOccurrenceKind, "deliverable">; deliverableId: string; runKey: string; deliverableRunId: string }
  | { kind: Extract<AgentObligationOccurrenceKind, "assigned">; issueId: string; mappingId: string }
  | { kind: Extract<AgentObligationOccurrenceKind, "goal">; goalId: string; /** `by_date` deadline from the contract (goals have no target-date column). */ deadline: string };

/**
 * One owed occurrence and how it ended, as of `asOf`. Generated from versioned
 * definitions, so a period in which nothing ran still appears (as `missed`,
 * `not_started` or `cause_unknown`). A block state is assigned only with
 * evidence: `evidenceRefs` is never empty for `blocked_on_*`; without
 * evidence the occurrence is `not_started` or `cause_unknown`, never a
 * presumed platform fault.
 */
export interface AgentObligationOccurrence {
  occurrenceId: string;
  responsibilityKey: string;
  /** The profile revision in force when the occurrence was owed (results group by revision, LLD §10). */
  profileRevisionId: string | null;
  /** Obligation credit: the responsible agent during the interval (LLD §5.1). */
  responsibleAgentId: string;
  source: AgentObligationOccurrenceSource;
  /** ISO time the occurrence became owed. */
  owedAt: string;
  /** ISO due time from the contract `deadline`; null when the responsibility has none. */
  dueAt: string | null;
  endState: AgentObligationEndState;
  /** What it was matched to (a run carrying `scheduledFor` → its linked issue; a deliverable run; the mapped issue). */
  matched: { routineRunId: string | null; issueId: string | null; deliverableRunId: string | null } | null;
  deliveredAt: string | null;
  /** Delivery credit: the producer at delivery, shown beside the responsible agent when they differ. */
  producerAgentId: string | null;
  /** Ledger event ids behind the end state. */
  evidenceRefs: string[];
  /** The catch-up/coalescing policy applied, a cancellation, or why the cause is unknown. */
  note: string | null;
}

// ---- The agent card (LLD §6.2) ----------------------------------------------

/** A stored section: its body plus the access classes its numbers rest on (sorted, distinct). The classes are never served. */
export interface AgentCardStoredSection<T> {
  accessClasses: EvaluationAccessClass[];
  body: T;
}

/** A section as a viewer receives it. `not_visible` carries no body and no counts. */
export type AgentCardSectionView<T> =
  | { visibility: "visible"; body: T }
  | { visibility: "partial"; body: T; note: string }
  | { visibility: "not_visible"; note: string };

/** 1. Is the work it owes getting done? One row per responsibility per profile revision in force. */
export interface AgentCardObligationRow {
  responsibilityKey: string;
  title: string | null;
  profileRevisionId: string | null;
  kind: AgentObligationOccurrenceKind | null;
  /** The denominator; null = owed periods unknown (a free-text deliverable cadence), with a gap. */
  owed: number | null;
  /** Every end state is present, zero included, so the counts sum to the occurrences generated. */
  byEndState: Record<AgentObligationEndState, number>;
  /** Occurrences delivered by a producer other than the responsible agent. */
  deliveredByOtherProducer: number;
  /** Work items delivered for this row in the window, sorted (capped at 5000; `deliveredItemCount` is exact). Calibration samples from these. */
  deliveredItems: EvaluationWorkItemRef[];
  deliveredItemCount: number;
  note: string | null;
}
export interface AgentCardObligationsSection {
  responsibilities: AgentCardObligationRow[];
  /** Work in the window mapped to no responsibility (its own bucket). */
  unmapped: { items: number };
}

export interface AgentCardJudgeTally {
  pass: number;
  fail: number;
  /** In scope but not judged by this judge type (bound judgments only). */
  unknown: number;
}
/** 2. Is the work good? Per criterion, per judge type, bound judgments only. */
export interface AgentCardCriterionRow {
  criterion: EvaluationCriterionRef;
  text: string;
  predicate: EvaluationTypedPredicate;
  /** Items in scope for this criterion: the denominator for every judge column. */
  items: number;
  byJudge: Record<AgentJudgeKind, AgentCardJudgeTally>;
}
export interface AgentCardQualitySection {
  criteria: AgentCardCriterionRow[];
  /** Who judged, related to the producer or not (`independence.ts`). Kept apart from source diversity (LLD §6.3). */
  judgeIndependence: { independent: number; notIndependent: number; unknown: number };
  /** Source tiers behind the decisive facts. Tier diversity is not assessor independence. */
  sourceDiversity: Partial<Record<EvaluationSourceTier, number>>;
  /** Automated observations naming no criterion tuple (every legacy receipt): counted here, never in `criteria`. */
  unboundObservations: number;
  /** Rework charged to this agent as producer; never to a reviewer of the item (LLD §6.3). */
  rework: { items: number; reopened: number };
}

/** A fact kept as its own column: never implied by another (LLD §1). */
export interface AgentCardFactCount {
  yes: number;
  no: number;
  unknown: number;
  of: number;
}
/** A project led or goal owned during the window, with its milestone O-metrics recomputed at the card's cut (LLD §8). */
export interface AgentCardAccountableResult {
  ref: EvaluationMilestoneRef;
  name: string | null;
  /** Lead (project) or owner (goal) intervals inside the window, from roster snapshots. */
  intervals: Array<{ role: "lead" | "owner"; from: string; to: string | null }>;
  citation: AgentCardDependencyCitation;
  outcome: Partial<Record<EvaluationOutcomeMetric, MetricResult>>;
}
/** 3. Is it accepted, used, and moving the result? The four facts are separate; the two lists are never merged into one number. */
export interface AgentCardAcceptanceSection {
  /** Over items where this agent was the producer at delivery. */
  facts: { automatedAcceptance: AgentCardFactCount; humanAcceptance: AgentCardFactCount; use: AgentCardFactCount; outcome: AgentCardFactCount };
  accountable: AgentCardAccountableResult[];
  delivered: { items: number; byResponsibility: Record<string, number> };
}

/** 4. What does it cost? Proxies, labelled; not minutes saved (LLD §15). */
export interface AgentCardCostSection {
  /** Null when no cost source exists in the window. */
  spendCents: number | null;
  /** Spend on runs with no issue, kept as unattributed (LLD §9.2). */
  unattributedSpendCents: number | null;
  runs: { total: number; succeeded: number; failed: number; withoutIssue: number };
  questionsToPeople: { asked: number; answered: number; medianWaitMinutes: number | null };
  humanReviewActions: number;
  humanCorrections: number;
  /** Labelled self-reported wherever shown. */
  selfReportedMinutes: number | null;
  /**
   * Burden that names people. Served to company admins and the accountable
   * user only (LLD §11); null for every other viewer, whatever the classes.
   */
  byPerson: Array<{ userId: string; questions: number; reviews: number; corrections: number }> | null;
}

/** 5. Is it staying inside its boundaries? Refusals are attempts; only unauthorized execution is a breach (LLD §6.3). */
export interface AgentCardBoundsSection {
  /** Null when no allowed-use source exists. */
  allowedUse: number | null;
  refusedAttempts: number;
  /** Same dimension and target after a refusal; each raises an exception for the owner. */
  repeatedAfterRefusal: number;
  /** Shadow mode: what V2 would have refused. */
  wouldRefuse: number;
  /** An action that ran outside the policy in force, found in audit records. E3. */
  unauthorizedExecution: number;
  byDimension: Record<string, { refused: number; repeated: number; wouldRefuse: number; unauthorized: number }>;
}

export interface AgentCardException {
  kind: AgentExceptionKind;
  /** Deterministic: `<kind>:<subject>:<qualifier>`, stable across recomputes. */
  key: string;
  severity: EvaluationExceptionSeverity;
  /** The person it is routed to (the accountable user for disagreements and repeats). */
  routeToUserId: string | null;
  item: EvaluationWorkItemRef | null;
  criterion: EvaluationCriterionRef | null;
  raisedAt: string;
  evidenceRefs: string[];
  note: string;
}
/** A criterion-level disagreement between bound judgments. Both stay; nothing is settled by vote (LLD §10). */
export interface AgentCardDisagreement {
  criterion: EvaluationCriterionRef;
  item: EvaluationWorkItemRef;
  judgments: Array<{ judge: AgentJudgeKind; result: AgentJudgmentResult; eventId: string; at: string }>;
  /** The `disagreement_noted` disposition, once a person records it. */
  notedEventId: string | null;
}
/** 6. What needs my decision? */
export interface AgentCardDecisionsSection {
  exceptions: AgentCardException[];
  disagreements: AgentCardDisagreement[];
  /** Calibration (LLD §10): agreement per judge with denominators, bound judgments only. */
  calibration: {
    sampled: number;
    closed: number;
    agreementByJudge: Partial<Record<AgentJudgeKind, { agree: number; of: number }>>;
  };
  /** Work owed by no applied responsibility. */
  unownedWork: number;
}

/** The six sections as stored. */
export interface AgentCardWorkerBodies {
  obligations: AgentCardObligationsSection;
  quality: AgentCardQualitySection;
  acceptance: AgentCardAcceptanceSection;
  cost: AgentCardCostSection;
  bounds: AgentCardBoundsSection;
  decisions: AgentCardDecisionsSection;
}
export type AgentCardStoredSections = { [K in AgentCardSectionKey]: AgentCardStoredSection<AgentCardWorkerBodies[K]> };
export type AgentCardSectionViews = { [K in AgentCardSectionKey]: AgentCardSectionView<AgentCardWorkerBodies[K]> };

/** The agent's work as a reviewer of others' work. A separate section, never mixed into its work as a worker. */
export interface AgentCardReviewerSection {
  reviews: { total: number; bound: number; unbound: number; byOutcome: Record<string, number> };
  /** Was it independent of the producer of each item it reviewed. */
  independence: { independent: number; notIndependent: number; unknown: number };
  /** Agreement with later bound human judgments on the same tuple and item. */
  agreementWithPeople: { agree: number; disagree: number; of: number };
}

/** A potentially fatal flag (LLD §6.4). Every one is routed to calibration until a person closes it. */
export interface AgentCardFatalFlag {
  fatalClass: AgentFatalClass;
  /** Deterministic key, stable across recomputes. */
  key: string;
  status: "potential" | "confirmed" | "dismissed";
  item: EvaluationWorkItemRef | null;
  raisedAt: string;
  evidenceRefs: string[];
  note: string;
}

export interface AgentCardGap {
  code: AgentCardGapCode;
  section: AgentCardSectionKey | "reviewer";
  message: string;
  responsibilityKey?: string | null;
  /** For `COVERAGE_WITHOUT_SOURCE`. */
  coverageClass?: EvaluationCoverageClass | null;
}

/** The contract in force at the cut: the agent's last `contract.declared` (v2), or none. */
export interface AgentCardContractSummary {
  source: "declared" | "none";
  contractVersion: "v2" | "none";
  contractEventId: string | null;
  profileRevisionId: string | null;
  declaredAt: string | null;
  accountableUserId: string | null;
  responsibilities: Array<{
    key: string;
    criteria: Array<{ ref: EvaluationCriterionRef; text: string; predicate: EvaluationTypedPredicate }>;
    coverage: EvaluationCoverageClass[];
    expectedHumanSteps: EvaluationExpectedHumanStep[];
    humanJudge: { userId: string; sampleRate: number; minPerWindow: number } | null;
  }>;
}

/**
 * The stored agent card (`evaluation_scorecards`, `milestone_kind = 'agent'`).
 * A pure function of the ledger rows `seq ≤ replay.throughSeq` and `replay`;
 * `verify` re-runs `scoreAgent` with exactly these and compares hashes. It is
 * computed from all classes and NEVER served raw: viewers get an
 * `AgentCardView`. There is no headline composite.
 */
export interface AgentCardV1 {
  kind: "agent_card";
  cardVersion: typeof AGENT_CARD_VERSION;
  formulaVersion: typeof AGENT_METRICS_VERSION;
  scorecardKind: typeof AGENT_CARD_SCORECARD_KIND;
  companyId: string;
  subjectRef: EvaluationAgentSubjectRef;
  agentName: string | null;
  contract: AgentCardContractSummary;
  replay: AgentCardReplayInputs;
  /** Every access class the card rests on (sorted, distinct): decides whether a viewer gets the stored card or a recompute. */
  accessClasses: EvaluationAccessClass[];
  /** Shown first, whatever the averages. */
  fatal: AgentCardStoredSection<AgentCardFatalFlag[]>;
  /** The agent as a worker: the six sections in question order. */
  worker: AgentCardStoredSections;
  /** The agent as a reviewer: separate. */
  reviewer: AgentCardStoredSection<AgentCardReviewerSection>;
  gaps: AgentCardStoredSection<AgentCardGap[]>;
  markers: string[];
}

/**
 * What a viewer receives (LLD §9.1, §11). When the viewer reads every class in
 * `card.accessClasses`, the stored body is served without its class lists.
 * Otherwise the card is recomputed by `scoreAgent` over only the rows that
 * viewer may read, at the same replay inputs (pure, so deterministic), and a
 * section is `not_visible` when the viewer reads none of its stored classes,
 * `partial` when some. Replay dependencies the viewer can't read are dropped.
 */
export interface AgentCardView {
  kind: "agent_card_view";
  cardVersion: typeof AGENT_CARD_VERSION;
  formulaVersion: typeof AGENT_METRICS_VERSION;
  companyId: string;
  agentId: string;
  agentName: string | null;
  /** The stored version projected; null for a side-effect-free "Compute now" projection. */
  stored: { version: number; storedAt: string; cardHash: string } | null;
  sideEffectFree: boolean;
  contract: AgentCardContractSummary;
  replay: AgentCardReplayInputs;
  /** Set from the viewer, not from the data: true whenever some class could be hidden from this viewer, so saying so leaks nothing. */
  restricted: boolean;
  fatal: AgentCardSectionView<AgentCardFatalFlag[]>;
  worker: AgentCardSectionViews;
  reviewer: AgentCardSectionView<AgentCardReviewerSection>;
  gaps: AgentCardSectionView<AgentCardGap[]>;
  markers: string[];
  /**
   * AgentDash (APM gate 3, P3.7): what this viewer may do with this card,
   * computed from the same guards the routes apply. Presentation only — the
   * server checks every action again.
   */
  viewer: AgentCardViewerPermissions;
}

/** What a viewer may do on an agent card (each flag mirrors the route that checks it). */
export interface AgentCardViewerPermissions {
  /** `POST …/snapshot` and `GET …/verify`: a company admin (instance admins included) or the agent's accountable person. */
  canSnapshot: boolean;
  /** A `disagreement_noted` disposition: an admin or the accountable person of the agent's contract. */
  canNoteDisagreement: boolean;
  /** A `use_confirmed` disposition: any person who can see the agent. */
  canConfirmUse: boolean;
  /**
   * The criterion tuple keys (`evaluationCriterionRefKey`) of this card this
   * viewer may attest (`criterion_attest`): those naming them as the
   * `human_attest` person or the responsibility's human judge.
   */
  attestableCriteria: string[];
}

/** `GET evaluation/agents/:agentId[?version=]`. `viewer` is present even when no card is stored yet. */
export interface AgentCardResponse {
  card: AgentCardView | null;
  viewer: AgentCardViewerPermissions;
}

/** One stored version (`GET evaluation/agents/:agentId/versions`), newest first. No card content. */
export interface AgentCardVersionSummary {
  version: number;
  cardHash: string;
  throughSeq: number;
  /** The stored replay input `asOf`. */
  asOf: string;
  createdAt: string;
}

export interface AgentCardVersionList {
  agentId: string;
  versions: AgentCardVersionSummary[];
}

/** Calibration review items synced by a snapshot (the server's review-items sync result). */
export interface AgentCardReviewItemSync {
  /** Null when nothing was created. */
  projectId: string | null;
  labelId: string | null;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Closed by the human: left closed, never recreated or reopened. */
  closed: string[];
  /** No human to route to: recorded, not silently dropped. */
  unrouted: string[];
  /** The routed human is not an active member: recorded, not silently dropped. */
  unassignable: Array<{ key: string; userId: string }>;
}

/** `snapshotAgentCard`: the version stored (or reused) for the current cut. */
export interface AgentCardSnapshotResult {
  version: number;
  /** True when the newest stored version was returned instead of a new one. */
  reused: boolean;
  throughSeq: number;
  cardHash: string;
  formulaVersion: string;
  /** Agent exceptions appended as `evaluation.finding` events (dedupe like milestone findings). */
  findings: { inserted: number; skipped: number };
  /** Calibration review items synced for this version; null when none were due. */
  reviewItems: AgentCardReviewItemSync | null;
}

/** `verifyAgentCard`: replay from the stored inputs and compare hashes. */
export type AgentCardVerifyResult =
  | { ok: false; status: "missing"; reason: string }
  /** Old cards stay immutable records; re-verifying them under newer code is not supported (LLD §6.1). */
  | { ok: false; status: "formula_changed"; reason: string; version: number }
  | {
      ok: boolean;
      status: "agree" | "disagree";
      version: number;
      throughSeq: number;
      storedHash: string;
      replayHash: string;
      /** Each cited milestone recomputed at its pinned cut and open flag. */
      dependencies: Array<{ kind: "project" | "goal"; id: string; storedHash: string; replayHash: string; ok: boolean }>;
    };

/** `POST evaluation/agents/:agentId/snapshot`: the snapshot, its immediate verify, and the stored card projected for the caller. */
export interface AgentCardSnapshotResponse {
  snapshot: AgentCardSnapshotResult;
  verify: AgentCardVerifyResult | null;
  card: AgentCardView | null;
}

/** One row of `GET evaluation/agents` (latest stored version, projected). */
export interface AgentCardSummary {
  agentId: string;
  agentName: string | null;
  /** AgentDash (P3.7): the agent's url key today (its current name, as every agent route resolves it), for links. */
  urlKey: string;
  stored: { version: number; storedAt: string; cardHash: string; throughSeq: number } | null;
  contractSource: AgentCardContractSummary["source"];
  /** Fatal flags this viewer can read; null when the fatal section is not visible to them. */
  fatalFlags: number | null;
  /** Per responsibility, owed and delivered, from the obligations section this viewer can read; null when not visible. */
  obligations: Array<{ responsibilityKey: string; owed: number | null; delivered: number }> | null;
  restricted: boolean;
}

// ---- Drill-down (LLD §12 `GET evaluation/agents/:agentId/cases`) -----------

/** One case behind a number. Rows are filtered by access class before anything is counted or paged. */
export interface AgentCaseRow {
  /** Stable within a version: the occurrence id, or `<section>:<eventId>`. */
  caseId: string;
  section: AgentCardSectionKey | "reviewer" | "fatal";
  responsibilityKey: string | null;
  /** An obligation end state, a judgment result, or a bounds/fatal state. */
  state: AgentObligationEndState | AgentJudgmentResult | "refused" | "repeated_after_refusal" | "would_refuse" | "unauthorized_execution" | AgentCardFatalFlag["status"];
  /** This agent's role in the case. */
  role: AgentWorkRole;
  item: EvaluationWorkItemRef | null;
  /** The issue identifier or deliverable run key; never a raw id as a label. */
  itemLabel: string | null;
  occurrenceId: string | null;
  criterion: EvaluationCriterionRef | null;
  judge: AgentJudgeKind | null;
  /** AgentDash (P3.7): which of the four acceptance facts an `acceptance` case stands for; absent elsewhere. */
  fact?: AgentAcceptanceFact | null;
  /** Event time of the deciding fact. */
  at: string;
  /**
   * Ledger event ids behind the case. A quality case with no judgment yet
   * still cites the item's records (its delivery, verdicts, run), so a bound
   * `criterion_attest` has something to cite.
   */
  evidenceRefs: string[];
  note: string | null;
}

export interface AgentCaseFilter {
  /** Stored version; latest when omitted. */
  version?: number;
  /** A responsibility key, or `AGENT_CASE_FILTER_NONE` for cases with no responsibility. */
  responsibility?: string;
  state?: AgentCaseRow["state"];
  section?: AgentCaseRow["section"];
  /** AgentDash (P3.7): one acceptance fact. */
  fact?: AgentAcceptanceFact;
  /** AgentDash (P3.7): a criterion tuple key (`evaluationCriterionRefKey`), or `AGENT_CASE_FILTER_NONE` for cases with no criterion. */
  criterion?: string;
  /** AgentDash (P3.7): the judge kind of the case. */
  judge?: AgentJudgeKind;
  limit?: number;
  cursor?: string | null;
}

export interface AgentCaseList {
  agentId: string;
  version: number | null;
  throughSeq: number | null;
  /** Rows this viewer may read, after the filter. The count never includes hidden rows. */
  rows: AgentCaseRow[];
  total: number;
  nextCursor: string | null;
  restricted: boolean;
}
