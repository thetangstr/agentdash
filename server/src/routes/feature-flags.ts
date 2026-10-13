// AgentDash: goals-eval-hitl
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import { accessService } from "../services/access.js";
import { insertActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { featureFlagsService } from "../services/feature-flags.js";
import {
  assertCompanyAccess,
  assertCompanyAdministrator,
  assistantGrantAttribution,
  getActorInfo,
  reportAuthzRefusal,
} from "./authz.js";

const setFlagSchema = z.object({
  enabled: z.boolean(),
});

/**
 * Feature-flag HTTP routes — Phase D2.
 *
 * Mounted under /api by app.ts. Per-company flag store; powers the
 * per-tenant DoD-guard rollout and any future tenant toggles.
 *
 * Authorization: reads are open to anyone with company access. Writes are
 * an owner/admin decision: flags switch on security-relevant behavior
 * (document access, the co-worker bridge, the DoD guard), so an agent —
 * or a prompt-injected one — must never be able to turn a feature on for
 * itself, and a plain member must not either. Agents are refused outright;
 * people need `isCompanyAdministrator` (owner/admin, instance admin, or the
 * local implicit board). Every change is recorded as `feature_flag.updated`
 * with the previous and new value.
 */
export function featureFlagRoutes(db: Db) {
  const router = Router();
  const svc = featureFlagsService(db);
  const access = accessService(db);

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
        if (req.actor.type === "agent") {
          reportAuthzRefusal(req, {
            companyId,
            entityType: "company",
            entityId: companyId,
            reasonCode: "AGENT_FEATURE_FLAG_FORBIDDEN",
          });
          throw forbidden("Agents cannot change feature flags. Ask an owner or admin.");
        }
        await assertCompanyAdministrator(
          access,
          req,
          companyId,
          "Only a workspace owner or admin can change feature flags.",
        );
        const parsed = setFlagSchema.safeParse(req.body);
        if (!parsed.success) {
          throw badRequest("Invalid feature-flag body", {
            code: "FEATURE_FLAG_INPUT_INVALID",
            issues: parsed.error.issues,
          });
        }
        const enabled = parsed.data.enabled;
        const actor = getActorInfo(req);
        const publications: ActivityPublication[] = [];
        const row = await db.transaction(async (tx) => {
          const executor = tx as unknown as Db;
          const change = await svc.change(companyId, flagKey, enabled, { executor, publications });
          publications.push(
            await insertActivity(executor, {
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "feature_flag.updated",
              entityType: "company",
              entityId: companyId,
              details: {
                flagKey,
                enabled,
                previousEnabled: change.previousEnabled,
                ...assistantGrantAttribution(req),
              },
            }),
          );
          return change.row;
        });
        for (const publication of publications) publishActivity(publication);
        res.json(row);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
