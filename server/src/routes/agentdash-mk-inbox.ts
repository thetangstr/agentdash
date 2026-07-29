import { Router } from "express";
import type { Request } from "express";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import { accessService } from "../services/access.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { requireProductProfile } from "../services/companies.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/** Statuses a human can still act on. */
const OPEN_APPROVAL_STATUSES = ["pending", "revision_requested"];

export function agentdashMkInboxRoutes(db: Db) {
  const router = Router();
  const stewardships = agentStewardshipService(db);
  const access = accessService(db);
  const issueApprovals = issueApprovalService(db);
  const governance = agentGovernanceService(db);

  /**
   * Coarse risk band derived from the approval type and payload. Enough for the
   * decision surface to order attention; it is not an authorization input.
   */
  function summarizeRisk(type: string, payload: unknown): { level: "high" | "medium" | "low"; reason: string } {
    const record = (payload ?? {}) as Record<string, unknown>;
    if (type === "hire_agent") {
      return { level: "high", reason: "Creates or changes an agent" };
    }
    if (type === "budget_override_required") {
      return { level: "high", reason: "Raises a spend limit" };
    }
    if (type === "mandate_violation") {
      return { level: "high", reason: "Mandate violation" };
    }
    if (typeof record.destructive === "boolean" && record.destructive) {
      return { level: "high", reason: "Destructive action" };
    }
    return { level: "medium", reason: "Governed action" };
  }

  /** Who currently holds decision authority, and the minimum the ceiling demands. */
  async function resolveEffectiveAuthority(companyId: string, agentId: string) {
    const [active, policy] = await Promise.all([
      stewardships.activeByAgent(companyId, agentId),
      governance.getForAgent(companyId, agentId),
    ]);
    return {
      steward: active ? { userId: active.userId, since: active.startedAt } : null,
      minimumApproval: policy.effectivePolicy.minimumApproval,
    };
  }

  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  function requireBoardUser(req: Request) {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user access required");
    return req.actor.userId;
  }

  /**
   * Normalized inbox item. Carries everything a decision surface needs —
   * including the `revision` the decider must echo back — so the client never
   * has to guess or re-fetch to act.
   */
  async function buildItems(
    companyId: string,
    scope: { agentIds: string[]; userId?: string } | { allCompanyAgents: true },
    requiresOverride: boolean,
  ) {
    let scopeCondition: ReturnType<typeof or> | undefined;
    if (!("allCompanyAgents" in scope)) {
      // Design 8.2: the personal inbox is the stewarded agent's requests PLUS
      // the user's own work. Filtering on agent id alone made a steward's own
      // human-created request (which has no requesting agent) invisible to the
      // person who filed it.
      const clauses = [];
      if (scope.agentIds.length > 0) {
        clauses.push(inArray(approvals.requestedByAgentId, scope.agentIds));
      }
      if (scope.userId) {
        clauses.push(eq(approvals.requestedByUserId, scope.userId));
        clauses.push(eq(approvals.decidedByUserId, scope.userId));
      }
      if (clauses.length === 0) return [];
      scopeCondition = or(...clauses);
    }

    const rows = await db
      .select({ approval: approvals, agent: agents })
      .from(approvals)
      // LEFT join: `requested_by_agent_id` is nullable, and budget-incident and
      // human-created approvals have no requester. Those are exactly the class
      // the authority service routes to administrators, so an inner join would
      // hide them from the one admin surface that exists to decide them.
      .leftJoin(agents, eq(agents.id, approvals.requestedByAgentId))
      .where(
        and(
          eq(approvals.companyId, companyId),
          inArray(approvals.status, OPEN_APPROVAL_STATUSES),
          ...(scopeCondition ? [scopeCondition] : []),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      // Bounded: the override view spans every agent in the company.
      .limit(200);

    // Authority is per AGENT, not per approval — resolving it inside the row
    // map issued two extra queries for every row on an unbounded admin view.
    const authorityByAgent = new Map<string, Awaited<ReturnType<typeof resolveEffectiveAuthority>>>();
    for (const agentId of new Set(
      rows.map((row) => row.approval.requestedByAgentId).filter((id): id is string => !!id),
    )) {
      authorityByAgent.set(agentId, await resolveEffectiveAuthority(companyId, agentId));
    }

    return Promise.all(
      rows.map(async ({ approval, agent }) => ({
        approvalId: approval.id,
        type: approval.type,
        status: approval.status,
        revision: approval.revision,
        // Same redaction every other approval read path applies. Hire payloads
        // carry adapterConfig, which routinely holds credentials; returning it
        // raw here would hand them to any steward and, on the override view, to
        // every administrator.
        payload: redactEventPayload(approval.payload) ?? {},
        createdAt: approval.createdAt,
        decidedAt: approval.decidedAt,
        expiresAt: approval.expiresAt,
        requestingAgent: agent ? { id: agent.id, name: agent.name, role: agent.role } : null,
        sourceIssues: (await issueApprovals.listIssuesForApproval(approval.id)).map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
        })),
        risk: summarizeRisk(approval.type, approval.payload),
        effectiveAuthority: approval.requestedByAgentId
          ? authorityByAgent.get(approval.requestedByAgentId) ?? {
              steward: null,
              minimumApproval: null,
            }
          : { steward: null, minimumApproval: null },
        decisionHistory: {
          decidedAt: approval.decidedAt,
          decidedByUserId: approval.decidedByUserId,
          decisionChannel: approval.decisionChannel,
          decisionActorRole: approval.decisionActorRole,
          overrideReason: approval.overrideReason,
          supersededAt: approval.supersededAt,
        },
        // Owner/admin items are exceptional by construction: they are only
        // decidable through the reasoned override action, never as an ordinary
        // approval control.
        requiresOverride,
      })),
    );
  }

  /**
   * The authenticated user's own inbox. The identity comes from the session and
   * nothing else — there is deliberately no userId parameter to honor.
   */
  router.get("/companies/:companyId/me/inbox", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    const current = await stewardships.activeByUserWithAgent(companyId, userId);

    // A user who stewards no agent still has their own work; returning an empty
    // inbox unconditionally hid it and made the tab permanently blank for them.
    res.json({
      stewardedAgent: current
        ? {
            id: current.agent.id,
            name: current.agent.name,
            role: current.agent.role,
            status: current.agent.status,
          }
        : null,
      stewardship: current?.stewardship ?? null,
      items: await buildItems(
        companyId,
        { agentIds: current ? [current.agent.id] : [], userId },
        false,
      ),
    });
  });

  /**
   * Separate owner/admin view. Kept off `/me/inbox` so override controls can
   * never be rendered in the same place as ordinary steward decisions.
   */
  router.get("/companies/:companyId/inbox/override", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    requireBoardUser(req);

    const isAdmin =
      req.actor.source === "local_implicit" ||
      req.actor.isInstanceAdmin ||
      (await access.canUser(companyId, req.actor.userId, "agents:create"));
    if (!isAdmin) {
      throw forbidden("The override view requires company owner or administrator access");
    }

    // Scoped by company on the approvals table itself, so approvals with no
    // requesting agent are included rather than filtered out by an agent list.
    res.json({ items: await buildItems(companyId, { allCompanyAgents: true }, true) });
  });

  return router;
}
