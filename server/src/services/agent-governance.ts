import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentGovernancePolicies,
  agents,
  approvals,
  companies,
  humanChannelBindings,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  AGENT_POLICY_CEILING_EXCEEDED,
  AGENT_POLICY_REVISION_CONFLICT,
  AgentPolicyCeilingError,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
  assertWithinCeiling,
  collectCeilingViolations,
  computeEffectiveAgentPolicy,
  normalizeAgentGovernancePolicy,
  policyListAllows,
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

/** Does the effective policy still permit this permission key? */
function permissionAllowed(policy: AgentGovernancePolicy, permissionKey: string) {
  return policy.permissions.includes("*") || policy.permissions.includes(permissionKey);
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
    void agent;

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

        // A ceiling is not merely a write gate: standing configuration that now
        // sits above it is brought down in the SAME transaction, otherwise
        // lowering a ceiling would leave the over-ceiling values in force.
        //
        // The current values are re-read under a row lock here rather than
        // reused from before the transaction: a concurrent legitimate budget
        // change between the two would otherwise be clobbered upward, and the
        // audit row would record a stale `previous`.
        const lockedAgent = await tx
          .select({
            budgetMonthlyCents: agents.budgetMonthlyCents,
            permissions: agents.permissions,
          })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
          .for("update")
          .then((rows) => rows[0] ?? null);

        if (lockedAgent) {
          const clamps: Array<{ field: string; previous: unknown; clampedTo: unknown }> = [];

          if (lockedAgent.budgetMonthlyCents > effectivePolicy.monthlyBudgetCents) {
            await tx
              .update(agents)
              .set({ budgetMonthlyCents: effectivePolicy.monthlyBudgetCents, updatedAt: now })
              .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
            clamps.push({
              field: "budgetMonthlyCents",
              previous: lockedAgent.budgetMonthlyCents,
              clampedTo: effectivePolicy.monthlyBudgetCents,
            });
          }

          // Permissions are the security-relevant dimension: a ceiling that no
          // longer allows a permission must actually revoke it.
          //
          // The GRANT ROW is the source of truth, not the `permissions` column.
          // `normalizeAgentPermissions` keeps only `canCreateAgents` in that
          // column, so keying off it would make `tasks:assign` unrevokable —
          // yet every agent is issued a real `tasks:assign` grant at creation
          // and `access.hasPermission` reads the grants table.
          const permissions = { ...((lockedAgent.permissions ?? {}) as Record<string, unknown>) };
          const grantRows = await tx
            .select({ permissionKey: principalPermissionGrants.permissionKey })
            .from(principalPermissionGrants)
            .where(
              and(
                eq(principalPermissionGrants.companyId, companyId),
                eq(principalPermissionGrants.principalType, "agent"),
                eq(principalPermissionGrants.principalId, agentId),
              ),
            );
          const heldPermissions = new Set(grantRows.map((row) => row.permissionKey));
          if (permissions.canCreateAgents) heldPermissions.add("agents:create");

          let permissionsChanged = false;
          for (const permissionKey of heldPermissions) {
            if (permissionAllowed(effectivePolicy, permissionKey)) continue;
            await tx
              .delete(principalPermissionGrants)
              .where(
                and(
                  eq(principalPermissionGrants.companyId, companyId),
                  eq(principalPermissionGrants.principalType, "agent"),
                  eq(principalPermissionGrants.principalId, agentId),
                  eq(principalPermissionGrants.permissionKey, permissionKey),
                ),
              );
            if (permissionKey === "agents:create" && permissions.canCreateAgents) {
              permissions.canCreateAgents = false;
              permissionsChanged = true;
            }
            clamps.push({ field: permissionKey, previous: "granted", clampedTo: "revoked" });
          }

          if (permissionsChanged) {
            await tx
              .update(agents)
              .set({ permissions, updatedAt: now })
              .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
          }

          // A ceiling that only gates NEW channel bindings is not a ceiling.
          // The standing binding is the delivery path for this agent's approval
          // cards, so leaving it active would keep routing decisions over the
          // very channel the owner just disallowed.
          //
          // Same transaction as the ceiling write: a revocation that could
          // survive a rollback of the narrowing, or vice versa, would leave the
          // policy and the channels disagreeing about what is permitted.
          const activeBindings = await tx
            .select({
              id: humanChannelBindings.id,
              provider: humanChannelBindings.provider,
            })
            .from(humanChannelBindings)
            .where(
              and(
                eq(humanChannelBindings.companyId, companyId),
                eq(humanChannelBindings.agentId, agentId),
                isNull(humanChannelBindings.revokedAt),
              ),
            );

          for (const binding of activeBindings) {
            if (policyListAllows(effectivePolicy.providers, binding.provider)) continue;
            await tx
              .update(humanChannelBindings)
              .set({
                revokedAt: now,
                revokedByUserId: input.actorUserId ?? null,
                updatedAt: now,
              })
              .where(eq(humanChannelBindings.id, binding.id));
            clamps.push({
              field: `channel:${binding.provider}`,
              previous: "bound",
              clampedTo: "revoked",
            });
          }

          // A pending connector_send is an act waiting for a human. Leaving it
          // decidable after the owner disallowed its provider would let the
          // ceiling be defeated by approving something filed before it
          // narrowed — the execution path re-checks, but a steward would be
          // shown a card for work that can no longer happen.
          //
          // Only PENDING rows. Cancelling a decided approval would rewrite
          // history; the execution record is where "was it honoured" lives.
          const pendingSends = await tx
            .select({ id: approvals.id, payload: approvals.payload })
            .from(approvals)
            .where(
              and(
                eq(approvals.companyId, companyId),
                eq(approvals.requestedByAgentId, agentId),
                eq(approvals.type, "connector_send"),
                inArray(approvals.status, ["pending", "revision_requested"]),
              ),
            );

          for (const pending of pendingSends) {
            const provider = String(
              (pending.payload as Record<string, unknown> | null)?.provider ?? "",
            );
            if (provider && policyListAllows(effectivePolicy.providers, provider)) continue;
            await tx
              .update(approvals)
              .set({ status: "cancelled", updatedAt: now })
              .where(eq(approvals.id, pending.id));
            clamps.push({
              field: `connector_send:${provider || "unknown"}`,
              previous: "pending",
              clampedTo: "cancelled",
            });
          }

          for (const clamp of clamps) {
            await logActivity(tx as unknown as Db, {
              companyId,
              actorType: "user",
              actorId: input.actorUserId ?? "board",
              action: "agent.governance_configuration_clamped",
              entityType: "agent",
              entityId: agentId,
              agentId,
              details: { reason: "ceiling_lowered", ...clamp, revision: updated.revision },
            });
          }
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
   * AgentDash-MK: the harness write path — NARROWING ONLY.
   *
   * The web steward-request path rejects an over-ceiling request with 422,
   * which is right for a human at a form: they can see the ceiling and fix the
   * value. It is wrong for a harness. A rejected push leaves the agent running
   * on the PREVIOUS, broader request, so an error here would make "the laptop
   * asked for too much" fail toward *less* constraint. A compromised or merely
   * out-of-date harness must only ever be able to make its agent more
   * constrained than the org authorized.
   *
   * So the request is clamped to the ceiling instead. `computeEffectiveAgentPolicy`
   * IS the clamp — it is the same intersection the effective policy already
   * uses, so a clamped request is by construction within the ceiling and the
   * assertion in `applyUpdate` cannot fire.
   *
   * This adds no term to the policy model. The harness is the steward's
   * instrument writing the steward's side; `effective = owner ceiling ∩ steward
   * request` is unchanged.
   *
   * The clamp list is returned rather than swallowed: silently accepting a push
   * that did not take effect is how a human ends up debugging "why can't my
   * agent do X" with no signal at all.
   */
  async function pushHarnessStewardRequest(
    companyId: string,
    agentId: string,
    input: {
      policy: AgentGovernancePolicy;
      /** Optional — the harness rarely holds one. Defaults to the current row. */
      revision?: number;
      actorUserId: string | null;
    },
  ): Promise<{ policy: AgentGovernancePolicyRow; clamped: AgentPolicyViolation[] }> {
    const current = await materialize(companyId, agentId);
    const ceiling = current.ownerCeiling as AgentGovernancePolicy;
    const requested = normalizeAgentGovernancePolicy(input.policy);

    // Recorded before clamping — after clamping there is nothing left to see.
    const clamped = collectCeilingViolations(ceiling, requested);
    const narrowed = computeEffectiveAgentPolicy(ceiling, requested);

    const policy = await applyUpdate(companyId, agentId, "steward_request", {
      policy: narrowed,
      revision: input.revision ?? current.revision,
      actorUserId: input.actorUserId,
      channel: "system",
    });

    for (const violation of clamped) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: input.actorUserId ?? "board",
        action: "agent.governance_harness_request_clamped",
        entityType: "agent_governance_policy",
        entityId: policy.id,
        agentId,
        details: {
          reason: "narrowing_only",
          field: violation.field,
          requested: violation.requested,
          allowed: violation.allowed,
          direction: violation.direction,
          revision: policy.revision,
        },
      });
    }

    return { policy, clamped };
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
    context: {
      actorUserId?: string | null;
      channel?: AgentGovernanceChannel;
      target?: AgentGovernanceTarget;
    } = {},
  ): Promise<void> {
    if (!(await isProfileCompany(companyId))) return;
    const record = await getForAgent(companyId, agentId);
    // The EFFECTIVE policy is the agent's actual authority (ceiling ∩ request),
    // and it is what the ceiling-lowering clamp reconciles against. Validating
    // against the raw ceiling instead would let a steward who narrowed their own
    // request immediately widen back past it, making the clamp non-durable.
    const bound = record.effectivePolicy as AgentGovernancePolicy;
    const candidate = normalizeAgentGovernancePolicy({
      ...(record.effectivePolicy as AgentGovernancePolicy),
      ...partial,
    });
    try {
      assertWithinCeiling(bound, candidate);
    } catch (error) {
      if (error instanceof AgentPolicyCeilingError) {
        await auditRejected({
          companyId,
          agentId,
          actorUserId: context.actorUserId ?? null,
          channel: context.channel ?? "web",
          target: context.target ?? "steward_request",
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
    actor: { type?: string; userId?: string | null; source?: string | null; isInstanceAdmin?: boolean },
  ): Promise<AgentConfigurationAuthority | null> {
    // Board principals only. Agent-authenticated callers have their own
    // authority rules; the guard lives here so no caller can forget it.
    if (actor.type && actor.type !== "board") return null;
    if (actor.source === "local_implicit" || actor.isInstanceAdmin) return "admin";
    if (await access.canUser(companyId, actor.userId, "agents:create")) return "admin";
    if (!actor.userId) return null;
    if (!(await isProfileCompany(companyId))) return null;
    const active = await stewardships.activeByAgent(companyId, agentId);
    if (active && active.userId === actor.userId) return "steward";
    // A4 (2026-08-16): whoever created an agent owns it. Deliberately the
    // STEWARD tier, not admin — the field allowlist and the no-self-promotion
    // rules exist to stop privilege escalation through one's own agent, and
    // that reasoning applies to creators exactly as it does to stewards.
    const created = await db
      .select({ createdByUserId: agents.createdByUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return created?.createdByUserId === actor.userId ? "steward" : null;
  }

  /**
   * The agent's effective policy for runtime enforcement, or `null` when this
   * company is not on the profile.
   *
   * Enforcement points call this instead of `getForAgent` so the "not on the
   * profile" case is one falsy check rather than a policy object each caller
   * must remember to ignore. Returning the unrestricted default here would be
   * subtly wrong: it reads as "enforce, but permit everything", which hides the
   * fact that the whole mechanism is off.
   */
  async function resolveAgentPolicy(
    companyId: string,
    agentId: string,
  ): Promise<AgentGovernancePolicy | null> {
    if (!(await isProfileCompany(companyId))) return null;
    const record = await getForAgent(companyId, agentId);
    return record.effectivePolicy as AgentGovernancePolicy;
  }

  return {
    isProfileCompany,
    getForAgent,
    resolveAgentPolicy,
    materialize,
    updateOwnerCeiling,
    updateStewardRequest,
    pushHarnessStewardRequest,
    assertAgentMutationWithinCeiling,
    resolveConfigurationAuthority,
  };
}
