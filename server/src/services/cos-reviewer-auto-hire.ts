// AgentDash: goals-eval-hitl
import { and, count, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  cosReviewerAssignments,
  issueReviewQueueState,
} from "@paperclipai/db";
import { COS_REVIEW_DEFAULTS } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { agentService } from "./agents.js";

export type AutoHireReason = "queue_depth" | "neutrality_conflict";

export type CosReviewerAssignmentRow = typeof cosReviewerAssignments.$inferSelect;

export interface HireResult {
  hired: boolean;
  reason:
    | "below_threshold"
    | "cap_reached"
    | "hired"
    | "approval_pending";
  activeCount: number;
  depth?: number;
  threshold?: number;
  assignmentId?: string;
  reviewerAgentId?: string;
  /**
   * Set when the auto-hire path requires a `hire_agent` approval gate before
   * the assignment row can be created. Phase D wires the resolution flow.
   */
  approvalId?: string;
}

interface AutoHireDeps {
  /**
   * Optional override for agent creation — useful for tests. When omitted,
   * the service uses the standard `agentService(db).create` path.
   *
   * Decision (Phase C2): the existing `hire_agent` approval flow at
   * [server/src/services/approvals.ts](./approvals.ts) is for *user-initiated*
   * hires. For *system-initiated* reviewer auto-hire we call
   * `agentService.create` directly: it's purely programmatic, no approval gate
   * exists in the inherited flow for this path, and a parallel approval-gated
   * pathway would (a) require modifying inherited approvals body — forbidden
   * — or (b) create an unbounded "approval_pending" backlog while the queue
   * grows, defeating the purpose of auto-hire.
   */
  createAgent?: (companyId: string, role: string, name: string) => Promise<{ id: string }>;
}

/**
 * Reviewer auto-hire — convergence-safe, capped, neutrality-conflict-aware.
 *
 * Per the consensus plan §3 Phase C3 + ADR Consequences:
 *  - Convergence guard: a `SELECT … FOR UPDATE` on the active-assignment set
 *    serializes concurrent calls so two simultaneous triggers cannot
 *    double-hire (Risk #6, Risk #8).
 *  - Concurrent-hire ceiling: env `AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES`
 *    (default 3) bounds the thunder-herd.
 *  - Neutrality-conflict trigger bypasses the queue-depth threshold
 *    (Synthesis Rec #5) but still respects the convergence guard.
 *  - Caller-only: never edits inherited `approvals.ts`.
 */
export function cosReviewerAutoHire(db: Db, deps: AutoHireDeps = {}) {
  const agentsSvc = agentService(db);

  function envInt(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function maxConcurrentHires(): number {
    return envInt(
      "AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES",
      COS_REVIEW_DEFAULTS.MAX_CONCURRENT_HIRES,
    );
  }

  function queueDepthThresholdPerActive(): number {
    return envInt(
      "AGENTDASH_REVIEWER_QUEUE_DEPTH_THRESHOLD",
      COS_REVIEW_DEFAULTS.QUEUE_DEPTH_HIRE_THRESHOLD,
    );
  }

  async function activeReviewers(companyId: string): Promise<CosReviewerAssignmentRow[]> {
    return db
      .select()
      .from(cosReviewerAssignments)
      .where(
        and(
          eq(cosReviewerAssignments.companyId, companyId),
          isNull(cosReviewerAssignments.retiredAt),
        ),
      );
  }

  async function evaluateAndHireIfNeeded(
    companyId: string,
    reason: AutoHireReason,
  ): Promise<HireResult> {
    return db.transaction(async (tx) => {
      // 1. Convergence guard: lock the active-assignment set for this company.
      //    Concurrent `evaluateAndHireIfNeeded` calls serialize here.
      const activeRows = await tx
        .select()
        .from(cosReviewerAssignments)
        .where(
          and(
            eq(cosReviewerAssignments.companyId, companyId),
            isNull(cosReviewerAssignments.retiredAt),
          ),
        )
        .for("update");
      const activeCount = activeRows.length;

      // 2. Cap check.
      const cap = maxConcurrentHires();
      if (activeCount >= cap) {
        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "system",
          actorId: "cos_reviewer_auto_hire",
          action: "reviewer_hire_throttled",
          entityType: "company",
          entityId: companyId,
          details: { reason, activeCount, cap },
        });
        return { hired: false, reason: "cap_reached", activeCount };
      }

      // 3. Queue-depth gate (only for the depth-driven path; neutrality
      //    conflict bypasses it per Synthesis Rec #5).
      let depth = 0;
      let threshold = 0;
      if (reason === "queue_depth") {
        const depthRows = await tx
          .select({ value: count() })
          .from(issueReviewQueueState)
          .where(
            and(
              eq(issueReviewQueueState.companyId, companyId),
              isNull(issueReviewQueueState.assignedReviewerAgentId),
            ),
          );
        depth = Number(depthRows[0]?.value ?? 0);
        threshold = queueDepthThresholdPerActive() * Math.max(activeCount, 1);
        if (depth < threshold) {
          return {
            hired: false,
            reason: "below_threshold",
            activeCount,
            depth,
            threshold,
          };
        }
      }

      // 4. Hire path. System-initiated: programmatic, no approval gate.
      const reviewerName = `CoS Reviewer ${new Date().toISOString().slice(0, 19)}`;
      const created = deps.createAgent
        ? await deps.createAgent(companyId, "reviewer", reviewerName)
        : await agentsSvc.create(companyId, {
            name: reviewerName,
            role: "reviewer",
            title: "CoS Reviewer",
            adapterType: "process",
            adapterConfig: {},
            budgetMonthlyCents: 0,
            status: "idle",
            spentMonthlyCents: 0,
            metadata: {
              autoHired: true,
              autoHireReason: reason,
              autoHireSource: "cos_reviewer_auto_hire",
            } as Record<string, unknown>,
          });
      const reviewerAgentId = created?.id ?? null;
      if (!reviewerAgentId) {
        // Defensive: if agent creation returned null, surface as cap_reached
        // rather than commit a dangling assignment row.
        return { hired: false, reason: "cap_reached", activeCount };
      }

      const insertedAssignment = await tx
        .insert(cosReviewerAssignments)
        .values({
          companyId,
          reviewerAgentId,
          queuePartition: null,
          queueDepthAtSpawn: reason === "queue_depth" ? depth : null,
        })
        .returning();
      const assignment = insertedAssignment[0]!;

      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: "system",
        actorId: "cos_reviewer_auto_hire",
        action: "reviewer_hired",
        entityType: "agent",
        entityId: reviewerAgentId,
        agentId: reviewerAgentId,
        details: {
          reason,
          assignmentId: assignment.id,
          queueDepthAtSpawn: assignment.queueDepthAtSpawn,
          activeCountAfter: activeCount + 1,
        },
      });

      return {
        hired: true,
        reason: "hired",
        activeCount: activeCount + 1,
        assignmentId: assignment.id,
        reviewerAgentId,
        ...(reason === "queue_depth" ? { depth, threshold } : {}),
      };
    });
  }

  async function retire(assignmentId: string): Promise<void> {
    const now = new Date();
    await db
      .update(cosReviewerAssignments)
      .set({ retiredAt: now })
      .where(eq(cosReviewerAssignments.id, assignmentId));
  }

  return {
    evaluateAndHireIfNeeded,
    retire,
    activeReviewers,
  };
}

export type CosReviewerAutoHireService = ReturnType<typeof cosReviewerAutoHire>;
