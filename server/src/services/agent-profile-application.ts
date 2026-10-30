import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents as agentsTable,
  agentProfileApplications,
  agentProfileRevisions,
  agentProfiles,
  agentConfigRevisions,
  agentGovernancePolicies,
  approvals,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  AGENT_PROFILE_APPLICATION_IN_PROGRESS,
  AGENT_PROFILE_APPLICATION_STEPS,
  accessPolicyReplacementWrite,
  agentOperatingProfileV1Schema,
  canonicalProfileJson,
  collectCeilingViolations,
  computeEffectiveAgentPolicy,
  mergeAccessPolicyWrite,
  parseAccessPolicy,
  profileBodyHash,
  supportedEnvironmentDriversForAdapter,
  toV1GovernancePolicy,
  type AgentAccessListScope,
  type AgentAccessPolicy,
  type AgentGovernancePolicy,
  type AgentOperatingProfileV1,
  type AgentProfileApplicationDto,
  type AgentProfileApplicationStep,
  type AgentProfileApplicationStepRecord,
  type AgentProfileApproverAuthority,
  type AgentProfileChangePayload,
  type StoredAgentGovernancePolicy,
} from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference, writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { HttpError, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertEnvironmentSelectionForCompany } from "../routes/environment-selection.js";
import { insertActivity, logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { agentAccountabilityService } from "./agent-accountability.js";
import { agentGovernanceService } from "./agent-governance.js";
import { agentInstructionRefreshService } from "./agent-instruction-refresh.js";
import {
  assertHireProfileDecider,
  assertProfileChangeDecider,
  parseHireProfileFields,
  parseProfileChangePayload,
  resolveProfileAuthorityHolder,
} from "./agent-profile-authority.js";
import { expectedProfileBlockHash } from "./agent-profile-block.js";
import { agentService } from "./agents.js";
import { companySkillService } from "./company-skills.js";
import { environmentService } from "./environments.js";
import { declareAgentContract } from "./evaluation/agent-contract.js";
import { hermesSshEnabled } from "./hermes-ssh-policy.js";

/**
 * AgentDash: Agent Performance Management gate 2 — the serialized,
 * stale-checked, resumable application of an approved profile revision
 * (overview LLD §4.2; gate 2 spec P2.2).
 *
 * This is the ONLY path that changes an agent's governance request, config,
 * environment, skills, AGENTS.md profile block or agent contract from a
 * profile. Steps, in order:
 * 1. serialize per agent: under a transaction advisory lock on
 *    `(companyId, agentId)` the application is marked `in_progress` (at most
 *    one per agent — a partial unique index backs it). The mark is a lease:
 *    `updated_at` is refreshed per step, and a mark older than
 *    `PROFILE_APPLICATION_LEASE_MS` is an interrupted application that a
 *    resume (or the next application) takes over;
 * 2. stale check against the revision's `bases` → `refused_stale`;
 * 3. re-check the approver's authority (`fieldAuthority`, overview LLD §4.1);
 * 4. idempotent steps keyed by `(applicationId, step)`, recorded in `steps`;
 * 5. activation in one transaction: `active_revision_id`, `agent_profile.applied`,
 *    the AGENTS.md block render, clearing in-progress.
 * A failure leaves `failed` and never switches the active revision.
 *
 * Never widens: the governance step writes the request side only and never
 * raises a ceiling; a V1 request beyond the ceiling is clamped to it (V2
 * dimensions are intersected with the ceiling at check time anyway).
 */

/** An `in_progress` mark older than this is an interrupted application. */
export const PROFILE_APPLICATION_LEASE_MS = 10 * 60 * 1000;

/**
 * The human the application is attributed to — the approval's decider — and
 * how it was reached. `path` distinguishes the shared `afterApprove` effect,
 * the emergency-override route and a resume, for the activity trail.
 */
export interface ProfileApplicationActor {
  userId: string;
  path: "approval" | "override" | "resume";
  source?: string | null;
  isInstanceAdmin?: boolean;
  /** Set when the decision arrived through an assistant grant. */
  via?: string;
}

export interface ProfileApplicationResult {
  application: AgentProfileApplicationDto;
  /** True only when step 5 committed and the revision is now active. */
  activated: boolean;
}

/** Optional hooks. `beforeStep` runs before each step-4 step and may throw (fault injection). */
export interface ProfileApplicationOptions {
  beforeStep?: (step: AgentProfileApplicationStep) => void | Promise<void>;
  now?: () => Date;
}

type ApplicationRow = typeof agentProfileApplications.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;
type RevisionRow = typeof agentProfileRevisions.$inferSelect;

const STALE_DETAIL =
  "The agent's profile, access policy or configuration changed after this revision was proposed. Start a new draft from the active revision.";
const AUTHORITY_DETAIL = "The approver no longer holds the authority this change needs.";
const INTERRUPTED_ERROR = "Interrupted: the application stopped before this step finished.";

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

function pendingStep(step: AgentProfileApplicationStep): AgentProfileApplicationStepRecord {
  return { step, status: "pending", targetId: null, beforeHash: null, afterHash: null, error: null, completedAt: null };
}

/** Every step in order; a step never reached is `pending`. */
function normalizeSteps(stored: AgentProfileApplicationStepRecord[] | null | undefined): AgentProfileApplicationStepRecord[] {
  const byStep = new Map((stored ?? []).map((record) => [record.step, record]));
  return AGENT_PROFILE_APPLICATION_STEPS.map((step) => ({ ...pendingStep(step), ...(byStep.get(step) ?? {}) }));
}

function failureOf(row: ApplicationRow): AgentProfileApplicationDto["failure"] {
  if (row.status === "refused_stale") return { kind: "stale", step: null, detail: STALE_DETAIL };
  if (row.status !== "failed") return null;
  const failed = normalizeSteps(row.steps).find((record) => record.status === "failed");
  if (failed) return { kind: "step", step: failed.step, detail: failed.error ?? `The ${failed.step} step failed.` };
  return { kind: "authority", step: null, detail: AUTHORITY_DETAIL };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toProfileApplicationDto(row: ApplicationRow): AgentProfileApplicationDto {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    revisionId: row.revisionId,
    approvalId: row.approvalId ?? null,
    status: row.status,
    steps: normalizeSteps(row.steps),
    approverUserId: row.approverUserId ?? null,
    approverAuthority: row.approverAuthority ?? null,
    failure: failureOf(row),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function leaseCutoff(now: Date): Date {
  return new Date(now.getTime() - PROFILE_APPLICATION_LEASE_MS);
}

function isLive(row: Pick<ApplicationRow, "status" | "updatedAt">, now: Date): boolean {
  return row.status === "in_progress" && new Date(row.updatedAt).getTime() > leaseCutoff(now).getTime();
}

/**
 * True while an application holds this agent (status `in_progress` within
 * the lease), so the dispatcher defers new runs and no run starts with a mixed
 * configuration. One indexed lookup: the heartbeat calls it on every claim.
 */
export async function isProfileApplicationInProgress(db: Db, companyId: string, agentId: string): Promise<boolean> {
  const row = await db
    .select({ id: agentProfileApplications.id })
    .from(agentProfileApplications)
    .where(
      and(
        eq(agentProfileApplications.companyId, companyId),
        eq(agentProfileApplications.agentId, agentId),
        eq(agentProfileApplications.status, "in_progress"),
        gt(agentProfileApplications.updatedAt, leaseCutoff(new Date())),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row !== null;
}

/** Application receipts for the agent, newest first. Read-only. */
export async function listProfileApplications(
  db: Db,
  scope: { companyId: string; agentId: string },
): Promise<AgentProfileApplicationDto[]> {
  const rows = await db
    .select()
    .from(agentProfileApplications)
    .where(and(eq(agentProfileApplications.companyId, scope.companyId), eq(agentProfileApplications.agentId, scope.agentId)))
    .orderBy(desc(agentProfileApplications.createdAt), desc(agentProfileApplications.id));
  return rows.map(toProfileApplicationDto);
}

/** The newest receipt, or null. Read-only. */
export async function latestProfileApplication(
  db: Db,
  scope: { companyId: string; agentId: string },
): Promise<AgentProfileApplicationDto | null> {
  const row = await db
    .select()
    .from(agentProfileApplications)
    .where(and(eq(agentProfileApplications.companyId, scope.companyId), eq(agentProfileApplications.agentId, scope.agentId)))
    .orderBy(desc(agentProfileApplications.createdAt), desc(agentProfileApplications.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row ? toProfileApplicationDto(row) : null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface RunContext {
  db: Db;
  approval: ApprovalRow;
  payload: AgentProfileChangePayload;
  companyId: string;
  agentId: string;
  applicationId: string;
  actor: ProfileApplicationActor;
  approverUserId: string;
  options: ProfileApplicationOptions;
}

function now(options: ProfileApplicationOptions): Date {
  return options.now?.() ?? new Date();
}

function sha(value: unknown): string {
  return createHash("sha256").update(canonicalProfileJson(value), "utf8").digest("hex");
}

/**
 * The approval an application applies: an `agent_profile_change`, or (APM
 * gate 5) a `hire_agent` filed by proposing an unbound draft, whose payload
 * carries the revision's change payload.
 */
async function loadApproval(db: Db, approvalId: string): Promise<ApprovalRow> {
  const approval = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .then((rows) => rows[0] ?? null);
  if (!approval) throw notFound("Profile change approval not found");
  if (approval.type === "agent_profile_change") return approval;
  if (approval.type === "hire_agent" && parseHireProfileFields(approval.payload)) return approval;
  throw notFound("Profile change approval not found");
}

/** The change payload an application applies, for either kind of approval. */
function changePayloadOf(approval: ApprovalRow): AgentProfileChangePayload {
  if (approval.type === "hire_agent") {
    const fields = parseHireProfileFields(approval.payload);
    if (!fields) throw unprocessable("This hire approval has no profile to apply", { code: "AGENT_PROFILE_CHANGE_INVALID" });
    return fields.profileChange;
  }
  return parseProfileChangePayload(approval.payload);
}

async function loadApplication(db: Db, applicationId: string): Promise<ApplicationRow | null> {
  return db
    .select()
    .from(agentProfileApplications)
    .where(eq(agentProfileApplications.id, applicationId))
    .then((rows) => rows[0] ?? null);
}

async function loadRevision(ctx: Pick<RunContext, "db" | "payload" | "companyId">): Promise<RevisionRow | null> {
  return ctx.db
    .select()
    .from(agentProfileRevisions)
    .where(
      and(
        eq(agentProfileRevisions.id, ctx.payload.revisionId),
        eq(agentProfileRevisions.companyId, ctx.companyId),
        eq(agentProfileRevisions.profileId, ctx.payload.profileId),
      ),
    )
    .then((rows) => rows[0] ?? null);
}

async function saveSteps(ctx: RunContext, steps: AgentProfileApplicationStepRecord[], patch: Partial<typeof agentProfileApplications.$inferInsert> = {}) {
  await ctx.db
    .update(agentProfileApplications)
    .set({ steps, updatedAt: now(ctx.options), ...patch })
    .where(eq(agentProfileApplications.id, ctx.applicationId));
}

async function logApplicationActivity(ctx: RunContext, action: string, details: Record<string, unknown>) {
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: "user",
    actorId: ctx.approverUserId,
    agentId: ctx.agentId,
    action,
    entityType: "agent_profile_application",
    entityId: ctx.applicationId,
    details: {
      approvalId: ctx.approval.id,
      revisionId: ctx.payload.revisionId,
      revisionNumber: ctx.payload.revisionNumber,
      path: ctx.actor.path,
      ...(ctx.actor.via ? { via: ctx.actor.via } : {}),
      ...details,
    },
  });
}

// ---------------------------------------------------------------------------
// Step 1: claim the agent
// ---------------------------------------------------------------------------

/**
 * Mark this application `in_progress` unless another live one holds the
 * agent. An expired mark (interrupted application) is closed as `failed`
 * first, so it can be resumed; the same lock and the partial unique index
 * make two claims for one agent impossible.
 */
async function claimAgent(ctx: RunContext): Promise<"claimed" | "busy"> {
  const at = now(ctx.options);
  const interrupted: ApplicationRow[] = [];
  const outcome = await ctx.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agent_profile_application'), hashtext(${`${ctx.companyId}:${ctx.agentId}`}))`,
    );
    const holders = await tx
      .select()
      .from(agentProfileApplications)
      .where(
        and(
          eq(agentProfileApplications.companyId, ctx.companyId),
          eq(agentProfileApplications.agentId, ctx.agentId),
          eq(agentProfileApplications.status, "in_progress"),
        ),
      )
      .for("update");
    for (const holder of holders) {
      if (isLive(holder, at)) return "busy" as const;
      if (holder.id === ctx.applicationId) continue;
      // An expired lease: the process applying it is gone. Close it so it can be resumed.
      const steps = normalizeSteps(holder.steps);
      const running = steps.find((record) => record.status === "pending");
      if (running) Object.assign(running, { status: "failed", error: INTERRUPTED_ERROR });
      await tx
        .update(agentProfileApplications)
        .set({ status: "failed", steps, updatedAt: at })
        .where(eq(agentProfileApplications.id, holder.id));
      await tx
        .update(agentProfileRevisions)
        .set({ state: "application_failed", updatedAt: at })
        .where(and(eq(agentProfileRevisions.id, holder.revisionId), eq(agentProfileRevisions.state, "approved")));
      interrupted.push(holder);
    }
    await tx
      .update(agentProfileApplications)
      .set({ status: "in_progress", updatedAt: at })
      .where(eq(agentProfileApplications.id, ctx.applicationId));
    return "claimed" as const;
  });
  for (const holder of interrupted) {
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "system",
      actorId: "agent-profile-application",
      agentId: ctx.agentId,
      action: "agent_profile.application_failed",
      entityType: "agent_profile_application",
      entityId: holder.id,
      details: { approvalId: holder.approvalId, revisionId: holder.revisionId, interrupted: true, takenOverBy: ctx.applicationId },
    });
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Step 2: stale check
// ---------------------------------------------------------------------------

function governanceRevisionFromTarget(targetId: string | null): number | null {
  const match = targetId ? /@(\d+)$/.exec(targetId) : null;
  return match ? Number(match[1]) : null;
}

/** What the bases should read now, counting the writes this application's own completed steps made. */
function expectedBases(payload: AgentProfileChangePayload, steps: AgentProfileApplicationStepRecord[]) {
  const done = (step: AgentProfileApplicationStep) => steps.find((record) => record.step === step && record.status === "done");
  const governance = done("governance_request");
  const governanceRevision = governance ? governanceRevisionFromTarget(governance.targetId) : payload.bases.governanceRevision;
  let configRevisionId = payload.bases.configRevisionId;
  for (const step of ["config", "environment", "skills"] as const) {
    const record = done(step);
    if (record?.targetId) configRevisionId = record.targetId;
  }
  return { governanceRevision, configRevisionId };
}

async function staleReason(ctx: RunContext, revision: RevisionRow | null, steps: AgentProfileApplicationStepRecord[]): Promise<string | null> {
  if (!revision) return "revision_missing";
  if (revision.approvalId !== ctx.approval.id) return "revision_not_this_approval";
  if (revision.bodyHash !== ctx.payload.bodyHash || profileBodyHash(revision.body) !== ctx.payload.bodyHash) return "body_changed";
  if (!["proposed", "approved", "application_failed"].includes(revision.state)) return `revision_${revision.state}`;
  const profile = await ctx.db
    .select({ activeRevisionId: agentProfiles.activeRevisionId, agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.id, ctx.payload.profileId), eq(agentProfiles.companyId, ctx.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!profile || profile.agentId !== ctx.agentId) return "profile_missing";
  if ((profile.activeRevisionId ?? null) !== (ctx.payload.bases.basedOnRevisionId ?? null)) return "active_revision_changed";
  const expected = expectedBases(ctx.payload, steps);
  const [governance, config] = await Promise.all([
    ctx.db
      .select({ revision: agentGovernancePolicies.revision })
      .from(agentGovernancePolicies)
      .where(and(eq(agentGovernancePolicies.companyId, ctx.companyId), eq(agentGovernancePolicies.agentId, ctx.agentId)))
      .then((rows) => rows[0]?.revision ?? null),
    ctx.db
      .select({ id: agentConfigRevisions.id })
      .from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.companyId, ctx.companyId), eq(agentConfigRevisions.agentId, ctx.agentId)))
      .orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id))
      .limit(1)
      .then((rows) => rows[0]?.id ?? null),
  ]);
  if (governance !== expected.governanceRevision) return "governance_changed";
  if (config !== expected.configRevisionId) return "config_changed";
  return null;
}

// ---------------------------------------------------------------------------
// Step 4: the idempotent steps
// ---------------------------------------------------------------------------

type StepOutcome = { status: "done" | "skipped"; targetId?: string | null; beforeHash?: string | null; afterHash?: string | null; note?: Record<string, unknown> };

function diffTouches(payload: AgentProfileChangePayload, predicate: (pointer: string) => boolean): boolean {
  return payload.diff.some((entry) => predicate(entry.pointer));
}

async function latestConfigRevision(db: Db, companyId: string, agentId: string): Promise<string | null> {
  return db
    .select({ id: agentConfigRevisions.id })
    .from(agentConfigRevisions)
    .where(and(eq(agentConfigRevisions.companyId, companyId), eq(agentConfigRevisions.agentId, agentId)))
    .orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id))
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
}

/** (a) The governance REQUEST side, replaced through `mergeAccessPolicyWrite`. Never the ceiling. */
async function stepGovernanceRequest(ctx: RunContext, body: AgentOperatingProfileV1): Promise<StepOutcome> {
  const governance = agentGovernanceService(ctx.db);
  const current = await governance.getForAgent(ctx.companyId, ctx.agentId);
  const storedRequest = current.stewardRequest as StoredAgentGovernancePolicy;
  const ceiling = parseAccessPolicy(current.ownerCeiling);
  const requested: AgentAccessPolicy = body.access;
  // The V1 store cannot hold a request beyond the ceiling (applyUpdate 422s
  // it), and application never raises a ceiling: clamp only the fields that
  // exceed it, so the effective access is exactly what it would be anyway.
  const violations = collectCeilingViolations(toV1GovernancePolicy(ceiling), toV1GovernancePolicy(requested));
  const effective = computeEffectiveAgentPolicy(toV1GovernancePolicy(ceiling), toV1GovernancePolicy(requested));
  const v1: AgentGovernancePolicy = { ...toV1GovernancePolicy(requested) };
  for (const violation of violations) (v1 as unknown as Record<string, unknown>)[violation.field] = effective[violation.field];
  const desired: AgentAccessPolicy = { ...requested, ...v1 };
  const write = accessPolicyReplacementWrite(storedRequest, desired);
  const merged = mergeAccessPolicyWrite(storedRequest, write);
  const beforeHash = sha(parseAccessPolicy(storedRequest));
  const afterHash = sha(parseAccessPolicy(merged));
  if (beforeHash === afterHash) return { status: "skipped", beforeHash, afterHash };
  const row = await governance.updateStewardRequest(ctx.companyId, ctx.agentId, {
    policy: write,
    revision: current.revision,
    actorUserId: ctx.approverUserId,
    channel: "system",
    // AgentDash (P2.3): the profile's own write; not "changed outside the profile".
    source: "profile_application",
  });
  return {
    status: "done",
    targetId: `${row.id}@${row.revision}`,
    beforeHash,
    afterHash: sha(parseAccessPolicy(row.stewardRequest)),
    note: violations.length > 0 ? { clampedToCeiling: violations.map((violation) => violation.field) } : undefined,
  };
}

/** (b) Config fields the diff changed (model, heartbeat), through `agentService.update` with a recorded revision. */
async function stepConfig(ctx: RunContext, body: AgentOperatingProfileV1): Promise<StepOutcome> {
  const touchesModel = diffTouches(ctx.payload, (pointer) => pointer === "/runtime" || pointer === "/runtime/model");
  const touchesHeartbeat = diffTouches(ctx.payload, (pointer) => pointer === "/runtime" || pointer.startsWith("/runtime/heartbeat"));
  if (!touchesModel && !touchesHeartbeat) return { status: "skipped" };
  const agents = agentService(ctx.db);
  const agent = await agents.getById(ctx.agentId);
  if (!agent || agent.companyId !== ctx.companyId) throw notFound("Agent not found");
  if (body.runtime?.adapterType && body.runtime.adapterType !== agent.adapterType) {
    throw new HttpError(422, "A profile cannot change the adapter type; change it on the agent's settings");
  }
  const patch: Record<string, unknown> = {};
  if (touchesModel) {
    const adapterConfig = { ...((agent.adapterConfig ?? {}) as Record<string, unknown>) };
    if (body.runtime?.model) adapterConfig.model = body.runtime.model;
    else delete adapterConfig.model;
    patch.adapterConfig = adapterConfig;
  }
  if (touchesHeartbeat) {
    const runtimeConfig = { ...((agent.runtimeConfig ?? {}) as Record<string, unknown>) };
    const heartbeat = { ...((runtimeConfig.heartbeat ?? {}) as Record<string, unknown>) };
    const desired = body.runtime?.heartbeat ?? {};
    for (const key of ["intervalSec", "wakeOnDemand"] as const) {
      if (desired[key] === undefined) delete heartbeat[key];
      else heartbeat[key] = desired[key];
    }
    runtimeConfig.heartbeat = heartbeat;
    patch.runtimeConfig = runtimeConfig;
  }
  const before = await latestConfigRevision(ctx.db, ctx.companyId, ctx.agentId);
  await agents.update(ctx.agentId, patch, {
    recordRevision: { createdByUserId: ctx.approverUserId, source: "profile_application" },
  });
  const after = await latestConfigRevision(ctx.db, ctx.companyId, ctx.agentId);
  return after && after !== before ? { status: "done", targetId: after, afterHash: sha(patch) } : { status: "skipped" };
}

/** (c) The default environment, validated by the same company/driver rules as a direct edit. */
async function stepEnvironment(ctx: RunContext, body: AgentOperatingProfileV1): Promise<StepOutcome> {
  if (!diffTouches(ctx.payload, (pointer) => pointer === "/runtime" || pointer === "/runtime/environmentId")) return { status: "skipped" };
  const agents = agentService(ctx.db);
  const agent = await agents.getById(ctx.agentId);
  if (!agent || agent.companyId !== ctx.companyId) throw notFound("Agent not found");
  const desired = body.runtime?.environmentId ?? null;
  if ((agent.defaultEnvironmentId ?? null) === desired) return { status: "skipped" };
  if (desired) {
    const environments = environmentService(ctx.db);
    await assertEnvironmentSelectionForCompany(environments, ctx.companyId, desired, {
      allowedDrivers: supportedEnvironmentDriversForAdapter(agent.adapterType, { hermesSshEnabled: hermesSshEnabled() }),
    });
    const environment = await environments.getById(desired);
    if (agent.adapterType === "hermes_local" && environment?.driver === "ssh") {
      // Pinning hermes to SSH has its own host-access check on the agent's settings page.
      throw new HttpError(422, "Pin an SSH environment from the agent's settings; a profile cannot pin one");
    }
  }
  const before = await latestConfigRevision(ctx.db, ctx.companyId, ctx.agentId);
  await agents.update(ctx.agentId, { defaultEnvironmentId: desired }, {
    recordRevision: { createdByUserId: ctx.approverUserId, source: "profile_application" },
  });
  const after = await latestConfigRevision(ctx.db, ctx.companyId, ctx.agentId);
  return after && after !== before ? { status: "done", targetId: after, afterHash: sha({ desired }) } : { status: "skipped" };
}

/**
 * (d) Routine bindings: each bound trigger must exist, belong to a routine
 * assigned to this agent, and be in this company. Validation only — routines
 * are never modified.
 */
async function stepRoutineBindings(ctx: RunContext, body: AgentOperatingProfileV1): Promise<StepOutcome> {
  const triggerIds = [
    ...new Set(
      body.responsibilities.flatMap((responsibility) =>
        responsibility.obligation.kind === "routine" && responsibility.obligation.routineTriggerId
          ? [responsibility.obligation.routineTriggerId]
          : [],
      ),
    ),
  ].sort();
  if (triggerIds.length === 0) return { status: "skipped" };
  const rows = await ctx.db
    .select({ id: routineTriggers.id, assigneeAgentId: routines.assigneeAgentId })
    .from(routineTriggers)
    .innerJoin(routines, eq(routines.id, routineTriggers.routineId))
    .where(
      and(
        inArray(routineTriggers.id, triggerIds),
        eq(routineTriggers.companyId, ctx.companyId),
        eq(routines.companyId, ctx.companyId),
      ),
    );
  const valid = new Set(rows.filter((row) => row.assigneeAgentId === ctx.agentId).map((row) => row.id));
  const invalid = triggerIds.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    throw new HttpError(
      422,
      `Routine trigger${invalid.length === 1 ? "" : "s"} ${invalid.join(", ")} ${invalid.length === 1 ? "is" : "are"} not on a routine assigned to this agent in this company`,
    );
  }
  return { status: "done", targetId: null, afterHash: sha(triggerIds) };
}

function scopeAllows(scope: AgentAccessListScope | undefined, key: string): boolean {
  return !scope || scope.mode === "all" || scope.ids.includes(key);
}

/** (e) Skills: `skills ∩ access.do.skills` (request and ceiling), through the skill sync rules. */
async function stepSkills(ctx: RunContext, body: AgentOperatingProfileV1): Promise<StepOutcome> {
  if (!diffTouches(ctx.payload, (pointer) => pointer === "/skills" || pointer === "/access" || pointer.startsWith("/access/do"))) {
    return { status: "skipped" };
  }
  const agents = agentService(ctx.db);
  const agent = await agents.getById(ctx.agentId);
  if (!agent || agent.companyId !== ctx.companyId) throw notFound("Agent not found");
  const governance = await agentGovernanceService(ctx.db).getForAgent(ctx.companyId, ctx.agentId);
  const ceiling = parseAccessPolicy(governance.ownerCeiling);
  const skills = companySkillService(ctx.db);
  const resolved = await skills.resolveRequestedSkillKeys(ctx.companyId, body.skills);
  const allowed = resolved.filter((key) => scopeAllows(body.access.do?.skills, key) && scopeAllows(ceiling.do?.skills, key));
  // Required company skills are always installed, exactly as the skill sync route does.
  const required = (await skills.listRuntimeSkillEntries(ctx.companyId)).filter((entry) => entry.required).map((entry) => entry.key);
  const desired = [...new Set([...required, ...allowed])];
  const adapterConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const current = readPaperclipSkillSyncPreference(adapterConfig).desiredSkills;
  const beforeHash = sha([...current].sort());
  const afterHash = sha([...desired].sort());
  if (beforeHash === afterHash) return { status: "skipped", beforeHash, afterHash };
  const before = await latestConfigRevision(ctx.db, ctx.companyId, ctx.agentId);
  await agents.update(ctx.agentId, { adapterConfig: writePaperclipSkillSyncPreference(adapterConfig, desired) }, {
    recordRevision: { createdByUserId: ctx.approverUserId, source: "profile_application" },
  });
  const after = await latestConfigRevision(ctx.db, ctx.companyId, ctx.agentId);
  return {
    status: after && after !== before ? "done" : "skipped",
    targetId: after && after !== before ? after : null,
    beforeHash,
    afterHash,
    note: { excludedByAccess: resolved.filter((key) => !allowed.includes(key)) },
  };
}

/** (f) `contract.declared` for the agent subject (P2.4), idempotent per revision. */
async function stepContract(ctx: RunContext, body: AgentOperatingProfileV1, accountableUserId: string | null): Promise<StepOutcome> {
  const { eventId } = await declareAgentContract(ctx.db, {
    companyId: ctx.companyId,
    agentId: ctx.agentId,
    profileRevisionId: ctx.payload.revisionId,
    body,
    accountableUserId,
    actor: { actorType: "user", actorId: ctx.approverUserId },
  });
  return { status: "done", targetId: eventId };
}

function plainError(error: unknown, step: AgentProfileApplicationStep): string {
  if (error instanceof HttpError && error.status < 500) return error.message.slice(0, 500);
  return `The ${step.replace(/_/g, " ")} step failed. See the server log for details.`;
}

// ---------------------------------------------------------------------------
// The run (steps 2–5)
// ---------------------------------------------------------------------------

async function finish(ctx: RunContext): Promise<ProfileApplicationResult> {
  const row = await loadApplication(ctx.db, ctx.applicationId);
  if (!row) throw notFound("Profile application not found");
  return { application: toProfileApplicationDto(row), activated: row.status === "applied" };
}

async function endApplication(
  ctx: RunContext,
  status: "failed" | "refused_stale",
  revisionState: "application_failed" | "refused_stale",
  steps: AgentProfileApplicationStepRecord[],
  patch: Partial<typeof agentProfileApplications.$inferInsert> = {},
) {
  await saveSteps(ctx, steps, { status, ...patch });
  await ctx.db
    .update(agentProfileRevisions)
    .set({ state: revisionState, updatedAt: now(ctx.options) })
    .where(
      and(
        eq(agentProfileRevisions.id, ctx.payload.revisionId),
        inArray(agentProfileRevisions.state, ["proposed", "approved", "application_failed"]),
      ),
    );
}

async function runApplication(ctx: RunContext, resumed: boolean): Promise<ProfileApplicationResult> {
  // Step 1.
  if ((await claimAgent(ctx)) === "busy") {
    throw conflict("Another profile application is in progress for this agent; resume this one when it finishes", {
      code: AGENT_PROFILE_APPLICATION_IN_PROGRESS,
      applicationId: ctx.applicationId,
    });
  }
  const startRow = await loadApplication(ctx.db, ctx.applicationId);
  if (!startRow) throw notFound("Profile application not found");
  // A step left `failed` (or interrupted) is retried from the top of that step.
  const steps = normalizeSteps(startRow.steps).map((record) =>
    record.status === "failed" ? { ...record, status: "pending" as const, error: null } : record,
  );
  await logApplicationActivity(ctx, "agent_profile.application_started", {
    resumed,
    resumeFromStep: steps.find((record) => record.status === "pending")?.step ?? null,
  });

  // Step 2.
  const revision = await loadRevision(ctx);
  const stale = await staleReason(ctx, revision, steps);
  if (stale) {
    await endApplication(ctx, "refused_stale", "refused_stale", steps);
    await logApplicationActivity(ctx, "agent_profile.application_refused_stale", { reason: stale });
    return finish(ctx);
  }
  const body = agentOperatingProfileV1Schema.parse(revision!.body);
  await ctx.db
    .update(agentProfileRevisions)
    .set({ state: "approved", updatedAt: now(ctx.options) })
    .where(and(eq(agentProfileRevisions.id, revision!.id), inArray(agentProfileRevisions.state, ["proposed", "application_failed"])));

  // Step 3.
  const checkActor =
    ctx.actor.userId === ctx.approverUserId
      ? { type: "board", userId: ctx.approverUserId, source: ctx.actor.source ?? null, isInstanceAdmin: ctx.actor.isInstanceAdmin ?? false }
      : { type: "board", userId: ctx.approverUserId };
  let approverAuthority: AgentProfileApproverAuthority;
  let accountableUserId: string | null = null;
  try {
    // AgentDash (APM gate 5): a hire's first application is decided with the hire's own authority (agents:create).
    const decision =
      ctx.approval.type === "hire_agent"
        ? await assertHireProfileDecider(ctx.db, ctx.approval, checkActor)
        : await assertProfileChangeDecider(ctx.db, ctx.approval, checkActor);
    approverAuthority = {
      role: decision.decisionActorRole,
      required: decision.requiredAuthority,
      checkedAt: now(ctx.options).toISOString(),
      selfApproval: decision.selfApproval,
    };
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 403) throw error;
    await endApplication(ctx, "failed", "application_failed", steps);
    await logApplicationActivity(ctx, "agent_profile.application_failed", { kind: "authority", detail: error.message });
    return finish(ctx);
  }
  await saveSteps(ctx, steps, { approverUserId: ctx.approverUserId, approverAuthority });
  accountableUserId = (await agentAccountabilityService(ctx.db).resolveForAgent(ctx.companyId, ctx.agentId))?.userId ?? null;

  // Step 4.
  const runners: Record<AgentProfileApplicationStep, () => Promise<StepOutcome>> = {
    governance_request: () => stepGovernanceRequest(ctx, body),
    config: () => stepConfig(ctx, body),
    environment: () => stepEnvironment(ctx, body),
    routine_bindings: () => stepRoutineBindings(ctx, body),
    skills: () => stepSkills(ctx, body),
    contract: () => stepContract(ctx, body, accountableUserId),
  };
  for (const record of steps) {
    if (record.status === "done" || record.status === "skipped") continue;
    try {
      await ctx.options.beforeStep?.(record.step);
      const outcome = await runners[record.step]();
      Object.assign(record, {
        status: outcome.status,
        targetId: outcome.targetId ?? null,
        beforeHash: outcome.beforeHash ?? null,
        afterHash: outcome.afterHash ?? null,
        error: null,
        completedAt: now(ctx.options).toISOString(),
      });
      // Durable per step, and the lease is refreshed with it.
      await saveSteps(ctx, steps);
      await logApplicationActivity(ctx, "agent_profile.application_step", {
        step: record.step,
        status: record.status,
        targetId: record.targetId,
        ...(outcome.note ?? {}),
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) {
        logger.error({ err: error, applicationId: ctx.applicationId, step: record.step }, "profile application step failed");
      }
      Object.assign(record, { status: "failed", error: plainError(error, record.step), completedAt: null });
      await endApplication(ctx, "failed", "application_failed", steps);
      await logApplicationActivity(ctx, "agent_profile.application_failed", { kind: "step", step: record.step, error: record.error });
      return finish(ctx);
    }
  }

  // Step 5: activation, one transaction.
  const blockHash = expectedProfileBlockHash({ id: revision!.id, revisionNumber: revision!.revisionNumber, body });
  const activated = await ctx.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const profile = await tx
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.id, ctx.payload.profileId), eq(agentProfiles.companyId, ctx.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!profile || (profile.activeRevisionId ?? null) !== (ctx.payload.bases.basedOnRevisionId ?? null)) return null;
    const at = now(ctx.options);
    if (profile.activeRevisionId) {
      await tx
        .update(agentProfileRevisions)
        .set({ state: "superseded", updatedAt: at })
        .where(eq(agentProfileRevisions.id, profile.activeRevisionId));
    }
    await tx
      .update(agentProfileRevisions)
      .set({ state: "applied", updatedAt: at })
      .where(eq(agentProfileRevisions.id, revision!.id));
    await tx
      .update(agentProfiles)
      .set({ activeRevisionId: revision!.id, updatedAt: at })
      .where(eq(agentProfiles.id, profile.id));
    await tx
      .update(agentProfileApplications)
      .set({ status: "applied", steps, updatedAt: at })
      .where(eq(agentProfileApplications.id, ctx.applicationId));
    return insertActivity(tx, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.approverUserId,
      agentId: ctx.agentId,
      action: "agent_profile.applied",
      entityType: "agent_profile_revision",
      entityId: revision!.id,
      details: {
        applicationId: ctx.applicationId,
        approvalId: ctx.approval.id,
        revisionNumber: revision!.revisionNumber,
        supersededRevisionId: profile.activeRevisionId ?? null,
        blockHash,
        steps: steps.map((record) => ({ step: record.step, status: record.status, targetId: record.targetId })),
        path: ctx.actor.path,
        ...(ctx.actor.via ? { via: ctx.actor.via } : {}),
      },
    });
  });
  if (!activated) {
    await endApplication(ctx, "refused_stale", "refused_stale", steps);
    await logApplicationActivity(ctx, "agent_profile.application_refused_stale", { reason: "active_revision_changed" });
    return finish(ctx);
  }
  publishActivity(activated);

  // Delivery to disk is best-effort and evidenced at run start (P2.3).
  try {
    await agentInstructionRefreshService({ db: ctx.db }).refreshIfStale(ctx.agentId);
  } catch (err) {
    logger.warn({ err, agentId: ctx.agentId, applicationId: ctx.applicationId }, "operating-profile block refresh failed after application");
  }
  return finish(ctx);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Apply the revision an approved `agent_profile_change` names. Called from
 * `afterApprove` and from the override route (one function, both paths).
 * Idempotent per approval: a second call returns the existing application
 * (one application per approval, unique index) and does not re-run steps.
 */
export async function applyProfileRevision(
  db: Db,
  approvalId: string,
  actor: ProfileApplicationActor,
  options: ProfileApplicationOptions = {},
): Promise<ProfileApplicationResult> {
  const approval = await loadApproval(db, approvalId);
  if (approval.type === "hire_agent") {
    // APM gate 5: a hire binds its profile first; there is one path for that.
    const result = await applyHireProfileRevision(db, approvalId, actor, options);
    if (!result) throw conflict("The hire's profile could not be bound to the hired agent", { code: "AGENT_PROFILE_HIRE_NOT_BOUND" });
    return result;
  }
  if (approval.status !== "approved") {
    throw conflict("Only an approved profile change can be applied", { code: "AGENT_PROFILE_CHANGE_NOT_APPROVED", status: approval.status });
  }
  const payload = changePayloadOf(approval);
  return startApplication(db, approval, payload, actor, options);
}

async function startApplication(
  db: Db,
  approval: ApprovalRow,
  payload: AgentProfileChangePayload,
  actor: ProfileApplicationActor,
  options: ProfileApplicationOptions,
): Promise<ProfileApplicationResult> {
  const existing = await db
    .select()
    .from(agentProfileApplications)
    .where(eq(agentProfileApplications.approvalId, approval.id))
    .then((rows) => rows[0] ?? null);
  if (existing) return { application: toProfileApplicationDto(existing), activated: existing.status === "applied" };
  const inserted = await db
    .insert(agentProfileApplications)
    .values({
      companyId: approval.companyId,
      agentId: payload.agentId,
      revisionId: payload.revisionId,
      approvalId: approval.id,
      status: "pending",
      steps: normalizeSteps([]),
      approverUserId: approval.decidedByUserId ?? actor.userId,
    })
    .onConflictDoNothing()
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!inserted) {
    // Lost a race with another call for the same approval: that call runs it.
    const raced = await db
      .select()
      .from(agentProfileApplications)
      .where(eq(agentProfileApplications.approvalId, approval.id))
      .then((rows) => rows[0] ?? null);
    if (!raced) throw notFound("Profile application not found");
    return { application: toProfileApplicationDto(raced), activated: raced.status === "applied" };
  }
  return runApplication(
    {
      db,
      approval,
      payload,
      companyId: approval.companyId,
      agentId: payload.agentId,
      applicationId: inserted.id,
      actor,
      approverUserId: approval.decidedByUserId ?? actor.userId,
      options,
    },
    false,
  );
}

/**
 * The resume route's authority rule, shared with the profile view's
 * `viewer.canResumeApplication` so the two can never disagree: the
 * application's approver, or an administrator (`agents:create`). Throws 403
 * otherwise, and 409 when there is no approval or approver to resume from.
 */
export async function assertCanResumeProfileApplication(
  db: Db,
  row: Pick<ApplicationRow, "companyId" | "agentId" | "approvalId" | "approverUserId">,
  actor: Pick<ProfileApplicationActor, "userId" | "source" | "isInstanceAdmin">,
): Promise<{ approval: ApprovalRow; approverUserId: string }> {
  if (!row.approvalId) throw conflict("This application has no approval to resume from");
  const approval = await loadApproval(db, row.approvalId);
  const approverUserId = approval.decidedByUserId ?? row.approverUserId ?? null;
  if (!approverUserId) throw conflict("This application has no recorded approver");
  if (actor.userId !== approverUserId) {
    const holder = await resolveProfileAuthorityHolder(db, { companyId: row.companyId, agentId: row.agentId }, {
      type: "board",
      userId: actor.userId,
      source: actor.source ?? null,
      isInstanceAdmin: actor.isInstanceAdmin ?? false,
    });
    if (!holder.isAdmin) throw forbidden("Only the approver or an administrator can resume a profile application");
  }
  return { approval, approverUserId };
}

/**
 * `POST .../profile/applications/:id/resume` (admin or the approver). Re-runs
 * steps 1–3, then continues from the first incomplete step. A stale base or a
 * lost authority ends the application rather than resuming it; an ended
 * application (`refused_stale`, or failed on authority) cannot be resumed.
 */
export async function resumeProfileApplication(
  db: Db,
  applicationId: string,
  actor: ProfileApplicationActor,
  options: ProfileApplicationOptions & { companyId?: string; agentId?: string } = {},
): Promise<ProfileApplicationResult> {
  const row = await loadApplication(db, applicationId);
  if (!row || (options.companyId && row.companyId !== options.companyId) || (options.agentId && row.agentId !== options.agentId)) {
    throw notFound("Profile application not found");
  }
  const { approval, approverUserId } = await assertCanResumeProfileApplication(db, row, actor);
  if (row.status === "applied") return { application: toProfileApplicationDto(row), activated: true };
  const failure = failureOf(row);
  if (row.status === "refused_stale" || failure?.kind === "authority") {
    throw conflict("This application has ended and cannot be resumed; start a new draft", {
      code: "AGENT_PROFILE_APPLICATION_ENDED",
      status: row.status,
      failure,
    });
  }
  if (row.status === "in_progress" && isLive(row, now(options))) {
    throw conflict("This application is still in progress", { code: AGENT_PROFILE_APPLICATION_IN_PROGRESS, applicationId });
  }
  return runApplication(
    {
      db,
      approval,
      payload: changePayloadOf(approval),
      companyId: row.companyId,
      agentId: row.agentId,
      applicationId: row.id,
      actor,
      approverUserId,
      options,
    },
    true,
  );
}

// ---------------------------------------------------------------------------
// APM gate 5 (P5.1): a hire that carries an unbound profile
// ---------------------------------------------------------------------------

/** True when an approval is a `hire_agent` filed by proposing an unbound draft. */
export function isProfileHireApproval(approval: { type: string; payload: unknown }): boolean {
  if (approval.type !== "hire_agent") return false;
  try {
    return parseHireProfileFields(approval.payload) !== null;
  } catch {
    // Names a profile but does not parse: still a profile hire, and applying it refuses.
    return true;
  }
}

type BindOutcome = { bound: true; already: boolean; publication?: ActivityPublication } | { bound: false; reason: string; detail: string };

/**
 * Bind the unbound profile to the agent the approved hire activated
 * (`agent_profiles.agent_id`), in one transaction under the profile row lock.
 * Idempotent: an already-bound profile for the same agent is fine. Refuses —
 * without changing anything — when the agent is not active in the company,
 * the profile went to another agent, the agent already has a profile, or the
 * revision is no longer this hire's.
 */
async function bindHireProfile(db: Db, approval: ApprovalRow, payload: AgentProfileChangePayload, actorUserId: string): Promise<BindOutcome> {
  const hireAgentId = (approval.payload as Record<string, unknown> | null)?.agentId;
  if (hireAgentId !== payload.agentId) {
    return { bound: false, reason: "agent_mismatch", detail: "The hire names a different agent than its profile change." };
  }
  const outcome = await db.transaction(async (rawTx): Promise<BindOutcome> => {
    const tx = rawTx as unknown as Db;
    const agent = await tx
      .select({ id: agentsTable.id, status: agentsTable.status })
      .from(agentsTable)
      .where(and(eq(agentsTable.id, payload.agentId), eq(agentsTable.companyId, approval.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.status === "terminated" || agent.status === "pending_approval") {
      return { bound: false as const, reason: "agent_not_active", detail: "The hired agent is not active, so its profile was not applied." };
    }
    const profile = await tx
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.id, payload.profileId), eq(agentProfiles.companyId, approval.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!profile) return { bound: false as const, reason: "profile_missing", detail: "The draft profile no longer exists." };
    if (profile.agentId === payload.agentId) return { bound: true as const, already: true };
    if (profile.agentId) return { bound: false as const, reason: "profile_bound_elsewhere", detail: "The draft profile already belongs to another agent." };
    const other = await tx
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, payload.agentId))
      .then((rows) => rows[0] ?? null);
    if (other) return { bound: false as const, reason: "agent_has_profile", detail: "The hired agent already has a profile of its own; start a draft there." };
    const revision = await tx
      .select()
      .from(agentProfileRevisions)
      .where(and(eq(agentProfileRevisions.id, payload.revisionId), eq(agentProfileRevisions.profileId, profile.id)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!revision || revision.state !== "proposed" || revision.bodyHash !== payload.bodyHash) {
      return { bound: false as const, reason: "revision_changed", detail: "The draft is no longer the one this hire proposed." };
    }
    if (revision.approvalId && revision.approvalId !== approval.id) {
      return { bound: false as const, reason: "revision_not_this_approval", detail: "The draft was proposed with another hire." };
    }
    const at = new Date();
    if (!revision.approvalId) {
      // The proposal stopped between filing the hire and recording it; the hire is the record.
      await tx
        .update(agentProfileRevisions)
        .set({ approvalId: approval.id, bases: payload.bases, updatedAt: at })
        .where(and(eq(agentProfileRevisions.id, revision.id), isNull(agentProfileRevisions.approvalId)));
    }
    await tx.update(agentProfiles).set({ agentId: payload.agentId, updatedAt: at }).where(eq(agentProfiles.id, profile.id));
    const publication = await insertActivity(tx, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: actorUserId,
      agentId: payload.agentId,
      action: "agent_profile.bound",
      entityType: "agent_profile",
      entityId: profile.id,
      details: { profileId: profile.id, revisionId: revision.id, revisionNumber: revision.revisionNumber, approvalId: approval.id },
    });
    return { bound: true as const, already: false, publication };
  });
  if (outcome.bound && outcome.publication) publishActivity(outcome.publication);
  return outcome;
}

/**
 * Called once a `hire_agent` that carries a profile is approved and its
 * agent activated (the shared `afterApprove` effect and the override route):
 * bind the profile to the agent, then apply the revision through the same
 * serialized, stale-checked, resumable application and receipt as any
 * profile change. The first application's field authority is the hire
 * approval's (`assertHireProfileDecider`). Idempotent per approval. Returns
 * null when the hire carries no profile, or when binding was refused (the
 * revision is then `application_failed` and `agent_profile.application_failed`
 * records why; the agent stays active, with no profile applied).
 */
export async function applyHireProfileRevision(
  db: Db,
  approvalId: string,
  actor: ProfileApplicationActor,
  options: ProfileApplicationOptions = {},
): Promise<ProfileApplicationResult | null> {
  const approval = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .then((rows) => rows[0] ?? null);
  if (!approval || approval.type !== "hire_agent") return null;
  const fields = parseHireProfileFields(approval.payload);
  if (!fields) return null;
  if (approval.status !== "approved") {
    throw conflict("Only an approved hire can apply its profile", { code: "AGENT_PROFILE_CHANGE_NOT_APPROVED", status: approval.status });
  }
  const payload = fields.profileChange;
  const existing = await db
    .select()
    .from(agentProfileApplications)
    .where(eq(agentProfileApplications.approvalId, approval.id))
    .then((rows) => rows[0] ?? null);
  if (existing) return { application: toProfileApplicationDto(existing), activated: existing.status === "applied" };
  const approverUserId = approval.decidedByUserId ?? actor.userId;
  const bound = await bindHireProfile(db, approval, payload, approverUserId);
  if (!bound.bound) {
    await db
      .update(agentProfileRevisions)
      .set({ state: "application_failed", updatedAt: options.now?.() ?? new Date() })
      .where(
        and(
          eq(agentProfileRevisions.id, payload.revisionId),
          eq(agentProfileRevisions.companyId, approval.companyId),
          inArray(agentProfileRevisions.state, ["proposed", "approved"]),
        ),
      );
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: approverUserId,
      agentId: payload.agentId,
      action: "agent_profile.application_failed",
      entityType: "agent_profile_revision",
      entityId: payload.revisionId,
      details: { approvalId: approval.id, kind: "bind", reason: bound.reason, detail: bound.detail, path: actor.path },
    });
    return null;
  }
  return startApplication(db, approval, payload, actor, options);
}
