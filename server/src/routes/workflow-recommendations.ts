import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { requireProductProfile } from "../services/companies.js";
import { workflowRecommendationService } from "../services/workflow-recommendations.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * AgentDash-MK: the review agent's recommendation surface.
 *
 * **Read-only, and that is structural rather than an oversight.** There is no
 * POST, PUT, or PATCH on this router and there is no service function it could
 * call: the only writer of a recommendation is the derivation itself, which
 * renders every word it says from a step key and a count. A create route would
 * be a free-text field pointed at a human, which is exactly where a sentence
 * about a named colleague would eventually arrive.
 *
 * Deciding a recommendation happens on the approvals routes, like every other
 * decision in this system. There is no accept/decline verb here, because a
 * second decision path is a second thing to get wrong.
 *
 * **The list defaults to the caller's own.** A recommendation is addressed to
 * the pipeline owner — for a deliverable, the first approver — and there is no
 * `?userId=` by which one person could read another's. `?scope=all` exists for
 * an implementer operating the encoding, and gives no more than the union of
 * everyone's, because a recommendation names no individual to begin with.
 *
 * 404 outside `agentdash_mk`, matching the other profile routes.
 */
export function workflowRecommendationRoutes(db: Db) {
  const router = Router();
  const svc = workflowRecommendationService(db);

  async function requireProfileCompany(companyId: string) {
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  /** Checked after the profile lookup, so an off-profile company gets 404. */
  function requireImplementer(req: Request) {
    if (req.actor.type !== "board") return false;
    return req.actor.source === "local_implicit" || Boolean(req.actor.isInstanceAdmin);
  }

  router.get("/companies/:companyId/workflow-recommendations", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(companyId);
    // An agent is refused rather than served an empty list. A recommendation is
    // a suggestion about how work is organized, put to a person for a decision;
    // an agent reading one has nothing it may legitimately do with it, and the
    // one thing it might try — acting on it — is the thing this half of the
    // review agent does not do.
    if (req.actor.type !== "board") {
      throw forbidden("A recommendation is put to a human for a decision, not to an agent");
    }
    assertCompanyAccess(req, companyId);
    const allRecipients = req.query.scope === "all" && requireImplementer(req);
    res.json({
      recommendations: await svc.list(companyId, {
        recipientUserId: req.actor.userId ?? null,
        allRecipients,
      }),
    });
  });

  return router;
}
