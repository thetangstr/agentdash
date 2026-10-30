import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  AGENT_ACCEPTANCE_FACTS,
  AGENT_CARD_SECTIONS,
  AGENT_JUDGE_KINDS,
  AGENT_JUDGMENT_RESULTS,
  AGENT_OBLIGATION_END_STATES,
  evaluationAgentDispositionSchema,
  type AgentCardResponse,
  type AgentCardSnapshotResponse,
  type AgentCardVersionList,
  type AgentCaseFilter,
  type EvaluationAgentDisposition,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { accessService } from "../services/access.js";
import { agentAccountabilityService } from "../services/agent-accountability.js";
import { isEvaluatorPrincipal } from "../services/agent-performance-authz.js";
import { resolveEvaluationViewer } from "../services/evaluation/access-class.js";
import { isEffectivePerformanceManager } from "../services/performance-manager.js";
import {
  agentCardService,
  agentCardSnapshotAllowed,
  defaultAgentCardWindow,
  recordAgentDisposition,
  type AgentCardActor,
} from "../services/evaluation/agent-cards.js";
import { parseProjectionWindowDays } from "./agent-performance.js";
import { assertCompanyAccess, getActorInfo, isCompanyAdministrator } from "./authz.js";
import { agentVisibilityParam, seesEverything, visibleAgentIdsFor } from "./visibility.js";

/**
 * AgentDash: Agent Performance Management gate 3 (P3.3) — agent cards
 * (evaluation LLD §11–§12). Mounted under /api by app.ts.
 *
 *   GET  /companies/:companyId/evaluation/agents                         latest card per visible agent (projected)
 *   GET  /companies/:companyId/evaluation/agents/:agentId[?version=]     a stored card, projected for the viewer (+ `viewer` flags)
 *   GET  /companies/:companyId/evaluation/agents/:agentId/versions       the stored versions (no card content)
 *   GET  /companies/:companyId/evaluation/agents/:agentId/compute        "Compute now": side-effect-free card at the current cut
 *   GET  /companies/:companyId/evaluation/agents/:agentId/cases          drill-down, filtered by access class (then responsibility, state, section, fact, criterion, judge)
 *   POST /companies/:companyId/evaluation/agents/:agentId/snapshot       store a version (admin or accountable user; audited)
 *   GET  /companies/:companyId/evaluation/agents/:agentId/verify         replay check (admin or accountable user)
 *
 * The gate 1 projection route (`GET .../evaluation/agents/:agentId/projection`)
 * stays in `routes/agent-performance.ts`. The dispositions extension
 * (`use_confirmed`, `disagreement_noted`, bound `criterion_attest`) is handled
 * by `POST .../evaluation/dispositions` through `handleAgentDisposition` below.
 *
 * Who reads a card: board members who can see the agent, each receiving a
 * projection for the access classes they can read (admins, the accountable
 * user and the steward read their private classes; members read company and
 * their projects). AgentDash (APM gate 4, P4.1): the company's effective
 * performance manager also reads the list, a card, its cases and "Compute
 * now", as an agent principal: no private class, and project classes only
 * where its own project access (legacy and enforced V2) allows. Every other
 * agent, the evaluator principal included, is refused; versions, snapshot
 * and verify stay people-only.
 * Every card view carries `viewer`: what the caller may do, from the same
 * guards (`agentCardSnapshotAllowed`, `agentDisagreementAllowed`,
 * `namedAttestersOf`) the snapshot, verify and dispositions routes apply.
 */

const VIEW_FORBIDDEN = "Agent cards are read by people and by the company's performance manager.";
const SNAPSHOT_FORBIDDEN = "Only the agent's accountable person or a company admin can snapshot or verify its card.";

const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const caseQuery = z.object({
  version: z.coerce.number().int().min(1).optional(),
  responsibility: z.string().min(1).max(80).optional(),
  state: z.enum([...AGENT_OBLIGATION_END_STATES, ...AGENT_JUDGMENT_RESULTS, "refused", "repeated_after_refusal", "would_refuse", "unauthorized_execution", "potential", "confirmed", "dismissed"]).optional(),
  section: z.enum([...AGENT_CARD_SECTIONS, "reviewer", "fatal"]).optional(),
  fact: z.enum(AGENT_ACCEPTANCE_FACTS).optional(),
  /** A criterion tuple key (`evaluationCriterionRefKey`, a JSON array) or `AGENT_CASE_FILTER_NONE`. */
  criterion: z.string().min(1).max(600).optional(),
  judge: z.enum(AGENT_JUDGE_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
});

/** Whether a disposition body is one of the agent-subject kinds (a `criterion_attest` only with a `binding`). */
export function isAgentDispositionBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const kind = (body as Record<string, unknown>).kind;
  if (kind === "use_confirmed" || kind === "disagreement_noted") return true;
  return kind === "criterion_attest" && "binding" in (body as Record<string, unknown>);
}

/**
 * `POST evaluation/dispositions` for the agent-subject kinds. People only;
 * the subject agent must be visible to them; who may record each kind is
 * checked by `recordAgentDisposition`. Audited.
 */
export async function handleAgentDisposition(db: Db, req: Request, companyId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.actor.type !== "board") throw forbidden("Dispositions are recorded by people");
  const parsed = evaluationAgentDispositionSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("Invalid disposition", { issues: parsed.error.issues });
  const body: EvaluationAgentDisposition = parsed.data;
  const agentId = body.kind === "criterion_attest" ? body.binding.subjectRef.id : body.subjectRef.id;
  const visible = await visibleAgentIdsFor(db, req, companyId);
  if (visible && !visible.has(agentId)) throw notFound("Agent not found");
  const actor = getActorInfo(req);
  const admin = seesEverything(req, companyId) || (await isCompanyAdministrator(accessService(db), req, companyId));
  const result = await recordAgentDisposition(db, { companyId, actor: { userId: actor.actorId, admin }, body });
  await logActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "evaluation.disposition_recorded",
    entityType: "agent",
    entityId: agentId,
    agentId,
    details: { kind: body.kind, sourceId: result.sourceId, inserted: result.inserted },
  });
  return {
    status: result.inserted > 0 ? 201 : 200,
    body: { inserted: result.inserted, skipped: result.skipped, eventId: result.eventId, status: "recorded", next: "the disposition is a ledger fact; the next agent card reflects it" },
  };
}

export function evaluationAgentRoutes(db: Db) {
  const router = Router();
  const cards = agentCardService(db);
  const access = accessService(db);
  // Agent visibility (2026-09-30): an agent the actor cannot see is 404 here too.
  router.param("agentId", agentVisibilityParam(db));

  async function agentInCompany(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, accountableUserId: agents.accountableUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  function assertPerson(req: Request) {
    if (req.actor.type !== "board") throw forbidden(VIEW_FORBIDDEN);
  }

  /** People, or the company's effective performance manager as an agent principal (never the evaluator). */
  async function assertCardReader(req: Request, companyId: string) {
    if (req.actor.type === "board") return;
    if (req.actor.type === "agent" && !isEvaluatorPrincipal(req) && (await isEffectivePerformanceManager(db, companyId, req.actor.agentId))) return;
    throw forbidden(VIEW_FORBIDDEN);
  }

  /** The caller as the card guards see it (the same flags `handleAgentDisposition` computes). */
  async function cardActor(req: Request, companyId: string): Promise<AgentCardActor> {
    const person = req.actor.type === "board";
    const companyAdmin = person && (await isCompanyAdministrator(access, req, companyId));
    return { person, userId: person ? (req.actor.userId ?? null) : null, companyAdmin, dispositionAdmin: companyAdmin || (person && seesEverything(req, companyId)) };
  }

  /** Admin, or the human who answers for the agent (its accountable person). */
  async function assertCanSnapshot(req: Request, companyId: string, agentId: string, accountableUserId: string | null) {
    assertPerson(req);
    const resolved = await agentAccountabilityService(db).resolveForAgent(companyId, agentId);
    if (agentCardSnapshotAllowed(await cardActor(req, companyId), { agentUserId: accountableUserId, resolvedUserId: resolved?.userId ?? null })) return;
    throw forbidden(SNAPSHOT_FORBIDDEN);
  }

  function windowFrom(req: Request, asOf: Date) {
    return defaultAgentCardWindow(asOf, parseProjectionWindowDays(req.query.windowDays));
  }

  router.get("/companies/:companyId/evaluation/agents", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertCardReader(req, companyId);
      const viewer = await resolveEvaluationViewer(db, req, companyId);
      const visibleAgentIds = await visibleAgentIdsFor(db, req, companyId);
      res.json({ agents: await cards.listAgentCards(viewer, { visibleAgentIds }) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/evaluation/agents/:agentId", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      await assertCardReader(req, companyId);
      await agentInCompany(companyId, agentId);
      const q = versionQuery.safeParse(req.query);
      if (!q.success) throw badRequest("Invalid query", { issues: q.error.issues });
      const viewer = await resolveEvaluationViewer(db, req, companyId);
      const actor = await cardActor(req, companyId);
      const card = await cards.getAgentCard(viewer, agentId, { version: q.data.version, actor });
      if (!card && q.data.version != null) throw notFound("No stored card with that version");
      const body: AgentCardResponse = { card, viewer: card ? card.viewer : await cards.cardPermissions(actor, companyId, agentId) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/evaluation/agents/:agentId/versions", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      assertPerson(req);
      await agentInCompany(companyId, agentId);
      const body: AgentCardVersionList = { agentId, versions: await cards.listAgentCardVersions(companyId, agentId) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/evaluation/agents/:agentId/compute", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      await assertCardReader(req, companyId);
      await agentInCompany(companyId, agentId);
      const asOf = new Date(); // the observation time is read here, never inside scoring
      const viewer = await resolveEvaluationViewer(db, req, companyId);
      const actor = await cardActor(req, companyId);
      res.json({ card: await cards.computeAgentCard(viewer, agentId, { asOf, window: windowFrom(req, asOf), actor }) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/evaluation/agents/:agentId/cases", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      await assertCardReader(req, companyId);
      await agentInCompany(companyId, agentId);
      const q = caseQuery.safeParse(req.query);
      if (!q.success) throw badRequest("Invalid query", { issues: q.error.issues });
      const viewer = await resolveEvaluationViewer(db, req, companyId);
      const filter: AgentCaseFilter = { ...q.data, state: q.data.state as AgentCaseFilter["state"] };
      res.json(await cards.agentCases(viewer, agentId, filter));
    } catch (err) {
      next(err);
    }
  });

  router.post("/companies/:companyId/evaluation/agents/:agentId/snapshot", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      const agent = await agentInCompany(companyId, agentId);
      await assertCanSnapshot(req, companyId, agentId, agent.accountableUserId ?? null);
      const asOf = new Date();
      const actor = getActorInfo(req);
      const snapshot = await cards.snapshotAgentCard(companyId, agentId, { asOf, window: windowFrom(req, asOf), fallbackUserId: actor.actorType === "user" ? actor.actorId : null });
      const verify = await cards.verifyAgentCard(companyId, agentId, snapshot.version);
      const viewer = await resolveEvaluationViewer(db, req, companyId);
      const card = await cards.getAgentCard(viewer, agentId, { version: snapshot.version, actor: await cardActor(req, companyId) });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "evaluation.agent_card_snapshot",
        entityType: "agent",
        entityId: agentId,
        agentId,
        details: {
          version: snapshot.version,
          reused: snapshot.reused,
          throughSeq: snapshot.throughSeq,
          cardHash: snapshot.cardHash,
          findings: snapshot.findings,
          reviewItems: snapshot.reviewItems ? { created: snapshot.reviewItems.created.length, updated: snapshot.reviewItems.updated.length, closed: snapshot.reviewItems.closed.length } : null,
        },
      });
      const body: AgentCardSnapshotResponse = { snapshot, verify, card };
      res.status(snapshot.reused ? 200 : 201).json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/evaluation/agents/:agentId/verify", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      const agent = await agentInCompany(companyId, agentId);
      await assertCanSnapshot(req, companyId, agentId, agent.accountableUserId ?? null);
      const q = versionQuery.safeParse(req.query);
      if (!q.success) throw badRequest("Invalid query", { issues: q.error.issues });
      res.json({ verify: await cards.verifyAgentCard(companyId, agentId, q.data.version) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
