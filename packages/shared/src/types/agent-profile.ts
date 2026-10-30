// AgentDash: Agent Performance Management, gate 2 ("people define it").
//
// DTOs for the operating profile: revisions, the approval payload, the
// application receipt, and responsibility mapping. Drafting, approving and
// applying are three separate records — a saved draft changes nothing, an
// approved revision changes nothing until its application succeeds.
// Design: doc/plans/2026-10-29-agent-performance-management-lld.md §3–5,
// doc/plans/2026-10-29-agent-access-lld.md §3–4 and §11,
// doc/plans/2026-10-29-agent-evaluation-lld.md §3 and §5.2.

import type { AgentAccessV2Clip } from "../agent-access-v2.js";
import type {
  AgentOperatingProfileV1,
  AgentProfileDiffEntry,
  AgentProfileProvenanceMap,
  AgentProfileSourceRef,
} from "../validators/agent-profile.js";
import type { AgentAccessV2Dimension, AgentGovernancePolicy } from "./agent-governance.js";
import type { AgentProfileDerived } from "./agent-performance.js";

// ---------------------------------------------------------------------------
// Company enforcement mode (access LLD §4, §7, §11)
// ---------------------------------------------------------------------------

/**
 * Per-company V2 access mode, stored as `companies.agent_access_enforcement`.
 * - `off`: no V2 check runs.
 * - `shadow`: V2 is evaluated and would-be refusals are logged (`access.would_refuse`); nothing is refused.
 * - `enforce`: V2 refusals are refused. Not selectable in gate 2.
 */
export const AGENT_ACCESS_ENFORCEMENT_MODES = ["off", "shadow", "enforce"] as const;
export type AgentAccessEnforcementMode = (typeof AGENT_ACCESS_ENFORCEMENT_MODES)[number];

/** Gate 2 may select only these; `enforce` answers 409 until gate 3. */
export const AGENT_ACCESS_ENFORCEMENT_MODES_SELECTABLE_GATE2 = ["off", "shadow"] as const;

/** `GET /api/companies/:companyId/agent-access-enforcement`. */
export interface AgentAccessEnforcementView {
  companyId: string;
  mode: AgentAccessEnforcementMode;
  /** The modes this build lets an admin choose; the UI enables exactly these. */
  selectableModes: AgentAccessEnforcementMode[];
}

/** `PATCH /api/companies/:companyId/agent-access-enforcement`: the new view, plus what it replaced. */
export interface AgentAccessEnforcementUpdateResult extends AgentAccessEnforcementView {
  changed: boolean;
  previousMode: AgentAccessEnforcementMode;
}

/** What a server-side access check concluded. `refuse` only ever comes from `enforce`. */
export type AgentAccessCheckOutcome = "allow" | "would_refuse" | "refuse";

/** Error code and 403 body for an enforced V2 refusal (access LLD §4). Gate 2 never sends it. */
export const ACCESS_POLICY_REFUSED = "ACCESS_POLICY_REFUSED";

export interface AgentAccessRefusalBody {
  code: typeof ACCESS_POLICY_REFUSED;
  dimension: AgentAccessV2Dimension;
  rule: string;
  requested: Record<string, unknown>;
  allowedSummary: string;
  howToRequest: string;
}

// ---------------------------------------------------------------------------
// Revisions (overview LLD §3.2)
// ---------------------------------------------------------------------------

/**
 * `draft → proposed → approved | rejected | withdrawn`, then
 * `approved → applied | application_failed | refused_stale`, then
 * `applied → superseded`. Only `draft` is editable.
 */
export const AGENT_PROFILE_REVISION_STATES = [
  "draft",
  "proposed",
  "approved",
  "rejected",
  "withdrawn",
  "applied",
  "application_failed",
  "refused_stale",
  "superseded",
] as const;
export type AgentProfileRevisionState = (typeof AGENT_PROFILE_REVISION_STATES)[number];

/**
 * What a proposal was frozen against. Application refuses as stale when any of
 * them moved (overview LLD §4.2 step 2), so an old approval can never quietly
 * restore access someone removed since.
 */
export interface AgentProfileBases {
  /** The active revision when proposed; null when the agent had none (first profile). */
  basedOnRevisionId: string | null;
  /** `agent_governance_policies.revision` when proposed; null when no governance row existed. */
  governanceRevision: number | null;
  /** The latest `agent_config_revisions.id` when proposed; null when the agent had none. */
  configRevisionId: string | null;
}

export interface AgentProfileRevisionDto {
  id: string;
  companyId: string;
  profileId: string;
  /** Null for an unbound draft (a role not hired yet). */
  agentId: string | null;
  /** 1-based, unique per profile. Derived revision 0 is never stored. */
  revisionNumber: number;
  basedOnRevisionId: string | null;
  state: AgentProfileRevisionState;
  body: AgentOperatingProfileV1;
  /** `profileBodyHash(body)`. The `If-Match` value for draft edits. */
  bodyHash: string;
  provenance: AgentProfileProvenanceMap;
  sourceRefs: AgentProfileSourceRef[];
  /** Null until proposed. */
  bases: AgentProfileBases | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  /** The `agent_profile_change` approval, once proposed. */
  approvalId: string | null;
  /**
   * AgentDash (APM gate 4): `"performance_manager"` when the revision's
   * approval says the company's performance manager filed it (its payload's
   * `proposedBy.capacity`, or a profile hire's `profileChange.proposedBy`);
   * null otherwise, including before it is proposed. A label only, so readers
   * need not fetch each approval. Optional for older readers; the server
   * always sets it.
   */
  proposedByCapacity?: "performance_manager" | null;
  createdAt: string;
  updatedAt: string;
}

/** A revision without its body, for history lists. */
export type AgentProfileRevisionSummary = Omit<AgentProfileRevisionDto, "body" | "provenance" | "sourceRefs">;

/**
 * `GET /api/companies/:companyId/agents/:agentId/profile` (and the agent's own
 * `GET /api/agents/me/profile`). `derived` is the gate 1 revision 0, present
 * only while the agent has no active revision; it is a starting point, never
 * applied automatically.
 */
export interface AgentProfileView {
  kind: "agent_profile_view";
  version: "agent-profile/1";
  companyId: string;
  agentId: string;
  /** Null until the first draft is saved. */
  profileId: string | null;
  active: AgentProfileRevisionDto | null;
  /** The newest revision in `draft` state, if any. */
  latestDraft: AgentProfileRevisionDto | null;
  /** The revision awaiting a decision (`proposed`), if any. */
  pendingProposal: AgentProfileRevisionSummary | null;
  /** Revision 0 derived from today's records; null once a revision has been applied. */
  derived: AgentProfileDerived | null;
  /** The newest application receipt, so a failed one can offer Resume. */
  latestApplication: AgentProfileApplicationDto | null;
  /** True while an application is in progress; new runs for this agent are deferred. */
  applicationInProgress: boolean;
  /** What the caller may do here, from the mutations' own guards. */
  viewer: AgentProfileViewerPermissions;
  /**
   * AgentDash (APM gate 4): whether this agent is the company's effective
   * performance manager (the designated agent, else the non-terminated Chief
   * of Staff). The `performance-manager-guidance` prompt block applies only
   * when this is true. Optional for older readers; the server always sets it.
   */
  performanceManager?: boolean;
}

/**
 * What the reader of an `AgentProfileView` may do, computed server-side by
 * running each mutation's own authority guard against its target — never a
 * separate approximation. Each flag answers "would the guard let me?" only:
 * a state precondition the mutation also checks (409: another proposal is
 * pending, the active profile moved, the application ended or is still live)
 * is not folded in, and the server's refusal is still the answer.
 */
export interface AgentProfileViewerPermissions {
  /** Start a draft (none open) or save the open one: the draft-write guard. */
  canEditDraft: boolean;
  /** Propose the open draft; false when no draft is open. */
  canPropose: boolean;
  /** Withdraw the pending proposal; false when nothing is pending. */
  canWithdraw: boolean;
  /** Resume the newest application (its approver or an administrator); false when there is none. */
  canResumeApplication: boolean;
  /** Approve or reject the pending proposal (the decider rule); null when nothing is pending. */
  canDecideActiveProposal: boolean | null;
}

// ---------------------------------------------------------------------------
// Approval payload (overview LLD §4.1)
// ---------------------------------------------------------------------------

/**
 * The authority a changed field needs, by the rules direct edits follow today:
 * - `steward_or_accountable`: identity, style, responsibilities, criteria,
 *   knowledge, rhythm text, and access within the admin ceiling;
 * - `admin`: runtime / adapter / environment fields (host-executed settings);
 * - `admin_ceiling`: access beyond the ceiling — an admin, who raises the
 *   ceiling as a separate recorded step.
 * Ordered weakest to strongest; the decider needs the strongest any field needs.
 */
export const AGENT_PROFILE_FIELD_AUTHORITIES = ["steward_or_accountable", "admin", "admin_ceiling"] as const;
export type AgentProfileFieldAuthority = (typeof AGENT_PROFILE_FIELD_AUTHORITIES)[number];

export interface AgentProfileFieldAuthorityEntry {
  /** JSON pointer into the profile body, as in `diff`. */
  pointer: string;
  required: AgentProfileFieldAuthority;
  /** Why, in plain words — e.g. "adapter settings run on the host". */
  reason?: string | null;
}

export interface AgentProfileAccessChange {
  dimension: AgentAccessV2Dimension | keyof AgentGovernancePolicy;
  /** `changes` when the two scopes cannot be ranked (e.g. `listed` vs `reports_chain`). */
  change: "widens" | "narrows" | "changes";
  /** The request asks for more than the ceiling; the effective access is clipped to it. */
  clippedByCeiling: boolean;
  clip?: AgentAccessV2Clip | null;
  detail?: string | null;
}

export type AgentProfileProposer =
  | {
      kind: "agent";
      agentId: string;
      runId?: string | null;
      /**
       * AgentDash (APM gate 4): set when the company's effective performance
       * manager files the proposal for another agent. It is a label only: the
       * proposer is still an agent, so a person must decide and the proposing
       * agent never can.
       */
      capacity?: "performance_manager";
    }
  | { kind: "user"; userId: string };

/** The `payload` of an `agent_profile_change` approval. The server computes it at propose time. */
export interface AgentProfileChangePayload {
  agentId: string;
  profileId: string;
  revisionId: string;
  revisionNumber: number;
  basedOnRevisionId: string | null;
  bases: AgentProfileBases;
  /** Body hash at freeze; application refuses if the stored body no longer matches. */
  bodyHash: string;
  diff: AgentProfileDiffEntry[];
  fieldAuthority: AgentProfileFieldAuthorityEntry[];
  /** The strongest `fieldAuthority` entry; the decider must hold it. */
  requiredAuthority: AgentProfileFieldAuthority;
  /** Responsibility keys added, removed or changed. */
  affectedResponsibilities: string[];
  accessChanges: AgentProfileAccessChange[];
  evidence: {
    cardId?: string | null;
    cardVersion?: number | null;
    ledgerEventIds: string[];
  };
  reason: string | null;
  expectedBenefit: string | null;
  risks: string | null;
  proposedBy: AgentProfileProposer;
}

/** Recorded with the approval decision (overview LLD §4.1 "Who decides"). */
export interface AgentProfileDecisionRecord {
  decisionActorRole: "admin" | "steward" | "accountable";
  /** A human author with the required authority approved their own draft. */
  selfApproval: boolean;
  requiredAuthority: AgentProfileFieldAuthority;
}

// ---------------------------------------------------------------------------
// Application receipt (overview LLD §4.2)
// ---------------------------------------------------------------------------

export const AGENT_PROFILE_APPLICATION_STATUSES = ["pending", "in_progress", "applied", "failed", "refused_stale"] as const;
export type AgentProfileApplicationStatus = (typeof AGENT_PROFILE_APPLICATION_STATUSES)[number];

/** Step 4 (a)–(f), in execution order. Activation (step 5) is not a step: it is the final transaction. */
export const AGENT_PROFILE_APPLICATION_STEPS = [
  "governance_request",
  "config",
  "environment",
  "routine_bindings",
  "skills",
  "contract",
] as const;
export type AgentProfileApplicationStep = (typeof AGENT_PROFILE_APPLICATION_STEPS)[number];

export const AGENT_PROFILE_APPLICATION_STEP_STATUSES = ["pending", "done", "skipped", "failed"] as const;
export type AgentProfileApplicationStepStatus = (typeof AGENT_PROFILE_APPLICATION_STEP_STATUSES)[number];

/** One durable step record, keyed by `(applicationId, step)`. */
export interface AgentProfileApplicationStepRecord {
  step: AgentProfileApplicationStep;
  status: AgentProfileApplicationStepStatus;
  /** What the step wrote: governance row id, config revision id, contract event id, … */
  targetId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  /** Plain-language failure, never a secret or a stack. */
  error: string | null;
  completedAt: string | null;
}

/** The approver's authority as checked at application time (step 3). */
export interface AgentProfileApproverAuthority {
  role: "admin" | "steward" | "accountable";
  required: AgentProfileFieldAuthority;
  checkedAt: string;
  selfApproval: boolean;
}

export interface AgentProfileApplicationDto {
  id: string;
  companyId: string;
  agentId: string;
  revisionId: string;
  approvalId: string | null;
  status: AgentProfileApplicationStatus;
  /** Every step in `AGENT_PROFILE_APPLICATION_STEPS` order, `pending` until reached. */
  steps: AgentProfileApplicationStepRecord[];
  approverUserId: string | null;
  approverAuthority: AgentProfileApproverAuthority | null;
  /** Why the application stopped: the stale base, the lost authority or the failed step. */
  failure: { kind: "stale" | "authority" | "step"; step?: AgentProfileApplicationStep | null; detail: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** Run-start evidence written into `heartbeat_runs.context_snapshot` (overview LLD §3.4). */
export interface AgentProfileDeliveryEvidence {
  profileRevisionId: string | null;
  /** Hash of the operating-profile block actually read from disk; null when absent or unreadable. */
  blockHashOnDisk: string | null;
  /** Hash the active revision renders to; null when the agent has no active revision. */
  expectedHash: string | null;
}

// ---------------------------------------------------------------------------
// Responsibility mapping (evaluation LLD §5.2)
// ---------------------------------------------------------------------------

export const ISSUE_RESPONSIBILITY_MAPPED_BY = ["routine", "deliverable", "planner", "agent", "human"] as const;
export type IssueResponsibilityMappedBy = (typeof ISSUE_RESPONSIBILITY_MAPPED_BY)[number];

/** One interval of an append-only history. `validTo === null` is the current mapping. */
export interface IssueResponsibilityDto {
  id: string;
  companyId: string;
  issueId: string;
  agentId: string;
  responsibilityKey: string;
  /** The active revision that defined the key when mapped. */
  profileRevisionId: string | null;
  validFrom: string;
  validTo: string | null;
  mappedBy: IssueResponsibilityMappedBy;
  /** Agent id or user id of whoever mapped it; null for system dispatch. */
  mappedByActorId: string | null;
  reason: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Error codes (overview LLD §5)
// ---------------------------------------------------------------------------

/** 409 on a draft save whose `If-Match` is not the current body hash; the body carries the current draft. */
export const AGENT_PROFILE_DRAFT_CONFLICT = "AGENT_PROFILE_DRAFT_CONFLICT";
/** 409 on an edit, propose or withdraw of a revision not in the required state. */
export const AGENT_PROFILE_REVISION_STATE_CONFLICT = "AGENT_PROFILE_REVISION_STATE_CONFLICT";
/** 422 on a responsibility mapping whose key is not in the agent's active profile. */
export const AGENT_PROFILE_UNKNOWN_RESPONSIBILITY = "AGENT_PROFILE_UNKNOWN_RESPONSIBILITY";
/** 409 on an application or resume while another application holds the agent. */
export const AGENT_PROFILE_APPLICATION_IN_PROGRESS = "AGENT_PROFILE_APPLICATION_IN_PROGRESS";

export interface AgentProfileDraftConflictBody {
  error: string;
  code: typeof AGENT_PROFILE_DRAFT_CONFLICT;
  current: AgentProfileRevisionDto;
}
