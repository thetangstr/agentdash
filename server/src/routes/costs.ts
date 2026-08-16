import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createCostEventSchema,
  createFinanceEventSchema,
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  agentRunService,
  budgetService,
  costService,
  financeService,
  companyService,
  agentService,
  issueService,
  heartbeatService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import { accessService } from "../services/access.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { approvalAuthorityService } from "../services/approval-authority.js";
import { approvalService } from "../services/approvals.js";
import { badRequest, forbidden } from "../errors.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

export function parseCostDateRange(query: Record<string, unknown>) {
  const fromRaw = query.from as string | undefined;
  const toRaw = query.to as string | undefined;
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  if (from && isNaN(from.getTime())) throw badRequest("invalid 'from' date");
  if (to && isNaN(to.getTime())) throw badRequest("invalid 'to' date");
  return (from || to) ? { from, to } : undefined;
}

export function parseCostLimit(query: Record<string, unknown>) {
  const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  if (raw == null || raw === "") return 100;
  const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
    throw badRequest("invalid 'limit' value");
  }
  return limit;
}

export function costRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const budgetHooks = {
    cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
  };
  const costs = costService(db, budgetHooks);
  const finance = financeService(db);
  const budgets = budgetService(db, budgetHooks);
  const companies = companyService(db);
  const agents = agentService(db);
  // AgentDash-MK: agent budgets are a ceiling dimension. These routes are the
  // primary agent-budget write paths, so the ceiling must bind here too —
  // enforcing it only on PATCH /agents/:id would leave it trivially bypassable.
  const governance = agentGovernanceService(db);
  const access = accessService(db);

  /**
   * Who may see what a company spends.
   *
   * Reads were open to any member: `assertCompanyAccess` only asks whether you
   * belong to the company, so every invited teammate could read the whole
   * spend picture. Budgets and money are an owner's business, and a practice
   * inviting three staff should not be publishing its cost base to them as a
   * side effect.
   *
   * "Administrator" here is the same test the rest of this file already uses
   * for budget authority — `agents:create`, plus instance admins, who
   * `canUser` allows unconditionally. Deliberately not a new permission key: a
   * new key defaults to nobody holding it, which would lock the owner out of
   * their own billing on every existing install.
   *
   * Agent keys keep their access. An agent reporting its own run cost is how
   * usage gets recorded at all.
   */
  async function assertSpendVisibility(
    req: Parameters<typeof assertCompanyAccess>[0],
    companyId: string,
  ) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") return;
    if (req.actor.isInstanceAdmin) return;
    // Fail closed: a permission lookup that throws must not surface as a 500.
    const allowed = await access
      .canUser(companyId, req.actor.userId, "agents:create")
      .catch(() => false);
    if (allowed) return;
    throw forbidden(
      "Spend and billing are visible to administrators only. "
      + "Ask an owner for the agents:create permission if you need them.",
    );
  }

  const approvalAuthority = approvalAuthorityService(db);
  const approvalsSvc = approvalService(db);

  /**
   * These routes historically required only company membership. In a profile
   * company an agent's budget is agent configuration, so it needs the same
   * steward-or-admin authority as every other agent-config mutation. No-op
   * outside `agentdash_mk`, leaving default-profile behavior unchanged.
   */
  async function assertAgentBudgetAuthority(
    req: Parameters<typeof assertCompanyAccess>[0],
    companyId: string,
    agentId: string,
  ): Promise<"admin" | "steward" | null> {
    if (!(await governance.isProfileCompany(companyId))) return null;
    const authority = await governance.resolveConfigurationAuthority(companyId, agentId, req.actor);
    if (!authority) {
      throw forbidden(
        "Only the assigned steward or an authorized administrator can change this agent's budget",
      );
    }
    return authority;
  }

  /**
   * A budget ceiling that can be switched off is not a ceiling. Enforcement is
   * `hardStopEnabled && amount > 0` (services/budgets.ts), so a steward who can
   * clear either flag escapes the owner's spend limit while every amount check
   * still passes. Only administrators may weaken those.
   */
  function assertStewardCannotWeakenBudgetPolicy(
    authority: "admin" | "steward" | null,
    body: { hardStopEnabled?: unknown; isActive?: unknown; amount?: unknown },
  ) {
    if (authority !== "steward") return;
    const weakened: string[] = [];
    if (body.hardStopEnabled === false) weakened.push("hardStopEnabled");
    if (body.isActive === false) weakened.push("isActive");
    if (body.amount === 0) weakened.push("amount=0");
    if (weakened.length > 0) {
      throw forbidden(
        `Stewardship does not permit disabling the budget hard stop (${weakened.join(", ")}); ` +
          "an administrator with agents:create must make this change",
      );
    }
  }
  const issues = issueService(db);

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return issues.getByIdentifier(rawId);
    }
    return issues.getById(rawId);
  }

  router.post("/companies/:companyId/cost-events", validate(createCostEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only report its own costs" });
      return;
    }

    const event = await costs.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "cost.reported",
      entityType: "cost_event",
      entityId: event.id,
      details: { costCents: event.costCents, model: event.model },
    });

    res.status(201).json(event);
  });

  router.post("/companies/:companyId/finance-events", validate(createFinanceEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const event = await finance.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "finance_event.reported",
      entityType: "finance_event",
      entityId: event.id,
      details: {
        amountCents: event.amountCents,
        biller: event.biller,
        eventKind: event.eventKind,
        direction: event.direction,
      },
    });

    res.status(201).json(event);
  });

  router.get("/companies/:companyId/costs/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    const summary = await costs.summary(companyId, range);
    res.json(summary);
  });

  // Run counts and wall-clock, which — unlike spend — we actually record.
  router.get("/companies/:companyId/costs/run-activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    res.json(await costs.runActivity(companyId, range));
  });

  router.get("/issues/:id/cost-summary", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const summary = await costs.issueTreeSummary(issue.companyId, issue.id);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byAgent(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-agent-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byAgentModel(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-provider", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byProvider(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    const summary = await finance.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/finance-by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await finance.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-by-kind", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await finance.byKind(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    const limit = parseCostLimit(req.query);
    const rows = await finance.list(companyId, range, limit);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/window-spend", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const rows = await costs.windowSpend(companyId);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/quota-windows", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    assertBoard(req);
    // validate companyId resolves to a real company so the "__none__" sentinel
    // and any forged ids are rejected before we touch provider credentials
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const results = await fetchAllQuotaWindows();
    res.json(results);
  });

  router.get("/companies/:companyId/budgets/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const overview = await budgets.overview(companyId);
    res.json(overview);
  });

  router.post(
    "/companies/:companyId/budgets/policies",
    validate(upsertBudgetPolicySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      // An agent-scoped budget policy sets the same spend authority as the
      // agent budget field, so it is ceiling-bound on the same terms.
      if (req.body.scopeType === "agent" && typeof req.body.scopeId === "string") {
        const authority = await assertAgentBudgetAuthority(req, companyId, req.body.scopeId);
        assertStewardCannotWeakenBudgetPolicy(authority, req.body);
        await governance.assertAgentMutationWithinCeiling(
          companyId,
          req.body.scopeId,
          { monthlyBudgetCents: req.body.amount },
          { actorUserId: req.actor.userId ?? null },
        );
      }
      const summary = await budgets.upsertPolicy(companyId, req.body, req.actor.userId ?? "board");
      res.json(summary);
    },
  );

  router.post(
    "/companies/:companyId/budget-incidents/:incidentId/resolve",
    validate(resolveBudgetIncidentSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const incidentId = req.params.incidentId as string;
      assertCompanyAccess(req, companyId);
      const incidentContext = await budgets.getIncidentContext(companyId, incidentId);

      // Resolving an incident ALSO resolves the linked approval, whatever the
      // action. That is a decision, so it must satisfy the same actor rules as
      // a direct approve/reject — otherwise `{"action":"dismiss"}` is an
      // unguarded second decision boundary for any company member.
      if (incidentContext?.approvalId) {
        const linkedApproval = await approvalsSvc.getById(incidentContext.approvalId);
        if (linkedApproval) {
          await approvalAuthority.requireDecisionActor(linkedApproval, req.actor);
        }
      }

      // Resolving an incident with a raised limit writes agents.budgetMonthlyCents
      // just like the two routes above, so it is bound by the same ceiling.
      if (req.body.action === "raise_budget_and_resume" && typeof req.body.amount === "number") {
        const scopedAgentId = incidentContext?.agentScopeId ?? null;
        if (scopedAgentId) {
          await assertAgentBudgetAuthority(req, companyId, scopedAgentId);
          await governance.assertAgentMutationWithinCeiling(
            companyId,
            scopedAgentId,
            { monthlyBudgetCents: req.body.amount },
            { actorUserId: req.actor.userId ?? null },
          );
        }
      }
      const incident = await budgets.resolveIncident(companyId, incidentId, req.body, req.actor.userId ?? "board");
      res.json(incident);
    },
  );

  router.get("/companies/:companyId/costs/by-project", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpendVisibility(req, companyId);
    const range = parseCostDateRange(req.query);
    const rows = await costs.byProject(companyId, range);
    res.json(rows);
  });

  router.patch("/companies/:companyId/budgets", validate(updateBudgetSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await companies.update(companyId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.budget_updated",
      entityType: "company",
      entityId: companyId,
      details: { budgetMonthlyCents: req.body.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      companyId,
      {
        scopeType: "company",
        scopeId: companyId,
        amount: req.body.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.userId ?? "board",
    );

    res.json(company);
  });

  router.patch("/agents/:agentId/budgets", validate(updateBudgetSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agents.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    assertCompanyAccess(req, agent.companyId);
    assertBoard(req);
    await assertAgentBudgetAuthority(req, agent.companyId, agent.id);
    await governance.assertAgentMutationWithinCeiling(
      agent.companyId,
      agent.id,
      { monthlyBudgetCents: req.body.budgetMonthlyCents },
      { actorUserId: req.actor.userId ?? null },
    );

    const updated = await agents.update(agentId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent.budget_updated",
      entityType: "agent",
      entityId: updated.id,
      details: { budgetMonthlyCents: updated.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      updated.companyId,
      {
        scopeType: "agent",
        scopeId: updated.id,
        amount: updated.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    );

    res.json(updated);
  });

  // ---------------------------------------------------------------------------
  // AgentDash (AGE-119): agent-run metering endpoints
  // ---------------------------------------------------------------------------
  const agentRuns = agentRunService(db);

  router.get("/companies/:companyId/agent-runs/monthly", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.query.agentId as string | undefined;
    const summary = await agentRuns.monthlyCount(companyId, { agentId });
    res.json(summary);
  });

  router.get("/companies/:companyId/agent-runs/monthly-by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await agentRuns.monthlyCountByAgent(companyId);
    res.json(rows);
  });

  return router;
}
