import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { EVALUATION_EVENT_TYPES, evaluationMilestoneRefSchema, type EvaluationEventType } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { accessService } from "../services/access.js";
import { evaluationIngest, MAX_BACKFILL_PASSES } from "../services/evaluation/ingest.js";
import { evaluationLedger } from "../services/evaluation/ledger.js";
import { evaluationReplay } from "../services/evaluation/replay.js";
import { evaluationScorecardService } from "../services/evaluation/scorecards.js";
import { assertCompanyAccess, assertCompanyAdministrator, getActorInfo } from "./authz.js";

/**
 * AgentDash: Company Evaluator — Milestone 1 routes (read-side plus two
 * operator actions). Mounted under /api by app.ts. Every handler asserts
 * company access; the two POSTs are company-administrator only, are recorded
 * in the activity log, and only run ingest or store a projection — nothing
 * here writes to any source record. A card's state markers are derived from
 * the milestone itself, never accepted from the caller (spec §4.6).
 * The evaluator principal's own write routes (findings, review items,
 * corrections) arrive with the read-only gate in Milestone 3.
 */
export function evaluationRoutes(db: Db) {
  const router = Router();
  const ledger = evaluationLedger(db);
  const replay = evaluationReplay(db);
  const cards = evaluationScorecardService(db);
  const ingest = evaluationIngest(db);
  const access = accessService(db);

  const listQuery = z.object({
    limit: z.coerce.number().int().min(1).max(5000).optional(),
    type: z.string().optional(),
    since: z.string().datetime().optional(),
  });
  const refQuery = z.object({ kind: z.enum(["project", "goal"]), id: z.string().uuid() });

  router.get("/companies/:companyId/evaluation/events", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const q = listQuery.safeParse(req.query);
      if (!q.success) throw badRequest("Invalid query", { issues: q.error.issues });
      const types = q.data.type
        ? q.data.type.split(",").filter((t): t is EvaluationEventType => (EVALUATION_EVENT_TYPES as readonly string[]).includes(t))
        : undefined;
      const rows = await ledger.list(companyId, {
        types,
        sinceEventTime: q.data.since ? new Date(q.data.since) : undefined,
        limit: q.data.limit,
      });
      res.json({ events: rows, count: rows.length });
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/evaluation/ingest-state", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const [cursors, byType, maxSeq] = await Promise.all([ingest.cursors(companyId), ledger.countByType(companyId), ledger.maxSeq(companyId)]);
      res.json({ cursors, eventsByType: byType, maxSeq, running: ingest.running });
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/evaluation/replay", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const q = refQuery.safeParse(req.query);
      if (!q.success) throw badRequest("kind (project|goal) and id are required", { issues: q.error.issues });
      const ref = evaluationMilestoneRefSchema.parse(q.data);
      const { card, hash, state, throughSeq } = await replay.replay(companyId, ref);
      res.json({ card, hash, state, throughSeq });
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/evaluation/scorecards", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const q = refQuery.safeParse(req.query);
      if (!q.success) throw badRequest("kind (project|goal) and id are required", { issues: q.error.issues });
      const ref = evaluationMilestoneRefSchema.parse(q.data);
      const latest = await cards.latest(companyId, ref);
      // `verify` is a consistency check, requested explicitly.
      const verify = latest && req.query.verify === "true" ? await cards.verify(companyId, ref, latest.version) : null;
      res.json({ latest, verify });
    } catch (err) {
      next(err);
    }
  });

  /** Operator action: run one ingest pass now (shadow-mode verification). Administrators only; bounded; audited. */
  router.post("/companies/:companyId/evaluation/ingest/run", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertCompanyAdministrator(access, req, companyId);
      const backfill = req.query.backfill === "true";
      const result = backfill ? await ingest.backfill(companyId, MAX_BACKFILL_PASSES) : await ingest.tick(companyId);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "evaluation.ingest_run",
        entityType: "company",
        entityId: companyId,
        details: { backfill, inserted: result.inserted, scanned: result.scanned },
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /** Operator action: store the current projection as the next card version and verify replay. Administrators only; audited. */
  router.post("/companies/:companyId/evaluation/scorecards/snapshot", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertCompanyAdministrator(access, req, companyId);
      const body = z.object({ kind: z.enum(["project", "goal"]), id: z.string().uuid() }).safeParse(req.body);
      if (!body.success) throw badRequest("kind, id required", { issues: body.error.issues });
      const ref = evaluationMilestoneRefSchema.parse(body.data);
      const stored = await cards.snapshot(companyId, ref);
      const verify = await cards.verify(companyId, ref, stored.version);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "evaluation.scorecard_snapshot",
        entityType: ref.kind,
        entityId: ref.id,
        details: { version: stored.version, throughSeq: Number(stored.throughSeq), cardHash: stored.cardHash },
      });
      res.status(201).json({ stored, verify });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
