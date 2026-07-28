import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, companies } from "@paperclipai/db";
import type { ApprovalDecisionChannel } from "@paperclipai/shared";
import { badRequest, conflict, forbidden } from "../errors.js";
import { accessService } from "./access.js";
import { agentStewardshipService } from "./agent-stewardships.js";

type ApprovalRow = typeof approvals.$inferSelect;

/**
 * Who decided, recorded on the approval and in the audit trail.
 * - `board`    — legacy default-profile behavior, unchanged.
 * - `steward`  — the current steward of the requesting agent (the ordinary
 *                AgentDash-MK path).
 * - `admin`    — an administrator deciding an approval no agent requested, so
 *                there is no steward to route it to.
 * - `owner_override` — the explicit, reasoned emergency action.
 */
export type ApprovalDecisionRole = "board" | "steward" | "admin" | "owner_override";

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

    if (approval.requestedByAgentId) {
      const active = await stewardships.activeByAgent(approval.companyId, approval.requestedByAgentId);
      if (!active || !actor.userId || active.userId !== actor.userId) {
        throw forbidden(
          "Only the current steward of the requesting agent can decide this approval; " +
            "an owner or administrator must use the emergency override action",
        );
      }
      return {
        role: "steward",
        channel: body.channel!,
        revision: body.revision!,
        idempotencyKey: body.idempotencyKey!,
      };
    }

    // No requesting agent means no steward to route to; administrators decide.
    if (!(await isAdministrator(approval.companyId, actor))) {
      throw forbidden("Only an authorized administrator can decide this approval");
    }
    return {
      role: "admin",
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
    requireDecisionAuthority,
    requireEmergencyOverride,
  };
}
