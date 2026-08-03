import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, companies, deliverables, workflowRecommendations } from "@paperclipai/db";
import {
  WORKFLOW_RECOMMENDATION_MIN_CYCLES,
  WORKFLOW_RECOMMENDATION_WINDOW_CYCLES,
  isSeatShapedStepKey,
  raiseWorkflowRecommendationSchema,
  workflowRecommendationObservationSchema,
  type RaiseWorkflowRecommendation,
  type WorkflowRecommendationEvidence,
  type WorkflowRecommendationKind,
  type WorkflowRecommendationStatus,
  type WorkflowRecommendationView,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { approvalService } from "./approvals.js";
import { workflowEventsService, type WorkflowPipelineEvent } from "./workflow-events.js";

/**
 * AgentDash-MK: the review agent's RECOMMENDATION half.
 *
 * Slice B built measurement; this reads it back. An org-level observer that
 * notices a pattern across at least three cycles, states it in one sentence
 * rendered from counts, cites the exact rows it rests on, and puts it in front
 * of one named human through the approvals service.
 *
 * ## It never acts
 *
 * There is no branch below that writes to a deliverable, a fact, a correction,
 * or a run. Accepting a recommendation sets its status to `accepted` and stops.
 * The change it suggests — re-encoding a derivation, moving a fact from `human`
 * to `system` — is an implementer's to make while watching a real cycle, which
 * is the same rule that keeps the fact list out of self-service hands.
 *
 * This is not caution about a feature that could be added later. A review agent
 * that could act on its own findings would be a second decision path beside the
 * approvals service, and the whole shape of this system is that there is one.
 *
 * ## What it refuses to derive
 *
 * **Approval-seat latency.** It is derivable — G instrumented `approval.first`
 * and `approval.second` with the elapsed wait on each — and it is refused. A
 * deliverable names exactly one user per seat on its own row, and a check
 * constraint guarantees the two seats are two different people, so "seat one is
 * your bottleneck" has no reading that is not "this named colleague is slow".
 * That is a per-employee response-time report, which is the documented
 * task-mining backlash. Refused twice: skipped here, and refused by the table.
 *
 * **A review-burden trend.** Three points and a threshold nobody can justify.
 * The metric is already served per run by B, where a human reads it with its
 * context. A plausible-looking recommendation with no evidential basis is worse
 * than an absent one.
 *
 * **"This step always needs a human."** A fact declared `human` in the fact
 * list needs a human every cycle by definition. It would fire on every human
 * fact forever and mean nothing.
 *
 * ## Never run
 *
 * No real weekly cycle has ever executed anywhere in this system. Everything
 * below is exercised against synthetic event histories written by B's real
 * emitters, and the QUALITY of what it emits — whether these two patterns are
 * the ones worth surfacing, whether three cycles is the right floor — is
 * entirely unvalidated and cannot be validated until real cycles accumulate.
 */

type RecommendationRow = typeof workflowRecommendations.$inferSelect;

/** A pattern the derivation found, before anything has been written. */
export type DerivedRecommendation = RaiseWorkflowRecommendation & {
  companyId: string;
  recipientUserId: string;
};

/**
 * The sentence a human reads, rendered from the counts.
 *
 * Rendered rather than stored, so there is no free-text column anywhere in
 * which a name could arrive from a later slice or a well-meaning caller. Every
 * substitution below is a pipeline id, a step key, or an integer.
 */
export function renderRecommendationStatement(input: {
  kind: WorkflowRecommendationKind;
  pipelineId: string;
  stepKey: string;
  cyclesObserved: number;
  evidenceCycles: number;
  observation: Record<string, number>;
}): string {
  const where = `${input.stepKey} in ${input.pipelineId}`;
  if (input.kind === "recurring_correction") {
    return (
      `${where} was corrected in ${input.evidenceCycles} of the last ` +
      `${input.cyclesObserved} cycles (${input.observation.correctionCount ?? 0} corrections in ` +
      `total). A figure a human fixes every cycle is a derivation that is wrong every cycle — ` +
      `worth an implementer re-encoding how this fact is produced, rather than correcting it again.`
    );
  }
  const maxStallHours = Math.round(((input.observation.maxStallMs ?? 0) / 3_600_000) * 10) / 10;
  return (
    `${where} ran its escalation lease out in ${input.evidenceCycles} of the last ` +
    `${input.cyclesObserved} cycles (longest stall ${maxStallHours}h), so the figure landed ` +
    `missing and flagged each time. Worth checking whether the ask is going somewhere it can be ` +
    `answered, or whether this fact belongs on the connector side of the fact list.`
  );
}

export function workflowRecommendationService(db: Db) {
  const events = workflowEventsService(db);
  const approvalsSvc = approvalService(db);

  /**
   * Who a recommendation about this pipeline is addressed to.
   *
   * For a deliverable, the **first** approver. Deliberately not the second:
   * the second seat is the more senior one, and the version of this feature
   * where a CEO receives efficiency recommendations about the work below them
   * is the version that kills adoption.
   *
   * A pipeline with no resolvable owner returns null and raises nothing at
   * all — `bridge:act` and `approval:hire_agent` are real pipeline ids with
   * real accumulated events and nobody who owns them. Escalating those up the
   * org chart to find a reader is worse than staying silent.
   */
  async function pipelineOwnerUserId(
    companyId: string,
    pipelineId: string,
  ): Promise<string | null> {
    if (!pipelineId.startsWith("deliverable:")) return null;
    const key = pipelineId.slice("deliverable:".length);
    if (!key) return null;
    const row = await db
      .select({ firstApproverUserId: deliverables.firstApproverUserId })
      .from(deliverables)
      .where(and(eq(deliverables.companyId, companyId), eq(deliverables.key, key)))
      .then((rows) => rows[0] ?? null);
    return row?.firstApproverUserId ?? null;
  }

  /** The reproducible read, for someone who does not trust the number. */
  function evidenceQuery(pipelineId: string, stepKey: string, eventTypes: string[]) {
    return (
      `select id, run_id, step_key, event_type, duration_ms, occurred_at from workflow_events ` +
      `where company_id = $1 and pipeline_id = '${pipelineId}' and step_key = '${stepKey}' ` +
      `and event_type in (${eventTypes.map((type) => `'${type}'`).join(", ")}) ` +
      `order by occurred_at`
    );
  }

  function buildEvidence(
    pipelineId: string,
    stepKey: string,
    eventTypes: string[],
    supporting: WorkflowPipelineEvent[],
  ): WorkflowRecommendationEvidence {
    return {
      query: evidenceQuery(pipelineId, stepKey, eventTypes),
      runIds: Array.from(new Set(supporting.map((event) => event.runId))),
      eventIds: supporting.map((event) => event.id),
      eventTypes,
      from: supporting[0]?.occurredAt?.toISOString() ?? null,
      to: supporting[supporting.length - 1]?.occurredAt?.toISOString() ?? null,
    };
  }

  /**
   * Read one pipeline's accumulated cycles and say what, if anything, they
   * support.
   *
   * Reads through `metricsForPipeline` — B's own query surface — rather than
   * opening a second query against the events table. A second reader with its
   * own SQL would be a second place the person dimension could be added later
   * without anybody noticing the rule had two homes.
   */
  async function derive(companyId: string, pipelineId: string): Promise<DerivedRecommendation[]> {
    const recipientUserId = await pipelineOwnerUserId(companyId, pipelineId);
    if (!recipientUserId) return [];

    const window = await events.metricsForPipeline(
      companyId,
      pipelineId,
      WORKFLOW_RECOMMENDATION_WINDOW_CYCLES,
    );
    const cyclesObserved = window.runIds.length;
    if (cyclesObserved < WORKFLOW_RECOMMENDATION_MIN_CYCLES) return [];
    const latestRunId = window.runIds[window.runIds.length - 1]!;

    const stepKeys = Array.from(new Set(window.events.map((event) => event.stepKey)))
      // The seat exclusion, applied before anything is counted. A seat is one
      // named person by construction; see the module comment.
      .filter((stepKey) => !isSeatShapedStepKey(stepKey))
      .sort();

    const derived: DerivedRecommendation[] = [];

    for (const stepKey of stepKeys) {
      const onStep = window.events.filter((event) => event.stepKey === stepKey);

      const corrections = onStep.filter((event) => event.eventType === "correction_recorded");
      const correctionCycles = new Set(corrections.map((event) => event.runId)).size;
      if (correctionCycles >= WORKFLOW_RECOMMENDATION_MIN_CYCLES) {
        derived.push({
          companyId,
          recipientUserId,
          pipelineId,
          stepKey,
          kind: "recurring_correction",
          cyclesObserved,
          evidenceCycles: correctionCycles,
          latestRunId,
          observation: {
            cyclesObserved,
            cyclesWithEvidence: correctionCycles,
            correctionCount: corrections.length,
          },
          evidence: buildEvidence(pipelineId, stepKey, ["correction_recorded"], corrections),
        });
      }

      const expiries = onStep.filter((event) => event.eventType === "escalation_expired");
      const stallCycles = new Set(expiries.map((event) => event.runId)).size;
      if (stallCycles >= WORKFLOW_RECOMMENDATION_MIN_CYCLES) {
        derived.push({
          companyId,
          recipientUserId,
          pipelineId,
          stepKey,
          kind: "chronic_escalation_stall",
          cyclesObserved,
          evidenceCycles: stallCycles,
          latestRunId,
          observation: {
            cyclesObserved,
            cyclesWithEvidence: stallCycles,
            expiredCount: expiries.length,
            maxStallMs: expiries.reduce(
              (max, event) => Math.max(max, event.durationMs ?? 0),
              0,
            ),
          },
          evidence: buildEvidence(pipelineId, stepKey, ["escalation_expired"], expiries),
        });
      }
    }

    return derived;
  }

  /**
   * Has this already been said, and has anything changed since?
   *
   * An open one is never duplicated: the tick runs on a timer, and a surface
   * that repeats the same suggestion every pass is a surface people stop
   * reading, after which a real finding scrolls past with the rest.
   *
   * A **decided** one comes back only when the evidence has grown. A declined
   * recommendation whose condition is still true is not new information; a
   * declined recommendation whose condition got worse is. This is the whole of
   * the noise budget, and it is why `evidence_cycles` is a column rather than a
   * derived number.
   */
  async function alreadySaid(candidate: DerivedRecommendation): Promise<boolean> {
    const existing = await db
      .select({
        status: workflowRecommendations.status,
        evidenceCycles: workflowRecommendations.evidenceCycles,
      })
      .from(workflowRecommendations)
      .where(
        and(
          eq(workflowRecommendations.companyId, candidate.companyId),
          eq(workflowRecommendations.pipelineId, candidate.pipelineId),
          eq(workflowRecommendations.kind, candidate.kind),
          eq(workflowRecommendations.stepKey, candidate.stepKey),
        ),
      );
    if (existing.some((row) => row.status === "open")) return true;
    const decidedCeiling = existing.reduce(
      (max, row) => Math.max(max, row.evidenceCycles),
      0,
    );
    return candidate.evidenceCycles <= decidedCeiling;
  }

  /**
   * Write the recommendation, then open its approval against it.
   *
   * In that order deliberately: a recommendation that failed to open its
   * approval is visible as an unrouted row somebody can find, whereas an
   * approval with no recommendation behind it would be a decision request about
   * nothing.
   */
  async function raise(candidate: DerivedRecommendation): Promise<RecommendationRow | null> {
    const parsed = raiseWorkflowRecommendationSchema.safeParse({
      pipelineId: candidate.pipelineId,
      stepKey: candidate.stepKey,
      kind: candidate.kind,
      cyclesObserved: candidate.cyclesObserved,
      evidenceCycles: candidate.evidenceCycles,
      latestRunId: candidate.latestRunId,
      observation: candidate.observation,
      evidence: candidate.evidence,
    });
    if (!parsed.success) {
      logger.error(
        { err: parsed.error, pipelineId: candidate.pipelineId, stepKey: candidate.stepKey },
        "workflow recommendation rejected: malformed derivation",
      );
      return null;
    }
    // The closed allowlist, applied per kind. Every permitted key is an
    // integer, so a name has nowhere to go — this is the gate, and the table's
    // regex is the backstop for writers that never come through here.
    const observation = workflowRecommendationObservationSchema(candidate.kind).safeParse(
      candidate.observation,
    );
    if (!observation.success) {
      logger.error(
        { err: observation.error, kind: candidate.kind },
        "workflow recommendation rejected: observation carries a key the allowlist does not declare",
      );
      return null;
    }

    const created = await db
      .insert(workflowRecommendations)
      .values({
        companyId: candidate.companyId,
        pipelineId: parsed.data.pipelineId,
        stepKey: parsed.data.stepKey,
        kind: parsed.data.kind,
        cyclesObserved: parsed.data.cyclesObserved,
        evidenceCycles: parsed.data.evidenceCycles,
        latestRunId: parsed.data.latestRunId,
        observation: observation.data as Record<string, number>,
        evidence: parsed.data.evidence as unknown as Record<string, unknown>,
        recipientUserId: candidate.recipientUserId,
      })
      // Two ticks overlapping is not an error; it is the partial unique index
      // doing its job.
      .onConflictDoNothing()
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!created) return null;

    /**
     * Through the approvals service, which stays the only decision boundary.
     *
     * `requestedByAgentId` is deliberately unset: nothing is blocked on this
     * decision, and the shared approvals route wakes a requesting agent on
     * every decision. The decider is the user named in the payload — the
     * pipeline owner — and `approval-authority` enforces it.
     */
    const approval = await approvalsSvc.create(candidate.companyId, {
      type: "workflow_recommendation",
      status: "pending",
      payload: {
        kind: "workflow_recommendation",
        recommendationId: created.id,
        recommendationKind: created.kind,
        pipelineId: created.pipelineId,
        stepKey: created.stepKey,
        cyclesObserved: created.cyclesObserved,
        evidenceCycles: created.evidenceCycles,
        statement: renderRecommendationStatement({
          kind: created.kind as WorkflowRecommendationKind,
          pipelineId: created.pipelineId,
          stepKey: created.stepKey,
          cyclesObserved: created.cyclesObserved,
          evidenceCycles: created.evidenceCycles,
          observation: created.observation,
        }),
        // Advisory, said in the payload rather than only in a doc: whoever
        // renders this must not offer a control that implies otherwise.
        advisoryOnly: true,
        evidence: created.evidence,
        approverUserId: created.recipientUserId,
      },
    });

    if (approval) {
      await db
        .update(workflowRecommendations)
        .set({ approvalId: approval.id })
        .where(eq(workflowRecommendations.id, created.id));
    } else {
      logger.error(
        { recommendationId: created.id },
        "workflow recommendation raised but its approval could not be opened; it is unrouted",
      );
    }

    await logActivity(db, {
      companyId: candidate.companyId,
      actorType: "user",
      actorId: "review_agent",
      action: "workflow_recommendation.raised",
      entityType: "workflow_recommendation",
      entityId: created.id,
      details: {
        pipelineId: created.pipelineId,
        stepKey: created.stepKey,
        kind: created.kind,
        evidenceCycles: created.evidenceCycles,
      },
    });

    return created;
  }

  /**
   * Look at every measured pipeline and raise what three cycles support.
   *
   * Idempotent, so the interval is a latency choice rather than a correctness
   * one. Runs on its own slow tick: it reads a window per pipeline, and nothing
   * it produces is urgent — a recommendation is a suggestion about a recurring
   * pattern, not an event anybody is waiting on.
   */
  async function sweepRecommendations() {
    const pipelines = await events.listMeasuredPipelines();
    let raised = 0;
    for (const pipeline of pipelines) {
      try {
        for (const candidate of await derive(pipeline.companyId, pipeline.pipelineId)) {
          if (await alreadySaid(candidate)) continue;
          if (await raise(candidate)) raised += 1;
        }
      } catch (error) {
        // One pipeline's derivation must not stop every other company's.
        logger.error(
          { err: error, pipelineId: pipeline.pipelineId },
          "[recommendations] deriving a pipeline failed",
        );
      }
    }
    return { considered: pipelines.length, raised };
  }

  function toView(row: RecommendationRow): WorkflowRecommendationView {
    return {
      id: row.id,
      pipelineId: row.pipelineId,
      stepKey: row.stepKey,
      kind: row.kind as WorkflowRecommendationKind,
      status: row.status as WorkflowRecommendationStatus,
      statement: renderRecommendationStatement({
        kind: row.kind as WorkflowRecommendationKind,
        pipelineId: row.pipelineId,
        stepKey: row.stepKey,
        cyclesObserved: row.cyclesObserved,
        evidenceCycles: row.evidenceCycles,
        observation: row.observation,
      }),
      cyclesObserved: row.cyclesObserved,
      evidenceCycles: row.evidenceCycles,
      observation: row.observation,
      evidence: row.evidence as unknown as WorkflowRecommendationEvidence,
      recipientUserId: row.recipientUserId,
      approvalId: row.approvalId,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    };
  }

  /**
   * What one person is being shown.
   *
   * There is no `userId` parameter a caller supplies: the recipient is the
   * authenticated actor, and the only other shape is an implementer reading
   * everything in order to operate the encoding. Nobody can ask for somebody
   * else's list, which is the same absence B enforced on the metrics route.
   */
  async function list(
    companyId: string,
    options: { recipientUserId?: string | null; allRecipients?: boolean } = {},
  ): Promise<WorkflowRecommendationView[]> {
    const conditions = [eq(workflowRecommendations.companyId, companyId)];
    if (!options.allRecipients) {
      if (!options.recipientUserId) return [];
      conditions.push(eq(workflowRecommendations.recipientUserId, options.recipientUserId));
    }
    const rows = await db
      .select()
      .from(workflowRecommendations)
      .where(and(...conditions))
      .orderBy(desc(workflowRecommendations.createdAt));
    return rows.map(toView);
  }

  /**
   * A human decided. Record it, and do nothing else.
   *
   * This is the whole of "advisory": there is no branch here that touches a
   * deliverable, a fact, a correction, or a run. Returns null when the approval
   * gates something else, so the routes can call it unconditionally alongside
   * the bridge, fact, and deliverable settlements.
   */
  async function settleRecommendationApproval(approvalId: string) {
    const row = await db
      .select()
      .from(workflowRecommendations)
      .where(eq(workflowRecommendations.approvalId, approvalId))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;

    const approval = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
    if (!approval) return null;

    const status: WorkflowRecommendationStatus | null =
      approval.status === "approved" ? "accepted" : approval.status === "rejected" ? "declined" : null;
    if (!status) return null;

    const now = new Date();
    const settled = await db
      .update(workflowRecommendations)
      .set({ status, decidedAt: now })
      // Conditional on it still being open, so a redelivered decision cannot
      // reopen or re-decide a settled suggestion.
      .where(
        and(eq(workflowRecommendations.id, row.id), eq(workflowRecommendations.status, "open")),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!settled) return null;

    await logActivity(db, {
      companyId: settled.companyId,
      actorType: "user",
      actorId: "approval",
      action: `workflow_recommendation.${status}`,
      entityType: "workflow_recommendation",
      entityId: settled.id,
      details: { pipelineId: settled.pipelineId, stepKey: settled.stepKey, kind: settled.kind },
    });

    return toView(settled);
  }

  /** Whether this company is measured at all. Used by the read route. */
  async function isProfileCompany(companyId: string) {
    const company = await db
      .select({ productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return company?.productProfile === "agentdash_mk";
  }

  return {
    derive,
    list,
    isProfileCompany,
    settleRecommendationApproval,
    sweepRecommendations,
  };
}

export type WorkflowRecommendationService = ReturnType<typeof workflowRecommendationService>;
