import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  researchCycles,
  hypotheses,
  experiments,
  metricDefinitions,
  measurements,
  evaluations,
} from "@agentdash/db";
import { notFound } from "../errors.js";

export function autoresearchService(db: Db) {
  // ---------------------------------------------------------------------------
  // Research Cycles
  // ---------------------------------------------------------------------------

  async function createCycle(
    companyId: string,
    data: {
      goalId: string;
      projectId?: string;
      title: string;
      description?: string;
      ownerAgentId?: string;
      maxIterations?: number;
      createdByAgentId?: string;
      createdByUserId?: string;
    },
  ) {
    return db
      .insert(researchCycles)
      .values({ ...data, companyId, startedAt: new Date() })
      .returning()
      .then((rows) => rows[0]);
  }

  async function listCycles(companyId: string, status?: string) {
    const conditions = [eq(researchCycles.companyId, companyId)];
    if (status) conditions.push(eq(researchCycles.status, status));

    return db
      .select()
      .from(researchCycles)
      .where(and(...conditions))
      .orderBy(desc(researchCycles.createdAt));
  }

  async function getCycleById(id: string) {
    const row = await db
      .select()
      .from(researchCycles)
      .where(eq(researchCycles.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Research cycle not found");
    return row;
  }

  async function updateCycle(
    id: string,
    data: Partial<Pick<typeof researchCycles.$inferInsert, "status" | "title" | "description" | "currentIteration">>,
  ) {
    const row = await db
      .update(researchCycles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(researchCycles.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Research cycle not found");
    return row;
  }

  // ---------------------------------------------------------------------------
  // Hypotheses
  // ---------------------------------------------------------------------------

  async function createHypothesis(
    companyId: string,
    data: {
      cycleId: string;
      parentHypothesisId?: string;
      title: string;
      rationale?: string;
      source?: string;
      sourceContext?: Record<string, unknown>;
      priority?: number;
      createdByAgentId?: string;
      createdByUserId?: string;
    },
  ) {
    return db
      .insert(hypotheses)
      .values({ ...data, companyId })
      .returning()
      .then((rows) => rows[0]);
  }

  async function listHypotheses(cycleId: string, status?: string) {
    const conditions = [eq(hypotheses.cycleId, cycleId)];
    if (status) conditions.push(eq(hypotheses.status, status));

    return db
      .select()
      .from(hypotheses)
      .where(and(...conditions))
      .orderBy(desc(hypotheses.priority), desc(hypotheses.createdAt));
  }

  async function updateHypothesis(
    id: string,
    data: Partial<Pick<typeof hypotheses.$inferInsert, "status" | "priority" | "approvedByUserId" | "approvedAt">>,
  ) {
    const row = await db
      .update(hypotheses)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(hypotheses.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Hypothesis not found");
    return row;
  }

  // ---------------------------------------------------------------------------
  // Experiments
  // ---------------------------------------------------------------------------

  async function createExperiment(
    companyId: string,
    data: {
      cycleId: string;
      hypothesisId: string;
      projectId?: string;
      issueId?: string;
      title: string;
      description?: string;
      successCriteria: Array<{ metricKey: string; comparator: string; targetValue: number; baselineValue?: number }>;
      budgetCapCents?: number;
      timeLimitHours?: number;
      rollbackTrigger?: Array<{ metricKey: string; comparator: string; threshold: number }>;
      createdByAgentId?: string;
      createdByUserId?: string;
    },
  ) {
    return db
      .insert(experiments)
      .values({ ...data, companyId })
      .returning()
      .then((rows) => rows[0]);
  }

  async function listExperiments(cycleId: string, status?: string) {
    const conditions = [eq(experiments.cycleId, cycleId)];
    if (status) conditions.push(eq(experiments.status, status));

    return db
      .select()
      .from(experiments)
      .where(and(...conditions))
      .orderBy(desc(experiments.createdAt));
  }

  async function getExperimentById(id: string) {
    const row = await db
      .select()
      .from(experiments)
      .where(eq(experiments.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Experiment not found");
    return row;
  }

  async function updateExperiment(
    id: string,
    data: Partial<
      Pick<
        typeof experiments.$inferInsert,
        "status" | "startedAt" | "measuringAt" | "completedAt" | "abortedAt" | "abortReason" | "approvalId"
      >
    >,
  ) {
    const row = await db
      .update(experiments)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(experiments.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Experiment not found");
    return row;
  }

  async function abortExperiment(id: string, reason: string) {
    const row = await db
      .update(experiments)
      .set({
        status: "aborted",
        abortedAt: new Date(),
        abortReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(experiments.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Experiment not found");
    return row;
  }

  // ---------------------------------------------------------------------------
  // Metric Definitions
  // ---------------------------------------------------------------------------

  async function createMetricDefinition(
    companyId: string,
    data: {
      key: string;
      displayName: string;
      description?: string;
      unit?: string;
      dataSourceType: string;
      dataSourceConfig?: Record<string, unknown>;
      aggregation?: string;
      collectionMethod?: string;
      pollIntervalMinutes?: number;
      pluginId?: string;
      createdByUserId?: string;
    },
  ) {
    return db
      .insert(metricDefinitions)
      .values({ ...data, companyId })
      .returning()
      .then((rows) => rows[0]);
  }

  async function listMetricDefinitions(companyId: string) {
    return db
      .select()
      .from(metricDefinitions)
      .where(eq(metricDefinitions.companyId, companyId));
  }

  async function getMetricDefinitionById(id: string) {
    const row = await db
      .select()
      .from(metricDefinitions)
      .where(eq(metricDefinitions.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Metric definition not found");
    return row;
  }

  async function updateMetricDefinition(
    id: string,
    data: Partial<typeof metricDefinitions.$inferInsert>,
  ) {
    const row = await db
      .update(metricDefinitions)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(metricDefinitions.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Metric definition not found");
    return row;
  }

  // ---------------------------------------------------------------------------
  // Measurements
  // ---------------------------------------------------------------------------

  async function recordMeasurement(
    companyId: string,
    data: {
      metricDefinitionId: string;
      experimentId?: string;
      cycleId?: string;
      value: number;
      rawData?: Record<string, unknown>;
      sampleSize?: number;
      confidenceInterval?: { lower: number; upper: number; confidenceLevel: number };
      collectedAt: Date;
      collectionMethod: string;
      dataSourceSnapshot?: Record<string, unknown>;
    },
  ) {
    return db
      .insert(measurements)
      .values({ ...data, companyId })
      .returning()
      .then((rows) => rows[0]);
  }

  async function listMeasurements(experimentId: string) {
    return db
      .select()
      .from(measurements)
      .where(eq(measurements.experimentId, experimentId))
      .orderBy(asc(measurements.collectedAt));
  }

  async function getMetricTimeSeries(
    companyId: string,
    metricKey: string,
    opts?: { days?: number },
  ) {
    const days = opts?.days ?? 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const def = await db
      .select()
      .from(metricDefinitions)
      .where(
        and(
          eq(metricDefinitions.companyId, companyId),
          eq(metricDefinitions.key, metricKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!def) throw notFound("Metric definition not found");

    const rows = await db
      .select({
        value: measurements.value,
        collectedAt: measurements.collectedAt,
      })
      .from(measurements)
      .where(
        and(
          eq(measurements.companyId, companyId),
          eq(measurements.metricDefinitionId, def.id),
          gte(measurements.collectedAt, since),
        ),
      )
      .orderBy(asc(measurements.collectedAt));

    return rows;
  }

  // ---------------------------------------------------------------------------
  // Evaluations
  // ---------------------------------------------------------------------------

  async function createEvaluation(
    companyId: string,
    data: {
      experimentId: string;
      cycleId: string;
      hypothesisId: string;
      verdict: string;
      summary: string;
      analysis: Array<{
        metricKey: string;
        baseline: number;
        final: number;
        delta: number;
        deltaPct: number;
        significant: boolean;
      }>;
      confidenceLevel?: number;
      costTotalCents?: number;
      nextAction: string;
      nextActionDetail?: Record<string, unknown>;
      evaluatedByAgentId?: string;
      evaluatedByUserId?: string;
    },
  ) {
    return db
      .insert(evaluations)
      .values({ ...data, companyId })
      .returning()
      .then((rows) => rows[0]);
  }

  async function listEvaluations(cycleId: string) {
    return db
      .select()
      .from(evaluations)
      .where(eq(evaluations.cycleId, cycleId))
      .orderBy(desc(evaluations.createdAt));
  }

  async function getEvaluationById(id: string) {
    const row = await db
      .select()
      .from(evaluations)
      .where(eq(evaluations.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Evaluation not found");
    return row;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    // Research Cycles
    createCycle,
    listCycles,
    getCycleById,
    updateCycle,

    // Hypotheses
    createHypothesis,
    listHypotheses,
    updateHypothesis,

    // Experiments
    createExperiment,
    listExperiments,
    getExperimentById,
    updateExperiment,
    abortExperiment,

    // Metric Definitions
    createMetricDefinition,
    listMetricDefinitions,
    getMetricDefinitionById,
    updateMetricDefinition,

    // Measurements
    recordMeasurement,
    listMeasurements,
    getMetricTimeSeries,

    // Evaluations
    createEvaluation,
    listEvaluations,
    getEvaluationById,
  };
}
