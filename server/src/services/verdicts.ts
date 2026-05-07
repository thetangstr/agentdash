// AgentDash: goals-eval-hitl
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  goals,
  issueExecutionDecisions,
  issues,
  projects,
  verdicts,
} from "@paperclipai/db";
import {
  VERDICT_CLOSING_OUTCOMES,
  createVerdictInputSchema,
  definitionOfDoneSchema,
  goalMetricDefinitionSchema,
  type CreateVerdictInput,
  type DefinitionOfDone,
  type GoalMetricDefinition,
  type VerdictEntityType,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

export type VerdictRow = typeof verdicts.$inferSelect;

const CLOSING_OUTCOMES: readonly string[] = VERDICT_CLOSING_OUTCOMES;
const IN_FLIGHT_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

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
export function verdictsService(db: Db) {
  async function loadIssue(companyId: string, issueId: string) {
    const row = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
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

  async function assertNeutralValidator(input: CreateVerdictInput): Promise<void> {
    const NEUTRAL_VIOLATION_MSG = "reviewer must not be the assignee";

    if (input.entityType === "issue") {
      const issue = await loadIssue(input.companyId, input.issueId!);
      if (
        input.reviewerAgentId &&
        issue.assigneeAgentId &&
        input.reviewerAgentId === issue.assigneeAgentId
      ) {
        throw conflict(NEUTRAL_VIOLATION_MSG, { code: "NEUTRAL_VALIDATOR_VIOLATION" });
      }
      if (
        input.reviewerUserId &&
        issue.assigneeUserId &&
        input.reviewerUserId === issue.assigneeUserId
      ) {
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

  async function create(input: CreateVerdictInput): Promise<VerdictRow> {
    const parsed = createVerdictInputSchema.safeParse(input);
    if (!parsed.success) {
      throw badRequest("Invalid verdict input", {
        code: "VERDICT_INPUT_INVALID",
        issues: parsed.error.issues,
      });
    }
    const data = parsed.data;

    await assertNeutralValidator(data);

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
          inArray(verdicts.outcome, CLOSING_OUTCOMES as string[]),
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
            inArray(verdicts.outcome, CLOSING_OUTCOMES as string[]),
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
      actorType: "system",
      actorId: "verdicts_service",
      action: "dod_set",
      entityType: "project",
      entityId: projectId,
      details: { definitionOfDone: parsed.data },
    });

    return updated[0]!;
  }

  async function setIssueDoD(
    companyId: string,
    issueId: string,
    dod: DefinitionOfDone,
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
      actorType: "system",
      actorId: "verdicts_service",
      action: "dod_set",
      entityType: "issue",
      entityId: issueId,
      details: { definitionOfDone: parsed.data },
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
