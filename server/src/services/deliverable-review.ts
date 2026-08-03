import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  deliverableFacts,
  deliverableRuns,
  deliverables,
  factCorrections,
  factValues,
} from "@paperclipai/db";
import type {
  DeliverableCheckOutcome,
  DeliverableReviewSurface,
  RecordFactCorrection,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { approvalService } from "./approvals.js";
import { deliverableCheckService } from "./deliverable-checks.js";
import { logActivity } from "./activity-log.js";
import { elapsedMsBetween, workflowEventsService } from "./workflow-events.js";

/**
 * AgentDash-MK: review, two sequential approvals, and the corrections loop.
 *
 * ## The review surface is a budget, not a report
 *
 * **Minutes of senior attention per cycle is the number that decides whether
 * this is a business.** So an approver is shown the draft plus the items that
 * need a decision, and never a blank re-review of every figure. A surface that
 * asks for the same twenty confirmations every week is a surface people stop
 * reading — and then a real failure scrolls past with the rest, which is
 * precisely the reviewer-capitulation mode the independent check exists to
 * mitigate. Making the surface long would give that mode back.
 *
 * A failed acceptance check does **not** block presentation. It is put in front
 * of the first approver as an item needing attention. Blocking would mean a
 * wrong check silently stops a deliverable forever, and the person who could
 * fix it never learns it exists. What the check buys is that a rubber-stamped
 * approval still failed its acceptance tests, in the record, scored across
 * cycles as `pass^k`. That is partial mitigation and it is honest about being
 * partial.
 *
 * ## Sequential is a constraint, not an order of operations
 *
 * The second approval row does not exist until the first has landed, and the
 * database refuses `second_approval_id` on a run with no `first_approved_at`.
 * A caller that created both up front and collected them in whichever order
 * they arrived would be refused by the table rather than by a comment.
 *
 * Every decision goes through `approvalService`. It remains the single decision
 * boundary; nothing here writes an approval row, and nothing here decides one.
 *
 * ## Corrections attach to the fact
 *
 * Never to a person. Nobody authors a skill and no artifact carries somebody's
 * name describing what they used to get wrong — that is the learning loop which
 * survives both the evidence about self-authored process capture and the social
 * objection to being the subject of it. The correction is keyed on `fact_id`,
 * applied by the next run regardless of who collected the figure that time, and
 * looked up by nothing else.
 *
 * ## What "who waited on whom" is allowed to mean
 *
 * G5 asks for it; the measurement substrate refuses to record which person did
 * anything. Both are right, and the resolution is that the events name the
 * **seat**: `approval.first` and `approval.second`, with `actorRole` of
 * `approver_1` / `approver_2` and the elapsed wait on each. Sequence plus
 * duration answers "how long did each stage wait, and which one was the
 * bottleneck". It does not answer "which employee is slow", and it must not:
 * that is a per-person response-time report one query away, which is the
 * documented task-mining backlash and the fastest way to lose adoption at the
 * exact moment the system starts working.
 */

type RunRow = typeof deliverableRuns.$inferSelect;

export function deliverableReviewService(db: Db) {
  const approvalsSvc = approvalService(db);
  const checks = deliverableCheckService(db);
  const workflow = workflowEventsService(db);

  async function runRow(companyId: string, runId: string): Promise<RunRow> {
    const row = await db
      .select()
      .from(deliverableRuns)
      .where(and(eq(deliverableRuns.id, runId), eq(deliverableRuns.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Deliverable run not found");
    return row;
  }

  async function deliverableFor(run: RunRow) {
    const row = await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.id, run.deliverableId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Deliverable not found");
    return row;
  }

  function pipelineIdFor(key: string) {
    return `deliverable:${key}`;
  }

  /** The run this approval belongs to, or null when it gates something else. */
  async function runForApproval(approvalId: string): Promise<RunRow | null> {
    const byFirst = await db
      .select()
      .from(deliverableRuns)
      .where(eq(deliverableRuns.firstApprovalId, approvalId))
      .then((rows) => rows[0] ?? null);
    if (byFirst) return byFirst;
    return db
      .select()
      .from(deliverableRuns)
      .where(eq(deliverableRuns.secondApprovalId, approvalId))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Ask one approver, through the approvals service.
   *
   * `requestedByAgentId` is the assembler, so the audit trail says which agent
   * produced the thing being signed off. The *decider* is not derived from that
   * — it is the user named in the payload, and `approval-authority` enforces it.
   */
  async function askApprover(
    run: RunRow,
    deliverable: typeof deliverables.$inferSelect,
    stage: "first" | "second",
    approverUserId: string,
    surface: DeliverableReviewSurface,
  ) {
    const approval = await approvalsSvc.create(run.companyId, {
      type: "deliverable_review",
      requestedByAgentId: deliverable.assemblerAgentId,
      status: "pending",
      payload: {
        kind: "deliverable_review",
        stage,
        runId: run.id,
        runKey: run.runKey,
        deliverableKey: deliverable.key,
        deliverableName: deliverable.name,
        // The decider, named. Not resolved from an org chart and not the
        // requesting agent's steward: who signs an artifact off is a property
        // of the artifact.
        approverUserId,
        // What the approver is being asked about, and only that. The whole
        // draft is a route away; this is the part that needs a decision.
        attention: surface.attention,
        checkPassed: surface.checkPassed,
      },
    });
    if (!approval) throw conflict("Could not open the approval for this deliverable");

    await db
      .update(deliverableRuns)
      .set(
        stage === "first"
          ? { firstApprovalId: approval.id, status: "awaiting_approval", updatedAt: new Date() }
          : { secondApprovalId: approval.id, updatedAt: new Date() },
      )
      .where(eq(deliverableRuns.id, run.id));

    await workflow.emit({
      companyId: run.companyId,
      pipelineId: pipelineIdFor(deliverable.key),
      runId: run.id,
      stepKey: `approval.${stage}`,
      eventType: "approval_requested",
      // The first seat opens on the pipeline's own initiative; the second opens
      // because a human decided the first. The KIND of actor, never which one.
      actorKind: stage === "first" ? "agent" : "human",
      payload: { approvalType: "deliverable_review" },
    });

    return approval;
  }

  /**
   * Move a checked run in front of its first approver.
   *
   * Refuses if anything moved since the check read it. That is the
   * self-certification-by-later-edit case: a run whose stored digest no longer
   * matches its own values carries a verdict about figures that are no longer
   * in it, and presenting it would put a check nobody performed in front of a
   * person who will trust it.
   */
  async function present(companyId: string, runId: string) {
    const run = await runRow(companyId, runId);
    if (run.status !== "checked") {
      throw conflict("Only a checked run can be presented for approval");
    }
    const integrity = await checks.verifyDraftUnchanged(companyId, run.id);
    if (!integrity.unchanged) {
      throw conflict(
        "The figures in this run changed since the check read them; it must be checked again",
      );
    }

    const deliverable = await deliverableFor(run);
    const surface = await reviewSurface(companyId, run.id);
    const approval = await askApprover(
      run,
      deliverable,
      "first",
      deliverable.firstApproverUserId,
      surface,
    );

    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: deliverable.assemblerAgentId,
      agentId: deliverable.assemblerAgentId,
      action: "deliverable.presented",
      entityType: "deliverable_run",
      entityId: run.id,
      details: { deliverableKey: deliverable.key, runKey: run.runKey, approvalId: approval.id },
    });

    return { runId: run.id, approvalId: approval.id, stage: "first" as const };
  }

  /** Active corrections for this deliverable's facts, keyed by fact id. */
  async function activeCorrections(deliverableId: string) {
    const rows = await db
      .select({
        id: factCorrections.id,
        factId: factCorrections.factId,
        correction: factCorrections.correction,
        reason: factCorrections.reason,
      })
      .from(factCorrections)
      .innerJoin(deliverableFacts, eq(factCorrections.factId, deliverableFacts.id))
      .where(
        and(
          eq(deliverableFacts.deliverableId, deliverableId),
          isNull(factCorrections.retiredAt),
        ),
      );
    return new Map(rows.map((row) => [row.factId, row]));
  }

  /**
   * The draft plus what needs attention. Never a blank re-review.
   *
   * `attention` is computed here rather than left to a client to filter. A
   * client-side filter is a filter somebody turns off, and then the review slot
   * is spent on the twenty items that were fine.
   */
  async function reviewSurface(
    companyId: string,
    runId: string,
  ): Promise<DeliverableReviewSurface> {
    const run = await runRow(companyId, runId);
    const deliverable = await deliverableFor(run);
    const rows = await db
      .select({
        factId: deliverableFacts.id,
        factKey: deliverableFacts.key,
        label: deliverableFacts.label,
        orderIndex: deliverableFacts.orderIndex,
        value: factValues.value,
        status: factValues.status,
        sourceRef: factValues.sourceRef,
        method: factValues.method,
        fetchedAt: factValues.fetchedAt,
        flagged: factValues.flagged,
        flagReason: factValues.flagReason,
        answeredByAgentId: factValues.answeredByAgentId,
        answeredAt: factValues.answeredAt,
        appliedCorrectionId: factValues.appliedCorrectionId,
      })
      .from(deliverableFacts)
      .leftJoin(factValues, eq(factValues.factId, deliverableFacts.id))
      .where(
        and(
          eq(deliverableFacts.deliverableId, run.deliverableId),
          // The left join has to be narrowed to THIS run, or a fact with values
          // in three cycles would appear three times in one draft.
          eq(factValues.runId, run.id),
        ),
      );
    rows.sort((a, b) => a.orderIndex - b.orderIndex || a.factKey.localeCompare(b.factKey));

    const corrections = await activeCorrections(run.deliverableId);
    const outcome = (run.checkOutcome ?? []) as unknown as DeliverableCheckOutcome[];

    const attention: DeliverableReviewSurface["attention"] = [];
    for (const row of rows) {
      if (!row.flagged) continue;
      attention.push({
        factKey: row.factKey,
        kind: "flagged_value",
        severity: "blocking",
        detail: row.flagReason ?? "flagged with no reason recorded",
      });
    }
    for (const entry of outcome) {
      if (entry.passed) continue;
      attention.push({
        factKey: entry.factKey,
        kind: "failed_check",
        severity: entry.severity,
        detail: `${entry.checkKey}: ${entry.detail}`,
      });
    }

    const stage: DeliverableReviewSurface["stage"] =
      run.status === "awaiting_approval"
        ? run.firstApprovedAt === null
          ? "first"
          : "second"
        : null;

    return {
      runId: run.id,
      deliverableKey: deliverable.key,
      deliverableName: deliverable.name,
      runKey: run.runKey,
      status: run.status as DeliverableReviewSurface["status"],
      stage,
      draft: rows.map((row) => {
        const correction = corrections.get(row.factId);
        const note =
          correction && (correction.correction as Record<string, unknown>).kind === "annotate"
            ? String((correction.correction as Record<string, unknown>).note ?? correction.reason)
            : null;
        return {
          factKey: row.factKey,
          label: row.label,
          value: row.value ?? null,
          provenance: {
            status: (row.status ?? "missing") as DeliverableReviewSurface["draft"][number]["provenance"]["status"],
            sourceRef: row.sourceRef ?? null,
            method: row.method ?? null,
            fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
            answeredByAgentId: row.answeredByAgentId ?? null,
            answeredAt: row.answeredAt ? row.answeredAt.toISOString() : null,
            flagged: row.flagged ?? false,
            flagReason: row.flagReason ?? null,
            appliedCorrectionId: row.appliedCorrectionId ?? null,
          },
          notes: note ? [note] : [],
        };
      }),
      attention,
      checkPassed: run.checkPassed,
      checkedAt: run.checkedAt ? run.checkedAt.toISOString() : null,
      approvals: {
        first: {
          approvalId: run.firstApprovalId,
          approverUserId: deliverable.firstApproverUserId,
          approvedAt: run.firstApprovedAt ? run.firstApprovedAt.toISOString() : null,
        },
        second: {
          approvalId: run.secondApprovalId,
          approverUserId: deliverable.secondApproverUserId,
          approvedAt: run.secondApprovedAt ? run.secondApprovedAt.toISOString() : null,
        },
      },
    };
  }

  /**
   * A named approver decided yes. Advance one seat, or ship.
   *
   * Called from the approvals routes on the same branches that already settle a
   * gated bridge task and a held fact answer. Returns null when the approval
   * gates something else, so the route can call it unconditionally.
   */
  async function advanceDeliverableApproval(approvalId: string) {
    const run = await runForApproval(approvalId);
    if (!run) return null;
    const approval = await approvalsSvc.getById(approvalId);
    if (!approval || approval.status !== "approved") return null;
    const stage = (approval.payload as Record<string, unknown>)?.stage;
    const deliverable = await deliverableFor(run);
    const now = new Date();

    if (stage === "first") {
      const claimed = await db
        .update(deliverableRuns)
        .set({ firstApprovedAt: now, updatedAt: now })
        // Conditional on the seat still being open, so a redelivered decision
        // cannot open a second "second approval".
        .where(
          and(
            eq(deliverableRuns.id, run.id),
            eq(deliverableRuns.firstApprovalId, approvalId),
            isNull(deliverableRuns.firstApprovedAt),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!claimed) return null;

      await workflow.emit({
        companyId: run.companyId,
        pipelineId: pipelineIdFor(deliverable.key),
        runId: run.id,
        stepKey: "approval.first",
        eventType: "approval_decided",
        actorKind: "human",
        // How long this SEAT waited. Not how long a person took: nothing here
        // can see anyone's calendar, and the honest reading is elapsed-under-
        // review rather than measured attention.
        durationMs: elapsedMsBetween(approval.createdAt, now),
        payload: {
          approvalType: "deliverable_review",
          decision: "approved",
          channel: approval.decisionChannel ?? null,
          actorRole: "approver_1",
          override: Boolean(approval.overrideReason),
        },
      });

      const surface = await reviewSurface(run.companyId, run.id);
      await askApprover(
        claimed,
        deliverable,
        "second",
        deliverable.secondApproverUserId,
        surface,
      );
      return { runId: run.id, stage: "first" as const, shipped: false };
    }

    if (stage !== "second") return null;

    const approved = await db
      .update(deliverableRuns)
      .set({ secondApprovedAt: now, status: "approved", updatedAt: now })
      .where(
        and(
          eq(deliverableRuns.id, run.id),
          eq(deliverableRuns.secondApprovalId, approvalId),
          isNull(deliverableRuns.secondApprovedAt),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!approved) return null;

    await workflow.emit({
      companyId: run.companyId,
      pipelineId: pipelineIdFor(deliverable.key),
      runId: run.id,
      stepKey: "approval.second",
      eventType: "approval_decided",
      actorKind: "human",
      durationMs: elapsedMsBetween(approval.createdAt, now),
      payload: {
        approvalType: "deliverable_review",
        decision: "approved",
        channel: approval.decisionChannel ?? null,
        actorRole: "approver_2",
        override: Boolean(approval.overrideReason),
      },
    });

    // `approved` then `shipped`, in two writes rather than one. If shipping
    // fails, the run stays visibly approved-and-unshipped rather than
    // pretending the second decision did not happen.
    await db
      .update(deliverableRuns)
      .set({ status: "shipped", shippedAt: now, updatedAt: now })
      .where(and(eq(deliverableRuns.id, run.id), eq(deliverableRuns.status, "approved")));

    await logActivity(db, {
      companyId: run.companyId,
      actorType: "user",
      actorId: "approval",
      action: "deliverable.shipped",
      entityType: "deliverable_run",
      entityId: run.id,
      details: { deliverableKey: deliverable.key, runKey: run.runKey },
    });

    await workflow.emit({
      companyId: run.companyId,
      pipelineId: pipelineIdFor(deliverable.key),
      runId: run.id,
      stepKey: "ship",
      eventType: "step_completed",
      actorKind: "system",
      durationMs: elapsedMsBetween(run.openedAt, now),
      payload: { taskClass: "ship" },
    });

    return { runId: run.id, stage: "second" as const, shipped: true };
  }

  /**
   * A named approver decided no. Send the cycle back to collection.
   *
   * Back rather than abandoned: a weekly artifact that is wrong on Tuesday
   * should still ship on Wednesday, and any correction recorded during the
   * review is applied on the way round. The check's artifacts are cleared with
   * the reset, because figures collected again have to be checked again —
   * a verdict left standing over fresh values is exactly what the draft digest
   * exists to catch.
   *
   * The fact values are deleted so the draft is rebuilt with corrections
   * applied. Human facts are NOT re-asked: the fact-request row survives, the
   * dedup index holds, and assembly reconciles from the answer that already
   * arrived. Nobody is asked the same question twice because a reviewer said no.
   */
  async function failDeliverableApproval(approvalId: string, reason: string | null) {
    const run = await runForApproval(approvalId);
    if (!run) return null;
    const approval = await approvalsSvc.getById(approvalId);
    if (!approval || approval.status !== "rejected") return null;
    const deliverable = await deliverableFor(run);
    const stage = (approval.payload as Record<string, unknown>)?.stage;
    const now = new Date();

    const reset = await db
      .update(deliverableRuns)
      .set({
        status: "collecting",
        assembledAt: null,
        checkedAt: null,
        checkPassed: null,
        checkOutcome: null,
        checkDraftHash: null,
        firstApprovalId: null,
        firstApprovedAt: null,
        secondApprovalId: null,
        secondApprovedAt: null,
        updatedAt: now,
      })
      .where(and(eq(deliverableRuns.id, run.id), eq(deliverableRuns.status, "awaiting_approval")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!reset) return null;

    await db.delete(factValues).where(eq(factValues.runId, run.id));

    await workflow.emit({
      companyId: run.companyId,
      pipelineId: pipelineIdFor(deliverable.key),
      runId: run.id,
      stepKey: `approval.${stage === "second" ? "second" : "first"}`,
      eventType: "approval_decided",
      actorKind: "human",
      durationMs: elapsedMsBetween(approval.createdAt, now),
      payload: {
        approvalType: "deliverable_review",
        decision: "rejected",
        channel: approval.decisionChannel ?? null,
        actorRole: stage === "second" ? "approver_2" : "approver_1",
        override: Boolean(approval.overrideReason),
      },
    });

    await logActivity(db, {
      companyId: run.companyId,
      actorType: "user",
      actorId: "approval",
      action: "deliverable.sent_back",
      entityType: "deliverable_run",
      entityId: run.id,
      details: {
        deliverableKey: deliverable.key,
        runKey: run.runKey,
        reasonChars: (reason ?? "").length,
      },
    });

    return { runId: run.id, sentBack: true };
  }

  /**
   * Record a correction against the FACT.
   *
   * There is no parameter naming whose figure was wrong and no column to put
   * one in. `createdByUserId` is authorship — the same kind of provenance as an
   * answer's answering agent, so a change can be questioned — and it is
   * deliberately not indexed and never filtered on. This table cannot answer
   * "how many corrections has this person's work needed", which is a
   * performance record wearing a data model.
   *
   * The previous active correction for the fact is retired rather than joined:
   * two live corrections on one figure is an order-dependent pile, and the
   * order would decide the number.
   */
  async function recordCorrection(
    companyId: string,
    runId: string,
    input: RecordFactCorrection,
    byUserId: string,
  ) {
    const run = await runRow(companyId, runId);
    const fact = await db
      .select()
      .from(deliverableFacts)
      .where(
        and(
          eq(deliverableFacts.deliverableId, run.deliverableId),
          eq(deliverableFacts.key, input.factKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!fact) throw notFound("This deliverable has no such fact");

    const now = new Date();
    await db
      .update(factCorrections)
      .set({ retiredAt: now })
      .where(and(eq(factCorrections.factId, fact.id), isNull(factCorrections.retiredAt)));

    const created = await db
      .insert(factCorrections)
      .values({
        companyId,
        factId: fact.id,
        correction: input.correction as Record<string, unknown>,
        reason: input.reason,
        originRunId: run.id,
        createdByUserId: byUserId,
      })
      .returning()
      .then((rows) => rows[0]!);

    const deliverable = await deliverableFor(run);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: byUserId,
      action: "deliverable.corrected",
      entityType: "deliverable_fact",
      entityId: fact.id,
      details: {
        deliverableKey: deliverable.key,
        factKey: fact.key,
        kind: String((input.correction as Record<string, unknown>).kind),
      },
    });

    const emitted = await workflow.emit({
      companyId,
      pipelineId: pipelineIdFor(deliverable.key),
      runId: run.id,
      // The step key IS the fact, so corrections about one figure group across
      // cycles without anything having to correlate them.
      stepKey: fact.key,
      eventType: "correction_recorded",
      actorKind: "human",
      payload: { correctionChars: JSON.stringify(input.correction).length },
    });
    if (emitted.rejectedBecause) {
      logger.error(
        { factId: fact.id, rejectedBecause: emitted.rejectedBecause },
        "a correction was not measured",
      );
    }

    return created;
  }

  /** Whether this user holds one of the two approver seats. */
  async function isApprover(companyId: string, runId: string, userId: string | null | undefined) {
    if (!userId) return false;
    const run = await runRow(companyId, runId);
    const deliverable = await deliverableFor(run);
    return (
      deliverable.firstApproverUserId === userId || deliverable.secondApproverUserId === userId
    );
  }

  return {
    present,
    reviewSurface,
    advanceDeliverableApproval,
    failDeliverableApproval,
    recordCorrection,
    isApprover,
    activeCorrections,
  };
}

export type DeliverableReviewService = ReturnType<typeof deliverableReviewService>;
