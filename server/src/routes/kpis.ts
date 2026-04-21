import { Router } from "express";
import type { Db } from "@agentdash/db";
import { createKpiSchema, setKpiValueSchema, updateKpiSchema } from "@agentdash/shared";
import { validate } from "../middleware/validate.js";
import { kpisService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// AgentDash: Manual KPIs routes (AGE-45)

export function kpiRoutes(db: Db) {
  const router = Router();
  const svc = kpisService(db);

  router.get("/companies/:companyId/kpis", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.post(
    "/companies/:companyId/kpis",
    validate(createKpiSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const kpi = await svc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "kpi.created",
        entityType: "kpi",
        entityId: kpi.id,
        details: { name: kpi.name, targetValue: kpi.targetValue },
      });
      res.status(201).json(kpi);
    },
  );

  router.patch(
    "/companies/:companyId/kpis/:id",
    validate(updateKpiSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertCompanyAccess(req, companyId);
      const existing = await svc.getById(id);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "KPI not found" });
        return;
      }
      const updated = await svc.update(id, req.body);
      if (!updated) {
        res.status(404).json({ error: "KPI not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "kpi.updated",
        entityType: "kpi",
        entityId: id,
        details: req.body,
      });
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/kpis/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    const existing = await svc.getById(id);
    if (!existing || existing.companyId !== companyId) {
      res.status(404).json({ error: "KPI not found" });
      return;
    }
    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "KPI not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "kpi.deleted",
      entityType: "kpi",
      entityId: id,
    });
    res.json(removed);
  });

  router.post(
    "/companies/:companyId/kpis/:id/value",
    validate(setKpiValueSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertCompanyAccess(req, companyId);
      const existing = await svc.getById(id);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "KPI not found" });
        return;
      }
      const updated = await svc.setValue(id, req.body.value);
      if (!updated) {
        res.status(404).json({ error: "KPI not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "kpi.value_updated",
        entityType: "kpi",
        entityId: id,
        details: { value: req.body.value },
      });
      res.json(updated);
    },
  );

  return router;
}
