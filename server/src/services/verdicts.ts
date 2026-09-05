// AgentDash: goals-eval-hitl
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  goals,
  issueExecutionDecisions,
  issues,
  projects,
  verdicts,
} from "@paperclipai/db";
import {
  VERDICT_COVERED_OUTCOMES,
  VERDICT_INDEXED_OUTCOMES,
  createVerdictInputSchema,
  definitionOfDoneSchema,
  goalMetricDefinitionSchema,
  type CreateVerdictInput,
  type DefinitionOfDone,
  type GoalMetricDefinition,
  type VerdictEntityType,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { logActivity, logAuthzRefusal } from "./activity-log.js";
import type { approvalService } from "./approvals.js";
import type { issueApprovalService } from "./issue-approvals.js";

export type VerdictRow = typeof verdicts.$inferSelect;

/**
 * AGE-91: stand-in request for service-level `create` callers that have no
 * HTTP context. Its actor is `none`, which `logAuthzRefusal` treats as
 * "unauthenticated" and skips — so internal refusals stay unlogged, exactly
 * as the issue specifies for anonymous requests.
 */
function anonymousRequest(): Request {
  return { method: "POST", url: "", originalUrl: "", actor: { type: "none" } } as unknown as Request;
}

/**
 * Runtime "loop closed" outcomes (`passed` | `failed`). Used by the coverage
 * filter and by `closingVerdictFor` for idempotency checks. Note: this is a
 * STRICT SUBSET of {@link VERDICT_INDEXED_OUTCOMES}, which the partial index
 * `verdicts_closing_idx` (migration 0080) covers. The index is intentionally
 * a superset so we can also quickly find open `escalated_to_human` rows; do
 * NOT relax the runtime filter to match it.
 */
const COVERED_OUTCOMES: readonly string[] = VERDICT_COVERED_OUTCOMES;
const IN_FLIGHT_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
// Reference the indexed-outcome constant so the import is preserved as a
// signpost — code reading this file should see both constants together.
void VERDICT_INDEXED_OUTCOMES;

interface CoverageBreakdownRow {
  projectId: string | null;
  totalInFlight: number;
  coveredInFlight: number;
  coverageRatio: number;
}

export interface CoverageResult {
  totalInFlight: number;
  coveredInFlight: number;
  coverageRatio: number;
  byProject?: CoverageBreakdownRow[];
}

export interface IssueReviewTimelineRow {
  source: "execution_decision" | "verdict";
  rowId: string;
  createdAt: Date;
  outcome: string;
  body: string | null;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  rubricScores: Record<string, unknown> | null;
}

function actorForReviewer(input: { reviewerAgentId?: string; reviewerUserId?: string }): {
  actorType: "agent" | "user";
  actorId: string;
} {
  if (input.reviewerAgentId) return { actorType: "agent", actorId: input.reviewerAgentId };
  if (input.reviewerUserId) return { actorType: "user", actorId: input.reviewerUserId };
  throw badRequest("Verdict requires reviewerAgentId or reviewerUserId");
}

function entityIdFor(input: CreateVerdictInput): string {
  if (input.entityType === "goal") return input.goalId!;
  if (input.entityType === "project") return input.projectId!;
  return input.issueId!;
}

/**
 * Verdict service — polymorphic across goal/project/issue.
 *
 * Service-layer guarantees (per ADR Consequences):
 *  - Neutral-validator guard runs BEFORE insert. CoS prompt advice about
 *    reviewer eligibility is advisory; this guard is authoritative.
 *  - Company-scope is enforced on every write/read.
 *  - Schema CHECK constraints (exactly-one entity FK / exactly-one reviewer)
 *    are trusted; on DB rejection the error is surfaced as VERDICT_SHAPE_INVALID.
 */
export interface VerdictsServiceDeps {
  approvalsService?: ReturnType<typeof approvalService>;
  issueApprovalsService?: ReturnType<typeof issueApprovalService>;
}

export function verdictsService(db: Db, deps?: VerdictsServiceDeps) {
  async function loadIssue(companyId: string, issueId: string) {
    const row = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        // Included so setIssueDoD can record the prior DoD in dod_set activity.
        definitionOfDone: issues.definitionOfDone,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Issue not found");
    if (row.companyId !== companyId) {
      throw unprocessable("Issue does not belong to the requested company");
    }
    return row;
  }

  async function loadProject(companyId: string, projectId: string) {
    const row = await db
      .select({
        id: projects.id,
        companyId: projects.companyId,
        leadAgentId: projects.leadAgentId,
        // Included so setProjectDoD can record the prior DoD in dod_set activity.
        definitionOfDone: projects.definitionOfDone,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Project not found");
    if (row.companyId !== companyId) {
      throw unprocessable("Project does not belong to the requested company");
    }
    return row;
  }

  async function loadGoal(companyId: string, goalId: string) {
    const row = await db
      .select({
        id: goals.id,
        companyId: goals.companyId,
        ownerAgentId: goals.ownerAgentId,
      })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Goal not found");
    if (row.companyId !== companyId) {
      throw unprocessable("Goal does not belong to the requested company");
    }
    return row;
  }

  /**
   * AGE-91: a refused self-review leaves a record. The guard still throws the
   * exact same 409 — the log is written before the throw, best-effort, so a
   * logging failure can never change the response.
   */
  async function assertNeutralValidator(
    input: CreateVerdictInput,
    req: Request,
  ): Promise<void> {
    const NEUTRAL_VIOLATION_MSG = "reviewer must not be the assignee";

    const refusal = (): void => {
      try {
        void Promise.resolve(
          logAuthzRefusal(db, {
            req,
            companyId: input.companyId,
            entityType: input.entityType,
            entityId: entityIdFor(input),
            reasonCode: "NEUTRAL_VALIDATOR_VIOLATION",
          }),
        ).catch(() => {});
      } catch {
        // Best-effort: a missing/stubbed logger or a failed insert must never
        // change the thrown 409.
      }
    };

    if (input.entityType === "issue") {
      const issue = await loadIssue(input.companyId, input.issueId!);
      if (
        input.reviewerAgentId &&
        issue.assigneeAgentId &&
        input.reviewerAgentId === issue.assigneeAgentId
      ) {
        refusal();
        throw conflict(NEUTRAL_VIOLATION_MSG, { code: "NEUTRAL_VALIDATOR_VIOLATION" });
      }
      if (
        input.reviewerUserId &&
        issue.assigneeUserId &&
        input.reviewerUserId === issue.assigneeUserId
      ) {
        refusal();
        throw conflict(NEUTRAL_VIOLATION_MSG, { code: "NEUTRAL_VALIDATOR_VIOLATION" });
      }
      return;
    }

    if (input.entityType === "project") {
      const project = await loadProject(input.companyId, input.projectId!);
      if (
        input.reviewerAgentId &&
        project.leadAgentId &&
        input.reviewerAgentId === project.leadAgentId
      ) {
        refusal();
        throw conflict(NEUTRAL_VIOLATION_MSG, { code: "NEUTRAL_VALIDATOR_VIOLATION" });
      }
      return;
    }

    if (input.entityType === "goal") {
      const goal = await loadGoal(input.companyId, input.goalId!);
      if (
        input.reviewerAgentId &&
        goal.ownerAgentId &&
        input.reviewerAgentId === goal.ownerAgentId
      ) {
        refusal();
        throw conflict(NEUTRAL_VIOLATION_MSG, { code: "NEUTRAL_VALIDATOR_VIOLATION" });
      }
      return;
    }
  }

  function normalizeShapeError(err: unknown): never {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("verdicts_entity_target_check") ||
      message.includes("verdicts_reviewer_xor_check")
    ) {
      throw unprocessable("Verdict shape invalid", {
        code: "VERDICT_SHAPE_INVALID",
        cause: message,
      });
    }
    throw err;
  }

  /**
   * AGE-91: optional per-call HTTP context. When the caller (the verdict
   * routes) passes the current request, a refused self-review is recorded as
   * an `authz.refused` activity row attributed to the authenticated actor.
   * Service-level callers (orchestrators, bridges) omit it and behave exactly
   * as before — no request, no refusal row, response unchanged either way.
   */
  async function create(
    input: CreateVerdictInput,
    httpContext?: { req: Request },
  ): Promise<VerdictRow> {
    const req: Request = httpContext?.req ?? anonymousRequest();
    const parsed = createVerdictInputSchema.safeParse(input);
    if (!parsed.success) {
      throw badRequest("Invalid verdict input", {
        code: "VERDICT_INPUT_INVALID",
        issues: parsed.error.issues,
      });
    }
    const data = parsed.data;

    await assertNeutralValidator(data, req);

    const actor = actorForReviewer(data);

    let inserted: VerdictRow;
    try {
      const result = await db
        .insert(verdicts)
        .values({
          companyId: data.companyId,
          entityType: data.entityType,
          goalId: data.goalId ?? null,
          projectId: data.projectId ?? null,
          issueId: data.issueId ?? null,
          reviewerAgentId: data.reviewerAgentId ?? null,
          reviewerUserId: data.reviewerUserId ?? null,
          outcome: data.outcome,
          rubricScores: (data.rubricScores ?? null) as Record<string, unknown> | null,
          justification: data.justification ?? null,
        })
        .returning();
      inserted = result[0]!;
    } catch (err) {
      normalizeShapeError(err);
    }

    await logActivity(db, {
      companyId: data.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "verdict_recorded",
      entityType: data.entityType,
      entityId: entityIdFor(data),
      agentId: data.reviewerAgentId ?? null,
      details: {
        verdictId: inserted!.id,
        entityType: data.entityType,
        entityId: entityIdFor(data),
        outcome: data.outcome,
        reviewerAgentId: data.reviewerAgentId ?? null,
        reviewerUserId: data.reviewerUserId ?? null,
        justification: data.justification ? data.justification.slice(0, 200) : null,
      },
    });

    // Fix #179: Auto-create the verdict_escalation approval when the verdict
    // outcome is escalated_to_human. Without this, the verdict-approval bridge
    // has nothing to listen for — the escalation loop is silently dropped.
    // Backward-compat: when deps are not provided (e.g. in unit tests that
    // don't wire approvals), the auto-create is skipped.
    if (
      data.outcome === "escalated_to_human" &&
      deps?.approvalsService &&
      data.entityType === "issue" &&
      data.issueId
    ) {
      const requestedBy: { requestedByAgentId?: string; requestedByUserId?: string } = {};
      if (data.reviewerAgentId) requestedBy.requestedByAgentId = data.reviewerAgentId;
      else if (data.reviewerUserId) requestedBy.requestedByUserId = data.reviewerUserId;

      const approval = await deps.approvalsService.create(data.companyId, {
        type: "verdict_escalation",
        ...requestedBy,
        status: "pending",
        payload: {
          type: "verdict_escalation",
          verdictId: inserted!.id,
          issueId: data.issueId,
          justification: data.justification ?? null,
        } as Record<string, unknown>,
      });

      if (deps.issueApprovalsService && approval) {
        await deps.issueApprovalsService.link(data.issueId, approval.id, {
          agentId: data.reviewerAgentId ?? null,
          userId: data.reviewerUserId ?? null,
        });
      }

      await logActivity(db, {
        companyId: data.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "escalated_to_human",
        entityType: data.entityType,
        entityId: entityIdFor(data),
        agentId: data.reviewerAgentId ?? null,
        details: {
          verdictId: inserted!.id,
          approvalId: approval?.id ?? null,
          issueId: data.issueId,
          reason: data.justification ?? null,
        },
      });
    }

    return inserted!;
  }

  function entityFkColumn(entityType: VerdictEntityType) {
    if (entityType === "goal") return verdicts.goalId;
    if (entityType === "project") return verdicts.projectId;
    return verdicts.issueId;
  }

  async function listForEntity(
    companyId: string,
    entityType: VerdictEntityType,
    entityId: string,
  ): Promise<VerdictRow[]> {
    const fk = entityFkColumn(entityType);
    return db
      .select()
      .from(verdicts)
      .where(
        and(
          eq(verdicts.companyId, companyId),
          eq(verdicts.entityType, entityType),
          eq(fk, entityId),
        ),
      )
      .orderBy(asc(verdicts.createdAt));
  }

  async function closingVerdictFor(
    companyId: string,
    entityType: VerdictEntityType,
    entityId: string,
  ): Promise<VerdictRow | null> {
    const fk = entityFkColumn(entityType);
    return db
      .select()
      .from(verdicts)
      .where(
        and(
          eq(verdicts.companyId, companyId),
          eq(verdicts.entityType, entityType),
          eq(fk, entityId),
          inArray(verdicts.outcome, COVERED_OUTCOMES as string[]),
        ),
      )
      .orderBy(desc(verdicts.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function coverage(
    companyId: string,
    options?: { includeBreakdown?: boolean },
  ): Promise<CoverageResult> {
    // In-flight issues = issues NOT in (done, cancelled).
    const inFlightRows = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        goalId: issues.goalId,
        definitionOfDone: issues.definitionOfDone,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.status, IN_FLIGHT_ISSUE_STATUSES as unknown as string[]),
        ),
      );

    const totalInFlight = inFlightRows.length;
    if (totalInFlight === 0) {
      return {
        totalInFlight: 0,
        coveredInFlight: 0,
        coverageRatio: 0,
        ...(options?.includeBreakdown ? { byProject: [] } : {}),
      };
    }

    const eligibleIssueIds = inFlightRows
      .filter((row) => row.goalId !== null && row.definitionOfDone !== null)
      .map((row) => row.id);

    let coveredIssueIds = new Set<string>();
    if (eligibleIssueIds.length > 0) {
      const closingRows = await db
        .select({ issueId: verdicts.issueId })
        .from(verdicts)
        .where(
          and(
            eq(verdicts.companyId, companyId),
            eq(verdicts.entityType, "issue"),
            inArray(verdicts.issueId, eligibleIssueIds),
            inArray(verdicts.outcome, COVERED_OUTCOMES as string[]),
          ),
        );
      coveredIssueIds = new Set(
        closingRows.map((row) => row.issueId).filter((id): id is string => Boolean(id)),
      );
    }

    const coveredInFlight = coveredIssueIds.size;
    const coverageRatio = totalInFlight === 0 ? 0 : coveredInFlight / totalInFlight;

    if (!options?.includeBreakdown) {
      return { totalInFlight, coveredInFlight, coverageRatio };
    }

    const byProjectMap = new Map<string | null, { total: number; covered: number }>();
    for (const row of inFlightRows) {
      const key = row.projectId ?? null;
      const bucket = byProjectMap.get(key) ?? { total: 0, covered: 0 };
      bucket.total += 1;
      if (coveredIssueIds.has(row.id)) bucket.covered += 1;
      byProjectMap.set(key, bucket);
    }
    const byProject: CoverageBreakdownRow[] = [];
    for (const [projectId, bucket] of byProjectMap.entries()) {
      byProject.push({
        projectId,
        totalInFlight: bucket.total,
        coveredInFlight: bucket.covered,
        coverageRatio: bucket.total === 0 ? 0 : bucket.covered / bucket.total,
      });
    }

    return { totalInFlight, coveredInFlight, coverageRatio, byProject };
  }

  async function issueReviewTimeline(
    companyId: string,
    issueId: string,
  ): Promise<IssueReviewTimelineRow[]> {
    // Verify issue belongs to company before exposing data.
    await loadIssue(companyId, issueId);

    // Hand-written UNION ALL across the two source tables. The migration ships
    // SQL view `issue_review_timeline_v` (Phase A8); we don't depend on it
    // here so the service stays driver-portable and tested without view DDL.
    const decisionRows = await db
      .select({
        rowId: issueExecutionDecisions.id,
        createdAt: issueExecutionDecisions.createdAt,
        outcome: issueExecutionDecisions.outcome,
        body: issueExecutionDecisions.body,
        reviewerAgentId: issueExecutionDecisions.actorAgentId,
        reviewerUserId: issueExecutionDecisions.actorUserId,
      })
      .from(issueExecutionDecisions)
      .where(
        and(
          eq(issueExecutionDecisions.companyId, companyId),
          eq(issueExecutionDecisions.issueId, issueId),
        ),
      );

    const verdictRows = await db
      .select({
        rowId: verdicts.id,
        createdAt: verdicts.createdAt,
        outcome: verdicts.outcome,
        justification: verdicts.justification,
        reviewerAgentId: verdicts.reviewerAgentId,
        reviewerUserId: verdicts.reviewerUserId,
        rubricScores: verdicts.rubricScores,
      })
      .from(verdicts)
      .where(
        and(
          eq(verdicts.companyId, companyId),
          eq(verdicts.entityType, "issue"),
          eq(verdicts.issueId, issueId),
        ),
      );

    const merged: IssueReviewTimelineRow[] = [
      ...decisionRows.map<IssueReviewTimelineRow>((row) => ({
        source: "execution_decision",
        rowId: row.rowId,
        createdAt: row.createdAt,
        outcome: row.outcome,
        body: row.body,
        reviewerAgentId: row.reviewerAgentId,
        reviewerUserId: row.reviewerUserId,
        rubricScores: null,
      })),
      ...verdictRows.map<IssueReviewTimelineRow>((row) => ({
        source: "verdict",
        rowId: row.rowId,
        createdAt: row.createdAt,
        outcome: row.outcome,
        body: row.justification ?? null,
        reviewerAgentId: row.reviewerAgentId,
        reviewerUserId: row.reviewerUserId,
        rubricScores: (row.rubricScores ?? null) as Record<string, unknown> | null,
      })),
    ];

    merged.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return merged;
  }

  // -------------------------------------------------------------------------
  // DoD setter helpers (Phase D routes will call these).
  // -------------------------------------------------------------------------

  async function setGoalMetricDefinition(
    companyId: string,
    goalId: string,
    def: GoalMetricDefinition,
  ): Promise<typeof goals.$inferSelect> {
    const parsed = goalMetricDefinitionSchema.safeParse(def);
    if (!parsed.success) {
      throw badRequest("Invalid metric definition", {
        code: "METRIC_DEFINITION_INVALID",
        issues: parsed.error.issues,
      });
    }
    const goal = await loadGoal(companyId, goalId);
    const updated = await db
      .update(goals)
      .set({
        metricDefinition: parsed.data as GoalMetricDefinition,
        updatedAt: new Date(),
      })
      .where(eq(goals.id, goal.id))
      .returning();

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "verdicts_service",
      action: "metric_updated",
      entityType: "goal",
      entityId: goalId,
      details: { metricDefinition: parsed.data },
    });

    return updated[0]!;
  }

  async function setProjectDoD(
    companyId: string,
    projectId: string,
    dod: DefinitionOfDone,
    actor?: { actorType: "agent" | "user"; actorId: string; agentId: string | null },
  ): Promise<typeof projects.$inferSelect> {
    const parsed = definitionOfDoneSchema.safeParse(dod);
    if (!parsed.success) {
      throw badRequest("Invalid definition of done", {
        code: "DOD_INVALID",
        issues: parsed.error.issues,
      });
    }
    const project = await loadProject(companyId, projectId);
    const updated = await db
      .update(projects)
      .set({
        definitionOfDone: parsed.data as DefinitionOfDone,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id))
      .returning();

    await logActivity(db, {
      companyId,
      // AgentDash: goals-eval-hitl — the evaluator needs to know WHO set a DoD
      // (to detect narrowing after an item leaves backlog), so record the real
      // request actor when the route provides one; programmatic callers without
      // an actor fall back to the service identity.
      actorType: actor?.actorType ?? "system",
      actorId: actor?.actorId ?? "verdicts_service",
      agentId: actor?.agentId ?? null,
      action: "dod_set",
      entityType: "project",
      entityId: projectId,
      details: {
        definitionOfDone: parsed.data,
        _previous: project.definitionOfDone ?? null,
      },
    });

    return updated[0]!;
  }

  async function setIssueDoD(
    companyId: string,
    issueId: string,
    dod: DefinitionOfDone,
    actor?: { actorType: "agent" | "user"; actorId: string; agentId: string | null },
  ): Promise<typeof issues.$inferSelect> {
    const parsed = definitionOfDoneSchema.safeParse(dod);
    if (!parsed.success) {
      throw badRequest("Invalid definition of done", {
        code: "DOD_INVALID",
        issues: parsed.error.issues,
      });
    }
    const issue = await loadIssue(companyId, issueId);
    const updated = await db
      .update(issues)
      .set({
        definitionOfDone: parsed.data as DefinitionOfDone,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id))
      .returning();

    await logActivity(db, {
      companyId,
      // AgentDash: goals-eval-hitl — the evaluator needs to know WHO set a DoD
      // (to detect narrowing after an item leaves backlog), so record the real
      // request actor when the route provides one; programmatic callers without
      // an actor fall back to the service identity.
      actorType: actor?.actorType ?? "system",
      actorId: actor?.actorId ?? "verdicts_service",
      agentId: actor?.agentId ?? null,
      action: "dod_set",
      entityType: "issue",
      entityId: issueId,
      details: {
        definitionOfDone: parsed.data,
        _previous: issue.definitionOfDone ?? null,
      },
    });

    return updated[0]!;
  }

  return {
    create,
    listForEntity,
    closingVerdictFor,
    coverage,
    issueReviewTimeline,
    setGoalMetricDefinition,
    setProjectDoD,
    setIssueDoD,
  };
}

export type VerdictsService = ReturnType<typeof verdictsService>;

// Suppress unused-import lint until callers wire in Phase D / C2.
void isNotNull;
void sql;
