import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { requireProductProfile } from "../services/companies.js";
import { workflowEventsService } from "../services/workflow-events.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * AgentDash-MK: the read surface over the measurement substrate.
 *
 * One route, one shape, and no dimension by which a person could be named.
 * There is no `?actor=`, no `?userId=`, and no companion route that breaks a
 * run down by who touched it — not because those would be declined, but because
 * the events beneath have nothing to answer them with. Reporting is per run and
 * per pipeline, which is the level the numbers are actually about.
 *
 * 404 outside `agentdash_mk`, matching the other profile routes: a
 * default-profile company must be indistinguishable from one that does not
 * exist rather than told that a feature it does not have is off.
 */
export function workflowMetricsRoutes(db: Db) {
  const router = Router();
  const events = workflowEventsService(db);

  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  router.get("/companies/:companyId/workflow-runs/:runId/metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    const runId = req.params.runId as string;
    await requireProfileCompany(req, companyId);
    // Query parameters are read nowhere on purpose: a caller who appends
    // `?userId=` gets the same aggregate as one who does not.
    res.json(await events.metricsForRun(companyId, runId));
  });

  return router;
}
