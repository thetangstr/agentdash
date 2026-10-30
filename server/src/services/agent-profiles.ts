import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentConfigRevisions,
  agentGovernancePolicies,
  agentProfileRevisions,
  agentProfiles,
  agents,
  approvals,
} from "@paperclipai/db";
import {
  AGENT_PROFILE_DRAFT_CONFLICT,
  AGENT_PROFILE_HIRE_INVALID,
  AGENT_PROFILE_REVISION_STATE_CONFLICT,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
  agentOperatingProfileV1Schema,
  diffProfiles,
  parseAccessPolicy,
  profileBodyHash,
  type AgentAccessPolicy,
  type AgentOperatingProfileV1,
  type AgentProfileBases,
  type AgentProfileChangePayload,
  type AgentProfileDerived,
  type AgentProfileDiffEntry,
  type AgentProfileProvenanceMap,
  type AgentProfileRevisionDto,
  type AgentProfileRevisionSummary,
  type AgentProfileSourceRef,
  type AgentProfileView,
  type AgentProfileViewerPermissions,
  type CreateAgentProfileDraft,
  type CreateUnboundAgentProfile,
  type AgentProfileHireFields,
  type ProposeUnboundAgentProfile,
  type UnboundAgentProfileProposalResult,
  type UnboundAgentProfileSummary,
  type UnboundAgentProfileView,
  type ProposeAgentProfileRevision,
  type UpdateAgentProfileDraft,
  type WithdrawAgentProfileRevision,
} from "@paperclipai/shared";
import { HttpError, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { insertActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { approvalService } from "./approvals.js";
import {
  affectedResponsibilityKeys,
  classifyProfileFieldAuthority,
  computeAccessChanges,
  resolveProfileAuthorityHolder,
  strongestProfileAuthority,
} from "./agent-profile-authority.js";
import {
  assertCanResumeProfileApplication,
  isProfileApplicationInProgress,
  latestProfileApplication,
} from "./agent-profile-application.js";
import { approvalAuthorityService, type ApprovalDecisionActor } from "./approval-authority.js";
import { UNRESTRICTED_PROJECT_SCOPE, type ViewerProjectScope } from "./agent-performance-authz.js";
import { buildAgentProfileDerived, loadAgentProfileDerivedInput } from "./agent-profile-derived.js";
import { isEffectivePerformanceManager } from "./performance-manager.js";
import { stewardInboxService } from "./steward-inbox.js";

/**
 * AgentDash: Agent Performance Management gate 2 — operating-profile drafts,
 * proposals and reads (overview LLD §3–5; gate 2 spec P2.2).
 *
 * Invariant: draft saves write profile rows only. Nothing here changes
 * governance, config, skills, the AGENTS.md block or the contract — only
 * `applyProfileRevision` (agent-profile-application.ts) does. Every mutation
 * writes an activity entry (`agent_profile.*`), in the same transaction.
 *
 * Who may write a draft (overview LLD §5): the agent's steward, its
 * accountable person, an administrator, the revision's creator, the agent for
 * itself, and the company's effective performance manager (APM gate 4: the
 * designated agent, else the non-terminated Chief of Staff —
 * `resolvePerformanceManager`).
 * Writing a draft is not deciding it: deciding is human-only
 * (agent-profile-authority.ts).
 */

/** Who is acting on a profile. Board actors carry the fields the authority checks need. */
export type AgentProfileActor =
  | { type: "user"; userId: string; source?: string | null; isInstanceAdmin?: boolean; via?: string }
  | { type: "agent"; agentId: string; runId?: string | null };

export interface AgentProfileScope {
  companyId: string;
  agentId: string;
}

type RevisionRow = typeof agentProfileRevisions.$inferSelect;
type ProfileRow = typeof agentProfiles.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

/**
 * Who reads the profile view, as each mutation's route would see them, so
 * `viewer` runs the mutations' own guards (`profileViewerPermissions`).
 */
export interface AgentProfileViewerContext {
  /**
   * The actor the draft, propose and withdraw routes build (`profileActor`).
   * A `user` actor is also the resume route's actor; an agent is refused there
   * (`assertBoard`).
   */
  actor: AgentProfileActor;
  /** `req.actor` as the approve and reject routes pass it to the decider rule; null when those routes refuse the caller (`assertBoard`). */
  decisionActor: ApprovalDecisionActor | null;
  /** The approval routes' read check (`requireApprovalAccess`): false when the caller cannot open this approval. */
  canOpenApproval?: (approval: ApprovalRow) => Promise<boolean>;
}


// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The only capacity a proposer carries today (APM gate 4). */
type ProfileProposerCapacity = "performance_manager";

/**
 * `proposedBy.capacity` from an approval's payload: an `agent_profile_change`
 * payload itself, or a profile hire's (`hire_agent`) `profileChange`. Only an
 * agent proposer can carry it. Pure.
 */
export function proposerCapacityOfApproval(approval: { type: string; payload: unknown }): ProfileProposerCapacity | null {
  const payload = approval.payload && typeof approval.payload === "object" ? (approval.payload as Record<string, unknown>) : null;
  const change =
    approval.type === "agent_profile_change"
      ? payload
      : approval.type === "hire_agent" && payload?.profileChange && typeof payload.profileChange === "object"
        ? (payload.profileChange as Record<string, unknown>)
        : null;
  const proposedBy = change?.proposedBy as { kind?: unknown; capacity?: unknown } | null | undefined;
  return proposedBy?.kind === "agent" && proposedBy.capacity === "performance_manager" ? "performance_manager" : null;
}

/** The proposer capacity of each revision's approval, by approval id (absent: none). One read. */
async function proposerCapacities(
  db: Db,
  companyId: string,
  rows: ReadonlyArray<Pick<RevisionRow, "approvalId"> | null>,
): Promise<ReadonlyMap<string, ProfileProposerCapacity>> {
  const ids = [...new Set(rows.flatMap((row) => (row?.approvalId ? [row.approvalId] : [])))];
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ id: approvals.id, type: approvals.type, payload: approvals.payload })
    .from(approvals)
    .where(and(eq(approvals.companyId, companyId), inArray(approvals.id, ids)));
  const out = new Map<string, ProfileProposerCapacity>();
  for (const approval of found) {
    const capacity = proposerCapacityOfApproval(approval);
    if (capacity) out.set(approval.id, capacity);
  }
  return out;
}

function capacityOf(capacities: ReadonlyMap<string, ProfileProposerCapacity>, row: Pick<RevisionRow, "approvalId">): ProfileProposerCapacity | null {
  return row.approvalId ? (capacities.get(row.approvalId) ?? null) : null;
}

/**
 * `proposedByCapacity` is read from the revision's approval
 * (`proposerCapacities`); callers without one pass nothing (null), which is
 * right for a revision never proposed.
 */
export function toProfileRevisionDto(
  row: RevisionRow,
  agentId: string | null,
  proposedByCapacity: ProfileProposerCapacity | null = null,
): AgentProfileRevisionDto {
  return {
    id: row.id,
    companyId: row.companyId,
    profileId: row.profileId,
    agentId,
    revisionNumber: row.revisionNumber,
    basedOnRevisionId: row.basedOnRevisionId ?? null,
    state: row.state,
    body: row.body,
    bodyHash: row.bodyHash,
    provenance: row.provenance ?? {},
    sourceRefs: row.sourceRefs ?? [],
    bases: row.bases ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdByRunId: row.createdByRunId ?? null,
    approvalId: row.approvalId ?? null,
    proposedByCapacity,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toSummary(dto: AgentProfileRevisionDto): AgentProfileRevisionSummary {
  const { body: _body, provenance: _provenance, sourceRefs: _sourceRefs, ...summary } = dto;
  return summary;
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

async function loadCompanyAgent(db: Db, scope: AgentProfileScope) {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      status: agents.status,
      adapterType: agents.adapterType,
    })
    .from(agents)
    .where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)))
    .then((rows) => rows[0] ?? null);
}

async function requireCompanyAgent(db: Db, scope: AgentProfileScope) {
  const agent = await loadCompanyAgent(db, scope);
  if (!agent) throw notFound("Agent not found");
  return agent;
}

async function loadProfileRow(db: Db, scope: AgentProfileScope, lock = false): Promise<ProfileRow | null> {
  const query = db
    .select()
    .from(agentProfiles)
    .where(and(eq(agentProfiles.agentId, scope.agentId), eq(agentProfiles.companyId, scope.companyId)));
  return (lock ? query.for("update") : query).then((rows) => rows[0] ?? null);
}

async function loadRevisionRow(
  db: Db,
  profile: ProfileRow,
  revisionId: string,
  lock = false,
): Promise<RevisionRow | null> {
  const query = db
    .select()
    .from(agentProfileRevisions)
    .where(
      and(
        eq(agentProfileRevisions.id, revisionId),
        eq(agentProfileRevisions.profileId, profile.id),
        eq(agentProfileRevisions.companyId, profile.companyId),
      ),
    );
  return (lock ? query.for("update") : query).then((rows) => rows[0] ?? null);
}

async function loadActiveRow(db: Db, profile: ProfileRow | null): Promise<RevisionRow | null> {
  if (!profile?.activeRevisionId) return null;
  return loadRevisionRow(db, profile, profile.activeRevisionId);
}

/** The revision in force (`agent_profiles.active_revision_id`), or null when none has been applied. Read-only. */
export async function getActiveProfileRevision(db: Db, scope: AgentProfileScope): Promise<AgentProfileRevisionDto | null> {
  const profile = await loadProfileRow(db, scope);
  const active = await loadActiveRow(db, profile);
  if (!active) return null;
  const capacities = await proposerCapacities(db, scope.companyId, [active]);
  return toProfileRevisionDto(active, scope.agentId, capacityOf(capacities, active));
}

/** Revision history, newest first, without bodies. Read-only. */
export async function listProfileRevisions(db: Db, scope: AgentProfileScope): Promise<AgentProfileRevisionSummary[]> {
  const profile = await loadProfileRow(db, scope);
  if (!profile) return [];
  const rows = await db
    .select()
    .from(agentProfileRevisions)
    .where(and(eq(agentProfileRevisions.profileId, profile.id), eq(agentProfileRevisions.companyId, scope.companyId)))
    .orderBy(desc(agentProfileRevisions.revisionNumber));
  const capacities = await proposerCapacities(db, scope.companyId, rows);
  return rows.map((row) => toSummary(toProfileRevisionDto(row, scope.agentId, capacityOf(capacities, row))));
}

/** One revision with its body, scoped to the company and agent; null when not found there. Read-only. */
export async function getProfileRevision(
  db: Db,
  scope: AgentProfileScope & { revisionId: string },
): Promise<AgentProfileRevisionDto | null> {
  const profile = await loadProfileRow(db, scope);
  if (!profile) return null;
  const row = await loadRevisionRow(db, profile, scope.revisionId);
  if (!row) return null;
  const capacities = await proposerCapacities(db, scope.companyId, [row]);
  return toProfileRevisionDto(row, scope.agentId, capacityOf(capacities, row));
}

/** `agent_governance_policies.revision`, or null when the agent has no persisted policy row. */
export async function currentGovernanceRevision(db: Db, scope: AgentProfileScope): Promise<number | null> {
  return db
    .select({ revision: agentGovernancePolicies.revision })
    .from(agentGovernancePolicies)
    .where(and(eq(agentGovernancePolicies.companyId, scope.companyId), eq(agentGovernancePolicies.agentId, scope.agentId)))
    .then((rows) => rows[0]?.revision ?? null);
}

/** The latest `agent_config_revisions.id`, or null when the agent has none. */
export async function latestConfigRevisionId(db: Db, scope: AgentProfileScope): Promise<string | null> {
  return db
    .select({ id: agentConfigRevisions.id })
    .from(agentConfigRevisions)
    .where(and(eq(agentConfigRevisions.companyId, scope.companyId), eq(agentConfigRevisions.agentId, scope.agentId)))
    .orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id))
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
}

/** The owner ceiling and steward request as V2 policies; the unrestricted default when no row exists. */
export async function loadAccessSides(db: Db, scope: AgentProfileScope): Promise<{ ceiling: AgentAccessPolicy; request: AgentAccessPolicy }> {
  const row = await db
    .select({ ownerCeiling: agentGovernancePolicies.ownerCeiling, stewardRequest: agentGovernancePolicies.stewardRequest })
    .from(agentGovernancePolicies)
    .where(and(eq(agentGovernancePolicies.companyId, scope.companyId), eq(agentGovernancePolicies.agentId, scope.agentId)))
    .then((rows) => rows[0] ?? null);
  return {
    ceiling: parseAccessPolicy(row?.ownerCeiling ?? DEFAULT_AGENT_GOVERNANCE_POLICY),
    request: parseAccessPolicy(row?.stewardRequest ?? DEFAULT_AGENT_GOVERNANCE_POLICY),
  };
}

async function loadDerived(db: Db, scope: AgentProfileScope, viewer: ViewerProjectScope): Promise<AgentProfileDerived | null> {
  const input = await loadAgentProfileDerivedInput(db, { ...scope, viewer });
  return input ? buildAgentProfileDerived(input) : null;
}

/**
 * What a proposal is compared with: the active revision's body, or — for an
 * agent with no applied profile — derived revision 0 converted to V1, which
 * describes what the agent has today. Field authority is computed against it.
 */
export async function profileBaseline(
  db: Db,
  scope: AgentProfileScope,
  active: RevisionRow | null,
): Promise<{ body: AgentOperatingProfileV1; provenance: AgentProfileProvenanceMap; from: "active" | "derived" }> {
  if (active) return { body: active.body, provenance: active.provenance ?? {}, from: "active" };
  const derived = await loadDerived(db, scope, UNRESTRICTED_PROJECT_SCOPE);
  if (!derived) throw notFound("Agent not found");
  const { request } = await loadAccessSides(db, scope);
  return { ...derivedProfileToDraft(derived, request), from: "derived" };
}

/**
 * The profile page read: active revision, newest draft, pending proposal,
 * newest application, and derived revision 0 while nothing has been applied.
 * Null when the agent is not in the company. Read-only. `viewer` applies the
 * restricted-project rule to the derived profile's routine titles;
 * `viewerContext` is who is reading, for the view's `viewer` permissions
 * (absent: every permission is false).
 */
export async function getAgentProfileView(
  db: Db,
  scope: AgentProfileScope & { viewer?: ViewerProjectScope; viewerContext?: AgentProfileViewerContext | null },
): Promise<AgentProfileView | null> {
  const agent = await loadCompanyAgent(db, scope);
  if (!agent) return null;
  const profile = await loadProfileRow(db, scope);
  const [active, draft, pending, latestApplication, applicationInProgress] = await Promise.all([
    loadActiveRow(db, profile),
    profile
      ? db
          .select()
          .from(agentProfileRevisions)
          .where(and(eq(agentProfileRevisions.profileId, profile.id), eq(agentProfileRevisions.state, "draft")))
          .orderBy(desc(agentProfileRevisions.revisionNumber))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    profile
      ? db
          .select()
          .from(agentProfileRevisions)
          .where(and(eq(agentProfileRevisions.profileId, profile.id), eq(agentProfileRevisions.state, "proposed")))
          .orderBy(desc(agentProfileRevisions.revisionNumber))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    latestProfileApplication(db, scope),
    isProfileApplicationInProgress(db, scope.companyId, scope.agentId),
  ]);
  const derived = active ? null : await loadDerived(db, scope, scope.viewer ?? UNRESTRICTED_PROJECT_SCOPE);
  const viewer = await profileViewerPermissions(db, scope, { draft, pending, latestApplication }, scope.viewerContext ?? null);
  const performanceManager = await isEffectivePerformanceManager(db, scope.companyId, scope.agentId);
  const capacities = await proposerCapacities(db, scope.companyId, [active, draft, pending]);
  return {
    kind: "agent_profile_view",
    version: "agent-profile/1",
    companyId: scope.companyId,
    agentId: scope.agentId,
    profileId: profile?.id ?? null,
    active: active ? toProfileRevisionDto(active, scope.agentId, capacityOf(capacities, active)) : null,
    latestDraft: draft ? toProfileRevisionDto(draft, scope.agentId, capacityOf(capacities, draft)) : null,
    pendingProposal: pending ? toSummary(toProfileRevisionDto(pending, scope.agentId, capacityOf(capacities, pending))) : null,
    derived,
    latestApplication,
    applicationInProgress,
    viewer,
    performanceManager,
  };
}

// ---------------------------------------------------------------------------
// Authority for drafts (writing a draft is not deciding it)
// ---------------------------------------------------------------------------

async function assertCanWriteDraft(
  db: Db,
  scope: AgentProfileScope,
  actor: AgentProfileActor,
  revision: RevisionRow | null,
): Promise<void> {
  if (actor.type === "agent") {
    if (actor.agentId === scope.agentId) return;
    if (revision && revision.createdByAgentId === actor.agentId) return;
    // AgentDash (APM gate 4): the designation decides, not the role.
    if (await isEffectivePerformanceManager(db, scope.companyId, actor.agentId)) return;
    throw forbidden("An agent may draft only its own profile; the performance manager may draft any agent's");
  }
  if (revision && revision.createdByUserId && revision.createdByUserId === actor.userId) return;
  const holder = await resolveProfileAuthorityHolder(db, scope, { ...actor, type: "board" });
  if (holder.isAdmin || holder.isSteward || holder.isAccountable) return;
  throw forbidden("Only the agent's steward, its accountable person or an administrator can draft its profile");
}

/** Who filed the proposal: the approval's requester (set by `proposeProfileRevision` from the proposing actor). */
async function proposerOfRevision(
  db: Db,
  companyId: string,
  revision: Pick<RevisionRow, "approvalId">,
): Promise<{ agentId: string | null; userId: string | null }> {
  if (!revision.approvalId) return { agentId: null, userId: null };
  const approval = await db
    .select({ requestedByAgentId: approvals.requestedByAgentId, requestedByUserId: approvals.requestedByUserId })
    .from(approvals)
    .where(and(eq(approvals.id, revision.approvalId), eq(approvals.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return { agentId: approval?.requestedByAgentId ?? null, userId: approval?.requestedByUserId ?? null };
}

const WITHDRAW_REFUSAL =
  "Only whoever proposed this change, or the agent's steward, its accountable person or an administrator, can withdraw it; the performance manager may withdraw only its own proposals";

/**
 * AgentDash (APM gate 5): who may withdraw a pending proposal — narrower than
 * who may write a draft. The proposer, or (for a person) the agent's steward,
 * accountable person or an administrator. An agent other than the proposer —
 * the performance manager included, and the agent the change is about — may
 * not withdraw someone else's proposal.
 */
async function assertCanWithdrawProposal(
  db: Db,
  scope: AgentProfileScope,
  actor: AgentProfileActor,
  revision: Pick<RevisionRow, "approvalId">,
): Promise<void> {
  const proposer = await proposerOfRevision(db, scope.companyId, revision);
  if (actor.type === "agent") {
    if (proposer.agentId && proposer.agentId === actor.agentId) return;
    throw forbidden(WITHDRAW_REFUSAL);
  }
  if (proposer.userId && proposer.userId === actor.userId) return;
  const holder = await resolveProfileAuthorityHolder(db, scope, { ...actor, type: "board" });
  if (holder.isAdmin || holder.isSteward || holder.isAccountable) return;
  throw forbidden(WITHDRAW_REFUSAL);
}

/** True when `check` passes; false when it refuses with one of `refusals` (403 by default). Anything else propagates. */
async function passesGuard(check: () => Promise<unknown>, refusals: readonly number[] = [403]): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (error) {
    if (error instanceof HttpError && refusals.includes(error.status)) return false;
    throw error;
  }
}

const NO_VIEWER_PERMISSIONS = (pending: boolean): AgentProfileViewerPermissions => ({
  canEditDraft: false,
  canPropose: false,
  canWithdraw: false,
  canResumeApplication: false,
  canDecideActiveProposal: pending ? false : null,
});

/**
 * The view's `viewer` flags. Each runs the guard its mutation runs, on the
 * mutation's target, and catches only that guard's refusal — no separate
 * approximation of who may do what:
 * - edit / propose: `assertCanWriteDraft` on the open draft (or on no
 *   revision, as creating a draft does);
 * - withdraw: `assertCanWithdrawProposal` on the pending proposal;
 * - resume: `assertCanResumeProfileApplication` on the newest application,
 *   board callers only (the resume route's `assertBoard`); a 404 or 409 (no
 *   approval or approver to resume from) also reads as false;
 * - decide: the approval routes' decider rule
 *   (`approvalAuthorityService.requireDecisionActor`, which for a profile
 *   change is `assertProfileChangeDecider`) on the pending proposal's
 *   approval, after the routes' read check; null when nothing is pending or
 *   its payload cannot be read.
 * State preconditions the mutations also check (409) are not folded in.
 */
export async function profileViewerPermissions(
  db: Db,
  scope: AgentProfileScope,
  targets: {
    draft: RevisionRow | null;
    pending: RevisionRow | null;
    latestApplication: { approvalId: string | null; approverUserId: string | null } | null;
  },
  context: AgentProfileViewerContext | null,
): Promise<AgentProfileViewerPermissions> {
  const { draft, pending, latestApplication } = targets;
  if (!context) return NO_VIEWER_PERMISSIONS(Boolean(pending));
  const { actor } = context;
  const canWrite = (revision: RevisionRow | null) => passesGuard(() => assertCanWriteDraft(db, scope, actor, revision));

  const decide = async (): Promise<boolean | null> => {
    if (!pending?.approvalId) return null;
    const approval = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, pending.approvalId), eq(approvals.companyId, scope.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!approval || approval.type !== "agent_profile_change") return null;
    if (!context.decisionActor) return false;
    if (context.canOpenApproval && !(await context.canOpenApproval(approval))) return false;
    try {
      await approvalAuthorityService(db).requireDecisionActor(approval, context.decisionActor);
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) return false;
      // An unreadable payload (422): nobody can decide it as it stands.
      if (error instanceof HttpError && error.status === 422) return null;
      throw error;
    }
  };

  // Create, save and propose all run the same draft-write guard on the open draft (or on none, to create).
  const [canEditDraft, canWithdraw, canResumeApplication, canDecideActiveProposal] = await Promise.all([
    canWrite(draft),
    pending ? passesGuard(() => assertCanWithdrawProposal(db, scope, actor, pending)) : Promise.resolve(false),
    latestApplication && actor.type === "user"
      ? passesGuard(
          () =>
            assertCanResumeProfileApplication(
              db,
              { companyId: scope.companyId, agentId: scope.agentId, approvalId: latestApplication.approvalId, approverUserId: latestApplication.approverUserId },
              actor,
            ),
          [403, 404, 409],
        )
      : Promise.resolve(false),
    decide(),
  ]);
  return { canEditDraft, canPropose: draft !== null && canEditDraft, canWithdraw, canResumeApplication, canDecideActiveProposal };
}

function stateConflict(message: string, details: Record<string, unknown> = {}) {
  return new HttpError(409, message, { code: AGENT_PROFILE_REVISION_STATE_CONFLICT, ...details }, AGENT_PROFILE_REVISION_STATE_CONFLICT);
}

/** 409 on a stale `If-Match`; the route answers with `{ error, code, current }`. */
export class AgentProfileDraftConflictError extends HttpError {
  readonly current: AgentProfileRevisionDto;

  constructor(current: AgentProfileRevisionDto) {
    super(409, "This draft changed since you loaded it", { code: AGENT_PROFILE_DRAFT_CONFLICT, current }, AGENT_PROFILE_DRAFT_CONFLICT);
    this.name = "AgentProfileDraftConflictError";
    this.current = current;
  }
}

function actorColumns(actor: AgentProfileActor) {
  return actor.type === "agent"
    ? { createdByAgentId: actor.agentId, createdByUserId: null, createdByRunId: actor.runId ?? null }
    : { createdByAgentId: null, createdByUserId: actor.userId, createdByRunId: null };
}

function activityActor(actor: AgentProfileActor) {
  return actor.type === "agent"
    ? { actorType: "agent" as const, actorId: actor.agentId, runId: actor.runId ?? null }
    : { actorType: "user" as const, actorId: actor.userId, runId: null };
}

function viaDetails(actor: AgentProfileActor) {
  return actor.type === "user" && actor.via ? { via: actor.via } : {};
}

function parseBody(body: unknown): AgentOperatingProfileV1 {
  const parsed = agentOperatingProfileV1Schema.safeParse(body);
  if (!parsed.success) {
    throw unprocessable("The profile is not valid", {
      code: "AGENT_PROFILE_INVALID",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/**
 * Create a draft. With no `input.body` it is seeded from the active revision,
 * or from derived revision 0 via `derivedProfileToDraft` with `proposed`
 * provenance. One open draft per profile: a second create is 409 naming the
 * open one. Writes revision rows and `agent_profile.draft_saved`.
 */
export async function createProfileDraft(
  db: Db,
  scope: AgentProfileScope & { input: CreateAgentProfileDraft },
  actor: AgentProfileActor,
): Promise<AgentProfileRevisionDto> {
  const agent = await requireCompanyAgent(db, scope);
  await assertCanWriteDraft(db, scope, actor, null);
  // AgentDash (APM gate 5): a pending hire that carries a draft profile owns this agent's first profile.
  if (agent.status === "pending_approval" && (await pendingProfileHireFor(db, scope))) {
    throw stateConflict("This agent's pending hire carries its draft profile; edit that draft instead", { agentId: scope.agentId });
  }

  // Seed outside the transaction: the derived read is several queries.
  const existingProfile = await loadProfileRow(db, scope);
  const existingActive = await loadActiveRow(db, existingProfile);
  const seed = scope.input.body
    ? { body: parseBody(scope.input.body), provenance: scope.input.provenance ?? {}, sourceRefs: scope.input.sourceRefs ?? [] }
    : existingActive
      ? { body: existingActive.body, provenance: existingActive.provenance ?? {}, sourceRefs: existingActive.sourceRefs ?? [] }
      : await (async () => {
          const baseline = await profileBaseline(db, scope, null);
          return { body: baseline.body, provenance: baseline.provenance, sourceRefs: derivedSourceRefs(scope.agentId) };
        })();

  const { dto, publication } = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx
      .insert(agentProfiles)
      .values({ companyId: scope.companyId, agentId: scope.agentId })
      .onConflictDoNothing();
    const profile = await loadProfileRow(tx, scope, true);
    if (!profile) throw notFound("Agent not found");
    const openDraft = await tx
      .select({ id: agentProfileRevisions.id })
      .from(agentProfileRevisions)
      .where(and(eq(agentProfileRevisions.profileId, profile.id), eq(agentProfileRevisions.state, "draft")))
      .then((rows) => rows[0] ?? null);
    if (openDraft) {
      throw stateConflict("This agent already has an open draft; edit it instead", { revisionId: openDraft.id });
    }
    const next = await tx
      .select({ max: sql<number>`coalesce(max(${agentProfileRevisions.revisionNumber}), 0)::int` })
      .from(agentProfileRevisions)
      .where(eq(agentProfileRevisions.profileId, profile.id))
      .then((rows) => (rows[0]?.max ?? 0) + 1);
    const inserted = await tx
      .insert(agentProfileRevisions)
      .values({
        companyId: scope.companyId,
        profileId: profile.id,
        revisionNumber: next,
        basedOnRevisionId: profile.activeRevisionId ?? null,
        state: "draft",
        body: seed.body,
        bodyHash: profileBodyHash(seed.body),
        provenance: seed.provenance,
        sourceRefs: seed.sourceRefs,
        ...actorColumns(actor),
      })
      .returning()
      .then((rows) => rows[0]!);
    const publication = await insertActivity(tx, {
      companyId: scope.companyId,
      ...activityActor(actor),
      agentId: scope.agentId,
      action: "agent_profile.draft_saved",
      entityType: "agent_profile_revision",
      entityId: inserted.id,
      details: {
        profileId: profile.id,
        revisionNumber: inserted.revisionNumber,
        created: true,
        seededFrom: scope.input.body ? "input" : existingActive ? "active" : "derived",
        bodyHash: inserted.bodyHash,
        ...viaDetails(actor),
      },
    });
    return { dto: toProfileRevisionDto(inserted, scope.agentId), publication };
  });
  publishActivity(publication);
  return dto;
}

/** The open `hire_agent` approval for this pending agent that carries an unbound profile, if any. */
async function pendingProfileHireFor(db: Db, scope: AgentProfileScope): Promise<string | null> {
  return db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, scope.companyId),
        eq(approvals.type, "hire_agent"),
        inArray(approvals.status, ["pending", "revision_requested"]),
        sql`${approvals.payload}->>'agentId' = ${scope.agentId}`,
        sql`${approvals.payload}->>'profileRevisionId' is not null`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
}

function derivedSourceRefs(agentId: string): AgentProfileSourceRef[] {
  return [{ kind: "agent_record", id: agentId, label: "Derived revision 0 (today's records)" }];
}

/**
 * Save a draft. `ifMatch` must equal the stored `bodyHash`; otherwise 409
 * `AGENT_PROFILE_DRAFT_CONFLICT` with the current draft in the body. Only
 * `draft` revisions are editable (409 `AGENT_PROFILE_REVISION_STATE_CONFLICT`).
 */
export async function saveProfileDraft(
  db: Db,
  scope: AgentProfileScope & { revisionId: string; ifMatch: string; input: UpdateAgentProfileDraft },
  actor: AgentProfileActor,
): Promise<AgentProfileRevisionDto> {
  const body = parseBody(scope.input.body);
  const { dto, publication } = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const profile = await loadProfileRow(tx, scope);
    const row = profile ? await loadRevisionRow(tx, profile, scope.revisionId, true) : null;
    if (!profile || !row) throw notFound("Profile revision not found");
    await assertCanWriteDraft(tx, scope, actor, row);
    if (row.state !== "draft") {
      throw stateConflict(`Only a draft can be edited; this revision is ${row.state}`, { state: row.state });
    }
    if (scope.ifMatch !== row.bodyHash) throw new AgentProfileDraftConflictError(toProfileRevisionDto(row, scope.agentId));
    const updated = await tx
      .update(agentProfileRevisions)
      .set({
        body,
        bodyHash: profileBodyHash(body),
        provenance: scope.input.provenance ?? row.provenance ?? {},
        sourceRefs: scope.input.sourceRefs ?? row.sourceRefs ?? [],
        updatedAt: new Date(),
      })
      .where(and(eq(agentProfileRevisions.id, row.id), eq(agentProfileRevisions.state, "draft")))
      .returning()
      .then((rows) => rows[0]!);
    const publication = await insertActivity(tx, {
      companyId: scope.companyId,
      ...activityActor(actor),
      agentId: scope.agentId,
      action: "agent_profile.draft_saved",
      entityType: "agent_profile_revision",
      entityId: row.id,
      details: {
        profileId: profile.id,
        revisionNumber: row.revisionNumber,
        created: false,
        fromBodyHash: row.bodyHash,
        bodyHash: updated.bodyHash,
        ...viaDetails(actor),
      },
    });
    return { dto: toProfileRevisionDto(updated, scope.agentId), publication };
  });
  publishActivity(publication);
  return dto;
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

/**
 * Freeze a draft, record `bases` (active revision, governance revision,
 * latest config revision), compute `diff` and `fieldAuthority`, and file the
 * `agent_profile_change` approval — the only way one is created. Writes
 * `agent_profile.proposed`.
 */
export async function proposeProfileRevision(
  db: Db,
  scope: AgentProfileScope & { revisionId: string; input: ProposeAgentProfileRevision },
  actor: AgentProfileActor,
): Promise<{ revision: AgentProfileRevisionDto; approvalId: string; payload: AgentProfileChangePayload }> {
  const agent = await requireCompanyAgent(db, scope);
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const profile = await loadProfileRow(tx, scope, true);
    const row = profile ? await loadRevisionRow(tx, profile, scope.revisionId, true) : null;
    if (!profile || !row) throw notFound("Profile revision not found");
    await assertCanWriteDraft(tx, scope, actor, row);
    if (row.state !== "draft") {
      throw stateConflict(`Only a draft can be proposed; this revision is ${row.state}`, { state: row.state });
    }
    if ((row.basedOnRevisionId ?? null) !== (profile.activeRevisionId ?? null)) {
      throw stateConflict(
        "The active profile changed since this draft was started; start a new draft from the active revision",
        { basedOnRevisionId: row.basedOnRevisionId, activeRevisionId: profile.activeRevisionId },
      );
    }
    const pending = await tx
      .select({ id: agentProfileRevisions.id })
      .from(agentProfileRevisions)
      .where(and(eq(agentProfileRevisions.profileId, profile.id), eq(agentProfileRevisions.state, "proposed")))
      .then((rows) => rows[0] ?? null);
    if (pending) {
      throw stateConflict("Another revision is awaiting a decision; withdraw it first", { revisionId: pending.id });
    }

    const body = parseBody(row.body);
    if (body.runtime?.adapterType && body.runtime.adapterType !== agent.adapterType) {
      throw unprocessable(
        "A profile cannot change the adapter type yet; change it on the agent's settings, then start a new draft",
        { code: "AGENT_PROFILE_UNSUPPORTED_CHANGE", pointer: "/runtime/adapterType" },
      );
    }

    const active = await loadActiveRow(tx, profile);
    const baseline = await profileBaseline(tx, scope, active);
    const [governanceRevision, configRevisionId, sides] = await Promise.all([
      currentGovernanceRevision(tx, scope),
      latestConfigRevisionId(tx, scope),
      loadAccessSides(tx, scope),
    ]);
    const bases: AgentProfileBases = {
      basedOnRevisionId: profile.activeRevisionId ?? null,
      governanceRevision,
      configRevisionId,
    };
    const diff = diffProfiles(baseline.body, body);
    const fieldAuthority = classifyProfileFieldAuthority({ diff, ceiling: sides.ceiling, request: body.access });
    const payload: AgentProfileChangePayload = {
      agentId: scope.agentId,
      profileId: profile.id,
      revisionId: row.id,
      revisionNumber: row.revisionNumber,
      basedOnRevisionId: bases.basedOnRevisionId,
      bases,
      bodyHash: row.bodyHash,
      diff,
      fieldAuthority,
      requiredAuthority: strongestProfileAuthority(fieldAuthority),
      affectedResponsibilities: affectedResponsibilityKeys(diff, body),
      accessChanges: computeAccessChanges({ before: baseline.body.access, after: body.access, ceiling: sides.ceiling }),
      evidence: {
        cardId: scope.input.evidence?.cardId ?? null,
        cardVersion: scope.input.evidence?.cardVersion ?? null,
        ledgerEventIds: scope.input.evidence?.ledgerEventIds ?? [],
      },
      reason: scope.input.reason ?? null,
      expectedBenefit: scope.input.expectedBenefit ?? null,
      risks: scope.input.risks ?? null,
      proposedBy:
        actor.type === "agent"
          ? {
              kind: "agent",
              agentId: actor.agentId,
              runId: actor.runId ?? null,
              // AgentDash (APM gate 4): a label only — the proposer is still an agent, so a person decides.
              ...(actor.agentId !== scope.agentId && (await isEffectivePerformanceManager(tx, scope.companyId, actor.agentId))
                ? { capacity: "performance_manager" as const }
                : {}),
            }
          : { kind: "user", userId: actor.userId },
    };

    const approval = await approvalService(tx).create(scope.companyId, {
      type: "agent_profile_change",
      requestedByAgentId: actor.type === "agent" ? actor.agentId : null,
      requestedByUserId: actor.type === "user" ? actor.userId : null,
      status: "pending",
      payload: payload as unknown as Record<string, unknown>,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    const updated = await tx
      .update(agentProfileRevisions)
      .set({ state: "proposed", bases, approvalId: approval.id, updatedAt: new Date() })
      .where(and(eq(agentProfileRevisions.id, row.id), eq(agentProfileRevisions.state, "draft")))
      .returning()
      .then((rows) => rows[0]!);
    const publications: ActivityPublication[] = [];
    publications.push(
      await insertActivity(tx, {
        companyId: scope.companyId,
        ...activityActor(actor),
        agentId: scope.agentId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, issueIds: [] },
      }),
      await insertActivity(tx, {
        companyId: scope.companyId,
        ...activityActor(actor),
        agentId: scope.agentId,
        action: "agent_profile.proposed",
        entityType: "agent_profile_revision",
        entityId: row.id,
        details: {
          profileId: profile.id,
          revisionNumber: row.revisionNumber,
          approvalId: approval.id,
          bases,
          requiredLevel: payload.requiredAuthority,
          changedFields: diff.length,
          ...viaDetails(actor),
        },
      }),
    );
    return {
      revision: toProfileRevisionDto(updated, scope.agentId, proposerCapacityOfApproval({ type: "agent_profile_change", payload })),
      approvalId: approval.id,
      payload,
      publications,
    };
  });
  for (const publication of outcome.publications) publishActivity(publication);
  try {
    await stewardInboxService(db).recordApprovalEvent(outcome.approvalId, "approval.opened");
  } catch (err) {
    logger.warn({ err, approvalId: outcome.approvalId }, "steward inbox event for a profile proposal failed");
  }
  return { revision: outcome.revision, approvalId: outcome.approvalId, payload: outcome.payload };
}

/**
 * Withdraw a proposal while its approval is pending. Cancels the approval.
 * Writes `agent_profile.withdrawn`. Who: `assertCanWithdrawProposal`.
 */
export async function withdrawProfileRevision(
  db: Db,
  scope: AgentProfileScope & { revisionId: string; input: WithdrawAgentProfileRevision },
  actor: AgentProfileActor,
): Promise<AgentProfileRevisionDto> {
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const profile = await loadProfileRow(tx, scope);
    const row = profile ? await loadRevisionRow(tx, profile, scope.revisionId, true) : null;
    if (!profile || !row) throw notFound("Profile revision not found");
    await assertCanWithdrawProposal(tx, scope, actor, row);
    if (row.state !== "proposed" || !row.approvalId) {
      throw stateConflict(`Only a proposed revision can be withdrawn; this revision is ${row.state}`, { state: row.state });
    }
    const now = new Date();
    const cancelled = await tx
      .update(approvals)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(approvals.id, row.approvalId),
          eq(approvals.companyId, scope.companyId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ),
      )
      .returning({ id: approvals.id, type: approvals.type, payload: approvals.payload })
      .then((rows) => rows[0] ?? null);
    if (!cancelled) throw stateConflict("The approval was already decided; it can no longer be withdrawn");
    const updated = await tx
      .update(agentProfileRevisions)
      .set({ state: "withdrawn", updatedAt: now })
      .where(eq(agentProfileRevisions.id, row.id))
      .returning()
      .then((rows) => rows[0]!);
    const publication = await insertActivity(tx, {
      companyId: scope.companyId,
      ...activityActor(actor),
      agentId: scope.agentId,
      action: "agent_profile.withdrawn",
      entityType: "agent_profile_revision",
      entityId: row.id,
      details: {
        profileId: profile.id,
        revisionNumber: row.revisionNumber,
        approvalId: row.approvalId,
        reason: scope.input.reason ?? null,
        ...viaDetails(actor),
      },
    });
    return { dto: toProfileRevisionDto(updated, scope.agentId, proposerCapacityOfApproval(cancelled)), publication, approvalId: row.approvalId };
  });
  publishActivity(outcome.publication);
  try {
    await stewardInboxService(db).recordApprovalEvent(outcome.approvalId, "approval.resolved");
  } catch (err) {
    logger.warn({ err, approvalId: outcome.approvalId }, "steward inbox event for a withdrawn profile proposal failed");
  }
  return outcome.dto;
}

/**
 * The reject path of `agent_profile_change` (`afterReject` and the override
 * route): marks the proposed revision `rejected`. Idempotent; the decision
 * itself is recorded by the caller's `approval.rejected` activity.
 */
export async function markProfileRevisionRejected(
  db: Db,
  approval: { id: string; companyId: string; payload: Record<string, unknown> },
  _actor: { userId: string; via?: string },
): Promise<void> {
  await db
    .update(agentProfileRevisions)
    .set({ state: "rejected", updatedAt: new Date() })
    .where(
      and(
        eq(agentProfileRevisions.approvalId, approval.id),
        eq(agentProfileRevisions.companyId, approval.companyId),
        eq(agentProfileRevisions.state, "proposed"),
      ),
    );
}

// ---------------------------------------------------------------------------
// Diff and export
// ---------------------------------------------------------------------------

/** `GET .../revisions/:revisionId/diff?against=active|<revisionId>`. Read-only. */
export async function diffProfileRevision(
  db: Db,
  scope: AgentProfileScope & { revisionId: string; against: "active" | string },
): Promise<AgentProfileDiffEntry[]> {
  const profile = await loadProfileRow(db, scope);
  const row = profile ? await loadRevisionRow(db, profile, scope.revisionId) : null;
  if (!profile || !row) throw notFound("Profile revision not found");
  if (scope.against === "active") {
    const baseline = await profileBaseline(db, scope, await loadActiveRow(db, profile));
    return diffProfiles(baseline.body, row.body);
  }
  const other = await loadRevisionRow(db, profile, scope.against);
  if (!other) throw notFound("Profile revision to compare against not found");
  return diffProfiles(other.body, row.body);
}

function provenanceLabel(provenance: AgentProfileProvenanceMap, pointer: string): string {
  const entry = provenance[pointer];
  if (!entry) return "";
  const label = { from_brief: "from the brief", proposed: "proposed", owner_confirmed: "confirmed by the owner", missing: "missing" }[entry.state];
  return ` _(${label}${entry.sourceRef ? `: ${entry.sourceRef}` : ""})_`;
}

function mdText(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : "—";
}

/** `GET .../revisions/:revisionId/export.md`: the profile as Markdown, with provenance labels. Pure. */
export function exportProfileMarkdown(
  revision: Pick<AgentProfileRevisionDto, "revisionNumber" | "state" | "body" | "provenance">,
): string {
  const { body } = revision;
  const p = revision.provenance ?? {};
  const out: string[] = [];
  out.push(`# Operating profile: ${mdText(body.identity.name)}`);
  out.push("");
  out.push(`Revision ${revision.revisionNumber} · ${revision.state.replace(/_/g, " ")}`);
  out.push("");
  out.push("## Who it is");
  out.push(`- Name: ${mdText(body.identity.name)}${provenanceLabel(p, "/identity/name")}`);
  out.push(`- Title: ${mdText(body.identity.title)}${provenanceLabel(p, "/identity/title")}`);
  out.push(`- Summary: ${mdText(body.identity.summary)}${provenanceLabel(p, "/identity/summary")}`);
  out.push(`- Audience: ${mdText(body.identity.audience)}${provenanceLabel(p, "/identity/audience")}`);
  out.push("");
  out.push("## Work it owns");
  if (body.responsibilities.length === 0) out.push("No responsibilities yet.");
  body.responsibilities.forEach((responsibility, index) => {
    const base = `/responsibilities/${index}`;
    out.push("");
    out.push(`### ${mdText(responsibility.title)} (\`${responsibility.key}\`)${provenanceLabel(p, `${base}/title`)}`);
    out.push(`- Outcome: ${mdText(responsibility.outcome)}${provenanceLabel(p, `${base}/outcome`)}`);
    const obligation = responsibility.obligation;
    const binding =
      obligation.kind === "routine"
        ? `routine trigger ${obligation.routineTriggerId}`
        : obligation.kind === "deliverable"
          ? `deliverable ${obligation.deliverableId}`
          : obligation.kind === "goal"
            ? `goal ${obligation.goalId}`
            : "assigned work";
    out.push(`- Owed through: ${binding}${provenanceLabel(p, `${base}/obligation`)}`);
    out.push(`- Deliverable: ${mdText(responsibility.deliverable.what)} → ${mdText(responsibility.deliverable.destination)}`);
    if (responsibility.notOwned?.length) out.push(`- Not owned: ${responsibility.notOwned.join("; ")}`);
    const escalateTo = responsibility.escalation.toAgentId
      ? `agent ${responsibility.escalation.toAgentId}`
      : responsibility.escalation.toUserId
        ? `person ${responsibility.escalation.toUserId}`
        : "—";
    out.push(`- Escalation: ${escalateTo} when ${mdText(responsibility.escalation.when)}`);
    const criteria = responsibility.performance.criteria;
    out.push(`- Criteria: ${criteria.length === 0 ? "none yet" : criteria.map((criterion) => criterion.id).join(", ")}${provenanceLabel(p, `${base}/performance`)}`);
  });
  out.push("");
  out.push("## How it works");
  out.push(`- Tone: ${mdText(body.identity.style.tone)}${provenanceLabel(p, "/identity/style/tone")}`);
  out.push(`- When unsure: ${mdText(body.identity.style.uncertaintyRule)}${provenanceLabel(p, "/identity/style/uncertaintyRule")}`);
  out.push(`- Timezone: ${mdText(body.rhythm.timezone)}${provenanceLabel(p, "/rhythm/timezone")}`);
  if (body.rhythm.quietHours) out.push(`- Quiet hours: ${body.rhythm.quietHours}`);
  if (body.rhythm.reportCadence) out.push(`- Report cadence: ${body.rhythm.reportCadence}`);
  out.push("");
  out.push("## What it knows");
  if (body.knowledge.length === 0) out.push("No knowledge sources listed.");
  for (const source of body.knowledge) out.push(`- ${source.source} (${source.kind.replace(/_/g, " ")})${source.freshness ? `, ${source.freshness}` : ""}`);
  out.push("");
  out.push(`## Skills${provenanceLabel(p, "/skills")}`);
  out.push(body.skills.length === 0 ? "None listed." : body.skills.map((skill) => `- ${skill}`).join("\n"));
  out.push("");
  out.push(`## Access requested${provenanceLabel(p, "/access")}`);
  out.push("```json");
  out.push(JSON.stringify(body.access, null, 2));
  out.push("```");
  if (body.runtime) {
    out.push("");
    out.push("## Runtime (administrator settings)");
    out.push(`- Adapter: ${mdText(body.runtime.adapterType)}`);
    out.push(`- Model: ${mdText(body.runtime.model)}`);
    if (body.runtime.heartbeat) {
      out.push(
        `- Heartbeat: every ${body.runtime.heartbeat.intervalSec ?? "—"}s, wake on demand ${
          body.runtime.heartbeat.wakeOnDemand === undefined ? "—" : body.runtime.heartbeat.wakeOnDemand ? "yes" : "no"
        }`,
      );
    }
  }
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Derived revision 0 → first draft
// ---------------------------------------------------------------------------

function clip(value: string | null | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

const EMPTY_PERFORMANCE = {
  criteria: [],
  coverage: [],
  outcomeLinks: [],
  expectedHumanSteps: [],
  judges: { automated: [] },
} satisfies AgentOperatingProfileV1["responsibilities"][number]["performance"];

/**
 * Convert gate 1's derived revision 0 into a V1 body for the first draft.
 * Every field it fills is `proposed` with its source; anything absent is
 * `missing`. `currentRequest` is today's steward request (parsed V2), which
 * becomes `access` unchanged — the draft asks for exactly what the agent has
 * now. Routine titles are never copied in (they can be restricted-project
 * content). Pure.
 */
export function derivedProfileToDraft(
  derived: AgentProfileDerived,
  currentRequest: AgentAccessPolicy,
): { body: AgentOperatingProfileV1; provenance: AgentProfileProvenanceMap } {
  const provenance: AgentProfileProvenanceMap = {};
  const proposed = (pointer: string, sourceRef: string | null) => {
    provenance[pointer] = sourceRef ? { state: "proposed", sourceRef: sourceRef.slice(0, 300) } : { state: "missing" };
  };
  const missing = (pointer: string) => {
    provenance[pointer] = { state: "missing" };
  };

  const name = clip(derived.identity.name.value, 200) || "Agent";
  proposed("/identity/name", derived.identity.name.source);
  const title = clip(derived.identity.title.value, 200);
  proposed("/identity/title", title ? derived.identity.title.source : null);
  const summarySource = derived.identity.summary.value ? derived.identity.summary : derived.objective;
  const summary = clip(summarySource.value, 4000);
  proposed("/identity/summary", summary ? summarySource.source : null);
  missing("/identity/audience");
  missing("/identity/style/tone");
  missing("/identity/style/uncertaintyRule");

  const accountableUserId = derived.rhythm.accountableUserId;
  const responsibilities = derived.responsibilities.map((responsibility, index) => {
    const base = `/responsibilities/${index}`;
    proposed(`${base}/key`, responsibility.source);
    proposed(`${base}/title`, responsibility.source);
    missing(`${base}/outcome`);
    // Gate 1 links no duty string to a routine, so nothing is bound yet.
    missing(`${base}/obligation`);
    missing(`${base}/deliverable`);
    if (accountableUserId) proposed(`${base}/escalation/toUserId`, "agent_accountability");
    missing(`${base}/escalation/when`);
    missing(`${base}/performance`);
    return {
      key: responsibility.key,
      title: clip(responsibility.title, 200) || `Responsibility ${index + 1}`,
      outcome: "",
      stakeholders: [],
      obligation: { kind: "assigned" as const },
      deliverable: { what: "", destination: "" },
      escalation: { ...(accountableUserId ? { toUserId: accountableUserId } : {}), when: "" },
      performance: EMPTY_PERFORMANCE,
    };
  });
  if (responsibilities.length === 0) missing("/responsibilities");
  missing("/knowledge");

  const skills = derived.skills.value.map((skill) => clip(skill, 200)).filter(Boolean).slice(0, 200);
  proposed("/skills", skills.length > 0 ? derived.skills.source : null);
  proposed("/access", "agent_governance_policies.steward_request");

  const timezone = derived.rhythm.routines.flatMap((routine) => routine.triggers).find((trigger) => trigger.timezone)?.timezone ?? null;
  proposed("/rhythm/timezone", timezone ? "routine_trigger.timezone" : null);
  const reportTo = derived.rhythm.reportsTo.agentId
    ? { agentId: derived.rhythm.reportsTo.agentId }
    : accountableUserId
      ? { userId: accountableUserId }
      : {};
  proposed("/rhythm/reportTo", derived.rhythm.reportsTo.agentId ? "agent.reportsTo" : accountableUserId ? "agent_accountability" : null);

  const heartbeat = derived.rhythm.heartbeat;
  const runtime: NonNullable<AgentOperatingProfileV1["runtime"]> = {
    adapterType: derived.runtime.adapterType,
    ...(derived.runtime.model ? { model: clip(derived.runtime.model, 200) } : {}),
    ...(derived.runtime.environmentId ? { environmentId: derived.runtime.environmentId } : {}),
    heartbeat: {
      ...(heartbeat.intervalSec !== null ? { intervalSec: Math.min(Math.trunc(heartbeat.intervalSec), 7 * 24 * 60 * 60) } : {}),
      ...(heartbeat.wakeOnDemand !== null ? { wakeOnDemand: heartbeat.wakeOnDemand } : {}),
    },
  };
  proposed("/runtime/adapterType", "agent.adapterType");
  if (runtime.model) proposed("/runtime/model", "agent.adapterConfig.model");
  if (runtime.environmentId) proposed("/runtime/environmentId", "agent.defaultEnvironmentId");
  proposed("/runtime/heartbeat", "agent.runtimeConfig.heartbeat");

  const body: AgentOperatingProfileV1 = {
    profileVersion: 1,
    identity: { name, title, summary, audience: "", style: { tone: "", uncertaintyRule: "" } },
    responsibilities,
    knowledge: [],
    skills,
    access: currentRequest,
    rhythm: { timezone: timezone ?? "UTC", reportTo },
    runtime,
  };
  return { body: parseBody(body), provenance };
}

// ---------------------------------------------------------------------------
// Unbound drafts (APM gate 5, P5.1): a profile for a role not hired yet
// ---------------------------------------------------------------------------
//
// An unbound profile is an `agent_profiles` row with `agent_id` null. Its
// drafts are created, saved and diffed like bound drafts. Writers: a board
// user with `agents:create` (or the local board / an instance admin), or the
// company's effective performance manager. Readers: board users, and the
// performance manager. Proposing a draft files a `hire_agent` approval
// through the ordinary hire path (routes/agents.ts), carrying the revision
// and its change payload (`AgentProfileHireFields`); the approved hire binds
// the profile to the agent it activates and applies the revision through
// `applyHireProfileRevision`. Saving, diffing or reading never creates an
// agent, an approval or a wake.

export interface UnboundProfileScope {
  companyId: string;
  profileId: string;
}

async function loadProfileById(db: Db, scope: UnboundProfileScope, lock = false): Promise<ProfileRow | null> {
  const query = db
    .select()
    .from(agentProfiles)
    .where(and(eq(agentProfiles.id, scope.profileId), eq(agentProfiles.companyId, scope.companyId)));
  return (lock ? query.for("update") : query).then((rows) => rows[0] ?? null);
}

/** The profile row by id (bound or not), company-scoped. Read-only. */
export async function findCompanyProfile(db: Db, scope: UnboundProfileScope): Promise<{ id: string; agentId: string | null } | null> {
  const row = await loadProfileById(db, scope);
  return row ? { id: row.id, agentId: row.agentId ?? null } : null;
}

/** `agents:create` in this company: the hire decider's authority (routes/approvals.ts `assertCanDecideAgentLifecycleApproval`). */
async function isCompanyAgentAdmin(db: Db, companyId: string, actor: AgentProfileActor): Promise<boolean> {
  if (actor.type !== "user") return false;
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
  return accessService(db).canUser(companyId, actor.userId, "agents:create");
}

async function assertCanWriteUnboundDraft(db: Db, companyId: string, actor: AgentProfileActor): Promise<void> {
  if (actor.type === "agent") {
    if (await isEffectivePerformanceManager(db, companyId, actor.agentId)) return;
    throw forbidden("Only the performance manager or an administrator with agents:create can write a draft profile for a new role");
  }
  if (await isCompanyAgentAdmin(db, companyId, actor)) return;
  throw forbidden("Only an administrator with agents:create or the performance manager can write a draft profile for a new role");
}

/** Board readers and the performance manager; any other agent is 403. */
export async function assertCanReadUnboundProfiles(db: Db, companyId: string, actor: AgentProfileActor): Promise<void> {
  if (actor.type === "user") return;
  if (await isEffectivePerformanceManager(db, companyId, actor.agentId)) return;
  throw forbidden("Only the performance manager reads draft profiles for new roles");
}

/** The pending hire proposal's proposer, or an administrator with `agents:create`. */
async function assertCanWithdrawUnboundProposal(db: Db, companyId: string, actor: AgentProfileActor, revision: Pick<RevisionRow, "approvalId">): Promise<void> {
  const proposer = await proposerOfRevision(db, companyId, revision);
  if (actor.type === "agent") {
    if (proposer.agentId && proposer.agentId === actor.agentId) return;
    throw forbidden("Only whoever proposed this hire or an administrator can withdraw it; the performance manager may withdraw only its own proposals");
  }
  if (proposer.userId && proposer.userId === actor.userId) return;
  if (await isCompanyAgentAdmin(db, companyId, actor)) return;
  throw forbidden("Only whoever proposed this hire or an administrator can withdraw it");
}

function boundConflict(profile: ProfileRow) {
  return stateConflict("This profile now belongs to a hired agent; change it on that agent's profile", { agentId: profile.agentId });
}

async function nextRevisionNumber(tx: Db, profileId: string): Promise<number> {
  return tx
    .select({ max: sql<number>`coalesce(max(${agentProfileRevisions.revisionNumber}), 0)::int` })
    .from(agentProfileRevisions)
    .where(eq(agentProfileRevisions.profileId, profileId))
    .then((rows) => (rows[0]?.max ?? 0) + 1);
}

async function unboundDraftActivity(
  tx: Db,
  companyId: string,
  actor: AgentProfileActor,
  row: RevisionRow,
  details: Record<string, unknown>,
) {
  return insertActivity(tx, {
    companyId,
    ...activityActor(actor),
    agentId: null,
    action: "agent_profile.draft_saved",
    entityType: "agent_profile_revision",
    entityId: row.id,
    details: { profileId: row.profileId, revisionNumber: row.revisionNumber, unbound: true, bodyHash: row.bodyHash, ...details, ...viaDetails(actor) },
  });
}

/** `POST /api/companies/:companyId/agent-profiles`: a new unbound profile and its first draft (revision 1). */
export async function createUnboundProfile(
  db: Db,
  scope: { companyId: string; input: CreateUnboundAgentProfile },
  actor: AgentProfileActor,
): Promise<AgentProfileRevisionDto> {
  await assertCanWriteUnboundDraft(db, scope.companyId, actor);
  const body = parseBody(scope.input.body);
  const { dto, publication } = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const profile = await tx
      .insert(agentProfiles)
      .values({ companyId: scope.companyId, agentId: null })
      .returning()
      .then((rows) => rows[0]!);
    const inserted = await tx
      .insert(agentProfileRevisions)
      .values({
        companyId: scope.companyId,
        profileId: profile.id,
        revisionNumber: 1,
        basedOnRevisionId: null,
        state: "draft",
        body,
        bodyHash: profileBodyHash(body),
        provenance: scope.input.provenance ?? {},
        sourceRefs: scope.input.sourceRefs ?? [],
        ...actorColumns(actor),
      })
      .returning()
      .then((rows) => rows[0]!);
    const publication = await unboundDraftActivity(tx, scope.companyId, actor, inserted, { created: true, seededFrom: "input" });
    return { dto: toProfileRevisionDto(inserted, null), publication };
  });
  publishActivity(publication);
  return dto;
}

/**
 * `POST .../agent-profiles/:profileId/revisions`: a new draft after the last
 * one was rejected or withdrawn. Seeded from `input.body`, else the newest
 * revision. One open draft and no pending proposal (409 otherwise).
 */
export async function createUnboundProfileDraft(
  db: Db,
  scope: UnboundProfileScope & { input: CreateAgentProfileDraft },
  actor: AgentProfileActor,
): Promise<AgentProfileRevisionDto> {
  await assertCanWriteUnboundDraft(db, scope.companyId, actor);
  const inputBody = scope.input.body ? parseBody(scope.input.body) : null;
  const { dto, publication } = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const profile = await loadProfileById(tx, scope, true);
    if (!profile) throw notFound("Draft profile not found");
    if (profile.agentId) throw boundConflict(profile);
    const open = await tx
      .select({ id: agentProfileRevisions.id, state: agentProfileRevisions.state })
      .from(agentProfileRevisions)
      .where(and(eq(agentProfileRevisions.profileId, profile.id), inArray(agentProfileRevisions.state, ["draft", "proposed"])))
      .then((rows) => rows[0] ?? null);
    if (open) {
      throw stateConflict(
        open.state === "draft" ? "This profile already has an open draft; edit it instead" : "A hire for this profile is awaiting a decision; withdraw it first",
        { revisionId: open.id },
      );
    }
    const newest = await tx
      .select()
      .from(agentProfileRevisions)
      .where(eq(agentProfileRevisions.profileId, profile.id))
      .orderBy(desc(agentProfileRevisions.revisionNumber))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const body = inputBody ?? (newest ? parseBody(newest.body) : null);
    if (!body) throw unprocessable("A body is required for this profile's first draft", { code: "AGENT_PROFILE_INVALID" });
    const inserted = await tx
      .insert(agentProfileRevisions)
      .values({
        companyId: scope.companyId,
        profileId: profile.id,
        revisionNumber: await nextRevisionNumber(tx, profile.id),
        basedOnRevisionId: null,
        state: "draft",
        body,
        bodyHash: profileBodyHash(body),
        provenance: scope.input.provenance ?? (inputBody ? {} : (newest?.provenance ?? {})),
        sourceRefs: scope.input.sourceRefs ?? (inputBody ? [] : (newest?.sourceRefs ?? [])),
        ...actorColumns(actor),
      })
      .returning()
      .then((rows) => rows[0]!);
    const publication = await unboundDraftActivity(tx, scope.companyId, actor, inserted, {
      created: true,
      seededFrom: inputBody ? "input" : "revision",
      ...(inputBody ? {} : { seededFromRevisionId: newest?.id ?? null }),
    });
    return { dto: toProfileRevisionDto(inserted, null), publication };
  });
  publishActivity(publication);
  return dto;
}

/** `GET /api/companies/:companyId/agent-profiles`: unbound profiles, newest first, each with its newest revision. Read-only. */
export async function listUnboundProfiles(db: Db, companyId: string): Promise<UnboundAgentProfileSummary[]> {
  const profiles = await db
    .select()
    .from(agentProfiles)
    .where(and(eq(agentProfiles.companyId, companyId), isNull(agentProfiles.agentId)))
    .orderBy(desc(agentProfiles.createdAt), desc(agentProfiles.id));
  if (profiles.length === 0) return [];
  const revisions = await db
    .select()
    .from(agentProfileRevisions)
    .where(and(eq(agentProfileRevisions.companyId, companyId), inArray(agentProfileRevisions.profileId, profiles.map((profile) => profile.id))))
    .orderBy(desc(agentProfileRevisions.revisionNumber));
  const newest = new Map<string, RevisionRow>();
  for (const row of revisions) if (!newest.has(row.profileId)) newest.set(row.profileId, row);
  const capacities = await proposerCapacities(db, companyId, [...newest.values()]);
  return profiles.map((profile) => {
    const latest = newest.get(profile.id) ?? null;
    return {
      profileId: profile.id,
      companyId: profile.companyId,
      agentId: profile.agentId ?? null,
      name: latest?.body.identity.name ?? "",
      title: latest?.body.identity.title ?? "",
      latestRevision: latest ? toSummary(toProfileRevisionDto(latest, null, capacityOf(capacities, latest))) : null,
      createdAt: iso(profile.createdAt),
      updatedAt: iso(profile.updatedAt),
    };
  });
}

/** `GET .../agent-profiles/:profileId`. Null when not in the company. Read-only. */
export async function getUnboundProfileView(
  db: Db,
  scope: UnboundProfileScope & { actor: AgentProfileActor | null },
): Promise<UnboundAgentProfileView | null> {
  const profile = await loadProfileById(db, scope);
  if (!profile) return null;
  const rows = await db
    .select()
    .from(agentProfileRevisions)
    .where(and(eq(agentProfileRevisions.profileId, profile.id), eq(agentProfileRevisions.companyId, scope.companyId)))
    .orderBy(desc(agentProfileRevisions.revisionNumber));
  const agentId = profile.agentId ?? null;
  const draft = rows.find((row) => row.state === "draft") ?? null;
  const pending = rows.find((row) => row.state === "proposed") ?? null;
  const actor = scope.actor;
  const canEditDraft = Boolean(actor) && !agentId && (await passesGuard(() => assertCanWriteUnboundDraft(db, scope.companyId, actor!)));
  const canWithdraw =
    Boolean(actor) && !agentId && pending !== null && (await passesGuard(() => assertCanWithdrawUnboundProposal(db, scope.companyId, actor!, pending)));
  const capacities = await proposerCapacities(db, scope.companyId, rows);
  return {
    kind: "unbound_agent_profile_view",
    version: "agent-profile/1",
    companyId: scope.companyId,
    profileId: profile.id,
    agentId,
    revisions: rows.map((row) => toSummary(toProfileRevisionDto(row, agentId, capacityOf(capacities, row)))),
    latestDraft: draft ? toProfileRevisionDto(draft, agentId, capacityOf(capacities, draft)) : null,
    pendingProposal: pending ? toSummary(toProfileRevisionDto(pending, agentId, capacityOf(capacities, pending))) : null,
    hireApprovalId: pending?.approvalId ?? null,
    viewer: { canEditDraft, canPropose: canEditDraft && draft !== null, canWithdraw },
  };
}

/** One revision of a company profile, by profile id. Read-only. */
export async function getUnboundProfileRevision(
  db: Db,
  scope: UnboundProfileScope & { revisionId: string },
): Promise<AgentProfileRevisionDto | null> {
  const profile = await loadProfileById(db, scope);
  const row = profile ? await loadRevisionRow(db, profile, scope.revisionId) : null;
  if (!profile || !row) return null;
  const capacities = await proposerCapacities(db, scope.companyId, [row]);
  return toProfileRevisionDto(row, profile.agentId ?? null, capacityOf(capacities, row));
}

/** `PATCH .../agent-profiles/:profileId/revisions/:revisionId` (`If-Match: <bodyHash>`). Same rules as a bound draft save. */
export async function saveUnboundProfileDraft(
  db: Db,
  scope: UnboundProfileScope & { revisionId: string; ifMatch: string; input: UpdateAgentProfileDraft },
  actor: AgentProfileActor,
): Promise<AgentProfileRevisionDto> {
  await assertCanWriteUnboundDraft(db, scope.companyId, actor);
  const body = parseBody(scope.input.body);
  const { dto, publication } = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const profile = await loadProfileById(tx, scope);
    const row = profile ? await loadRevisionRow(tx, profile, scope.revisionId, true) : null;
    if (!profile || !row) throw notFound("Profile revision not found");
    if (profile.agentId) throw boundConflict(profile);
    if (row.state !== "draft") {
      throw stateConflict(`Only a draft can be edited; this revision is ${row.state}`, { state: row.state });
    }
    if (scope.ifMatch !== row.bodyHash) throw new AgentProfileDraftConflictError(toProfileRevisionDto(row, null));
    const updated = await tx
      .update(agentProfileRevisions)
      .set({
        body,
        bodyHash: profileBodyHash(body),
        provenance: scope.input.provenance ?? row.provenance ?? {},
        sourceRefs: scope.input.sourceRefs ?? row.sourceRefs ?? [],
        updatedAt: new Date(),
      })
      .where(and(eq(agentProfileRevisions.id, row.id), eq(agentProfileRevisions.state, "draft")))
      .returning()
      .then((rows) => rows[0]!);
    const publication = await unboundDraftActivity(tx, scope.companyId, actor, updated, { created: false, fromBodyHash: row.bodyHash });
    return { dto: toProfileRevisionDto(updated, null), publication };
  });
  publishActivity(publication);
  return dto;
}

/** `GET .../agent-profiles/:profileId/revisions/:revisionId/diff?against=none|<revisionId>`. `none` (or `active`): against nothing. Read-only. */
export async function diffUnboundProfileRevision(
  db: Db,
  scope: UnboundProfileScope & { revisionId: string; against: string },
): Promise<AgentProfileDiffEntry[]> {
  const profile = await loadProfileById(db, scope);
  const row = profile ? await loadRevisionRow(db, profile, scope.revisionId) : null;
  if (!profile || !row) throw notFound("Profile revision not found");
  if (scope.against === "none" || scope.against === "active") return diffProfiles(null, row.body);
  const other = await loadRevisionRow(db, profile, scope.against);
  if (!other) throw notFound("Profile revision to compare against not found");
  return diffProfiles(other.body, row.body);
}

/**
 * What an unbound draft cannot carry into a hire: no adapter type, or a
 * routine binding (it names a routine already assigned to the agent, which a
 * new hire has none of). Each issue's `path` is dot-joined, the same key and
 * form as the hire validator's issues (routes/agents.ts), so a client reads
 * one shape.
 */
function unboundHireRefusals(body: AgentOperatingProfileV1): Array<{ path: string; message: string }> {
  const refusals: Array<{ path: string; message: string }> = [];
  if (!body.runtime?.adapterType) {
    refusals.push({ path: "runtime.adapterType", message: "a hire needs the adapter type the new agent runs on" });
  }
  body.responsibilities.forEach((responsibility, index) => {
    if (responsibility.obligation.kind === "routine") {
      refusals.push({
        path: `responsibilities.${index}.obligation`,
        message: "a new hire has no routines yet: use an assigned, deliverable or goal obligation, and bind the routine after the hire",
      });
    }
  });
  return refusals;
}

/**
 * Step 1 of proposing an unbound draft (the route in routes/agents.ts files
 * the hire): checks the writer, the state and that the draft can be a hire,
 * claims the draft (`draft` → `proposed`, so a second propose is 409), and
 * returns the new-agent fields the hire validator checks. The caller files
 * the hire, then `finalizeUnboundProfileProposal`; on any failure before the
 * hire is filed it calls `releaseUnboundProfileClaim`.
 */
export async function prepareUnboundProfileHire(
  db: Db,
  scope: UnboundProfileScope & { revisionId: string; input: ProposeUnboundAgentProfile },
  actor: AgentProfileActor,
): Promise<{ hireInput: Record<string, unknown>; adapterType: string; revisionNumber: number }> {
  await assertCanWriteUnboundDraft(db, scope.companyId, actor);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const profile = await loadProfileById(tx, scope, true);
    const row = profile ? await loadRevisionRow(tx, profile, scope.revisionId, true) : null;
    if (!profile || !row) throw notFound("Profile revision not found");
    if (profile.agentId) throw boundConflict(profile);
    if (row.state !== "draft") {
      throw stateConflict(`Only a draft can be proposed; this revision is ${row.state}`, { state: row.state });
    }
    const pending = await tx
      .select({ id: agentProfileRevisions.id })
      .from(agentProfileRevisions)
      .where(and(eq(agentProfileRevisions.profileId, profile.id), eq(agentProfileRevisions.state, "proposed")))
      .then((rows) => rows[0] ?? null);
    if (pending) throw stateConflict("A hire for this profile is awaiting a decision; withdraw it first", { revisionId: pending.id });
    const body = parseBody(row.body);
    const refusals = unboundHireRefusals(body);
    if (refusals.length > 0) {
      throw unprocessable("This draft cannot be filed as a hire yet", { code: AGENT_PROFILE_HIRE_INVALID, issues: refusals });
    }
    await tx
      .update(agentProfileRevisions)
      .set({ state: "proposed", updatedAt: new Date() })
      .where(and(eq(agentProfileRevisions.id, row.id), eq(agentProfileRevisions.state, "draft")));
    const input = scope.input;
    const reportsTo = input.reportsTo !== undefined ? input.reportsTo : (body.rhythm.reportTo.agentId ?? null);
    const hireInput: Record<string, unknown> = {
      name: body.identity.name,
      role: input.role ?? "general",
      title: body.identity.title || null,
      capabilities: body.identity.summary || null,
      adapterType: body.runtime!.adapterType!,
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(reportsTo ? { reportsTo } : {}),
      ...(input.budgetMonthlyCents !== undefined ? { budgetMonthlyCents: input.budgetMonthlyCents } : {}),
      ...(input.sourceIssueId ? { sourceIssueId: input.sourceIssueId } : {}),
      // Skills, access, model, heartbeat and environment are the profile's: its
      // application installs them (skills ∩ access, request side only) once approved.
      metadata: { source: "agent_profile_hire", profileId: profile.id, profileRevisionId: row.id },
    };
    return { hireInput, adapterType: body.runtime!.adapterType!, revisionNumber: row.revisionNumber };
  });
}

/** Undo `prepareUnboundProfileHire`'s claim when the hire was not filed. Only a claimed revision with no approval goes back to `draft`. */
export async function releaseUnboundProfileClaim(db: Db, scope: UnboundProfileScope & { revisionId: string }): Promise<void> {
  await db
    .update(agentProfileRevisions)
    .set({ state: "draft", updatedAt: new Date() })
    .where(
      and(
        eq(agentProfileRevisions.id, scope.revisionId),
        eq(agentProfileRevisions.companyId, scope.companyId),
        eq(agentProfileRevisions.profileId, scope.profileId),
        eq(agentProfileRevisions.state, "proposed"),
        isNull(agentProfileRevisions.approvalId),
      ),
    );
}

/**
 * The profile fields of the hire approval, computed when the hire is filed —
 * after the pending agent exists and before the approval is written — exactly
 * as a bound proposal computes its payload: the diff against the pending
 * agent's derived revision 0, field authority, access changes and `bases`.
 */
export async function buildHireProfileFields(
  db: Db,
  scope: UnboundProfileScope & { revisionId: string; agentId: string; input: ProposeUnboundAgentProfile },
  actor: AgentProfileActor,
): Promise<AgentProfileHireFields> {
  const profile = await loadProfileById(db, scope);
  const row = profile ? await loadRevisionRow(db, profile, scope.revisionId) : null;
  if (!profile || !row) throw notFound("Profile revision not found");
  const agentScope = { companyId: scope.companyId, agentId: scope.agentId };
  const body = parseBody(row.body);
  const baseline = await profileBaseline(db, agentScope, null);
  const [governanceRevision, configRevisionId, sides] = await Promise.all([
    currentGovernanceRevision(db, agentScope),
    latestConfigRevisionId(db, agentScope),
    loadAccessSides(db, agentScope),
  ]);
  const bases: AgentProfileBases = { basedOnRevisionId: null, governanceRevision, configRevisionId };
  const diff = diffProfiles(baseline.body, body);
  const fieldAuthority = classifyProfileFieldAuthority({ diff, ceiling: sides.ceiling, request: body.access });
  const input = scope.input;
  const profileChange: AgentProfileChangePayload = {
    agentId: scope.agentId,
    profileId: profile.id,
    revisionId: row.id,
    revisionNumber: row.revisionNumber,
    basedOnRevisionId: null,
    bases,
    bodyHash: row.bodyHash,
    diff,
    fieldAuthority,
    requiredAuthority: strongestProfileAuthority(fieldAuthority),
    affectedResponsibilities: affectedResponsibilityKeys(diff, body),
    accessChanges: computeAccessChanges({ before: baseline.body.access, after: body.access, ceiling: sides.ceiling }),
    evidence: {
      cardId: input.evidence?.cardId ?? null,
      cardVersion: input.evidence?.cardVersion ?? null,
      ledgerEventIds: input.evidence?.ledgerEventIds ?? [],
    },
    reason: input.reason ?? null,
    expectedBenefit: input.expectedBenefit ?? null,
    risks: input.risks ?? null,
    proposedBy:
      actor.type === "agent"
        ? {
            kind: "agent",
            agentId: actor.agentId,
            runId: actor.runId ?? null,
            ...((await isEffectivePerformanceManager(db, scope.companyId, actor.agentId)) ? { capacity: "performance_manager" as const } : {}),
          }
        : { kind: "user", userId: actor.userId },
  };
  return {
    profileId: profile.id,
    profileRevisionId: row.id,
    profileRevisionNumber: row.revisionNumber,
    profileBodyHash: row.bodyHash,
    profileChange,
  };
}

/** Step 3: record the filed hire on the claimed revision (approval id, bases) and write `agent_profile.proposed`. */
export async function finalizeUnboundProfileProposal(
  db: Db,
  scope: UnboundProfileScope & { revisionId: string; approvalId: string; agentId: string; fields: AgentProfileHireFields },
  actor: AgentProfileActor,
): Promise<UnboundAgentProfileProposalResult> {
  const { dto, publication } = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const updated = await tx
      .update(agentProfileRevisions)
      .set({ approvalId: scope.approvalId, bases: scope.fields.profileChange.bases, updatedAt: new Date() })
      .where(
        and(
          eq(agentProfileRevisions.id, scope.revisionId),
          eq(agentProfileRevisions.companyId, scope.companyId),
          eq(agentProfileRevisions.state, "proposed"),
          isNull(agentProfileRevisions.approvalId),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw stateConflict("This draft is no longer awaiting its hire proposal");
    const publication = await insertActivity(tx, {
      companyId: scope.companyId,
      ...activityActor(actor),
      agentId: scope.agentId,
      action: "agent_profile.proposed",
      entityType: "agent_profile_revision",
      entityId: updated.id,
      details: {
        profileId: updated.profileId,
        revisionNumber: updated.revisionNumber,
        approvalId: scope.approvalId,
        approvalType: "hire_agent",
        unbound: true,
        bases: scope.fields.profileChange.bases,
        requiredLevel: scope.fields.profileChange.requiredAuthority,
        changedFields: scope.fields.profileChange.diff.length,
        ...viaDetails(actor),
      },
    });
    return {
      dto: toProfileRevisionDto(updated, null, proposerCapacityOfApproval({ type: "agent_profile_change", payload: scope.fields.profileChange })),
      publication,
    };
  });
  publishActivity(publication);
  return { revision: dto, approvalId: scope.approvalId, agentId: scope.agentId, payload: scope.fields.profileChange };
}

/**
 * `POST .../agent-profiles/:profileId/revisions/:revisionId/withdraw`: cancel
 * the pending hire (its proposer or an administrator). The pending agent the
 * hire would have activated is terminated, exactly as rejecting the hire does;
 * the revision becomes `withdrawn` and the profile stays unbound.
 */
export async function withdrawUnboundProfileRevision(
  db: Db,
  scope: UnboundProfileScope & { revisionId: string; input: WithdrawAgentProfileRevision },
  actor: AgentProfileActor,
): Promise<AgentProfileRevisionDto> {
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const profile = await loadProfileById(tx, scope);
    const row = profile ? await loadRevisionRow(tx, profile, scope.revisionId, true) : null;
    if (!profile || !row) throw notFound("Profile revision not found");
    if (profile.agentId) throw boundConflict(profile);
    await assertCanWithdrawUnboundProposal(tx, scope.companyId, actor, row);
    if (row.state !== "proposed" || !row.approvalId) {
      throw stateConflict(`Only a proposed revision can be withdrawn; this revision is ${row.state}`, { state: row.state });
    }
    const now = new Date();
    const cancelled = await tx
      .update(approvals)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(approvals.id, row.approvalId),
          eq(approvals.companyId, scope.companyId),
          eq(approvals.type, "hire_agent"),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!cancelled) throw stateConflict("The hire was already decided; it can no longer be withdrawn");
    const updated = await tx
      .update(agentProfileRevisions)
      .set({ state: "withdrawn", updatedAt: now })
      .where(eq(agentProfileRevisions.id, row.id))
      .returning()
      .then((rows) => rows[0]!);
    const pendingAgentId = typeof (cancelled.payload as Record<string, unknown>)?.agentId === "string"
      ? ((cancelled.payload as Record<string, unknown>).agentId as string)
      : null;
    const publication = await insertActivity(tx, {
      companyId: scope.companyId,
      ...activityActor(actor),
      agentId: pendingAgentId,
      action: "agent_profile.withdrawn",
      entityType: "agent_profile_revision",
      entityId: row.id,
      details: {
        profileId: profile.id,
        revisionNumber: row.revisionNumber,
        approvalId: row.approvalId,
        approvalType: "hire_agent",
        unbound: true,
        reason: scope.input.reason ?? null,
        ...viaDetails(actor),
      },
    });
    return { dto: toProfileRevisionDto(updated, null, proposerCapacityOfApproval(cancelled)), publication, approvalId: row.approvalId, pendingAgentId };
  });
  publishActivity(outcome.publication);
  if (outcome.pendingAgentId) {
    try {
      // Never a working agent: only one still pending approval is ended.
      await agentService(db).terminate(outcome.pendingAgentId, {
        endedByUserId: actor.type === "user" ? actor.userId : null,
        onlyIfStatus: "pending_approval",
      });
    } catch (err) {
      logger.warn({ err, agentId: outcome.pendingAgentId }, "pending agent of a withdrawn profile hire was not terminated");
    }
  }
  try {
    await stewardInboxService(db).recordApprovalEvent(outcome.approvalId, "approval.resolved");
  } catch (err) {
    logger.warn({ err, approvalId: outcome.approvalId }, "steward inbox event for a withdrawn profile hire failed");
  }
  return outcome.dto;
}
