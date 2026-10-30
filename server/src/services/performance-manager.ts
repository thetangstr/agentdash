import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentProfileApplications,
  agentProfileRevisions,
  agents,
  approvals,
  companies,
  evaluationEvents,
  evaluationScorecards,
} from "@paperclipai/db";
import {
  AGENT_CARD_SCORECARD_KIND,
  AGENT_RECOMMENDATION_KINDS,
  EVALUATOR_AGENT_ROLE,
  formatEvaluationAccessClass,
  parseEvaluationAccessClass,
  type AgentCardView,
  type AgentRecommendationDecision,
  type AgentRecommendationDecisionResult,
  type AgentRecommendationDto,
  type AgentRecommendationEvidence,
  type AgentRecommendationKind,
  type AgentRecommendationList,
  type CreateAgentRecommendation,
  type DecideAgentRecommendation,
  type EvaluationAccessClass,
  type PerformanceManagerAgentRef,
  type PerformanceManagerAppliedItem,
  type PerformanceManagerProposalItem,
  type PerformanceManagerProposalOutcome,
  type PerformanceManagerRecord,
  type PerformanceManagerRecommendationItem,
  type PerformanceManagerRecommendationTally,
  type PerformanceManagerSectionSnapshot,
  type PerformanceManagerSource,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { insertActivity, publishActivity } from "./activity-log.js";
import { viewerClassCondition, viewerClassFilter, type EvaluationViewer } from "./evaluation/access-class.js";
import { agentCardService } from "./evaluation/agent-cards.js";
import { evaluationLedger, type EvaluationEventRow } from "./evaluation/ledger.js";

/**
 * AgentDash: Agent Performance Management gate 4 (P4.1) — the performance
 * manager (overview LLD §4.3; gate 4–5 build spec).
 *
 * Designation: `companies.performance_manager_agent_id`, else the company's
 * earliest-created non-terminated Chief of Staff. A designated agent that was
 * terminated leaves the company with no manager (no silent fall-back to an
 * agent the admin did not choose).
 *
 * The manager is advisory. What it may do is decided elsewhere and unchanged:
 * drafts and proposals go through the gate 2 path (field authority; a person
 * decides; the proposing agent never can), card reads through the gate 3
 * per-viewer projection for an agent principal. Here:
 * - recommendations, appended to the evaluation ledger as
 *   `evaluation.agent_recommendation` (`sourceVersion` `recommended`) with the
 *   owner's decision as a second event of the same source (`decided`; the
 *   dedupe key makes it once only). Neither is a card input
 *   (`EVALUATION_ADVISORY_EVENT_TYPES`), and nothing acts on them: a "pause"
 *   recommendation, accepted or not, never pauses the agent;
 * - the manager's record: its proposals' outcomes, its recommendations (each
 *   one, and tallied by kind and decision), and for each applied proposal the affected
 *   responsibilities' card sections from the last stored card before
 *   application and the first after, side by side. Descriptive only.
 */

const RECOMMENDATION_SOURCE_TABLE = "agent_recommendations";
const RECOMMENDATION_EVENT = "evaluation.agent_recommendation" as const;
export const PERFORMANCE_MANAGER_RECORD_NOTE =
  "Descriptive only: for each applied change, the affected responsibilities' card sections from the last stored card before it was applied and the first stored after are shown side by side. This does not say the change caused any difference, and there is no score.";

type ReadDb = Pick<Db, "select">;

// ---------------------------------------------------------------------------
// Designation
// ---------------------------------------------------------------------------

export interface PerformanceManagerResolution {
  designatedAgentId: string | null;
  designated: PerformanceManagerAgentRef | null;
  effective: PerformanceManagerAgentRef | null;
  source: PerformanceManagerSource;
}

const agentRefColumns = { id: agents.id, name: agents.name, role: agents.role, status: agents.status };

function toRef(row: { id: string; name: string; role: string; status: string }): PerformanceManagerAgentRef {
  return { agentId: row.id, name: row.name, role: row.role, status: row.status };
}

/** The designation and the effective manager; null when the company does not exist. Read-only. */
export async function resolvePerformanceManager(db: ReadDb, companyId: string): Promise<PerformanceManagerResolution | null> {
  const company = await db
    .select({ designatedAgentId: companies.performanceManagerAgentId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!company) return null;
  if (company.designatedAgentId) {
    const row = await db
      .select(agentRefColumns)
      .from(agents)
      .where(and(eq(agents.id, company.designatedAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    const designated = row ? toRef(row) : null;
    const usable = row && row.status !== "terminated" && row.role !== EVALUATOR_AGENT_ROLE;
    return { designatedAgentId: company.designatedAgentId, designated, effective: usable ? designated : null, source: usable ? "designated" : "none" };
  }
  const chief = await db
    .select(agentRefColumns)
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "chief_of_staff"), ne(agents.status, "terminated")))
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return { designatedAgentId: null, designated: null, effective: chief ? toRef(chief) : null, source: chief ? "chief_of_staff" : "none" };
}

/** Whether `agentId` is the company's effective performance manager now. Read-only. */
export async function isEffectivePerformanceManager(db: ReadDb, companyId: string, agentId: string | null | undefined): Promise<boolean> {
  if (!agentId) return false;
  const resolution = await resolvePerformanceManager(db, companyId);
  return resolution?.effective?.agentId === agentId;
}

/**
 * Set or clear the designation (callers check: board, company admin). The
 * agent must be in the company, not terminated and not the evaluator
 * principal. Writes `company.performance_manager_changed` in the same
 * transaction when the designation changes.
 */
export async function setPerformanceManager(
  db: Db,
  input: { companyId: string; agentId: string | null; actor: { actorType: "user" | "agent" | "system" | "plugin"; actorId: string; agentId: string | null } },
): Promise<{ previousDesignatedAgentId: string | null; changed: boolean }> {
  const { companyId, agentId, actor } = input;
  if (agentId) {
    const target = await db
      .select({ id: agents.id, role: agents.role, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!target) throw notFound("Agent not found");
    if (target.status === "terminated") {
      throw unprocessable("A terminated agent cannot be the performance manager", { code: "PERFORMANCE_MANAGER_INELIGIBLE", reason: "terminated" });
    }
    if (target.role === EVALUATOR_AGENT_ROLE) {
      throw unprocessable("The evaluator principal cannot be the performance manager", { code: "PERFORMANCE_MANAGER_INELIGIBLE", reason: "evaluator" });
    }
  }
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const current = await tx
      .select({ designatedAgentId: companies.performanceManagerAgentId })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!current) throw notFound("Company not found");
    const previous = current.designatedAgentId ?? null;
    if (previous === agentId) return { previous, publication: null };
    const before = await resolvePerformanceManager(tx, companyId);
    await tx.update(companies).set({ performanceManagerAgentId: agentId, updatedAt: new Date() }).where(eq(companies.id, companyId));
    const after = await resolvePerformanceManager(tx, companyId);
    const publication = await insertActivity(tx, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "company.performance_manager_changed",
      entityType: "company",
      entityId: companyId,
      details: {
        from: previous,
        to: agentId,
        effectiveFrom: before?.effective?.agentId ?? null,
        effectiveTo: after?.effective?.agentId ?? null,
        source: after?.source ?? "none",
      },
    });
    return { previous, publication };
  });
  if (outcome.publication) publishActivity(outcome.publication);
  return { previousDesignatedAgentId: outcome.previous, changed: outcome.publication !== null };
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function str(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" ? v : null;
}

function isKind(value: unknown): value is AgentRecommendationKind {
  return typeof value === "string" && (AGENT_RECOMMENDATION_KINDS as readonly string[]).includes(value);
}

function toDecision(row: EvaluationEventRow | undefined): AgentRecommendationDecision | null {
  if (!row) return null;
  const p = (row.payload ?? {}) as Record<string, unknown>;
  const decision = str(p, "decision");
  if (decision !== "accepted" && decision !== "declined") return null;
  return { decision, note: str(p, "note"), decidedByUserId: str(p, "decidedByUserId") ?? row.actorId ?? "", decidedAt: row.eventTime.toISOString(), eventId: row.id };
}

function toRecommendation(row: EvaluationEventRow, decided: EvaluationEventRow | undefined): AgentRecommendationDto | null {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  const kind = p.kind;
  if (!isKind(kind)) return null;
  const evidence = Array.isArray(p.evidence)
    ? (p.evidence as unknown[]).flatMap((e): AgentRecommendationEvidence[] => {
        if (!e || typeof e !== "object") return [];
        const k = (e as Record<string, unknown>).kind;
        const ref = (e as Record<string, unknown>).ref;
        return (k === "card" || k === "event" || k === "case") && typeof ref === "string" ? [{ kind: k, ref }] : [];
      })
    : [];
  return {
    id: row.sourceId,
    companyId: row.companyId,
    agentId: str(p, "agentId") ?? row.subjectAgentId ?? "",
    kind,
    reason: str(p, "reason") ?? "",
    evidence,
    proposalApprovalId: str(p, "proposalApprovalId"),
    recommendedByAgentId: row.actorId ?? "",
    recommendedAt: row.eventTime.toISOString(),
    eventId: row.id,
    advisory: true,
    decision: toDecision(decided),
  };
}

/** Recommendation rows (both phases) the viewer may read, optionally narrowed. Oldest first. */
async function recommendationRows(
  db: ReadDb,
  viewer: EvaluationViewer,
  filter: { agentId?: string; recommendedByAgentId?: string; recommendationId?: string },
): Promise<EvaluationEventRow[]> {
  const conds = [
    eq(evaluationEvents.companyId, viewer.companyId),
    eq(evaluationEvents.eventType, RECOMMENDATION_EVENT),
    eq(evaluationEvents.sourceTable, RECOMMENDATION_SOURCE_TABLE),
  ];
  if (filter.agentId) conds.push(eq(evaluationEvents.subjectAgentId, filter.agentId.toLowerCase()));
  if (filter.recommendationId) conds.push(eq(evaluationEvents.sourceId, filter.recommendationId));
  const access = viewerClassCondition(viewer);
  if (access) conds.push(access);
  const rows = (await db
    .select()
    .from(evaluationEvents)
    .where(and(...conds))
    .orderBy(asc(evaluationEvents.seq))) as EvaluationEventRow[];
  const filterRow = viewerClassFilter(viewer);
  const readable = rows.filter(filterRow);
  if (!filter.recommendedByAgentId) return readable;
  const ids = new Set(readable.filter((r) => r.sourceVersion === "recommended" && r.actorId === filter.recommendedByAgentId).map((r) => r.sourceId));
  return readable.filter((r) => ids.has(r.sourceId));
}

function assemble(rows: EvaluationEventRow[]): AgentRecommendationDto[] {
  const decided = new Map<string, EvaluationEventRow>();
  for (const r of rows) if (r.sourceVersion === "decided") decided.set(r.sourceId, r);
  const out: AgentRecommendationDto[] = [];
  for (const r of rows) {
    if (r.sourceVersion !== "recommended") continue;
    const dto = toRecommendation(r, decided.get(r.sourceId));
    if (dto) out.push(dto);
  }
  return out;
}

/**
 * `GET .../recommendations`: newest first, filtered by the viewer's access
 * classes. `permissions.canDecide` is the decision route's own guard, run by
 * the caller for this viewer. Read-only.
 */
export async function listAgentRecommendations(
  db: ReadDb,
  viewer: EvaluationViewer,
  agentId: string,
  permissions: { canDecide: boolean },
): Promise<AgentRecommendationList> {
  const list = assemble(await recommendationRows(db, viewer, { agentId }));
  list.sort((a, b) => (a.recommendedAt < b.recommendedAt ? 1 : a.recommendedAt > b.recommendedAt ? -1 : a.id < b.id ? 1 : -1));
  return { agentId, recommendations: list, restricted: !viewer.admin, viewer: { canDecide: permissions.canDecide } };
}

function evidenceInvalid(message: string, invalid: AgentRecommendationEvidence[] | string[]) {
  return unprocessable(message, { code: "AGENT_RECOMMENDATION_EVIDENCE_INVALID", invalid });
}

/**
 * File a recommendation (callers check: the effective performance manager,
 * as an agent, about an agent of its company). Every cited `event` must be a
 * ledger event the manager can read, every `card` a stored version of this
 * agent's card, and `proposalApprovalId` an `agent_profile_change` about this
 * agent. The stored access class is the most private class among the cited
 * events (company, or the one restricted project they rest on; events from
 * two restricted projects are refused), so a recommendation is never readable
 * by anyone who could not read the evidence it cites. Appends one ledger event
 * and `evaluation.agent_recommendation_created`, in one transaction. Advisory:
 * nothing else changes.
 */
export async function createAgentRecommendation(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    managerAgentId: string;
    runId: string | null;
    viewer: EvaluationViewer;
    body: CreateAgentRecommendation;
    now?: Date;
  },
): Promise<AgentRecommendationDto> {
  const { companyId, agentId, managerAgentId, viewer, body } = input;
  const ledger = evaluationLedger(db);
  const readable = viewerClassFilter(viewer);

  const invalid: AgentRecommendationEvidence[] = [];
  const eventClasses = new Set<EvaluationAccessClass>();
  for (const item of body.evidence) {
    if (item.kind === "event") {
      const row = await ledger.get(companyId, item.ref);
      // Absent and unreadable look the same: a citation must point at a fact the manager can read.
      if (!row || !readable(row)) invalid.push(item);
      else eventClasses.add(row.accessClass as EvaluationAccessClass);
    } else if (item.kind === "card") {
      const match = /^v?(\d{1,9})$/i.exec(item.ref);
      const version = match ? Number(match[1]) : null;
      const stored = version
        ? await db
            .select({ version: evaluationScorecards.version })
            .from(evaluationScorecards)
            .where(
              and(
                eq(evaluationScorecards.companyId, companyId),
                eq(evaluationScorecards.milestoneKind, AGENT_CARD_SCORECARD_KIND),
                eq(evaluationScorecards.milestoneId, agentId),
                eq(evaluationScorecards.version, version),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;
      if (!stored) invalid.push(item);
    }
    // `case` refs are drill-down case ids, resolved by each reader through their own projection.
  }
  if (invalid.length > 0) {
    throw evidenceInvalid("Some cited evidence does not exist for this agent or is not visible to you", invalid);
  }

  const restricted = [...eventClasses].filter((c) => c !== "company");
  if (restricted.length > 1) {
    throw unprocessable("Cite evidence from one restricted project at a time; file a separate recommendation for each", {
      code: "AGENT_RECOMMENDATION_EVIDENCE_MIXED_CLASSES",
    });
  }
  const accessClass: EvaluationAccessClass = restricted[0] ?? "company";
  const parsedClass = parseEvaluationAccessClass(accessClass);
  const projectId = parsedClass?.kind === "project" ? parsedClass.projectId : null;

  const proposalApprovalId = body.proposalApprovalId ?? null;
  if (proposalApprovalId) {
    const approval = await db
      .select({ type: approvals.type, payload: approvals.payload })
      .from(approvals)
      .where(and(eq(approvals.id, proposalApprovalId), eq(approvals.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    const about = approval?.payload && typeof approval.payload === "object" ? (approval.payload as Record<string, unknown>).agentId : null;
    if (!approval || approval.type !== "agent_profile_change" || about !== agentId) {
      throw unprocessable("proposalApprovalId must be a profile change proposal about this agent", { code: "AGENT_RECOMMENDATION_PROPOSAL_INVALID" });
    }
  }

  const id = randomUUID();
  const now = input.now ?? new Date();
  const evidence = body.evidence.map((e) => ({ kind: e.kind, ref: e.ref }));
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const appended = await evaluationLedger(tx).append([
      {
        companyId,
        projectId,
        actorType: "agent",
        actorId: managerAgentId,
        sourceTable: RECOMMENDATION_SOURCE_TABLE,
        sourceId: id,
        sourceVersion: "recommended",
        eventType: RECOMMENDATION_EVENT,
        eventTime: now,
        accessClass: formatEvaluationAccessClass(parsedClass ?? { kind: "company" }),
        subjectAgentId: agentId,
        payload: {
          phase: "recommended",
          recommendationId: id,
          agentId,
          kind: body.kind,
          reason: body.reason,
          evidence,
          proposalApprovalId,
          advisory: true,
          runId: input.runId,
        },
      },
    ]);
    const eventId = appended.insertedIds[0];
    if (!eventId) throw conflict("The recommendation could not be recorded; try again");
    const publication = await insertActivity(tx, {
      companyId,
      actorType: "agent",
      actorId: managerAgentId,
      agentId,
      runId: input.runId,
      action: "evaluation.agent_recommendation_created",
      entityType: "agent",
      entityId: agentId,
      details: { recommendationId: id, kind: body.kind, eventId, evidenceCount: evidence.length, proposalApprovalId, advisory: true },
    });
    const row = await evaluationLedger(tx).get(companyId, eventId);
    return { row: row!, publication };
  });
  publishActivity(outcome.publication);
  return toRecommendation(outcome.row, undefined)!;
}

/**
 * Record the owner's decision (callers check: a person who is the agent's
 * accountable person or a company admin). The viewer must be able to read the
 * recommendation (otherwise 404). Once only: a second decision is 409.
 * Appends the `decided` ledger event (same class and project as the
 * recommendation) and `evaluation.agent_recommendation_decided`. Changes
 * nothing else — an accepted "pause" does not pause the agent.
 */
export async function decideAgentRecommendation(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    recommendationId: string;
    userId: string;
    viewer: EvaluationViewer;
    body: DecideAgentRecommendation;
    now?: Date;
  },
): Promise<AgentRecommendationDecisionResult> {
  const { companyId, agentId, recommendationId, userId, viewer, body } = input;
  const rows = await recommendationRows(db, viewer, { agentId, recommendationId });
  const recommended = rows.find((r) => r.sourceVersion === "recommended");
  if (!recommended) throw notFound("Recommendation not found");
  if (rows.some((r) => r.sourceVersion === "decided")) {
    throw conflict("This recommendation already has a decision", { code: "AGENT_RECOMMENDATION_ALREADY_DECIDED" });
  }
  const p = (recommended.payload ?? {}) as Record<string, unknown>;
  const now = input.now ?? new Date();
  const note = body.note ?? null;
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const appended = await evaluationLedger(tx).append([
      {
        companyId,
        projectId: recommended.projectId,
        actorType: "user",
        actorId: userId,
        sourceTable: RECOMMENDATION_SOURCE_TABLE,
        sourceId: recommendationId,
        sourceVersion: "decided",
        eventType: RECOMMENDATION_EVENT,
        eventTime: now,
        accessClass: recommended.accessClass as EvaluationAccessClass,
        subjectAgentId: agentId,
        payload: {
          phase: "decided",
          recommendationId,
          agentId,
          kind: p.kind ?? null,
          decision: body.decision,
          note,
          decidedByUserId: userId,
          recommendationEventId: recommended.id,
        },
      },
    ]);
    const eventId = appended.insertedIds[0];
    // The dedupe key (source id + `decided`) makes the decision once only, even under a race.
    if (!eventId) throw conflict("This recommendation already has a decision", { code: "AGENT_RECOMMENDATION_ALREADY_DECIDED" });
    const publication = await insertActivity(tx, {
      companyId,
      actorType: "user",
      actorId: userId,
      agentId,
      action: "evaluation.agent_recommendation_decided",
      entityType: "agent",
      entityId: agentId,
      details: { recommendationId, kind: p.kind ?? null, decision: body.decision, eventId, effect: "none" },
    });
    const row = await evaluationLedger(tx).get(companyId, eventId);
    return { row: row!, publication };
  });
  publishActivity(outcome.publication);
  const recommendation = toRecommendation(recommended, outcome.row)!;
  return {
    recommendation,
    effect: "none",
    next:
      recommendation.kind === "pause" && body.decision === "accepted"
        ? "Recorded. Nothing was paused: to pause the agent, use the agent's pause action."
        : "Recorded. A recommendation changes nothing by itself.",
  };
}

// ---------------------------------------------------------------------------
// The manager's own record
// ---------------------------------------------------------------------------

function emptyTallies(): Record<AgentRecommendationKind, PerformanceManagerRecommendationTally> {
  return Object.fromEntries(AGENT_RECOMMENDATION_KINDS.map((k) => [k, { total: 0, accepted: 0, declined: 0, undecided: 0 }])) as Record<
    AgentRecommendationKind,
    PerformanceManagerRecommendationTally
  >;
}

/** One responsibility's sections of a projected card view. Pure. */
export function responsibilitySections(view: AgentCardView, key: string): PerformanceManagerSectionSnapshot {
  const ob = view.worker.obligations;
  const quality = view.worker.quality;
  const acceptance = view.worker.acceptance;
  return {
    cardVersion: view.stored?.version ?? 0,
    storedAt: view.stored?.storedAt ?? "",
    obligations:
      ob.visibility === "not_visible"
        ? { visibility: "not_visible", note: ob.note }
        : {
            visibility: ob.visibility,
            rows: ob.body.responsibilities
              .filter((r) => r.responsibilityKey === key)
              .map((r) => ({ profileRevisionId: r.profileRevisionId, owed: r.owed, byEndState: { ...r.byEndState }, deliveredItemCount: r.deliveredItemCount })),
          },
    quality:
      quality.visibility === "not_visible"
        ? { visibility: "not_visible", note: quality.note }
        : {
            visibility: quality.visibility,
            criteria: quality.body.criteria
              .filter((c) => c.criterion.responsibilityKey === key)
              .map((c) => ({ criterionId: c.criterion.criterionId, text: c.text, items: c.items, byJudge: { ...c.byJudge } })),
          },
    delivered:
      acceptance.visibility === "not_visible"
        ? { visibility: "not_visible", note: acceptance.note }
        : { visibility: acceptance.visibility, items: acceptance.body.delivered.byResponsibility[key] ?? 0 },
  };
}

function outcomeOf(
  approvalStatus: string,
  revisionState: string | null,
  applicationStatus: string | null,
): PerformanceManagerProposalOutcome {
  if (revisionState === "withdrawn" || approvalStatus === "cancelled") return "withdrawn";
  if (approvalStatus === "rejected") return "rejected";
  if (applicationStatus === "applied") return "applied";
  if (applicationStatus === "failed") return "application_failed";
  if (applicationStatus === "refused_stale") return "refused_stale";
  if (approvalStatus === "approved") return "approved";
  return "pending";
}

/**
 * The manager's record (`GET .../evaluation/performance-manager/record`).
 * Read-only. Proposals: the `agent_profile_change` approvals the manager
 * requested about other agents. Everything about an agent the viewer cannot
 * see is left out (counts included), recommendations (listed oldest first and
 * tallied) follow the viewer's access classes, and card sections are the
 * viewer's own projection.
 */
export async function performanceManagerRecord(
  db: Db,
  input: { companyId: string; managerAgentId: string; viewer: EvaluationViewer; visibleAgentIds: ReadonlySet<string> | null; now?: Date },
): Promise<PerformanceManagerRecord> {
  const { companyId, managerAgentId, viewer, visibleAgentIds } = input;
  const visible = (agentId: string | null | undefined) => !!agentId && (!visibleAgentIds || visibleAgentIds.has(agentId));
  const [manager, resolution] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, managerAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null),
    resolvePerformanceManager(db, companyId),
  ]);

  // ---- proposals ----
  const approvalRows = (
    await db
      .select({ id: approvals.id, status: approvals.status, payload: approvals.payload, createdAt: approvals.createdAt, decidedAt: approvals.decidedAt })
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.type, "agent_profile_change"), eq(approvals.requestedByAgentId, managerAgentId)))
      .orderBy(asc(approvals.createdAt), asc(approvals.id))
  ).filter((a) => {
    const target = (a.payload as Record<string, unknown>)?.agentId;
    return typeof target === "string" && target !== managerAgentId && visible(target);
  });
  const payloadOf = (a: (typeof approvalRows)[number]) => a.payload as Record<string, unknown>;
  const revisionIds = approvalRows.map((a) => payloadOf(a).revisionId).filter((id): id is string => typeof id === "string");
  const approvalIds = approvalRows.map((a) => a.id);
  // Recommendations are read first so the agents they are about are named with the proposals' targets.
  const recs = assemble(await recommendationRows(db, viewer, { recommendedByAgentId: managerAgentId })).filter((r) => visible(r.agentId));
  const targetIds = [...new Set([...approvalRows.map((a) => payloadOf(a).agentId as string), ...recs.map((r) => r.agentId)])];
  const [revisions, applications, ownerEdits, names] = await Promise.all([
    revisionIds.length > 0
      ? db
          .select({ id: agentProfileRevisions.id, state: agentProfileRevisions.state, revisionNumber: agentProfileRevisions.revisionNumber })
          .from(agentProfileRevisions)
          .where(and(eq(agentProfileRevisions.companyId, companyId), inArray(agentProfileRevisions.id, revisionIds)))
      : Promise.resolve([]),
    approvalIds.length > 0
      ? db
          .select({ approvalId: agentProfileApplications.approvalId, status: agentProfileApplications.status, updatedAt: agentProfileApplications.updatedAt, createdAt: agentProfileApplications.createdAt })
          .from(agentProfileApplications)
          .where(and(eq(agentProfileApplications.companyId, companyId), inArray(agentProfileApplications.approvalId, approvalIds)))
          .orderBy(asc(agentProfileApplications.createdAt))
      : Promise.resolve([]),
    revisionIds.length > 0
      ? db
          .selectDistinct({ entityId: activityLog.entityId })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.action, "agent_profile.draft_saved"),
              eq(activityLog.entityType, "agent_profile_revision"),
              eq(activityLog.actorType, "user"),
              inArray(activityLog.entityId, revisionIds),
            ),
          )
      : Promise.resolve([]),
    targetIds.length > 0
      ? db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, targetIds)))
      : Promise.resolve([]),
  ]);
  const revisionById = new Map(revisions.map((r) => [r.id, r]));
  const applicationByApproval = new Map<string, { status: string; at: Date }>();
  for (const a of applications) if (a.approvalId) applicationByApproval.set(a.approvalId, { status: a.status, at: a.updatedAt });
  const edited = new Set(ownerEdits.map((r) => r.entityId));
  const nameById = new Map(names.map((n) => [n.id, n.name]));

  const items: PerformanceManagerProposalItem[] = approvalRows.map((a) => {
    const p = payloadOf(a);
    const revisionId = String(p.revisionId ?? "");
    const revision = revisionById.get(revisionId) ?? null;
    const application = applicationByApproval.get(a.id) ?? null;
    const agentId = String(p.agentId);
    return {
      approvalId: a.id,
      agentId,
      agentName: nameById.get(agentId) ?? null,
      revisionId,
      revisionNumber: revision?.revisionNumber ?? (typeof p.revisionNumber === "number" ? p.revisionNumber : 0),
      filedAt: a.createdAt.toISOString(),
      approvalStatus: a.status,
      outcome: outcomeOf(a.status, revision?.state ?? null, application?.status ?? null),
      editedByOwnerBeforeDeciding: edited.has(revisionId),
      decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
      affectedResponsibilities: Array.isArray(p.affectedResponsibilities) ? (p.affectedResponsibilities as unknown[]).filter((k): k is string => typeof k === "string") : [],
    };
  });
  const count = (pred: (i: PerformanceManagerProposalItem) => boolean) => items.filter(pred).length;
  const approvedOutcomes = new Set<PerformanceManagerProposalOutcome>(["approved", "applied", "application_failed", "refused_stale"]);

  // ---- recommendations (read above) ----
  const byKind = emptyTallies();
  for (const r of recs) {
    const t = byKind[r.kind];
    t.total += 1;
    if (r.decision?.decision === "accepted") t.accepted += 1;
    else if (r.decision?.decision === "declined") t.declined += 1;
    else t.undecided += 1;
  }
  const recommendationItems: PerformanceManagerRecommendationItem[] = recs.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentName: nameById.get(r.agentId) ?? null,
    kind: r.kind,
    at: r.recommendedAt,
    decision: r.decision?.decision ?? null,
    decidedAt: r.decision?.decidedAt ?? null,
  }));

  // ---- applied: before/after card sections ----
  const cards = agentCardService(db);
  const applied: PerformanceManagerAppliedItem[] = [];
  for (const item of items) {
    if (item.outcome !== "applied") continue;
    const appliedAt = applicationByApproval.get(item.approvalId)!.at;
    const versions = await db
      .select({ version: evaluationScorecards.version, createdAt: evaluationScorecards.createdAt })
      .from(evaluationScorecards)
      .where(
        and(
          eq(evaluationScorecards.companyId, companyId),
          eq(evaluationScorecards.milestoneKind, AGENT_CARD_SCORECARD_KIND),
          eq(evaluationScorecards.milestoneId, item.agentId),
        ),
      )
      .orderBy(asc(evaluationScorecards.version));
    const beforeRow = [...versions].reverse().find((v) => v.createdAt.getTime() <= appliedAt.getTime()) ?? null;
    const afterRow = versions.find((v) => v.createdAt.getTime() > appliedAt.getTime()) ?? null;
    const [beforeView, afterView] = await Promise.all([
      beforeRow ? cards.getAgentCard(viewer, item.agentId, { version: beforeRow.version }) : Promise.resolve(null),
      afterRow ? cards.getAgentCard(viewer, item.agentId, { version: afterRow.version }) : Promise.resolve(null),
    ]);
    applied.push({
      approvalId: item.approvalId,
      agentId: item.agentId,
      agentName: item.agentName,
      revisionId: item.revisionId,
      appliedAt: appliedAt.toISOString(),
      affectedResponsibilities: item.affectedResponsibilities,
      before: beforeView?.stored ? { version: beforeView.stored.version, storedAt: beforeView.stored.storedAt } : null,
      after: afterView?.stored ? { version: afterView.stored.version, storedAt: afterView.stored.storedAt } : null,
      sections: item.affectedResponsibilities.map((key) => ({
        responsibilityKey: key,
        before: beforeView ? responsibilitySections(beforeView, key) : null,
        after: afterView ? responsibilitySections(afterView, key) : null,
      })),
    });
  }

  return {
    kind: "performance_manager_record",
    companyId,
    managerAgentId: manager?.id ?? managerAgentId,
    managerName: manager?.name ?? null,
    isEffectiveManager: resolution?.effective?.agentId === managerAgentId,
    generatedAt: (input.now ?? new Date()).toISOString(),
    proposals: {
      filed: items.length,
      pending: count((i) => i.outcome === "pending"),
      approved: count((i) => approvedOutcomes.has(i.outcome)),
      rejected: count((i) => i.outcome === "rejected"),
      withdrawn: count((i) => i.outcome === "withdrawn"),
      editedByOwnerBeforeDeciding: count((i) => i.editedByOwnerBeforeDeciding),
      applied: count((i) => i.outcome === "applied"),
      items,
    },
    recommendations: { total: recs.length, byKind, items: recommendationItems },
    applied,
    restricted: !viewer.admin || visibleAgentIds !== null,
    note: PERFORMANCE_MANAGER_RECORD_NOTE,
  };
}
