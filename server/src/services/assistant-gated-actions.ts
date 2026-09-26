import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, assistantActionHandles, assistantGrants, companies, projects } from "@paperclipai/db";
import { AGENT_ROLES } from "@paperclipai/shared";
import { accessService } from "./access.js";
import { approvalAuthorityService, type ApprovalDecisionActor } from "./approval-authority.js";
import { approvalDecisionEffectsService } from "./approval-decision-effects.js";
import { agentService } from "./agents.js";
import { approvalService } from "./approvals.js";
import { logActivity } from "./activity-log.js";
import { DECIDABLE_STATUSES } from "./steward-inbox.js";
import { defaultAgentPlanAdapterType } from "./cos-replier.js";
import { adapterSupportsInstructionsBundle } from "../adapters/instructions-bundle-support.js";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "./default-agent-instructions.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { absoluteUrl, approvalUrl } from "../lib/public-base-url.js";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { buildRequireTierDeps } from "../middleware/build-tier-deps.js";
import {
  exceededFreeTierCapacityAction,
  freeTierCapExceededPayload,
  isBillingDisabled,
  withCompanyTierCapacityLock,
} from "./tier-policy.js";

/**
 * AgentDash assistant MCP (M4, GH #679, spec §7): the gated class — decisions
 * and hires a person's assistant may prepare but must never execute until the
 * person has heard the read-back and said yes.
 *
 * Same shape as `steward-inbox-decisions.ts`, for the same reason: the
 * assistant OAuth grant is a read/act credential, never a decision credential.
 * What authorizes execution is a handle minted for ONE resolved action, bound
 * to the grant, spent exactly once, dead in fifteen minutes — and authority is
 * re-resolved against the grant's user at redemption, not at mint time. The
 * handle proves the two-step flow happened; the person still proves
 * permission.
 *
 * The row stores the RESOLVED action — approval id + revision + decision, or
 * the hire's name/role/adapter — never the sentence the assistant typed, so
 * what is confirmed is exactly what was read back.
 */

/** Long enough to read a confirmation, short enough to be worthless if it leaks. */
const HANDLE_TTL_MS = 15 * 60 * 1000;

const MAX_REASON_LENGTH = 1000;
const MAX_NOTE_LENGTH = 1000;
const MAX_NAME_LENGTH = 120;
const MAX_ROLE_LENGTH = 120;
const MAX_PERSON_SAID_LENGTH = 280;

export type AssistantActionKind = "approval_decision" | "hire_request";
export type AssistantDecision = "approve" | "reject" | "request_changes";

/**
 * What the routes hand the service: the loopback actor's grant binding. A
 * request without a live grant id never reaches here — the routes refuse it —
 * because a handle bound to nothing proves nothing.
 */
export interface AssistantGatedActor {
  userId: string;
  grantId: string;
  clientName: string;
  membershipRole: string | null;
}

export type GatedResult<T extends Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; code: string; reason: string; status?: number };

type ApprovalRow = typeof approvals.$inferSelect;
type HandleRow = typeof assistantActionHandles.$inferSelect;

interface DecisionHandlePayload {
  approvalId: string;
  revision: number;
  decision: AssistantDecision;
  note: string | null;
}

interface HireHandlePayload {
  name: string;
  role: string;
  title: string;
  reason: string;
  projectId: string | null;
  adapterType: string;
}

/** Human phrasing for an approval kind — one clause, payload stays out. */
const APPROVAL_KIND_PHRASES: Record<string, string> = {
  hire_agent: "hire a new agent",
  approve_issue: "close out a task",
  send_email: "send an email",
  connector_send: "send a message through a connector",
  environment_provision: "provision an environment",
  budget_override: "change a budget",
  deliverable_review: "sign off on a deliverable",
  workflow_recommendation: "act on a workflow recommendation",
  mandate_violation: "resolve a mandate violation",
};

function kindPhrase(approval: { type: string }): string {
  return APPROVAL_KIND_PHRASES[approval.type] ?? `act on "${approval.type}"`;
}

/**
 * The specifics a person needs in the read-back for the kinds we can describe
 * from the payload. Deliberately small: a wrong detail invented here would be
 * confirmed as fact.
 */
function approvalDetail(approval: ApprovalRow): string | null {
  const payload =
    typeof approval.payload === "object" && approval.payload !== null
      ? (approval.payload as Record<string, unknown>)
      : {};
  if (approval.type === "hire_agent") {
    const name = typeof payload.name === "string" ? payload.name : null;
    const title = typeof payload.title === "string" ? payload.title : null;
    const role = typeof payload.role === "string" ? payload.role : null;
    const descriptor = title ?? role;
    if (name && descriptor) return ` — ${name} as ${descriptor}`;
    if (name) return ` — ${name}`;
    return null;
  }
  return null;
}

function hireApprovalCreatesAgent(approval: {
  type: string;
  status?: string | null;
  payload: unknown;
}): boolean {
  if (approval.type !== "hire_agent") return false;
  if (!DECIDABLE_STATUSES.has(approval.status ?? "")) return false;
  const payload =
    typeof approval.payload === "object" && approval.payload !== null
      ? (approval.payload as Record<string, unknown>)
      : {};
  return typeof payload.agentId !== "string";
}

/** "qa engineer" → "qa" when it matches a known role, else "general". */
function normalizeRequestedRole(role: string): (typeof AGENT_ROLES)[number] {
  const normalized = role.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (AGENT_ROLES as readonly string[]).includes(normalized)
    ? (normalized as (typeof AGENT_ROLES)[number])
    : "general";
}

function titleCase(text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 ? trimmed : trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

export function assistantGatedActionsService(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    autoDispatchQueuedRuns?: boolean;
  } = {},
) {
  const access = accessService(db);
  const authority = approvalAuthorityService(db);
  const approvalsSvc = approvalService(db);
  const agentsSvc = agentService(db);
  const instructions = agentInstructionsService();
  const decisionEffects = approvalDecisionEffectsService(db, options);

  function decisionActor(actor: AssistantGatedActor): ApprovalDecisionActor {
    return { userId: actor.userId, source: "assistant_grant", isInstanceAdmin: false };
  }

  async function mintHandle(input: {
    companyId: string;
    actor: AssistantGatedActor;
    kind: AssistantActionKind;
    payload: Record<string, unknown>;
  }) {
    const token = `aah_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + HANDLE_TTL_MS);
    const [row] = await db
      .insert(assistantActionHandles)
      .values({
        token,
        companyId: input.companyId,
        grantId: input.actor.grantId,
        actorUserId: input.actor.userId,
        kind: input.kind,
        payload: input.payload,
        expiresAt,
      })
      .returning();
    return { token, expiresAt, id: row!.id };
  }

  /**
   * Can this person hire agents at all? The same rule the person-facing
   * `/agent-hires` route applies to board actors: any active human member may
   * create agents, everyone else needs the explicit `agents:create` grant.
   * Checked at prepare AND again at confirm — a membership removed between the
   * two is what the second check exists to catch.
   */
  async function canHire(companyId: string, actor: AssistantGatedActor): Promise<boolean> {
    // The 2026-08-16 rule the /agent-hires route applies: every active human
    // member may create agents; anyone else needs the explicit grant. A
    // null membership role means the grant resolve found no active
    // membership — that falls to the explicit permission.
    if (actor.membershipRole !== null) return true;
    return access.canUser(companyId, actor.userId, "agents:create");
  }

  /**
   * Deciding an agent hire drives a lifecycle transition either way — approve
   * activates or creates, reject terminates — so it needs `agents:create`,
   * mirroring `assertCanDecideAgentLifecycleApproval` on the board route.
   */
  async function canDecideHire(companyId: string, actor: AssistantGatedActor): Promise<boolean> {
    return access.canUser(companyId, actor.userId, "agents:create");
  }

  async function readBackFor(approval: ApprovalRow, decision: AssistantDecision, note: string | null) {
    const asker = approval.requestedByAgentId
      ? await agentsSvc.getById(approval.requestedByAgentId).then((a) => a?.name ?? "An agent")
      : "The board";
    const detail = approvalDetail(approval);
    const noteClause = note ? ` — your note: "${note}"` : "";
    const verb =
      decision === "approve" ? "Approve" : decision === "reject" ? "Reject" : "Send back for changes on";
    return `${verb} ${asker}'s request to ${kindPhrase(approval)}${detail ?? ""}${noteClause}.`;
  }

  function effectsFor(approval: ApprovalRow, decision: AssistantDecision): string[] {
    if (decision === "request_changes") {
      return ["The request goes back to whoever asked, with your note — nothing is approved."];
    }
    if (decision === "reject") {
      return approval.type === "hire_agent" && !hireApprovalCreatesAgent(approval)
        ? ["The hire is refused and the proposed agent is terminated."]
        : ["The request is rejected and does not proceed."];
    }
    if (approval.type === "hire_agent") {
      return hireApprovalCreatesAgent(approval)
        ? ["The hire is approved and the new agent is created on the requested adapter."]
        : ["The hire is approved and the agent becomes active."];
    }
    return ["The request is approved and whatever it was gating proceeds."];
  }

  /**
   * Prepare a decision: resolve the approval, check the action is currently
   * valid and the person currently has authority, mint the handle.
   * Changes nothing.
   */
  async function prepareDecision(
    companyId: string,
    actor: AssistantGatedActor,
    input: { approvalId: string; decision: AssistantDecision; note?: string | null },
  ): Promise<
    GatedResult<{
      readBack: string;
      handle: string;
      expiresAt: string;
      effects: string[];
      approval: { id: string; type: string; revision: number };
    }>
  > {
    const approval = await approvalsSvc.getById(input.approvalId);
    if (!approval || approval.companyId !== companyId) {
      return { ok: false, code: "approval_not_found", reason: "I couldn't find that approval — it may have been removed.", status: 404 };
    }
    if (!DECIDABLE_STATUSES.has(approval.status)) {
      return {
        ok: false,
        code: "approval_already_decided",
        reason: `That request was already ${approval.status} — nothing is waiting on you.`,
        status: 409,
      };
    }
    if (input.decision === "request_changes" && approval.status !== "pending") {
      return {
        ok: false,
        code: "approval_already_decided",
        reason: "That request is already waiting on changes — there is nothing new to send back.",
        status: 409,
      };
    }

    try {
      await authority.requireDecisionActor(approval, decisionActor(actor));
    } catch {
      return {
        ok: false,
        code: "not_authorized",
        reason: "You are not the person who can decide this one.",
        status: 403,
      };
    }
    if (input.decision !== "request_changes"
        && approval.type === "hire_agent"
        && !(await canDecideHire(companyId, actor))) {
      return {
        ok: false,
        code: "not_authorized",
        reason: "Deciding an agent hire needs the agents:create permission — ask a company admin.",
        status: 403,
      };
    }

    const note = input.note?.trim() || null;
    const readBack = await readBackFor(approval, input.decision, note);
    const handle = await mintHandle({
      companyId,
      actor,
      kind: "approval_decision",
      payload: {
        approvalId: approval.id,
        revision: approval.revision,
        decision: input.decision,
        note,
      } satisfies DecisionHandlePayload,
    });

    return {
      ok: true,
      readBack,
      handle: handle.token,
      expiresAt: handle.expiresAt.toISOString(),
      effects: effectsFor(approval, input.decision),
      approval: { id: approval.id, type: approval.type, revision: approval.revision },
    };
  }

  /**
   * Prepare a hire: resolve role/reason/name/project into a pinned spec and
   * mint the handle. Creates no agent and no approval — that only happens on
   * confirm.
   *
   * The payload is deliberately narrow: the assistant supplies a role, a
   * reason and at most a name hint and project. The adapter is the instance
   * default resolved HERE, and adapterConfig stays empty — an assistant can
   * never pick the binary, argv, env or cwd an agent runs with.
   */
  async function prepareHire(
    companyId: string,
    actor: AssistantGatedActor,
    input: { role: string; reason: string; name?: string | null; projectId?: string | null },
  ): Promise<
    GatedResult<{
      readBack: string;
      handle: string;
      expiresAt: string;
      wouldNeedApproval: boolean;
      effects: string[];
      hire: { name: string; role: string; adapterType: string };
    }>
  > {
    const role = input.role.trim();
    const reason = input.reason.trim();
    if (!role) return { ok: false, code: "invalid", reason: "I need a role for the hire — designer, QA, whatever the person asked for.", status: 400 };
    if (!reason) return { ok: false, code: "invalid", reason: "I need the reason for the hire — it is what the approver reads.", status: 400 };
    if (role.length > MAX_ROLE_LENGTH || reason.length > MAX_REASON_LENGTH || (input.name?.length ?? 0) > MAX_NAME_LENGTH) {
      return { ok: false, code: "invalid", reason: "That hire description is too long — keep the role and reason short.", status: 400 };
    }

    let project: { id: string; name: string } | null = null;
    if (input.projectId) {
      project = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!project) {
        return { ok: false, code: "project_not_found", reason: "I couldn't find that project in this company.", status: 404 };
      }
    }

    if (!(await canHire(companyId, actor))) {
      return {
        ok: false,
        code: "not_authorized",
        reason: "You do not have permission to hire agents in this company.",
        status: 403,
      };
    }

    const company = await db
      .select({ requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    const wouldNeedApproval = company?.requireBoardApprovalForNewAgents === true;

    const name = input.name?.trim() || titleCase(role);
    const title = titleCase(role);
    const adapterType = defaultAgentPlanAdapterType();
    const projectClause = project ? ` for the ${project.name} project` : "";

    const readBack = wouldNeedApproval
      ? `File a hire request for ${name}, ${title.toLowerCase()}${projectClause}: "${reason}". The agent is created pending approval — nothing runs until someone approves it on the board.`
      : `Hire ${name} as ${title.toLowerCase()}${projectClause}: "${reason}". They are created active and can be assigned work immediately.`;

    const handle = await mintHandle({
      companyId,
      actor,
      kind: "hire_request",
      payload: {
        name,
        role: normalizeRequestedRole(role),
        title,
        reason,
        projectId: project?.id ?? null,
        adapterType,
      } satisfies HireHandlePayload,
    });

    return {
      ok: true,
      readBack,
      handle: handle.token,
      expiresAt: handle.expiresAt.toISOString(),
      wouldNeedApproval,
      effects: wouldNeedApproval
        ? [
            `Creates ${name} in a pending state that cannot run`,
            "Opens a hire request on the board for someone with hiring authority",
          ]
        : [
            `Creates ${name} on the ${adapterType} adapter`,
            `${name} starts idle and can be assigned work immediately`,
          ],
      hire: { name, role: title, adapterType },
    };
  }

  /**
   * Spend the handle. Two lookups on purpose:
   *
   *   1. A plain SELECT tells the person WHICH refusal applies — spent,
   *      expired, or never valid — which is the spec's "relayable reason".
   *   2. A conditional UPDATE wins the redemption exactly once, so two
   *      concurrent confirms cannot both execute.
   */
  async function consumeHandle(companyId: string, actor: AssistantGatedActor, token: string) {
    const record = await db
      .select()
      .from(assistantActionHandles)
      .where(
        and(
          eq(assistantActionHandles.token, token),
          eq(assistantActionHandles.grantId, actor.grantId),
          eq(assistantActionHandles.companyId, companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!record) {
      return {
        error: {
          ok: false as const,
          code: "handle_invalid",
          reason: "That confirmation handle isn't valid — ask me to prepare the action again.",
          status: 404,
        },
      };
    }
    if (record.consumedAt) {
      return {
        error: {
          ok: false as const,
          code: "handle_consumed",
          reason: "That confirmation was already used — nothing happened twice. Ask me to prepare the action again if you still want it.",
          status: 409,
        },
      };
    }
    const now = new Date();
    if (record.expiresAt <= now) {
      return {
        error: {
          ok: false as const,
          code: "handle_expired",
          reason: "That confirmation expired — handles last 15 minutes. Ask me to prepare the action again.",
          status: 409,
        },
      };
    }
    const consumed = await db
      .update(assistantActionHandles)
      .set({ consumedAt: now })
      .where(
        and(
          eq(assistantActionHandles.id, record.id),
          isNull(assistantActionHandles.consumedAt),
          gt(assistantActionHandles.expiresAt, now),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!consumed) {
      return {
        error: {
          ok: false as const,
          code: "handle_consumed",
          reason: "That confirmation was already used — nothing happened twice.",
          status: 409,
        },
      };
    }
    return { record: consumed };
  }

  async function auditConfirmed(input: {
    companyId: string;
    actor: AssistantGatedActor;
    record: HandleRow;
    personSaid: string | null;
    details: Record<string, unknown>;
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actor.userId,
      action: "assistant.gated_action",
      entityType: "assistant_action_handle",
      entityId: input.record.id,
      details: {
        kind: input.record.kind,
        via: `assistant_grant ${input.actor.clientName}`,
        grantId: input.actor.grantId,
        personSaid: input.personSaid,
        prepareToConfirmMs: Date.now() - input.record.createdAt.getTime(),
        ...input.details,
      },
    }).catch((err) => logger.warn({ err }, "assistant gated-action activity not recorded"));
  }

  /**
   * Confirm and execute. Every state check runs AFTER the handle is spent,
   * against current data — a stale revision, a settled approval or an
   * authority that changed between prepare and confirm all refuse here.
   */
  async function confirm(
    companyId: string,
    actor: AssistantGatedActor,
    input: { handle: string; personSaid?: string | null },
  ): Promise<
    GatedResult<{
      outcome: string;
      kind: AssistantActionKind;
      approvalId?: string;
      agentId?: string;
      tapReturned?: boolean;
      links: Record<string, string>;
    }>
  > {
    const personSaid = input.personSaid?.trim().slice(0, MAX_PERSON_SAID_LENGTH) || null;
    const { record, error } = await consumeHandle(companyId, actor, input.handle);
    if (error) return error;

    const grant = await db
      .select({ decisionsNeedTap: assistantGrants.decisionsNeedTap, revokedAt: assistantGrants.revokedAt })
      .from(assistantGrants)
      .where(eq(assistantGrants.id, actor.grantId))
      .then((rows) => rows[0] ?? null);
    if (!grant || grant.revokedAt) {
      return {
        ok: false,
        code: "grant_revoked",
        reason: "This assistant connection was revoked — nothing was decided.",
        status: 403,
      };
    }

    if (record.kind === "hire_request") {
      return confirmHire(companyId, actor, record, personSaid, grant.decisionsNeedTap);
    }
    return confirmDecision(companyId, actor, record, personSaid, grant.decisionsNeedTap);
  }

  async function confirmDecision(
    companyId: string,
    actor: AssistantGatedActor,
    record: HandleRow,
    personSaid: string | null,
    decisionsNeedTap: boolean,
  ): ReturnType<typeof confirm> {
    const payload = record.payload as unknown as DecisionHandlePayload;
    const approval = await approvalsSvc.getById(payload.approvalId);
    if (!approval || approval.companyId !== companyId) {
      return {
        ok: false,
        code: "approval_not_found",
        reason: "That request no longer exists — nothing was decided.",
        status: 404,
      };
    }
    if (!DECIDABLE_STATUSES.has(approval.status)) {
      return {
        ok: false,
        code: "approval_already_decided",
        reason: `That request was already ${approval.status} — nothing more to do.`,
        status: 409,
      };
    }
    if (approval.revision !== payload.revision || approval.supersededAt) {
      return {
        ok: false,
        code: "approval_revision_conflict",
        reason: "That request changed since you were read the summary — ask me to look at it again before deciding.",
        status: 409,
      };
    }

    // "Decisions need a tap" (spec §7.2): the grant opted out of execution.
    // The handle is still spent — the person got their link — and nothing was
    // decided. The approval stays pending for the page.
    if (decisionsNeedTap) {
      const link = approvalUrl(approval.id);
      await auditConfirmed({
        companyId,
        actor,
        record,
        personSaid,
        details: { approvalId: approval.id, decision: payload.decision, tapReturned: true },
      });
      return {
        ok: true,
        kind: "approval_decision",
        tapReturned: true,
        approvalId: approval.id,
        outcome:
          "This connection is set to keep decisions on the page — nothing was decided. " +
          (link ? `Open the approval to decide it yourself.` : "Open the approval in AgentDash to decide it yourself."),
        links: link ? { approval: link } : {},
      };
    }

    try {
      const context = await authority.requireDecisionAuthority(approval, decisionActor(actor), {
        revision: payload.revision,
        idempotencyKey: `assistant:${record.id}`,
        channel: "assistant",
      });
      const meta = {
        revision: context.revision,
        channel: context.channel,
        idempotencyKey: context.idempotencyKey,
        actorRole: context.role,
      };

      if (
        payload.decision !== "request_changes"
        && approval.type === "hire_agent"
        && !(await canDecideHire(companyId, actor))
      ) {
        return {
          ok: false,
          code: "not_authorized",
          reason: "Deciding an agent hire needs the agents:create permission — nothing was decided.",
          status: 403,
        };
      }

      if (payload.decision === "request_changes") {
        const updated = await approvalsSvc.requestRevision(approval.id, actor.userId, payload.note);
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: actor.userId,
          action: "approval.revision_requested",
          entityType: "approval",
          entityId: updated.id,
          details: { type: updated.type },
        }).catch((err) => logger.warn({ err }, "revision-requested activity not recorded"));
        await auditConfirmed({
          companyId,
          actor,
          record,
          personSaid,
          details: { approvalId: approval.id, decision: payload.decision, applied: true },
        });
        const link = approvalUrl(updated.id);
        return {
          ok: true,
          kind: "approval_decision",
          approvalId: updated.id,
          outcome: "Sent back for changes — whoever asked will see your note.",
          links: link ? { approval: link } : {},
        };
      }

      // Approving a hire that CREATES the agent draws down the same
      // free-tier capacity the board route guards — under the same lock.
      const executeApprove = async () => {
        const doApprove = (txDb: Db) =>
          approvalService(txDb).approve(approval.id, actor.userId, payload.note, meta);
        if (!hireApprovalCreatesAgent(approval) || isBillingDisabled()) {
          return doApprove(db);
        }
        return withCompanyTierCapacityLock(db, companyId, async (txDb) => {
          const fresh = await approvalService(txDb).getById(approval.id);
          if (!fresh || !hireApprovalCreatesAgent(fresh)) {
            return doApprove(txDb);
          }
          const blocked = await exceededFreeTierCapacityAction(
            buildRequireTierDeps(txDb),
            companyId,
            { agents: 1 },
          );
          if (blocked) {
            return { blocked };
          }
          return doApprove(txDb);
        });
      };

      const resolved =
        payload.decision === "approve"
          ? await executeApprove()
          : await approvalsSvc.reject(approval.id, actor.userId, payload.note, meta);

      if ("blocked" in (resolved as { blocked?: unknown })) {
        const cap = freeTierCapExceededPayload((resolved as { blocked: "invite" | "hire" }).blocked);
        return {
          ok: false,
          code: cap.code,
          reason: `${cap.message} Nothing was decided.`,
          status: 402,
        };
      }

      const { approval: decided, applied } = resolved as {
        approval: ApprovalRow;
        applied: boolean;
      };

      if (payload.decision === "approve") {
        await decisionEffects.afterApprove(decided, applied, {
          actorUserId: actor.userId,
          decisionNote: payload.note,
        });
      } else {
        await decisionEffects.afterReject(decided, applied, {
          actorUserId: actor.userId,
          decisionNote: payload.note,
        });
      }

      await auditConfirmed({
        companyId,
        actor,
        record,
        personSaid,
        details: { approvalId: approval.id, decision: payload.decision, applied },
      });

      const link = approvalUrl(decided.id);
      return {
        ok: true,
        kind: "approval_decision",
        approvalId: decided.id,
        outcome:
          payload.decision === "approve"
            ? applied
              ? "Approved — the request went through."
              : "That approval was already decided — nothing changed."
            : applied
              ? "Rejected."
              : "That approval was already decided — nothing changed.",
        links: link ? { approval: link } : {},
      };
    } catch (err) {
      // Mirror steward-inbox-decisions: a refusal from the authority service
      // can mean "already decided" as easily as "not yours" — re-read and say
      // which, rather than claiming they lack permission for something they
      // may have just decided themselves.
      const status = (err as { status?: number }).status;
      logger.info({ err, approvalId: payload.approvalId }, "assistant confirm decision refused");
      const current = await approvalsSvc.getById(payload.approvalId).catch(() => null);
      const settled = current && !DECIDABLE_STATUSES.has(current.status);
      // requestRevision's 422 is the same race as the revision conflict —
      // the approval left `pending` between our checks and the write.
      const moved = status === 422 || status === 409;
      return {
        ok: false,
        code: settled ? "approval_already_decided" : moved ? "approval_revision_conflict" : "not_authorized",
        reason: settled
          ? `That request was already ${current!.status} — nothing more to do.`
          : moved
            ? "That request changed since you were read the summary — ask me to look again."
            : "You are not the person who can decide this one — nothing was decided.",
        status: settled || moved ? 409 : 403,
      };
    }
  }

  async function confirmHire(
    companyId: string,
    actor: AssistantGatedActor,
    record: HandleRow,
    personSaid: string | null,
    decisionsNeedTap: boolean,
  ): ReturnType<typeof confirm> {
    const payload = record.payload as unknown as HireHandlePayload;

    if (decisionsNeedTap) {
      const link = absoluteUrl("/agents/new");
      await auditConfirmed({
        companyId,
        actor,
        record,
        personSaid,
        details: { hireName: payload.name, tapReturned: true },
      });
      return {
        ok: true,
        kind: "hire_request",
        tapReturned: true,
        outcome:
          "This connection is set to keep decisions on the page — no hire was filed. " +
          (link ? "Open the new-agent page to hire them yourself." : "Open AgentDash to hire them yourself."),
        links: link ? { newAgent: link } : {},
      };
    }

    if (!(await canHire(companyId, actor))) {
      return {
        ok: false,
        code: "not_authorized",
        reason: "You do not have permission to hire agents in this company — nothing was filed.",
        status: 403,
      };
    }

    const company = await db
      .select({ requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    const requiresApproval = company?.requireBoardApprovalForNewAgents === true;

    const created = await (async () => {
      const create = (txDb: Db) =>
        agentService(txDb).create(companyId, {
          name: payload.name,
          role: payload.role,
          title: payload.title,
          capabilities: payload.reason,
          adapterType: payload.adapterType,
          adapterConfig: {},
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          status: requiresApproval ? "pending_approval" : "idle",
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
          autonomy: "stewarded",
          accountableUserId: null,
          metadata: {
            source: "assistant_hire_request",
            reason: payload.reason,
            projectId: payload.projectId,
          },
          createdByUserId: actor.userId,
        });
      if (isBillingDisabled()) return create(db);
      return withCompanyTierCapacityLock(db, companyId, async (txDb) => {
        const blocked = await exceededFreeTierCapacityAction(
          buildRequireTierDeps(txDb),
          companyId,
          { agents: 1 },
        );
        if (blocked) return { blocked };
        return create(txDb);
      });
    })();

    if ("blocked" in (created as { blocked?: unknown })) {
      const cap = freeTierCapExceededPayload((created as { blocked: "invite" | "hire" }).blocked);
      return { ok: false, code: cap.code, reason: `${cap.message} No hire was filed.`, status: 402 };
    }
    const agent = created as NonNullable<Awaited<ReturnType<typeof agentsSvc.getById>>>;

    // Same onboarding the person-facing hire path gives a new agent: the
    // managed AGENTS.md bundle for adapters that read one.
    let configuredAgent = agent;
    if (adapterSupportsInstructionsBundle(agent.adapterType)) {
      try {
        const files = await loadDefaultAgentInstructionsBundle(
          resolveDefaultAgentInstructionsBundleRole(agent.role),
        );
        const materialized = await instructions.materializeManagedBundle(agent, files, {
          entryFile: "AGENTS.md",
          replaceExisting: false,
        });
        configuredAgent =
          (await agentsSvc.update(agent.id, { adapterConfig: materialized.adapterConfig })) ?? agent;
      } catch (err) {
        // A bundle that fails to write must not sink the hire — the agent is
        // created and the file can be written from the board.
        logger.warn({ err, agentId: agent.id }, "assistant hire: instructions bundle not materialized");
      }
    }

    let approval: ApprovalRow | null = null;
    if (requiresApproval) {
      approval = await approvalsSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: actor.userId,
        status: "pending",
        payload: {
          name: configuredAgent.name,
          role: configuredAgent.role,
          title: payload.title,
          capabilities: payload.reason,
          adapterType: payload.adapterType,
          adapterConfig: {},
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          desiredSkills: [],
          metadata: {
            source: "assistant_hire_request",
            reason: payload.reason,
            projectId: payload.projectId,
          },
          agentId: configuredAgent.id,
          requestedByAgentId: null,
          requestedConfigurationSnapshot: {
            adapterType: payload.adapterType,
            adapterConfig: {},
            runtimeConfig: {},
            desiredSkills: [],
          },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
    }

    await access.ensureMembership(companyId, "agent", configuredAgent.id, "member", "active");
    await access.setPrincipalPermission(
      companyId,
      "agent",
      configuredAgent.id,
      "tasks:assign",
      true,
      actor.userId,
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId,
      action: "agent.hire_created",
      entityType: "agent",
      entityId: configuredAgent.id,
      details: {
        name: configuredAgent.name,
        role: configuredAgent.role,
        requiresApproval,
        approvalId: approval?.id ?? null,
        via: `assistant_grant ${actor.clientName}`,
      },
    }).catch((err) => logger.warn({ err }, "assistant hire activity not recorded"));
    if (approval) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedAgentId: configuredAgent.id },
      }).catch((err) => logger.warn({ err }, "assistant hire approval activity not recorded"));
    }
    await auditConfirmed({
      companyId,
      actor,
      record,
      personSaid,
      details: {
        hireName: configuredAgent.name,
        agentId: configuredAgent.id,
        approvalId: approval?.id ?? null,
        requiresApproval,
      },
    });

    const agentLink = absoluteUrl(`/agents/${configuredAgent.id}`);
    const approvalLink = approval ? approvalUrl(approval.id) : undefined;
    return {
      ok: true,
      kind: "hire_request",
      agentId: configuredAgent.id,
      ...(approval ? { approvalId: approval.id } : {}),
      outcome: requiresApproval
        ? `Filed a hire request for ${configuredAgent.name} — it is on the board waiting for approval, and they cannot run until someone approves it.`
        : `Hired ${configuredAgent.name} — they are active and can be assigned work.`,
      links: {
        ...(agentLink ? { agent: agentLink } : {}),
        ...(approvalLink ? { approval: approvalLink } : {}),
      },
    };
  }

  return { prepareDecision, prepareHire, confirm };
}
