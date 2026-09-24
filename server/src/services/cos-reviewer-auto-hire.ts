// AgentDash: goals-eval-hitl
import { and, count, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  cosReviewerAssignments,
  issueReviewQueueState,
} from "@paperclipai/db";
import { COS_REVIEW_DEFAULTS } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { approvalService } from "./approvals.js";
import { companyService } from "./companies.js";
import { defaultAgentPlanAdapterType } from "./cos-replier.js";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";
import { RUNNABLE_REVIEWER_STATUSES } from "./review-queue-assignments.js";
import {
  exceededFreeTierCapacityAction,
  isBillingDisabled,
  lockCompanyTierCapacity,
} from "./tier-policy.js";

export type AutoHireReason = "queue_depth" | "neutrality_conflict";

export type CosReviewerAssignmentRow = typeof cosReviewerAssignments.$inferSelect;

export { RUNNABLE_REVIEWER_STATUSES };

/**
 * How often an auto-hired reviewer wakes to look for `in_review` work.
 * `requireWork` must stay false: the work gate only sees issue assignments
 * and fact requests, and a review assignment lives in
 * `issue_review_queue_state`, which the gate cannot see — with it on, the
 * reviewer would only wake on the 12h sweep and the queue would still stall.
 */
const REVIEWER_HEARTBEAT = {
  enabled: true,
  intervalSec: 1800,
  wakeOnDemand: true,
  requireWork: false,
} as const;

const REVIEWER_CAPABILITIES =
  "Neutral review of Issues in `in_review`: read the Issue, its DoD, and the " +
  "work record, then write a verdict. Hired automatically when the review " +
  "queue outgrew the active reviewers.";

export interface HireResult {
  hired: boolean;
  reason:
    | "below_threshold"
    | "cap_reached"
    | "disabled"
    | "hired"
    | "approval_pending";
  activeCount: number;
  depth?: number;
  threshold?: number;
  assignmentId?: string;
  reviewerAgentId?: string;
  /** The `hire_agent` approval a human must decide before the reviewer runs. */
  approvalId?: string;
}

interface AutoHireDeps {
  /**
   * Optional override for agent creation — useful for tests. When omitted,
   * the service uses the standard `agentService(tx).create` path bound to the
   * evaluation transaction so the pending agent rolls back with everything
   * else on failure.
   */
  createAgent?: (companyId: string, role: string, name: string) => Promise<{ id: string }>;
  /**
   * Optional override for the post-insert provisioning step (instructions
   * bundle). Tests inject a spy; the default materializes the `reviewer`
   * instructions bundle and persists the resulting adapterConfig.
   */
  provisionReviewer?: (agentId: string) => Promise<void>;
}

/**
 * Reviewer auto-hire — convergence-safe, capped, neutrality-conflict-aware,
 * and approval-gated like every other hire.
 *
 * Per the consensus plan §3 Phase C3 + ADR Consequences:
 *  - Convergence guard: a per-company `pg_advisory_xact_lock` is taken at the
 *    top of the evaluation transaction, BEFORE any count is read. A
 *    `SELECT … FOR UPDATE` on the live-assignment set alone cannot serialize
 *    the zero-reviewer case — it locks only rows that already exist, and a
 *    waiting READ COMMITTED transaction keeps its stale row set, so two
 *    concurrent evaluations could both hire (Risk #6, Risk #8). The lock is
 *    the same key the tier-capacity paths use, and it is unconditional — it
 *    is not skipped when billing is disabled.
 *  - Concurrent-hire ceiling: env `AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES`
 *    (default 3) bounds the thunder-herd. `0` disables the feature outright —
 *    every evaluation returns `disabled` and no approval is filed.
 *  - Neutrality-conflict trigger bypasses the queue-depth threshold
 *    (Synthesis Rec #5) but still respects the convergence guard.
 *  - Approval gate: a hire request creates the agent as `pending_approval`
 *    plus a `hire_agent` approval — the same gate a user-initiated hire takes.
 *    The earlier Phase C2 shortcut called `agentService.create` directly
 *    because the approval flow "is for user-initiated hires"; the result was
 *    an instance minting agents no human decided on. The flow supports a
 *    pre-created pending agent (payload.agentId → activate on approve,
 *    terminate on reject), so the system-initiated path takes it unchanged.
 *  - Counting: hire slots are assignments whose agent is not `terminated`;
 *    that includes `pending_approval` rows, which is what stops every enqueue
 *    from filing a duplicate approval while the first one waits. Reviewing
 *    capacity — the count the depth threshold multiplies — is stricter:
 *    only `RUNNABLE_REVIEWER_STATUSES`, because a pending reviewer is not
 *    reviewing.
 */
export function cosReviewerAutoHire(db: Db, deps: AutoHireDeps = {}) {
  const agentsSvc = agentService(db);

  function envInt(key: string, fallback: number, min = 1): number {
    const raw = process.env[key];
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
  }

  function maxConcurrentHires(): number {
    return envInt(
      "AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES",
      COS_REVIEW_DEFAULTS.MAX_CONCURRENT_HIRES,
      0,
    );
  }

  function queueDepthThresholdPerActive(): number {
    return envInt(
      "AGENTDASH_REVIEWER_QUEUE_DEPTH_THRESHOLD",
      COS_REVIEW_DEFAULTS.QUEUE_DEPTH_HIRE_THRESHOLD,
    );
  }

  /**
   * Assignments whose agent can actually review — the defensive half of the
   * terminated-reviewer fix. The terminating side retires the row at
   * `agentService.terminate`; this join is the belt to that suspenders, so a
   * reviewer retired through any other path (a missed code path, a manual
   * status change) still cannot be counted or picked.
   */
  async function activeReviewers(companyId: string): Promise<CosReviewerAssignmentRow[]> {
    const rows = await db
      .select({ assignment: cosReviewerAssignments })
      .from(cosReviewerAssignments)
      .innerJoin(agents, eq(cosReviewerAssignments.reviewerAgentId, agents.id))
      .where(
        and(
          eq(cosReviewerAssignments.companyId, companyId),
          isNull(cosReviewerAssignments.retiredAt),
          inArray(agents.status, [...RUNNABLE_REVIEWER_STATUSES]),
        ),
      );
    return rows.map((row) => row.assignment);
  }

  /**
   * Post-commit provisioning. Materializes the `reviewer` mandate bundle —
   * the same step the user-initiated hire route runs on a `pending_approval`
   * agent. No API key is minted anywhere in this flow: the reviewer
   * authenticates the same way every heartbeat-dispatched worker does — the
   * server mints a run-scoped local agent JWT at run time and the adapter
   * injects it as `PAPERCLIP_API_KEY` (`supportsLocalAgentJwt`, which covers
   * every local adapter). A stored `pcp_` key would be an always-on credential
   * the reviewer does not need.
   */
  async function provisionReviewer(agentId: string): Promise<void> {
    if (deps.provisionReviewer) {
      await deps.provisionReviewer(agentId);
      return;
    }
    const agent = await agentsSvc.getById(agentId);
    if (!agent) return;
    const files = await loadDefaultAgentInstructionsBundle("reviewer");
    const materialized = await agentInstructionsService().materializeManagedBundle(agent, files, {
      entryFile: "AGENTS.md",
    });
    await agentsSvc.update(agent.id, { adapterConfig: materialized.adapterConfig });
  }

  async function evaluateAndHireIfNeeded(
    companyId: string,
    reason: AutoHireReason,
  ): Promise<HireResult> {
    let hiredAgentId: string | null = null;

    const result = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;

      // 1. Convergence guard: take the per-company advisory lock FIRST,
      //    before any count is read. FOR UPDATE alone cannot cover the
      //    zero-reviewer case (it locks only rows that exist, and a waiting
      //    READ COMMITTED transaction keeps its stale row set), so this lock
      //    is unconditional — never skipped when billing is disabled — and
      //    uses the same key the tier-capacity paths take, which serializes
      //    auto-hire against approval-time agent creation too.
      await lockCompanyTierCapacity(txDb, companyId);

      //    Then lock and read the live-assignment set for this company. The
      //    join keeps terminated agents out of the slot count defensively —
      //    the terminating path retires the row, but a count that trusts only
      //    `retiredAt` is one missed code path away from hiring past the cap.
      const slotRows = await tx
        .select({
          assignment: cosReviewerAssignments,
          agentStatus: agents.status,
        })
        .from(cosReviewerAssignments)
        .innerJoin(agents, eq(cosReviewerAssignments.reviewerAgentId, agents.id))
        .where(
          and(
            eq(cosReviewerAssignments.companyId, companyId),
            isNull(cosReviewerAssignments.retiredAt),
            ne(agents.status, "terminated"),
          ),
        )
        .for("update");
      const slotCount = slotRows.length;
      const activeCount = slotRows.filter((row) =>
        (RUNNABLE_REVIEWER_STATUSES as readonly string[]).includes(row.agentStatus),
      ).length;

      // 2. Kill switch — checked before the cap so the reason is honest.
      const cap = maxConcurrentHires();
      if (cap === 0) {
        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "system",
          actorId: "cos_reviewer_auto_hire",
          action: "reviewer_hire_throttled",
          entityType: "company",
          entityId: companyId,
          details: { reason, slotCount, cap, disabled: true },
        });
        return { hired: false, reason: "disabled" as const, activeCount };
      }

      // 3. Cap check — in-flight (pending) and live hires both occupy a slot,
      //    so a queued approval cannot be filed twice.
      if (slotCount >= cap) {
        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "system",
          actorId: "cos_reviewer_auto_hire",
          action: "reviewer_hire_throttled",
          entityType: "company",
          entityId: companyId,
          details: { reason, slotCount, activeCount, cap },
        });
        return { hired: false, reason: "cap_reached" as const, activeCount };
      }

      // 4. Queue-depth gate (only for the depth-driven path; neutrality
      //    conflict bypasses it per Synthesis Rec #5). Depth is measured per
      //    RUNNABLE reviewer — a pending-approval hire is not reviewing yet.
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
            reason: "below_threshold" as const,
            activeCount,
            depth,
            threshold,
          };
        }
      }

      // 5. Tier-cap gate. The shared tier advisory lock is already held from
      //    step 1 — held regardless of billing mode — so this only decides
      //    whether the company is over its free-tier agent cap.
      if (!isBillingDisabled()) {
        const blockedTierAction = await exceededFreeTierCapacityAction(
          {
            getCompany: async (id) => {
              const company = await companyService(txDb).getById(id);
              return { planTier: company?.planTier ?? "free" };
            },
            counts: {
              humans: async () => 0,
              agents: async (id) => (await agentService(txDb).list(id)).length,
            },
          },
          companyId,
          { agents: 1 },
        );
        if (blockedTierAction) {
          await logActivity(txDb, {
            companyId,
            actorType: "system",
            actorId: "cos_reviewer_auto_hire",
            action: "reviewer_hire_throttled",
            entityType: "company",
            entityId: companyId,
            details: { reason, slotCount, activeCount, tierCapAction: blockedTierAction },
          });
          return { hired: false, reason: "cap_reached" as const, activeCount };
        }
      }

      // 6. Hire path — the normal gate. The agent is created pending_approval
      //    (cannot run: auth and the scheduler both refuse that status) with a
      //    real adapter, a heartbeat, and a mandate — an agent the board can
      //    actually approve into work, not the unrunnable `process` stub this
      //    path used to mint. Approving activates it; rejecting terminates it,
      //    and termination retires this assignment row.
      //
      //    The adapter is the instance default: `AGENTDASH_DEFAULT_ADAPTER`
      //    when the operator set it, otherwise `hermes_local`. There is no
      //    per-company adapter setting today — "company default" would be a
      //    different thing and does not exist yet.
      //
      //    `agentService` is bound to the transaction, not the outer `db`: the
      //    pending agent, the assignment row, and the approval must commit or
      //    roll back together — an agent that outlives a failed approval
      //    insert is an orphan no human ever decided on.
      const reviewerName = `CoS Reviewer ${new Date().toISOString().slice(0, 19)}`;
      const adapterType = defaultAgentPlanAdapterType();
      const txAgentsSvc = agentService(txDb);
      const reviewerMetadata = {
        autoHired: true,
        autoHireReason: reason,
        autoHireSource: "cos_reviewer_auto_hire",
      } as Record<string, unknown>;
      const runtimeConfig = { heartbeat: { ...REVIEWER_HEARTBEAT } };
      const created = deps.createAgent
        ? await deps.createAgent(companyId, "reviewer", reviewerName)
        : await txAgentsSvc.create(companyId, {
            name: reviewerName,
            role: "reviewer",
            title: "CoS Reviewer",
            capabilities: REVIEWER_CAPABILITIES,
            adapterType,
            adapterConfig: {},
            runtimeConfig,
            budgetMonthlyCents: 0,
            status: "pending_approval",
            spentMonthlyCents: 0,
            metadata: reviewerMetadata,
          });
      const reviewerAgentId = created?.id ?? null;
      if (!reviewerAgentId) {
        // Defensive: if agent creation returned null, surface as cap_reached
        // rather than commit a dangling assignment row.
        return { hired: false, reason: "cap_reached" as const, activeCount };
      }
      hiredAgentId = reviewerAgentId;

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

      // 7. The approval. `payload.agentId` makes this the same object the
      //    user-initiated hire path produces: approve → activate, reject →
      //    terminate. The spec fields are included so the approver sees what
      //    the system is asking for, not a bare agent id.
      const insertedApproval = await approvalService(txDb).create(companyId, {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: null,
        status: "pending",
        payload: {
          name: reviewerName,
          role: "reviewer",
          title: "CoS Reviewer",
          capabilities: REVIEWER_CAPABILITIES,
          adapterType,
          adapterConfig: {},
          runtimeConfig,
          budgetMonthlyCents: 0,
          metadata: reviewerMetadata,
          agentId: reviewerAgentId,
          autoHireReason: reason,
        } as Record<string, unknown>,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
      const approvalId = insertedApproval.id;

      await logActivity(txDb, {
        companyId,
        actorType: "system",
        actorId: "cos_reviewer_auto_hire",
        action: "reviewer_hire_requested",
        entityType: "agent",
        entityId: reviewerAgentId,
        agentId: reviewerAgentId,
        details: {
          reason,
          assignmentId: assignment.id,
          approvalId,
          queueDepthAtSpawn: assignment.queueDepthAtSpawn,
          activeCountAfter: activeCount + 1,
        },
      });

      return {
        hired: true,
        reason: "approval_pending" as const,
        activeCount: activeCount + 1,
        assignmentId: assignment.id,
        reviewerAgentId,
        approvalId,
        ...(reason === "queue_depth" ? { depth, threshold } : {}),
      };
    });

    // 8. Post-commit provisioning: the mandate files and API key. Runs outside
    //    the transaction because it writes to the filesystem; a failure here
    //    leaves a pending-approval agent the board can still inspect and
    //    decide, and is loud in the activity log rather than silent.
    if (result.hired && hiredAgentId) {
      const agentId = hiredAgentId;
      try {
        await provisionReviewer(agentId);
      } catch (error) {
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "cos_reviewer_auto_hire",
          action: "reviewer_hire_provision_failed",
          entityType: "agent",
          entityId: agentId,
          agentId,
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        }).catch(() => undefined);
      }
    }

    return result;
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
