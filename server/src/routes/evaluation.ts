import { Router } from "express";
import {
  EVALUATION_EVENT_TYPES,
  EVALUATION_REVIEW_PROJECT_NAME,
  evaluationContractV1Schema,
  type EvaluationEventType,
  evaluationMilestoneRefSchema,
  EVALUATOR_AGENT_ROLE,
} from "@paperclipai/shared";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { accessService } from "../services/access.js";
import { evaluationIngest, MAX_BACKFILL_PASSES, withCompanyLock } from "../services/evaluation/ingest.js";
import { evaluationLedger, hashCanonical } from "../services/evaluation/ledger.js";
import { agentService } from "../services/agents.js";
import { projectService } from "../services/projects.js";
import { evaluationReplay } from "../services/evaluation/replay.js";
import { REVIEW_PROJECT_DESCRIPTION, evaluationReviewItems } from "../services/evaluation/review-items.js";
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
  const reviewItems = evaluationReviewItems(db);

  /** The evaluator principal (read-only key) or a company administrator. Ordinary agents and members are refused. */
  async function assertEvaluatorOrAdministrator(req: Parameters<typeof assertCompanyAccess>[0], companyId: string) {
    if (req.actor.type === "agent" && req.actor.principalKind === "evaluator") return;
    await assertCompanyAdministrator(access, req, companyId);
  }

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

  /** Replay materialises the company's window in memory; administrators only until aggregation moves into SQL. */
  router.get("/companies/:companyId/evaluation/replay", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertCompanyAdministrator(access, req, companyId);
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
      const wantVerify = req.query.verify === "true";
      // `verify` replays the company window in memory (as the replay route does): administrators only.
      // Plain card reads stay open to company members.
      if (wantVerify) await assertCompanyAdministrator(access, req, companyId);
      const latest = await cards.latest(companyId, ref);
      const verify = latest && wantVerify ? await cards.verify(companyId, ref, latest.version) : null;
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
      let result: Awaited<ReturnType<typeof ingest.backfill>> | Awaited<ReturnType<typeof ingest.tick>>;
      try {
        result = backfill ? await ingest.backfill(companyId, MAX_BACKFILL_PASSES) : await ingest.tick(companyId);
      } catch (err) {
        // Another pass holds this company's lock: tell the operator when to come back.
        if (err instanceof Error && /already running/.test(err.message)) res.set("Retry-After", "60");
        throw err;
      }
      const actor = getActorInfo(req);
      const outcome = "lockedOut" in result ? { passes: result.passes, exhausted: result.exhausted, lockedOut: result.lockedOut } : {};
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "evaluation.ingest_run",
        entityType: "company",
        entityId: companyId,
        details: { backfill, inserted: result.inserted, scanned: result.scanned, ...outcome },
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /** The latest declared contract for a milestone (spec §4), read from the ledger. */
  router.get("/companies/:companyId/evaluation/contracts", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const q = refQuery.safeParse(req.query);
      if (!q.success) throw badRequest("kind (project|goal) and id are required", { issues: q.error.issues });
      const ref = evaluationMilestoneRefSchema.parse(q.data);
      const events = await ledger.list(companyId, { types: ["contract.declared"], limit: 5000 });
      const contractOf = (e: { payload?: unknown }) => (e.payload as { contract?: { milestoneRef?: { kind?: string; id?: string } } } | undefined)?.contract ?? null;
      const mine = events.filter((e) => {
        const c = contractOf(e);
        return c?.milestoneRef?.kind === ref.kind && c?.milestoneRef?.id === ref.id;
      });
      const latest = mine[mine.length - 1] ?? null;
      res.json({ contract: latest ? contractOf(latest) : null, eventId: latest?.id ?? null, declaredAt: latest?.eventTime ?? null, declaredBy: latest?.actorId ?? null, versions: mine.length });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The accountable human declares a milestone contract (spec §4). Administrators
   * only; the body is the v1 schema; the event is appended under the company's
   * evaluator lock and audited. A weak contract (rule 16) is accepted and shown
   * on the card as a contract exception — it is not refused here.
   */
  router.post("/companies/:companyId/evaluation/contracts", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertCompanyAdministrator(access, req, companyId);
      const parsed = evaluationContractV1Schema.safeParse(req.body);
      if (!parsed.success) throw badRequest("Invalid contract", { issues: parsed.error.issues });
      const contract = parsed.data;
      if (contract.companyId !== companyId) throw badRequest("contract.companyId must match the route");
      if (contract.source !== "declared") throw badRequest("only declared contracts may be posted; derived contracts are the evaluator's own");
      const actor = getActorInfo(req);
      const now = new Date();
      const result = await withCompanyLock(db, companyId, (tx) =>
        evaluationLedger(tx).append([
          {
            companyId,
            projectId: contract.milestoneRef.kind === "project" ? contract.milestoneRef.id : null,
            goalId: contract.milestoneRef.kind === "goal" ? contract.milestoneRef.id : contract.goalId,
            actorType: actor.actorType === "agent" ? "agent" : "user",
            actorId: actor.actorId,
            sourceTable: "evaluation_contracts",
            sourceId: `${contract.milestoneRef.kind}:${contract.milestoneRef.id}`,
            sourceVersion: hashCanonical(contract).slice(0, 32),
            eventType: "contract.declared",
            eventTime: now,
            payload: { contract, companyId },
          },
        ]),
      );
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "evaluation.contract_declared",
        entityType: contract.milestoneRef.kind,
        entityId: contract.milestoneRef.id,
        details: { inserted: result.inserted, criteria: contract.acceptanceCriteria.length, requiredEvidence: contract.requiredEvidence },
      });
      res.status(result.inserted > 0 ? 201 : 200).json({ inserted: result.inserted, skipped: result.skipped, eventId: result.insertedIds[0] ?? null });
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
      // §9.2: exceptions become review items when asked (deterministic, outside the ledger lock). Errors are reported, never hidden.
      let reviewItemsResult: Awaited<ReturnType<typeof reviewItems.sync>> | { error: string } | null = null;
      if (req.query.reviewItems === "true") {
        try {
          reviewItemsResult = await reviewItems.sync(companyId, ref, stored.card as Parameters<typeof reviewItems.sync>[2], stored.version, actor.actorType === "user" ? actor.actorId : null);
        } catch (err) {
          reviewItemsResult = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "evaluation.scorecard_snapshot",
        entityType: ref.kind,
        entityId: ref.id,
        details: { version: stored.version, throughSeq: Number(stored.throughSeq), cardHash: stored.cardHash, reviewItems: reviewItemsResult && !("error" in reviewItemsResult) ? { created: reviewItemsResult.created.length, updated: reviewItemsResult.updated.length, unrouted: reviewItemsResult.unrouted.length } : reviewItemsResult },
      });
      res.status(201).json({ stored, verify, reviewItems: reviewItemsResult });
    } catch (err) {
      next(err);
    }
  });

  /**
   * D11 / spec §10.1: provision the evaluator principal — one agent with role
   * `evaluator`, no manager (outside every reporting chain), accountable to the
   * administrator who provisions it, and one read-only API key whose token is
   * returned exactly once — plus the review-items project (§9.2). Idempotent:
   * an existing evaluator is returned without a token unless `rotateKey` is
   * set, which revokes its previous evaluator keys. Administrators only; audited.
   */
  router.post("/companies/:companyId/evaluation/principal", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertCompanyAdministrator(access, req, companyId);
      const body = z.object({ rotateKey: z.boolean().optional() }).safeParse(req.body ?? {});
      if (!body.success) throw badRequest("Invalid body", { issues: body.error.issues });
      const actor = getActorInfo(req);
      const agentsSvc = agentService(db);
      const projectsSvc = projectService(db);

      const project =
        (await projectsSvc.list(companyId)).find((p) => p.name === EVALUATION_REVIEW_PROJECT_NAME) ??
        (await projectsSvc.create(companyId, { name: EVALUATION_REVIEW_PROJECT_NAME, description: REVIEW_PROJECT_DESCRIPTION, status: "in_progress" }));

      let agent = (await agentsSvc.list(companyId)).find((a) => a.role === EVALUATOR_AGENT_ROLE && a.status !== "terminated") ?? null;
      let created = false;
      if (!agent) {
        agent = await agentsSvc.create(companyId, {
          name: "Evaluator",
          title: "Company Evaluator",
          role: EVALUATOR_AGENT_ROLE,
          reportsTo: null,
          accountableUserId: actor.actorType === "user" ? actor.actorId : null,
          capabilities: "Reads the evaluation ledger and cards; reviews exceptions; never directs agents or changes reviewed work.",
        });
        created = true;
      }
      let key: { id: string; token: string } | null = null;
      if (created || body.data.rotateKey) {
        if (!created) await agentsSvc.revokeKeysOfKind(agent.id, "evaluator");
        const minted = await agentsSvc.createApiKey(agent.id, "evaluator (read-only)", { source: "manual", createdByUserId: actor.actorType === "user" ? actor.actorId : null }, "evaluator");
        key = { id: minted.id, token: minted.token };
      }
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "evaluation.principal_provisioned",
        entityType: "agent",
        entityId: agent.id,
        details: { created, keyMinted: key !== null, rotated: !created && key !== null, projectId: project.id },
      });
      res.status(created ? 201 : 200).json({ agent: { id: agent.id, name: agent.name, role: agent.role, reportsTo: agent.reportsTo ?? null }, key, projectId: project.id, created });
    } catch (err) {
      next(err);
    }
  });

  /**
   * §9.2: bring the review items for the latest stored card of a milestone up
   * to date. The evaluator principal's one sanctioned write into issues, and
   * the administrators'. Creates or updates issues only in the review-items
   * project, labelled, `todo`, assigned to a human; never touches a source
   * issue. Audited.
   */
  router.post("/companies/:companyId/evaluation/review-items", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertEvaluatorOrAdministrator(req, companyId);
      const body = z.object({ kind: z.enum(["project", "goal"]), id: z.string().uuid(), version: z.number().int().positive().optional() }).safeParse(req.body);
      if (!body.success) throw badRequest("kind, id required", { issues: body.error.issues });
      const ref = evaluationMilestoneRefSchema.parse({ kind: body.data.kind, id: body.data.id });
      const latest = await cards.latest(companyId, ref);
      if (!latest) throw notFound("No stored card for this milestone; snapshot it first");
      const actor = getActorInfo(req);
      const result = await reviewItems.sync(companyId, ref, latest.card as Parameters<typeof reviewItems.sync>[2], latest.version, actor.actorType === "user" ? actor.actorId : null);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "evaluation.review_items_synced",
        entityType: ref.kind,
        entityId: ref.id,
        details: { cardVersion: latest.version, created: result.created.length, updated: result.updated.length, unchanged: result.unchanged.length, unrouted: result.unrouted.length },
      });
      res.json({ cardVersion: latest.version, ...result });
    } catch (err) {
      next(err);
    }
  });

  const evidenceRefsSchema = z.array(z.string().min(1)).min(1).max(50);
  const noteSchema = z.string().min(1).max(4000);

  /** §9.3: every evaluator statement cites ledger events; uncited notes are refused, not stored. */
  async function requireCitations(companyId: string, refs: string[]): Promise<void> {
    const found = await ledger.existing(companyId, refs);
    const missing = refs.filter((r) => !found.has(r));
    if (missing.length > 0) throw badRequest("Every evidence reference must be a ledger event of this company", { missing });
  }

  function writerActor(req: Parameters<typeof getActorInfo>[0]): { actorType: "evaluator" | "user" | "agent"; actorId: string | null } {
    const actor = getActorInfo(req);
    if (req.actor.type === "agent" && req.actor.principalKind === "evaluator") return { actorType: "evaluator", actorId: req.actor.agentId ?? null };
    return { actorType: actor.actorType === "user" ? "user" : "agent", actorId: actor.actorId };
  }

  /**
   * The evaluator's evidence note on an exception (§9.3). Evaluator principal or
   * administrators; every statement cites ledger events; appended under the lock.
   */
  router.post("/companies/:companyId/evaluation/findings", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertEvaluatorOrAdministrator(req, companyId);
      const body = z.object({ exceptionKey: z.string().min(1).max(300), note: noteSchema, evidenceRefs: evidenceRefsSchema, milestoneRef: evaluationMilestoneRefSchema.optional() }).safeParse(req.body);
      if (!body.success) throw badRequest("exceptionKey, note and at least one evidenceRef are required", { issues: body.error.issues });
      await requireCitations(companyId, body.data.evidenceRefs);
      const who = writerActor(req);
      const now = new Date();
      const content = { kind: "evaluator_note", exceptionKey: body.data.exceptionKey, note: body.data.note, evidenceRefs: [...body.data.evidenceRefs].sort() };
      const result = await withCompanyLock(db, companyId, (tx) =>
        evaluationLedger(tx).append([
          {
            companyId,
            projectId: body.data.milestoneRef?.kind === "project" ? body.data.milestoneRef.id : null,
            goalId: body.data.milestoneRef?.kind === "goal" ? body.data.milestoneRef.id : null,
            actorType: who.actorType,
            actorId: who.actorId,
            sourceTable: "evaluator_notes",
            sourceId: body.data.exceptionKey,
            sourceVersion: hashCanonical(content).slice(0, 32),
            eventType: "evaluation.finding",
            eventTime: now,
            payload: content,
            correlationId: `finding:${body.data.exceptionKey}`,
          },
        ]),
      );
      const actor = getActorInfo(req);
      await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, action: "evaluation.finding_noted", entityType: "company", entityId: companyId, details: { exceptionKey: body.data.exceptionKey, inserted: result.inserted, citations: body.data.evidenceRefs.length } });
      res.status(result.inserted > 0 ? 201 : 200).json({ inserted: result.inserted, skipped: result.skipped, eventId: result.insertedIds[0] ?? null });
    } catch (err) {
      next(err);
    }
  });

  /**
   * §9.4: any company human files a correction against a ledger event. The
   * disputed event is never edited; the correction is a new event. Board users only.
   */
  router.post("/companies/:companyId/evaluation/corrections", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") throw forbidden("Corrections are filed by humans");
      const body = z.object({ disputedEventId: z.string().uuid(), claimedFact: noteSchema, evidenceRefs: z.array(z.string().min(1)).max(50).default([]), correlationId: z.string().max(200).optional() }).safeParse(req.body);
      if (!body.success) throw badRequest("disputedEventId and claimedFact are required", { issues: body.error.issues });
      const exists = await ledger.existing(companyId, [body.data.disputedEventId, ...body.data.evidenceRefs]);
      if (!exists.has(body.data.disputedEventId)) throw notFound("Disputed event not found in this company's ledger");
      const missing = body.data.evidenceRefs.filter((r) => !exists.has(r));
      // A correction against a T0/T0 disagreement may cite its correlationId instead of new evidence (§9.4).
      if (missing.length > 0 && !body.data.correlationId) throw badRequest("Evidence references must be ledger events of this company", { missing });
      const actor = getActorInfo(req);
      const now = new Date();
      const content = { disputedEventId: body.data.disputedEventId, claimedFact: body.data.claimedFact, evidenceRefs: [...body.data.evidenceRefs].sort(), correlationId: body.data.correlationId ?? null, filedBy: actor.actorId };
      const result = await withCompanyLock(db, companyId, (tx) =>
        evaluationLedger(tx).append([
          {
            companyId,
            actorType: "user",
            actorId: actor.actorId,
            sourceTable: "evaluation_corrections",
            sourceId: body.data.disputedEventId,
            sourceVersion: hashCanonical(content).slice(0, 32),
            eventType: "evaluation.correction",
            eventTime: now,
            payload: content,
            correlationId: body.data.correlationId ?? `correction:${body.data.disputedEventId}`,
          },
        ]),
      );
      await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, action: "evaluation.correction_filed", entityType: "company", entityId: companyId, details: { disputedEventId: body.data.disputedEventId, inserted: result.inserted } });
      res.status(result.inserted > 0 ? 201 : 200).json({ inserted: result.inserted, skipped: result.skipped, eventId: result.insertedIds[0] ?? null });
    } catch (err) {
      next(err);
    }
  });

  /** §9.4: the evaluator attaches an evidence note to a correction; it never decides. Evaluator principal or administrators. */
  router.post("/companies/:companyId/evaluation/corrections/:correctionEventId/note", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const correctionEventId = req.params.correctionEventId as string;
      assertCompanyAccess(req, companyId);
      await assertEvaluatorOrAdministrator(req, companyId);
      const body = z.object({ note: noteSchema, evidenceRefs: evidenceRefsSchema }).safeParse(req.body);
      if (!body.success) throw badRequest("note and at least one evidenceRef are required", { issues: body.error.issues });
      const correction = await ledger.get(companyId, correctionEventId);
      if (!correction || correction.eventType !== "evaluation.correction") throw notFound("Correction not found");
      await requireCitations(companyId, body.data.evidenceRefs);
      const who = writerActor(req);
      const now = new Date();
      const content = { kind: "evaluator_note", correctionEventId, note: body.data.note, evidenceRefs: [...body.data.evidenceRefs].sort() };
      const result = await withCompanyLock(db, companyId, (tx) =>
        evaluationLedger(tx).append([
          {
            companyId,
            actorType: who.actorType,
            actorId: who.actorId,
            sourceTable: "evaluator_notes",
            sourceId: correctionEventId,
            sourceVersion: hashCanonical(content).slice(0, 32),
            eventType: "evaluation.disposition",
            eventTime: now,
            payload: content,
            correlationId: `correction:${correctionEventId}`,
          },
        ]),
      );
      const actor = getActorInfo(req);
      await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, action: "evaluation.correction_noted", entityType: "company", entityId: companyId, details: { correctionEventId, inserted: result.inserted } });
      res.status(result.inserted > 0 ? 201 : 200).json({ inserted: result.inserted, skipped: result.skipped, eventId: result.insertedIds[0] ?? null });
    } catch (err) {
      next(err);
    }
  });

  /**
   * §9.4 / §4: a human's disposition — deciding a correction, attesting a
   * criterion, or accepting a contract exception (rule 16). Administrators
   * only; the disposition is the human's, never the evaluator's.
   */
  router.post("/companies/:companyId/evaluation/dispositions", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertCompanyAdministrator(access, req, companyId);
      const body = z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("correction_decided"), correctionEventId: z.string().uuid(), decision: z.enum(["accepted", "rejected"]), note: noteSchema.optional() }),
          z.object({ kind: z.literal("criterion_attest"), criterionId: z.string().min(1), issueId: z.string().uuid().optional(), result: z.enum(["satisfied", "unsatisfied"]), evidenceRefs: evidenceRefsSchema, milestoneRef: evaluationMilestoneRefSchema }),
          z.object({ kind: z.literal("contract_exception_accepted"), contractEventId: z.string().uuid(), note: noteSchema.optional() }),
        ])
        .safeParse(req.body);
      if (!body.success) throw badRequest("Invalid disposition", { issues: body.error.issues });
      const d = body.data;
      const referenced = d.kind === "correction_decided" ? [d.correctionEventId] : d.kind === "contract_exception_accepted" ? [d.contractEventId] : d.evidenceRefs;
      const exists = await ledger.existing(companyId, referenced);
      const missing = referenced.filter((r) => !exists.has(r));
      if (missing.length > 0) throw notFound(`Referenced ledger events not found in this company: ${missing.join(", ")}`);
      const actor = getActorInfo(req);
      const now = new Date();
      const sourceId = d.kind === "correction_decided" ? d.correctionEventId : d.kind === "contract_exception_accepted" ? d.contractEventId : `${d.criterionId}:${d.issueId ?? "milestone"}`;
      const content: Record<string, unknown> = { ...d, decidedBy: actor.actorId };
      const result = await withCompanyLock(db, companyId, (tx) =>
        evaluationLedger(tx).append([
          {
            companyId,
            projectId: d.kind === "criterion_attest" && d.milestoneRef.kind === "project" ? d.milestoneRef.id : null,
            goalId: d.kind === "criterion_attest" && d.milestoneRef.kind === "goal" ? d.milestoneRef.id : null,
            actorType: "user",
            actorId: actor.actorId,
            sourceTable: "evaluation_dispositions",
            sourceId,
            sourceVersion: hashCanonical(content).slice(0, 32),
            eventType: "evaluation.disposition",
            eventTime: now,
            payload: content,
            correlationId: d.kind === "correction_decided" ? `correction:${d.correctionEventId}` : null,
          },
        ]),
      );
      await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, action: "evaluation.disposition_recorded", entityType: "company", entityId: companyId, details: { kind: d.kind, sourceId, inserted: result.inserted } });
      res.status(result.inserted > 0 ? 201 : 200).json({ inserted: result.inserted, skipped: result.skipped, eventId: result.insertedIds[0] ?? null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
