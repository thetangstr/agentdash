// AgentDash: goals-eval-hitl
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, notFound } from "../errors.js";
import { featureFlagsService } from "../services/feature-flags.js";
import { assertCompanyAccess } from "./authz.js";

const setFlagSchema = z.object({
  enabled: z.boolean(),
});

/**
 * Feature-flag HTTP routes — Phase D2.
 *
 * Mounted under /api by app.ts. Per-company flag store; powers the
 * per-tenant DoD-guard rollout and any future tenant toggles.
 *
 * Authorization: PUT mirrors the company-scoped access policy used by
 * other write routes (assertCompanyAccess enforces viewer-readonly +
 * agent-key boundaries). A dedicated admin role for flag mutation is
 * deferred — Phase H tests can flag missing role-gate as a deviation.
 */
export function featureFlagRoutes(db: Db) {
  const router = Router();
  const svc = featureFlagsService(db);

  router.get("/companies/:companyId/feature-flags", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const rows = await svc.listForCompany(companyId);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/companies/:companyId/feature-flags/:flagKey",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const flagKey = req.params.flagKey as string;
        assertCompanyAccess(req, companyId);
        const row = await svc.get(companyId, flagKey);
        if (!row) {
          throw notFound("Feature flag not found");
        }
        res.json(row);
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    "/companies/:companyId/feature-flags/:flagKey",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const flagKey = req.params.flagKey as string;
        assertCompanyAccess(req, companyId);
        const parsed = setFlagSchema.safeParse(req.body);
        if (!parsed.success) {
          throw badRequest("Invalid feature-flag body", {
            code: "FEATURE_FLAG_INPUT_INVALID",
            issues: parsed.error.issues,
          });
        }
        const row = await svc.set(companyId, flagKey, parsed.data.enabled);
        res.json(row);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
