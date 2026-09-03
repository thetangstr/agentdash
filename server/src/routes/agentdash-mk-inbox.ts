import { Router } from "express";
import type { Request } from "express";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import { accessService } from "../services/access.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { summarizeApprovalRisk } from "../services/approval-risk.js";
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
    options: { includeResolved?: boolean } = {},
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
          // `includeResolved` widens the STATUS filter and nothing else. The
          // scope condition below is what keeps the result the caller's own —
          // the two are deliberately separate so widening one can never widen
          // the other.
          // Open means decidable, which is a question of status AND time.
          //
          // This filtered on status alone, and nothing anywhere marks a lapsed
          // approval as expired -- `expiresAt` is consulted in exactly one
          // place, at connector-send time. So an approval past its expiry sat
          // in the inbox as actionable for ever, and deciding it did nothing.
          // That is the same "cannot reach zero" failure the read-state rule
          // caused, arriving by a different road.
          ...(options.includeResolved
            ? []
            : [
                inArray(approvals.status, OPEN_APPROVAL_STATUSES),
                or(isNull(approvals.expiresAt), gt(approvals.expiresAt, new Date()))!,
              ]),
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
        risk: summarizeApprovalRisk(approval.type, approval.payload),
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

    // `open` (the default) is what a decision surface needs. `all` exists for
    // the Inbox tabs that render decided work — scoping those to an open-only
    // set would erase every resolved item rather than scope it. An unrecognized
    // value is rejected rather than silently treated as the default, so a
    // client typo cannot quietly narrow what a user sees.
    const statusParam = typeof req.query.status === "string" ? req.query.status : "open";
    if (statusParam !== "open" && statusParam !== "all") {
      throw badRequest("status must be 'open' or 'all'");
    }

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
        { includeResolved: statusParam === "all" },
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
