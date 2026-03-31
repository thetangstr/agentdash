import { and, asc, desc, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  securityPolicies,
  policyEvaluations,
  agentSandboxes,
  killSwitchEvents,
  agents,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

export function policyEngineService(db: Db) {
  // ---------------------------------------------------------------------------
  // Policy CRUD
  // ---------------------------------------------------------------------------

  async function createPolicy(
    companyId: string,
    data: {
      name: string;
      description?: string | null;
      policyType: string;
      targetType: string;
      targetId?: string | null;
      rules: Array<Record<string, unknown>>;
      effect?: string;
      priority?: number;
      createdByUserId?: string | null;
    },
  ) {
    const now = new Date();
    const [policy] = await db
      .insert(securityPolicies)
      .values({
        companyId,
        name: data.name,
        description: data.description ?? null,
        policyType: data.policyType,
        targetType: data.targetType,
        targetId: data.targetId ?? null,
        rules: data.rules,
        effect: data.effect ?? "deny",
        priority: data.priority ?? 100,
        createdByUserId: data.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return policy;
  }

  async function updatePolicy(
    id: string,
    data: Partial<{
      name: string;
      description: string | null;
      policyType: string;
      targetType: string;
      targetId: string | null;
      rules: Array<Record<string, unknown>>;
      effect: string;
      priority: number;
      isActive: boolean;
      updatedByUserId: string | null;
    }>,
  ) {
    const now = new Date();
    const updated = await db
      .update(securityPolicies)
      .set({ ...data, updatedAt: now })
      .where(eq(securityPolicies.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("Policy not found");
    return updated;
  }

  async function deactivatePolicy(id: string) {
    const now = new Date();
    const updated = await db
      .update(securityPolicies)
      .set({ isActive: false, updatedAt: now })
      .where(eq(securityPolicies.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("Policy not found");
    return updated;
  }

  async function listPolicies(
    companyId: string,
    opts?: { policyType?: string; isActive?: boolean },
  ) {
    const isActive = opts?.isActive ?? true;
    const conditions = [
      eq(securityPolicies.companyId, companyId),
      eq(securityPolicies.isActive, isActive),
    ];
    if (opts?.policyType) {
      conditions.push(eq(securityPolicies.policyType, opts.policyType));
    }
    return db
      .select()
      .from(securityPolicies)
      .where(and(...conditions));
  }

  async function getPolicyById(id: string) {
    const policy = await db
      .select()
      .from(securityPolicies)
      .where(eq(securityPolicies.id, id))
      .then((rows) => rows[0] ?? null);
    if (!policy) throw notFound("Policy not found");
    return policy;
  }

  // ---------------------------------------------------------------------------
  // Policy Evaluation
  // ---------------------------------------------------------------------------

  async function evaluateAction(
    companyId: string,
    agentId: string,
    action: string,
    resource: string | null,
    runContext?: { runId?: string; context?: Record<string, unknown> },
  ) {
    // Load the agent to determine its role
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent) throw unprocessable("Agent not found");

    // Build target-matching conditions
    const targetConditions = [
      eq(securityPolicies.targetType, "company"),
      and(
        eq(securityPolicies.targetType, "agent"),
        eq(securityPolicies.targetId, agentId),
      ),
    ];
    if (agent.role) {
      targetConditions.push(
        and(
          eq(securityPolicies.targetType, "role"),
          eq(securityPolicies.targetId, agent.role),
        ),
      );
    }

    // Load all active policies that match the company and target
    const policies = await db
      .select()
      .from(securityPolicies)
      .where(
        and(
          eq(securityPolicies.companyId, companyId),
          eq(securityPolicies.isActive, true),
          or(...targetConditions),
        ),
      )
      .orderBy(asc(securityPolicies.priority));

    // First-match evaluation
    let decision: "allowed" | "denied" = "allowed";
    let denialReason: string | undefined;
    const matchedPolicyIds: string[] = [];

    for (const policy of policies) {
      const rules = policy.rules as Array<Record<string, unknown>>;
      const ruleMatch = rules.some((rule) => rule.action === action);
      if (ruleMatch) {
        matchedPolicyIds.push(policy.id);
        if (policy.effect === "deny") {
          decision = "denied";
          denialReason = `Denied by policy: ${policy.name}`;
        } else {
          decision = "allowed";
        }
        break;
      }
    }

    // Record the evaluation
    await db.insert(policyEvaluations).values({
      companyId,
      agentId,
      runId: runContext?.runId ?? null,
      action,
      resource,
      matchedPolicyIds,
      decision,
      denialReason: denialReason ?? null,
      context: runContext?.context ?? null,
      evaluatedAt: new Date(),
    });

    return { decision, matchedPolicyIds, denialReason };
  }

  // ---------------------------------------------------------------------------
  // Sandbox Config
  // ---------------------------------------------------------------------------

  async function configureSandbox(
    companyId: string,
    agentId: string,
    config: {
      isolationLevel?: string;
      networkPolicy?: Record<string, unknown>;
      filesystemPolicy?: Record<string, unknown>;
      resourceLimits?: Record<string, unknown>;
      environmentVars?: Record<string, unknown>;
      secretAccess?: string[];
    },
  ) {
    const now = new Date();
    const insertValues: typeof agentSandboxes.$inferInsert = {
      companyId,
      agentId,
      ...(config.isolationLevel !== undefined && { isolationLevel: config.isolationLevel }),
      ...(config.networkPolicy !== undefined && { networkPolicy: config.networkPolicy }),
      ...(config.filesystemPolicy !== undefined && { filesystemPolicy: config.filesystemPolicy }),
      ...(config.resourceLimits !== undefined && { resourceLimits: config.resourceLimits }),
      ...(config.environmentVars !== undefined && { environmentVars: config.environmentVars }),
      ...(config.secretAccess !== undefined && { secretAccess: config.secretAccess }),
      createdAt: now,
      updatedAt: now,
    };

    const updateSet: Record<string, unknown> = { updatedAt: now };
    if (config.isolationLevel !== undefined) updateSet.isolationLevel = config.isolationLevel;
    if (config.networkPolicy !== undefined) updateSet.networkPolicy = config.networkPolicy;
    if (config.filesystemPolicy !== undefined) updateSet.filesystemPolicy = config.filesystemPolicy;
    if (config.resourceLimits !== undefined) updateSet.resourceLimits = config.resourceLimits;
    if (config.environmentVars !== undefined) updateSet.environmentVars = config.environmentVars;
    if (config.secretAccess !== undefined) updateSet.secretAccess = config.secretAccess;

    const [sandbox] = await db
      .insert(agentSandboxes)
      .values(insertValues)
      .onConflictDoUpdate({
        target: [agentSandboxes.companyId, agentSandboxes.agentId],
        set: updateSet,
      })
      .returning();

    return sandbox;
  }

  async function getSandbox(companyId: string, agentId: string) {
    return db
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.companyId, companyId),
          eq(agentSandboxes.agentId, agentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  // ---------------------------------------------------------------------------
  // Kill Switch
  // ---------------------------------------------------------------------------

  async function activateKillSwitch(
    companyId: string,
    scope: string,
    scopeId: string,
    userId: string,
    reason?: string | null,
  ) {
    const now = new Date();

    const [event] = await db
      .insert(killSwitchEvents)
      .values({
        companyId,
        scope,
        scopeId,
        action: "halt",
        reason: reason ?? null,
        triggeredByUserId: userId,
        triggeredAt: now,
      })
      .returning();

    if (scope === "company") {
      await db
        .update(agents)
        .set({ status: "paused", pauseReason: "kill_switch" })
        .where(eq(agents.companyId, companyId));
    } else if (scope === "agent") {
      await db
        .update(agents)
        .set({ status: "paused", pauseReason: "kill_switch" })
        .where(eq(agents.id, scopeId));
    }

    return event;
  }

  async function resumeFromKillSwitch(
    companyId: string,
    scope: string,
    scopeId: string,
    userId: string,
  ) {
    const now = new Date();

    const [event] = await db
      .insert(killSwitchEvents)
      .values({
        companyId,
        scope,
        scopeId,
        action: "resume",
        triggeredByUserId: userId,
        triggeredAt: now,
      })
      .returning();

    if (scope === "company") {
      await db
        .update(agents)
        .set({ status: "idle", pauseReason: null })
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.status, "paused"),
            eq(agents.pauseReason, "kill_switch"),
          ),
        );
    } else if (scope === "agent") {
      await db
        .update(agents)
        .set({ status: "idle", pauseReason: null })
        .where(
          and(
            eq(agents.id, scopeId),
            eq(agents.status, "paused"),
            eq(agents.pauseReason, "kill_switch"),
          ),
        );
    }

    return event;
  }

  async function getKillSwitchStatus(companyId: string) {
    // Check the latest company-scope event
    const latestCompanyEvent = await db
      .select()
      .from(killSwitchEvents)
      .where(
        and(
          eq(killSwitchEvents.companyId, companyId),
          eq(killSwitchEvents.scope, "company"),
        ),
      )
      .orderBy(desc(killSwitchEvents.triggeredAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const companyHalted = latestCompanyEvent?.action === "halt";

    // Get all agent-scope halt events
    const agentHaltEvents = await db
      .select()
      .from(killSwitchEvents)
      .where(
        and(
          eq(killSwitchEvents.companyId, companyId),
          eq(killSwitchEvents.scope, "agent"),
          eq(killSwitchEvents.action, "halt"),
        ),
      )
      .orderBy(desc(killSwitchEvents.triggeredAt));

    // Get all agent-scope resume events
    const agentResumeEvents = await db
      .select()
      .from(killSwitchEvents)
      .where(
        and(
          eq(killSwitchEvents.companyId, companyId),
          eq(killSwitchEvents.scope, "agent"),
          eq(killSwitchEvents.action, "resume"),
        ),
      )
      .orderBy(desc(killSwitchEvents.triggeredAt));

    // Build a set of resumed scopeIds with their latest resume timestamp
    const resumedMap = new Map<string, Date>();
    for (const re of agentResumeEvents) {
      if (!resumedMap.has(re.scopeId)) {
        resumedMap.set(re.scopeId, re.triggeredAt);
      }
    }

    // An agent is still halted if its latest halt is after the latest resume (or no resume exists)
    const haltedAgentIds: string[] = [];
    const seen = new Set<string>();
    for (const he of agentHaltEvents) {
      if (seen.has(he.scopeId)) continue;
      seen.add(he.scopeId);
      const resumedAt = resumedMap.get(he.scopeId);
      if (!resumedAt || he.triggeredAt > resumedAt) {
        haltedAgentIds.push(he.scopeId);
      }
    }

    return { companyHalted, haltedAgentIds };
  }

  // ---------------------------------------------------------------------------
  // AgentDash: Threshold-Aware Proposal Evaluation
  // ---------------------------------------------------------------------------

  async function evaluateProposal(
    companyId: string,
    agentId: string,
    proposal: {
      actionType: string;
      amountCents?: number;
      resource?: string | null;
      context?: Record<string, unknown>;
    },
  ) {
    // Load the agent to determine its role
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent) throw unprocessable("Agent not found");

    // Build target-matching conditions
    const targetConditions = [
      eq(securityPolicies.targetType, "company"),
      and(
        eq(securityPolicies.targetType, "agent"),
        eq(securityPolicies.targetId, agentId),
      ),
    ];
    if (agent.role) {
      targetConditions.push(
        and(
          eq(securityPolicies.targetType, "role"),
          eq(securityPolicies.targetId, agent.role),
        ),
      );
    }

    // Load all active policies
    const policies = await db
      .select()
      .from(securityPolicies)
      .where(
        and(
          eq(securityPolicies.companyId, companyId),
          eq(securityPolicies.isActive, true),
          or(...targetConditions),
        ),
      )
      .orderBy(asc(securityPolicies.priority));

    let decision: "allowed" | "denied" | "escalated" = "allowed";
    let denialReason: string | undefined;
    let escalationThreshold: number | undefined;
    const matchedPolicyIds: string[] = [];

    for (const policy of policies) {
      const rawRules = policy.rules;
      const rules: Array<Record<string, unknown>> = Array.isArray(rawRules) ? rawRules : [];

      for (const rule of rules) {
        // Check action_limit: amount exceeds threshold → escalate
        if (
          policy.policyType === "action_limit" &&
          (rule.action === proposal.actionType || rule.action === "*")
        ) {
          matchedPolicyIds.push(policy.id);
          const maxAmount = typeof rule.maxAmountCents === "number" ? rule.maxAmountCents : undefined;
          if (maxAmount != null && proposal.amountCents != null && proposal.amountCents > maxAmount) {
            decision = "escalated";
            escalationThreshold = maxAmount;
            denialReason = `Amount ${proposal.amountCents} exceeds threshold ${maxAmount} (policy: ${policy.name})`;
          }
          // Under threshold → stays "allowed"
          break;
        }

        // Check blast_radius policies
        if (policy.policyType === "blast_radius" && rule.action === proposal.actionType) {
          matchedPolicyIds.push(policy.id);
          if (policy.effect === "deny") {
            decision = "escalated";
            denialReason = `Blast radius limit (policy: ${policy.name})`;
          }
          break;
        }

        // Check resource_access (escalation paths)
        if (policy.policyType === "resource_access") {
          const escalateOn = Array.isArray(rule.escalateOn) ? rule.escalateOn : [];
          if (escalateOn.includes(proposal.actionType)) {
            matchedPolicyIds.push(policy.id);
            decision = "escalated";
            denialReason = `Escalation required (policy: ${policy.name})`;
            break;
          }
        }
      }

      if (decision !== "allowed") break;
    }

    // Record the evaluation
    const [evaluation] = await db.insert(policyEvaluations).values({
      companyId,
      agentId,
      runId: null,
      action: proposal.actionType,
      resource: proposal.resource ?? null,
      matchedPolicyIds,
      decision,
      denialReason: denialReason ?? null,
      context: { ...proposal.context, amountCents: proposal.amountCents },
      evaluatedAt: new Date(),
    }).returning();

    return {
      decision,
      matchedPolicyIds,
      denialReason,
      escalationThreshold,
      evaluationId: evaluation?.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Policy Evaluation Listing
  // ---------------------------------------------------------------------------

  async function listPolicyEvaluations(
    companyId: string,
    opts?: { agentId?: string; decision?: string; limit?: number },
  ) {
    const limit = opts?.limit ?? 50;
    const conditions = [eq(policyEvaluations.companyId, companyId)];
    if (opts?.agentId) {
      conditions.push(eq(policyEvaluations.agentId, opts.agentId));
    }
    if (opts?.decision) {
      conditions.push(eq(policyEvaluations.decision, opts.decision));
    }
    return db
      .select()
      .from(policyEvaluations)
      .where(and(...conditions))
      .orderBy(desc(policyEvaluations.evaluatedAt))
      .limit(limit);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    createPolicy,
    updatePolicy,
    deactivatePolicy,
    listPolicies,
    getPolicyById,
    evaluateAction,
    evaluateProposal,
    configureSandbox,
    getSandbox,
    activateKillSwitch,
    resumeFromKillSwitch,
    getKillSwitchStatus,
    listPolicyEvaluations,
  };
}
