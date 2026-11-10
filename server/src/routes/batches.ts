import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { batchConfirmSchema, batchPreviewSchema, batchReconcileSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { batchService, type BatchServiceOptions } from "../services/batch/engine.js";

/**
 * AgentDash admin powers, part 2: the batch routes.
 *
 * Every write is per record through that record's own single-record route
 * (services/batch/runner.ts); these routes only preview, confirm, read,
 * cancel and record verdicts. Guards: board access to the company, plus the
 * kind's own preview guard; confirm and cancel belong to the person who
 * previewed; reading another person's batch and recording verdicts are for
 * owners and admins.
 */
export function batchRoutes(db: Db, options: BatchServiceOptions = {}) {
  const router = Router();
  const svc = batchService(db, options);

  router.post("/companies/:companyId/batches/preview", validate(batchPreviewSchema), async (req, res) => {
    res.json(await svc.preview(req, req.params.companyId as string, req.body));
  });

  router.post("/companies/:companyId/batches/:batchId/confirm", validate(batchConfirmSchema), async (req, res) => {
    res.status(202).json(await svc.confirm(req, req.params.companyId as string, req.params.batchId as string, req.body));
  });

  router.get("/companies/:companyId/batches", async (req, res) => {
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    res.json({ batches: await svc.list(req, req.params.companyId as string, { limit: Number.isFinite(limit) ? limit : undefined }) });
  });

  router.get("/companies/:companyId/batches/:batchId", async (req, res) => {
    res.json(await svc.get(req, req.params.companyId as string, req.params.batchId as string));
  });

  router.post("/companies/:companyId/batches/:batchId/cancel", async (req, res) => {
    res.json(await svc.cancel(req, req.params.companyId as string, req.params.batchId as string));
  });

  router.post(
    "/companies/:companyId/batches/:batchId/items/:itemId/reconcile",
    validate(batchReconcileSchema),
    async (req, res) => {
      res.json(await svc.reconcile(
        req,
        req.params.companyId as string,
        req.params.batchId as string,
        req.params.itemId as string,
        req.body,
      ));
    },
  );

  return Object.assign(router, { batchService: svc });
}
