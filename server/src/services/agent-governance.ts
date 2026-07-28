import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentGovernancePolicies, agents, companies } from "@paperclipai/db";
import {
  AGENT_POLICY_CEILING_EXCEEDED,
  AGENT_POLICY_REVISION_CONFLICT,
  AgentPolicyCeilingError,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
  assertWithinCeiling,
  computeEffectiveAgentPolicy,
  normalizeAgentGovernancePolicy,
  type AgentGovernanceChannel,
  type AgentGovernancePolicy,
  type AgentGovernanceTarget,
  type AgentPolicyViolation,
} from "@paperclipai/shared";
import { HttpError, notFound } from "../errors.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { logActivity } from "./activity-log.js";

type AgentGovernancePolicyRow = typeof agentGovernancePolicies.$inferSelect;

export interface UpdateAgentGovernanceInput {
  policy: AgentGovernancePolicy;
  revision: number;
  actorUserId: string | null;
  channel?: AgentGovernanceChannel;
}

/** Internal sentinel so a revision conflict can roll the write back and still be audited after. */
class RevisionConflict extends Error {
  constructor() {
    super("revision conflict");
    this.name = "RevisionConflict";
  }
}

function ceilingExceeded(violations: AgentPolicyViolation[]) {
  return new HttpError(
    422,
    "Requested agent configuration exceeds the owner ceiling",
    { code: AGENT_POLICY_CEILING_EXCEEDED, violations },
    AGENT_POLICY_CEILING_EXCEEDED,
  );
}

function revisionConflict(expected: number, actual: number) {
  return new HttpError(
    409,
    "Agent governance policy changed; reload and retry",
    { code: AGENT_POLICY_REVISION_CONFLICT, expectedRevision: expected, currentRevision: actual },
    AGENT_POLICY_REVISION_CONFLICT,
  );
}

export function agentGovernanceService(db: Db) {
  async function isProfileCompany(companyId: string) {
    const company = await db
      .select({ productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return company?.productProfile === "agentdash_mk";
  }

  async function requireCompanyAgent(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function readRow(companyId: string, agentId: string) {
    return db
      .select()
      .from(agentGovernancePolicies)
      .where(
        and(
          eq(agentGovernancePolicies.companyId, companyId),
          eq(agentGovernancePolicies.agentId, agentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Read the agent's governance row, materializing the unrestricted default on
   * first touch. Concurrent first touches are resolved by the
   * (company_id, agent_id) unique index rather than by locking.
   */
  async function getForAgent(companyId: string, agentId: string): Promise<AgentGovernancePolicyRow> {
    const existing = await readRow(companyId, agentId);
    if (existing) return existing;

    await requireCompanyAgent(companyId, agentId);

    try {
      const inserted = await db
        .insert(agentGovernancePolicies)
        .values({
          companyId,
          agentId,
          ownerCeiling: DEFAULT_AGENT_GOVERNANCE_POLICY,
          stewardRequest: DEFAULT_AGENT_GOVERNANCE_POLICY,
          effectivePolicy: DEFAULT_AGENT_GOVERNANCE_POLICY,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      if (inserted) return inserted;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const raced = await readRow(companyId, agentId);
    if (!raced) throw notFound("Agent governance policy not found");
    return raced;
  }

  /**
   * Rejected attempts are audited on the base connection, never inside the
   * transaction that is about to roll back — a rollback would take the audit
   * row with it and the rejection would leave no trace.
   */
  async function auditRejected(input: {
    companyId: string;
    agentId: string;
    actorUserId: string | null;
    channel: AgentGovernanceChannel;
    target: AgentGovernanceTarget;
    code: string;
    fromRevision: number;
    requestedRevision: number;
    violations?: AgentPolicyViolation[];
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actorUserId ?? "board",
      action: "agent.governance_change_rejected",
      entityType: "agent_governance_policy",
      entityId: input.agentId,
      agentId: input.agentId,
      details: {
        result: "rejected",
        code: input.code,
        target: input.target,
        channel: input.channel,
        fromRevision: input.fromRevision,
        requestedRevision: input.requestedRevision,
        violations: input.violations ?? [],
      },
    });
  }

  async function applyUpdate(
    companyId: string,
    agentId: string,
    target: AgentGovernanceTarget,
    input: UpdateAgentGovernanceInput,
  ): Promise<AgentGovernancePolicyRow> {
    const channel: AgentGovernanceChannel = input.channel ?? "web";
    await requireCompanyAgent(companyId, agentId);
    const current = await getForAgent(companyId, agentId);
    const requested = normalizeAgentGovernancePolicy(input.policy);

    const nextCeiling = target === "owner_ceiling" ? requested : (current.ownerCeiling as AgentGovernancePolicy);
    const nextRequest = target === "steward_request" ? requested : (current.stewardRequest as AgentGovernancePolicy);

    // Owners may always tighten: a lowered ceiling clamps an over-broad standing
    // steward request rather than failing. A steward request, by contrast, must
    // fit inside the current ceiling.
    if (target === "steward_request") {
      try {
        assertWithinCeiling(nextCeiling, nextRequest);
      } catch (error) {
        if (error instanceof AgentPolicyCeilingError) {
          await auditRejected({
            companyId,
            agentId,
            actorUserId: input.actorUserId,
            channel,
            target,
            code: error.code,
            fromRevision: current.revision,
            requestedRevision: input.revision,
            violations: error.violations,
          });
          throw ceilingExceeded(error.violations);
        }
        throw error;
      }
    }

    const effectivePolicy = computeEffectiveAgentPolicy(nextCeiling, nextRequest);
    const nextRevision = current.revision + 1;
    const now = new Date();

    try {
      return await db.transaction(async (tx) => {
        const updated = await tx
          .update(agentGovernancePolicies)
          .set({
            ownerCeiling: nextCeiling,
            stewardRequest: nextRequest,
            effectivePolicy,
            revision: nextRevision,
            updatedAt: now,
            ...(target === "owner_ceiling"
              ? {
                  ownerCeilingRevision: current.ownerCeilingRevision + 1,
                  ownerCeilingUpdatedByUserId: input.actorUserId,
                }
              : {
                  stewardRequestRevision: current.stewardRequestRevision + 1,
                  stewardRequestUpdatedByUserId: input.actorUserId,
                }),
          })
          .where(
            and(
              eq(agentGovernancePolicies.id, current.id),
              eq(agentGovernancePolicies.companyId, companyId),
              eq(agentGovernancePolicies.revision, input.revision),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);

        if (!updated) throw new RevisionConflict();

        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "user",
          actorId: input.actorUserId ?? "board",
          action:
            target === "owner_ceiling"
              ? "agent.governance_ceiling_updated"
              : "agent.governance_request_updated",
          entityType: "agent_governance_policy",
          entityId: updated.id,
          agentId,
          details: {
            result: "accepted",
            target,
            channel,
            fromRevision: input.revision,
            toRevision: updated.revision,
            effectivePolicy,
          },
        });

        return updated;
      });
    } catch (error) {
      if (error instanceof RevisionConflict) {
        const latest = await readRow(companyId, agentId);
        await auditRejected({
          companyId,
          agentId,
          actorUserId: input.actorUserId,
          channel,
          target,
          code: AGENT_POLICY_REVISION_CONFLICT,
          fromRevision: latest?.revision ?? current.revision,
          requestedRevision: input.revision,
        });
        throw revisionConflict(input.revision, latest?.revision ?? current.revision);
      }
      throw error;
    }
  }

  async function updateOwnerCeiling(companyId: string, agentId: string, input: UpdateAgentGovernanceInput) {
    return applyUpdate(companyId, agentId, "owner_ceiling", input);
  }

  async function updateStewardRequest(companyId: string, agentId: string, input: UpdateAgentGovernanceInput) {
    return applyUpdate(companyId, agentId, "steward_request", input);
  }

  /**
   * Service-boundary enforcement for the pre-existing agent configuration
   * mutations (budget, permissions, providers, ...). No-op outside
   * `agentdash_mk` so default-profile behavior is untouched.
   */
  async function assertAgentMutationWithinCeiling(
    companyId: string,
    agentId: string,
    partial: Partial<AgentGovernancePolicy>,
  ): Promise<void> {
    if (!(await isProfileCompany(companyId))) return;
    const record = await getForAgent(companyId, agentId);
    const ceiling = record.ownerCeiling as AgentGovernancePolicy;
    const candidate = normalizeAgentGovernancePolicy({
      ...(record.effectivePolicy as AgentGovernancePolicy),
      ...partial,
    });
    try {
      assertWithinCeiling(ceiling, candidate);
    } catch (error) {
      if (error instanceof AgentPolicyCeilingError) throw ceilingExceeded(error.violations);
      throw error;
    }
  }

  return {
    isProfileCompany,
    getForAgent,
    updateOwnerCeiling,
    updateStewardRequest,
    assertAgentMutationWithinCeiling,
  };
}
