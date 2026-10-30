// AgentDash: Agent Performance Management gate 5 ("start from a brief").
//
// An owner pastes a Markdown agent-work brief. It becomes a planning issue
// (backlog, unassigned) whose `agent-work-brief` issue document holds the
// brief with its revisions. Submitting assigns the issue to the company's
// effective performance manager (the planner) — an ordinary assignment, so
// it wakes the planner the normal way. The planner writes a validated
// `scenario-manifest` document and unbound draft profiles; an unbound draft
// is proposed as a `hire_agent` approval carrying its revision, and the
// approved hire binds and applies the profile through the gate 2 path.
// Saving or previewing never hires an agent or starts a heartbeat.
// Design: doc/plans/2026-10-29-apm-gate4-5-build-spec.md (gate 5, P5.1),
// doc/plans/2026-10-28-agent-performance-management-discovery.md §2 and §4.

import type { AgentProfileChangePayload, AgentProfileRevisionDto, AgentProfileRevisionSummary } from "./agent-profile.js";

/** The issue document key that holds the pasted brief (Markdown, revisioned). */
export const AGENT_WORK_BRIEF_DOCUMENT_KEY = "agent-work-brief" as const;
/** The issue document key that holds the planner's scenario manifest (JSON text, validated on write). */
export const AGENT_SCENARIO_MANIFEST_DOCUMENT_KEY = "scenario-manifest" as const;
/**
 * `issues.origin_kind` of a planning issue created from a brief. Only the
 * brief route sets it (clients can set no origin but `execos_request`), so it
 * is what "an issue created as a brief" means — the manifest is validated
 * only there.
 */
export const AGENT_WORK_BRIEF_ORIGIN_KIND = "agent_work_brief" as const;

/** What the planner recommends for one scenario (discovery draft §4 step 3). */
export const AGENT_SCENARIO_RECOMMENDATIONS = [
  "reuse",
  "bounded_change",
  "new_role",
  "deterministic_workflow",
  "human_owned",
] as const;
export type AgentScenarioRecommendation = (typeof AGENT_SCENARIO_RECOMMENDATIONS)[number];

/** `POST /api/companies/:companyId/agent-briefs` and `.../submit`. */
export interface AgentBriefResult {
  kind: "agent_brief";
  companyId: string;
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  /** The `agent-work-brief` document: its id and current revision. */
  document: { id: string; key: typeof AGENT_WORK_BRIEF_DOCUMENT_KEY; latestRevisionId: string | null; latestRevisionNumber: number };
}

/** 409 on submit when the company has no effective performance manager. */
export const AGENT_BRIEF_NO_PERFORMANCE_MANAGER = "AGENT_BRIEF_NO_PERFORMANCE_MANAGER";
/** 409 on submit of a brief already assigned. */
export const AGENT_BRIEF_ALREADY_SUBMITTED = "AGENT_BRIEF_ALREADY_SUBMITTED";
/** 422 on a `scenario-manifest` write that does not parse as `AgentScenarioManifestV1`. */
export const AGENT_SCENARIO_MANIFEST_INVALID = "AGENT_SCENARIO_MANIFEST_INVALID";
/** 422 on proposing an unbound draft that cannot be filed as a hire. */
export const AGENT_PROFILE_HIRE_INVALID = "AGENT_PROFILE_HIRE_INVALID";

// ---------------------------------------------------------------------------
// Unbound drafts (a profile for a role not hired yet)
// ---------------------------------------------------------------------------

/** What the caller may do with an unbound profile, from the mutations' own guards. */
export interface UnboundAgentProfileViewerPermissions {
  /** Save the open draft, or start a new one when none is open and none is pending. */
  canEditDraft: boolean;
  /** Propose the open draft as a hire; false when no draft is open. */
  canPropose: boolean;
  /** Withdraw the pending hire proposal (its proposer or an administrator); false when nothing is pending. */
  canWithdraw: boolean;
}

/** `GET /api/companies/:companyId/agent-profiles` (one row per unbound profile). */
export interface UnboundAgentProfileSummary {
  profileId: string;
  companyId: string;
  /** Null while unbound; the hired agent once a hire bound it. */
  agentId: string | null;
  name: string;
  title: string;
  latestRevision: AgentProfileRevisionSummary | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/companies/:companyId/agent-profiles/:profileId`. */
export interface UnboundAgentProfileView {
  kind: "unbound_agent_profile_view";
  version: "agent-profile/1";
  companyId: string;
  profileId: string;
  /** Null while unbound. Once a hire binds it, read and change it on the agent's profile routes. */
  agentId: string | null;
  revisions: AgentProfileRevisionSummary[];
  latestDraft: AgentProfileRevisionDto | null;
  pendingProposal: AgentProfileRevisionSummary | null;
  /** The pending proposal's `hire_agent` approval, if any. */
  hireApprovalId: string | null;
  viewer: UnboundAgentProfileViewerPermissions;
}

/**
 * The profile fields a `hire_agent` approval carries when it was filed by
 * proposing an unbound draft. `profileChange` is computed by the server
 * against the pending agent's derived revision 0 when the hire is filed; the
 * approved hire binds the profile and applies `profileChange` through the
 * gate 2 application (the hire approval's `agents:create` authority is the
 * first application's field authority). Never accepted from a client.
 */
export interface AgentProfileHireFields {
  profileId: string;
  profileRevisionId: string;
  profileRevisionNumber: number;
  profileBodyHash: string;
  profileChange: AgentProfileChangePayload;
}

/** `POST .../agent-profiles/:profileId/revisions/:revisionId/propose`. */
export interface UnboundAgentProfileProposalResult {
  revision: AgentProfileRevisionDto;
  /** The `hire_agent` approval. Nothing is hired until a person approves it. */
  approvalId: string;
  /** The pending agent the hire would activate (`pending_approval`; it never runs before approval). */
  agentId: string;
  payload: AgentProfileChangePayload;
}
