import { Router } from "express";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { mapIssueResponsibilitySchema } from "@paperclipai/shared";
import { badRequest, forbidden, HttpError, notFound } from "../errors.js";
import { isEvaluatorPrincipal } from "../services/agent-performance-authz.js";
import {
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
 *     `{ current, history }`: the current mapping (null when unmapped) and
 *     every interval, oldest first. Anyone who can see the issue.
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
      .select({ id: issues.id })
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
    res.json({ current, history });
  });

  router.post("/companies/:companyId/issues/:issueId/responsibility", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (isEvaluatorPrincipal(req)) throw forbidden("The evaluator principal cannot map work to responsibilities");
    const parsed = mapIssueResponsibilitySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid responsibility mapping", { issues: parsed.error.issues });
    const issue = await resolveIssue(req, companyId, req.params.issueId as string);
    await assertAgentIdVisible(db, req, parsed.data.agentId);

    let actor: ResponsibilityMappingActor;
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      actor = { type: "agent", agentId: req.actor.agentId, runId: req.actor.runId ?? null };
    } else if (req.actor.type === "board") {
      actor = {
        type: "user",
        userId: req.actor.userId ?? "board",
        source: req.actor.source ?? null,
        isInstanceAdmin: req.actor.isInstanceAdmin === true,
      };
    } else {
      throw forbidden("Authentication required");
    }

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
