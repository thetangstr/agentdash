import { Router } from "express";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { mapIssueResponsibilitySchema } from "@paperclipai/shared";
import { badRequest, forbidden, HttpError, notFound } from "../errors.js";
import { isEvaluatorPrincipal } from "../services/agent-performance-authz.js";
import {
  authorizeMapping,
  currentResponsibility,
  mapIssueResponsibility,
  responsibilityHistory,
  type ResponsibilityMappingActor,
} from "../services/issue-responsibilities.js";
import { assertCompanyAccess, reportAuthzRefusal } from "./authz.js";
import { assertAgentIdVisible, assertIssueIdVisible, isCanonicalUuid } from "./visibility.js";

/**
 * AgentDash: Agent Performance Management gate 2 — which responsibility an
 * issue's work counts toward (evaluation LLD §5.2; gate 2 spec P2.4).
 *
 *   GET  /api/companies/:companyId/issues/:issueId/responsibility
 *     `{ current, history, viewer }`: the current mapping (null when unmapped),
 *     every interval oldest first, and authority to map the assigned agent.
 *     Company, issue and every referenced agent's visibility are checked before disclosure.
 *   POST /api/companies/:companyId/issues/:issueId/responsibility
 *     `{ agentId, responsibilityKey, reason? }`. Closes the current mapping and
 *     opens a new one; the key must be in the agent's ACTIVE profile (422
 *     `AGENT_PROFILE_UNKNOWN_RESPONSIBILITY`). Who may map: the issue's
 *     assignee agent (to its own responsibilities), the Chief of Staff, the
 *     agent's steward or accountable person, or a company admin. Activity:
 *     `issue.responsibility_mapped`.
 *
 * `:issueId` takes the uuid or the identifier (`ABC-12`). An issue in another
 * company, or in a project the caller can't see, is 404; so is an agent the
 * caller can't see.
 */
function mappingActor(req: Request): ResponsibilityMappingActor {
  if (req.actor.type === "agent" && req.actor.agentId) {
    return { type: "agent", agentId: req.actor.agentId, runId: req.actor.runId ?? null };
  }
  if (req.actor.type === "board") {
    return { type: "user", userId: req.actor.userId ?? "board", source: req.actor.source ?? null, isInstanceAdmin: req.actor.isInstanceAdmin === true };
  }
  throw forbidden("Authentication required");
}

export function issueResponsibilityRoutes(db: Db) {
  const router = Router();

  async function resolveIssue(req: Request, companyId: string, rawIssueId: string) {
    const ref = rawIssueId.trim();
    const match = isCanonicalUuid(ref)
      ? eq(issues.id, ref)
      : /^[A-Z]+-\d+$/i.test(ref)
        ? eq(issues.identifier, ref.toUpperCase())
        : null;
    if (!match) throw notFound("Issue not found");
    const issue = await db
      .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(match, eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");
    await assertIssueIdVisible(db, req, issue.id);
    return issue;
  }

  router.get("/companies/:companyId/issues/:issueId/responsibility", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const issue = await resolveIssue(req, companyId, req.params.issueId as string);
    const [current, history] = await Promise.all([
      currentResponsibility(db, issue.id, { companyId }),
      responsibilityHistory(db, { companyId, issueId: issue.id }),
    ]);
    // Refuse the complete projection when any mapped agent is hidden. Current
    // and historical rows can name agents other than today's assignee.
    const referencedAgentIds = new Set(history.map((entry) => entry.agentId));
    if (current) referencedAgentIds.add(current.agentId);
    if (issue.assigneeAgentId) referencedAgentIds.add(issue.assigneeAgentId);
    for (const agentId of referencedAgentIds) {
      await assertAgentIdVisible(db, req, agentId);
    }
    // AgentDash: an additive hint for the assigned agent, from the write guard.
    // Scope and visibility precede both authority and any profile disclosure.
    let canMapAssignee = false;
    if (issue.assigneeAgentId) {
      if (!isEvaluatorPrincipal(req)) {
        try {
          await authorizeMapping(db, { companyId, agentId: issue.assigneeAgentId, issueAssigneeAgentId: issue.assigneeAgentId }, mappingActor(req));
          canMapAssignee = true;
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 403)) throw error;
        }
      }
    }
    res.json({ current, history, viewer: { assigneeAgentId: issue.assigneeAgentId ?? null, canMapAssignee } });
  });

  router.post("/companies/:companyId/issues/:issueId/responsibility", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (isEvaluatorPrincipal(req)) throw forbidden("The evaluator principal cannot map work to responsibilities");
    const parsed = mapIssueResponsibilitySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid responsibility mapping", { issues: parsed.error.issues });
    const issue = await resolveIssue(req, companyId, req.params.issueId as string);
    await assertAgentIdVisible(db, req, parsed.data.agentId);

    const actor = mappingActor(req);

    try {
      const mapped = await mapIssueResponsibility(
        db,
        {
          companyId,
          issueId: issue.id,
          agentId: parsed.data.agentId,
          responsibilityKey: parsed.data.responsibilityKey,
          reason: parsed.data.reason ?? null,
        },
        actor,
      );
      res.json(mapped);
    } catch (err) {
      // AGE-91: a refused write leaves a trace; the thrown error is unchanged.
      if (err instanceof HttpError && err.status === 403) {
        reportAuthzRefusal(req, {
          companyId,
          entityType: "issue",
          entityId: issue.id,
          reasonCode: "RESPONSIBILITY_MAPPING_FORBIDDEN",
        });
      }
      throw err;
    }
  });

  return router;
}
