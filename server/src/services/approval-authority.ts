import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, companies } from "@paperclipai/db";
import type { ApprovalDecisionChannel } from "@paperclipai/shared";
import { badRequest, conflict, forbidden } from "../errors.js";
import { accessService } from "./access.js";
import { agentGovernanceService } from "./agent-governance.js";
import { agentStewardshipService } from "./agent-stewardships.js";

type ApprovalRow = typeof approvals.$inferSelect;

/**
 * Who decided, recorded on the approval and in the audit trail.
 * - `board`    — legacy default-profile behavior, unchanged.
 * - `steward`  — the current steward of the requesting agent (the ordinary
 *                AgentDash-MK path).
 * - `admin`    — an administrator deciding an approval no agent requested, so
 *                there is no steward to route it to; or one deciding for an
 *                agent whose ceiling sets `minimumApproval: "none"`.
 * - `owner_override` — the explicit, reasoned emergency action.
 */
export type ApprovalDecisionRole =
  | "board"
  | "steward"
  | "admin"
  /**
   * AgentDash-MK: one of a deliverable's two named approvers.
   *
   * A separate role because the ordinary rule — the steward of the requesting
   * agent decides — is the wrong rule here. A deliverable names its approvers
   * at definition time, and the agent that assembled it has a steward who is
   * very often neither of them.
   */
  | "approver"
  | "owner_override";

export interface ApprovalDecisionContext {
  role: ApprovalDecisionRole;
  channel: ApprovalDecisionChannel;
  revision: number;
  idempotencyKey: string | null;
}

export interface ApprovalDecisionActor {
  userId?: string | null;
  source?: string | null;
  isInstanceAdmin?: boolean;
}

export interface ApprovalDecisionRequest {
  revision?: number;
  idempotencyKey?: string;
  channel?: ApprovalDecisionChannel;
}

export function approvalAuthorityService(db: Db) {
  const access = accessService(db);
  const stewardships = agentStewardshipService(db);
  const governance = agentGovernanceService(db);

  async function isProfileCompany(companyId: string) {
    const company = await db
      .select({ productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return company?.productProfile === "agentdash_mk";
  }

  async function isAdministrator(companyId: string, actor: ApprovalDecisionActor) {
    if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
    return access.canUser(companyId, actor.userId, "agents:create");
  }

  /**
   * Profile companies must supply the decision metadata; default-profile
   * callers must not be forced to, or every existing client breaks.
   */
  function requireDecisionMetadata(body: ApprovalDecisionRequest) {
    if (typeof body.revision !== "number") {
      throw badRequest("revision is required for AgentDash-MK approval decisions");
    }
    if (!body.idempotencyKey) {
      throw badRequest("idempotencyKey is required for AgentDash-MK approval decisions");
    }
    if (!body.channel) {
      throw badRequest("channel is required for AgentDash-MK approval decisions");
    }
  }

  /** A decision must name the revision it was shown; a stale card fails closed. */
  function assertRevisionMatches(approval: ApprovalRow, revision: number | undefined) {
    if (revision === undefined) return;
    if (approval.revision !== revision) {
      throw conflict("Approval changed since this decision was requested", {
        code: "APPROVAL_REVISION_CONFLICT",
        expectedRevision: revision,
        currentRevision: approval.revision,
      });
    }
  }

  /**
   * Ordinary approve/reject. In `agentdash_mk` this belongs to the current
   * steward of the requesting agent — ordinary company membership, and even
   * ownership, is insufficient. Owners use the separate override action.
   *
   * Every call re-resolves company profile, membership, and active stewardship
   * from current state, so a decision made against a stale binding fails closed.
   */
  /**
   * Actor rules only, without the decision-metadata requirement.
   *
   * Split out so system-adjacent flows that resolve a linked approval as a side
   * effect (budget incident resolution) enforce the SAME actor rules as a
   * direct decision, without having to invent a revision and idempotency key.
   * Returns `null` for default-profile companies, whose existing board
   * behavior is unchanged.
   */
  async function requireDecisionActor(
    approval: ApprovalRow,
    actor: ApprovalDecisionActor,
  ): Promise<ApprovalDecisionRole | null> {
    if (!(await isProfileCompany(approval.companyId))) return null;

    // The local_trusted bootstrap board actor has no userId and no steward, but
    // is the founding operator. Treating it as an administrator keeps the
    // documented local bootstrap flow usable instead of forcing every decision
    // through a written emergency override.
    if (actor.source === "local_implicit") return "admin";

    /**
     * AgentDash-MK deliverable sign-off, checked BEFORE the steward rule.
     *
     * The approval carries a requesting agent — the assembler — so without this
     * branch the steward rule below would hand the decision to whoever stewards
     * the agent that produced the draft. That is the one person who must not
     * decide it. The approver is named on the definition and copied into the
     * payload when the seat opens; only that user may decide, and the second
     * approver may not decide the first seat.
     */
    /**
     * `workflow_recommendation` joins this branch rather than getting its own.
     *
     * It has the same shape: the decider is named on the approval when it is
     * opened, and it is a property of the artifact — the pipeline owner —
     * rather than of anybody's reporting line. Giving it a second branch would
     * be a second place the "who decides" rule lives, and the reason it is the
     * pipeline owner and not the senior seat is precisely the reason it must
     * not drift.
     */
    if (approval.type === "deliverable_review" || approval.type === "workflow_recommendation") {
      const named = (approval.payload as Record<string, unknown> | null)?.approverUserId;
      if (typeof named === "string" && actor.userId && named === actor.userId) {
        return "approver";
      }
      throw forbidden(
        approval.type === "deliverable_review"
          ? "Only the approver named on this stage of the deliverable can decide it; " +
              "an owner or administrator must use the emergency override action"
          : "Only the owner of this pipeline can decide a recommendation about it; " +
              "an owner or administrator must use the emergency override action",
      );
    }

    if (approval.requestedByAgentId) {
      const active = await stewardships.activeByAgent(approval.companyId, approval.requestedByAgentId);
      if (active && actor.userId && active.userId === actor.userId) {
        return "steward";
      }

      // `minimumApproval` is a floor on how much approval authority this
      // agent's actions require. At the default `steward` the rule above is the
      // whole rule. At `none` the owner has said this agent's work does not
      // need steward-level sign-off, so administrators may decide on the
      // ordinary path instead of writing an emergency override for routine work.
      //
      // Deliberately bounded to administrators: it removes a ceremony for
      // people who could already override, and adds no new class of decider.
      // A bystander with no administrative authority is still refused.
      const policy = await governance.resolveAgentPolicy(
        approval.companyId,
        approval.requestedByAgentId,
      );
      if (
        policy?.minimumApproval === "none" &&
        (await isAdministrator(approval.companyId, actor))
      ) {
        return "admin";
      }

      throw forbidden(
        "Only the current steward of the requesting agent can decide this approval; " +
          "an owner or administrator must use the emergency override action",
      );
    }

    // No requesting agent means no steward to route to; administrators decide.
    if (!(await isAdministrator(approval.companyId, actor))) {
      throw forbidden("Only an authorized administrator can decide this approval");
    }
    return "admin";
  }

  async function requireDecisionAuthority(
    approval: ApprovalRow,
    actor: ApprovalDecisionActor,
    body: ApprovalDecisionRequest,
  ): Promise<ApprovalDecisionContext> {
    if (!(await isProfileCompany(approval.companyId))) {
      return {
        role: "board",
        channel: body.channel ?? "web",
        revision: body.revision ?? approval.revision,
        idempotencyKey: body.idempotencyKey ?? null,
      };
    }

    requireDecisionMetadata(body);
    assertRevisionMatches(approval, body.revision);

    const role = (await requireDecisionActor(approval, actor)) ?? "admin";
    return {
      role,
      channel: body.channel!,
      revision: body.revision!,
      idempotencyKey: body.idempotencyKey!,
    };
  }

  /**
   * Emergency override. Distinct from the ordinary path, restricted to
   * owners/administrators, and always carries a reason so the audit trail
   * records why normal steward authority was bypassed.
   */
  async function requireEmergencyOverride(
    approval: ApprovalRow,
    actor: ApprovalDecisionActor,
    body: ApprovalDecisionRequest & { overrideReason?: string },
  ): Promise<ApprovalDecisionContext> {
    if (!(await isAdministrator(approval.companyId, actor))) {
      throw forbidden("Only a company owner or administrator can override an approval decision");
    }
    if (!body.overrideReason || body.overrideReason.trim().length === 0) {
      throw badRequest("An emergency override requires a reason");
    }
    if (await isProfileCompany(approval.companyId)) {
      requireDecisionMetadata(body);
    }
    assertRevisionMatches(approval, body.revision);

    return {
      role: "owner_override",
      channel: body.channel ?? "web",
      revision: body.revision ?? approval.revision,
      idempotencyKey: body.idempotencyKey ?? null,
    };
  }

  return {
    isProfileCompany,
    isAdministrator,
    requireDecisionActor,
    requireDecisionAuthority,
    requireEmergencyOverride,
  };
}
