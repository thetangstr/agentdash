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
import { accessService } from "./access.js";
import { agentStewardshipService } from "./agent-stewardships.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

type AgentGovernancePolicyRow = typeof agentGovernancePolicies.$inferSelect;

/**
 * A governance policy as seen by callers. `id` is null when the agent has no
 * persisted row yet and the unrestricted default is being reported
 * synthetically — reads must not write.
 */
export type AgentGovernanceView = Omit<AgentGovernancePolicyRow, "id" | "createdAt" | "updatedAt"> & {
  id: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export interface UpdateAgentGovernanceInput {
  policy: AgentGovernancePolicy;
  revision: number;
  actorUserId: string | null;
  channel?: AgentGovernanceChannel;
}

/** Which board principal may configure a given agent. */
export type AgentConfigurationAuthority = "admin" | "steward";

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

  async function requireCompanyAgent(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, budgetMonthlyCents: agents.budgetMonthlyCents })
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

  function syntheticDefault(companyId: string, agentId: string): AgentGovernanceView {
    return {
      id: null,
      companyId,
      agentId,
      ownerCeiling: DEFAULT_AGENT_GOVERNANCE_POLICY,
      ownerCeilingRevision: 1,
      ownerCeilingUpdatedByUserId: null,
      stewardRequest: DEFAULT_AGENT_GOVERNANCE_POLICY,
      stewardRequestRevision: 1,
      stewardRequestUpdatedByUserId: null,
      effectivePolicy: DEFAULT_AGENT_GOVERNANCE_POLICY,
      revision: 1,
      createdAt: null,
      updatedAt: null,
    };
  }

  /**
   * Read-only. Reports the unrestricted default synthetically when no row
   * exists, so a GET never inserts. Materialization happens on first write.
   */
  async function getForAgent(companyId: string, agentId: string): Promise<AgentGovernanceView> {
    const existing = await readRow(companyId, agentId);
    if (existing) return existing;
    await requireCompanyAgent(companyId, agentId);
    return syntheticDefault(companyId, agentId);
  }

  /** Insert-if-absent, used only on the write path. */
  async function materialize(companyId: string, agentId: string): Promise<AgentGovernancePolicyRow> {
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
      // onConflictDoNothing suppresses the unique violation; this only covers a
      // PK collision, which is vanishingly rare but must not be swallowed.
      if (!isUniqueViolation(error)) throw error;
    }

    // Lost the insert race: the winner has committed by the time the
    // speculative-insertion lock releases, so a fresh read sees the row.
    const raced = await readRow(companyId, agentId);
    if (!raced) throw notFound("Agent governance policy not found");
    return raced;
  }

  /**
   * Rejected attempts are audited on the base connection, never inside the
   * transaction that is about to roll back — a rollback would take the audit
   * row with it and the rejection would leave no trace. An audit failure must
   * never convert a clean 422/409 into a 500, so it is logged and swallowed.
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
    try {
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
    } catch (error) {
      logger.warn(
        { err: error, companyId: input.companyId, agentId: input.agentId, code: input.code },
        "failed to audit rejected agent governance change",
      );
    }
  }

  async function applyUpdate(
    companyId: string,
    agentId: string,
    target: AgentGovernanceTarget,
    input: UpdateAgentGovernanceInput,
  ): Promise<AgentGovernancePolicyRow> {
    const channel: AgentGovernanceChannel = input.channel ?? "web";
    const agent = await requireCompanyAgent(companyId, agentId);
    const current = await materialize(companyId, agentId);
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
    // A ceiling is not merely a write gate: if it now sits below what the agent
    // is already configured for, the standing configuration is brought down to
    // it in the same transaction, otherwise lowering a ceiling would leave the
    // over-ceiling budget in force indefinitely.
    const clampedBudgetCents =
      agent.budgetMonthlyCents > effectivePolicy.monthlyBudgetCents
        ? effectivePolicy.monthlyBudgetCents
        : null;

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

        if (clampedBudgetCents !== null) {
          await tx
            .update(agents)
            .set({ budgetMonthlyCents: clampedBudgetCents, updatedAt: now })
            .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));

          await logActivity(tx as unknown as Db, {
            companyId,
            actorType: "user",
            actorId: input.actorUserId ?? "board",
            action: "agent.governance_configuration_clamped",
            entityType: "agent",
            entityId: agentId,
            agentId,
            details: {
              reason: "ceiling_lowered",
              field: "budgetMonthlyCents",
              previous: agent.budgetMonthlyCents,
              clampedTo: clampedBudgetCents,
              revision: updated.revision,
            },
          });
        }

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
          // Both audit shapes report the caller's value in `requestedRevision`
          // and the server's in `fromRevision`, so a log reader never has to
          // know which action produced the row.
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
   * mutations (budget, permissions, ...). No-op outside `agentdash_mk` so
   * default-profile behavior is untouched. Denials are audited: for a
   * governance feature the rejected attempts are the ones that matter.
   */
  async function assertAgentMutationWithinCeiling(
    companyId: string,
    agentId: string,
    partial: Partial<AgentGovernancePolicy>,
    context: { actorUserId?: string | null; channel?: AgentGovernanceChannel } = {},
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
      if (error instanceof AgentPolicyCeilingError) {
        await auditRejected({
          companyId,
          agentId,
          actorUserId: context.actorUserId ?? null,
          channel: context.channel ?? "web",
          target: "steward_request",
          code: error.code,
          fromRevision: record.revision,
          requestedRevision: record.revision,
          violations: error.violations,
        });
        throw ceilingExceeded(error.violations);
      }
      throw error;
    }
  }

  /**
   * Single definition of who may configure one agent, shared by every route
   * that guards agent configuration. Administrators are checked first so the
   * common case costs no extra queries; stewardship is only consulted for
   * non-administrators in profile companies, and is always scoped to the one
   * target agent — it never widens to company-wide agent administration.
   */
  async function resolveConfigurationAuthority(
    companyId: string,
    agentId: string,
    actor: { userId?: string | null; source?: string | null; isInstanceAdmin?: boolean },
  ): Promise<AgentConfigurationAuthority | null> {
    if (actor.source === "local_implicit" || actor.isInstanceAdmin) return "admin";
    if (await access.canUser(companyId, actor.userId, "agents:create")) return "admin";
    if (!actor.userId) return null;
    if (!(await isProfileCompany(companyId))) return null;
    const active = await stewardships.activeByAgent(companyId, agentId);
    return active && active.userId === actor.userId ? "steward" : null;
  }

  return {
    isProfileCompany,
    getForAgent,
    materialize,
    updateOwnerCeiling,
    updateStewardRequest,
    assertAgentMutationWithinCeiling,
    resolveConfigurationAuthority,
  };
}
