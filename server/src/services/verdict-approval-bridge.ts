// AgentDash: goals-eval-hitl
import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";
import type { VerdictOutcome } from "@paperclipai/shared";
import { COS_REVIEW_DEFAULTS } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { subscribeGlobalLiveEvents } from "./live-events.js";
import type { VerdictsService } from "./verdicts.js";

type ApprovalRow = typeof approvals.$inferSelect;

interface BridgeDeps {
  verdicts: VerdictsService;
}

/**
 * Verdict ↔ Approval bridge — caller-only.
 *
 * Per the consensus plan §3 Phase C4 + ADR Consequences:
 *  - The bridge LISTENS for approval status changes and the WRITES a
 *    closing verdict. It never mutates approvals state and never edits
 *    the inherited `approvals.ts` body.
 *  - Inbound channel preference: the existing `activity.logged` LiveEvent
 *    bus already publishes `approval.approved`/`approval.rejected`/
 *    `approval.revision_requested` events from the approval routes (see
 *    server/src/routes/approvals.ts). Subscribing to that channel closes
 *    the loop without modifying approvals service body.
 *  - Polling fallback: if `startWatcher` is invoked with `usePolling:true`
 *    (or the LiveEvent bus is unavailable in some context), polls
 *    `approvals` rows where `decidedAt > lastSeenAt` AND
 *    `payload.type = 'verdict_escalation'`.
 *
 * NOT modified: `server/src/services/approvals.ts`. The bridge calls
 * `approvalService.getById(...)` indirectly via `db.select()` reads only.
 */
export function verdictApprovalBridge(db: Db, deps: BridgeDeps) {
  const RESOLVED_STATUSES = ["approved", "rejected", "revision_requested"] as const;
  type ResolvedStatus = (typeof RESOLVED_STATUSES)[number];

  function statusToOutcome(status: ResolvedStatus): VerdictOutcome {
    if (status === "approved") return "passed";
    if (status === "rejected") return "failed";
    return "revision_requested";
  }

  async function getApprovalById(approvalId: string): Promise<ApprovalRow | null> {
    return db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
  }

  async function onApprovalResolved(approvalId: string): Promise<void> {
    const approval = await getApprovalById(approvalId);
    if (!approval) return;

    if (!RESOLVED_STATUSES.includes(approval.status as ResolvedStatus)) return;

    // Only verdict-escalation approvals are our concern.
    const payload = (approval.payload ?? {}) as Record<string, unknown>;
    if (payload.type !== "verdict_escalation") return;

    const verdictId = typeof payload.verdictId === "string" ? payload.verdictId : null;
    const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
    if (!verdictId || !issueId) {
      // Malformed escalation payload — log and bail. We don't mutate the
      // approval row.
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "system",
        actorId: "verdict_approval_bridge",
        action: "verdict_escalation_payload_invalid",
        entityType: "approval",
        entityId: approval.id,
        details: { reason: "missing verdictId or issueId in payload" },
      });
      return;
    }

    // Idempotency: if a closing verdict already exists for the issue, bail.
    const closing = await deps.verdicts.closingVerdictFor(
      approval.companyId,
      "issue",
      issueId,
    );
    if (closing) {
      // We may have already mirrored this resolution in a previous tick.
      return;
    }

    const decidedByUserId = approval.decidedByUserId;
    if (!decidedByUserId) {
      // Approval claims resolved but no decider — wait for next event.
      return;
    }

    const outcome = statusToOutcome(approval.status as ResolvedStatus);

    const verdict = await deps.verdicts.create({
      companyId: approval.companyId,
      entityType: "issue",
      issueId,
      reviewerUserId: decidedByUserId,
      outcome,
      justification: approval.decisionNote ?? undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: decidedByUserId,
      action: "human_decision_recorded",
      entityType: "issue",
      entityId: issueId,
      details: {
        approvalId: approval.id,
        verdictId: verdict.id,
        originalEscalationVerdictId: verdictId,
        outcome,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Watcher (LiveEvent subscription with polling fallback)
  // -------------------------------------------------------------------------

  const APPROVAL_RESOLVED_ACTIONS: ReadonlySet<string> = new Set([
    "approval.approved",
    "approval.rejected",
    "approval.revision_requested",
  ]);

  let unsubscribeLive: (() => void) | null = null;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let lastSeenAt: Date = new Date(0);

  function pollIntervalMs(): number {
    const raw = process.env.AGENTDASH_APPROVAL_POLL_MS;
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return COS_REVIEW_DEFAULTS.BRIDGE_POLL_INTERVAL_MS;
  }

  async function pollOnce(): Promise<void> {
    const now = new Date();
    const since = lastSeenAt;
    const rows = await db
      .select()
      .from(approvals)
      .where(
        and(
          gt(approvals.decidedAt, since),
          inArray(approvals.status, RESOLVED_STATUSES as unknown as string[]),
        ),
      );
    for (const row of rows) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      if (payload.type !== "verdict_escalation") continue;
      try {
        await onApprovalResolved(row.id);
      } catch {
        // Non-fatal: next tick will retry.
      }
    }
    lastSeenAt = now;
  }

  function startWatcher(opts?: { intervalMs?: number; usePolling?: boolean }): () => void {
    // Decision (Phase C2): prefer LiveEvent subscription. The activity-log
    // writer already publishes `activity.logged` events with the
    // `approval.approved`/`approval.rejected`/`approval.revision_requested`
    // actions (see server/src/routes/approvals.ts + activity-log.ts). We
    // never added these emits — they exist independently — so subscribing
    // does not edit approvals.ts.
    //
    // The polling fallback is opt-in via `usePolling:true` so app bootstrap
    // can choose its policy without a code change here.
    const usePolling = opts?.usePolling === true;

    if (!usePolling) {
      unsubscribeLive = subscribeGlobalLiveEvents((event) => {
        if (event.type !== "activity.logged") return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const action = typeof payload.action === "string" ? payload.action : null;
        if (!action || !APPROVAL_RESOLVED_ACTIONS.has(action)) return;
        const entityId = typeof payload.entityId === "string" ? payload.entityId : null;
        if (!entityId) return;
        // Fire-and-forget: errors don't kill the subscription.
        void onApprovalResolved(entityId).catch(() => {});
      });
    }

    const ms = opts?.intervalMs ?? pollIntervalMs();
    if (usePolling) {
      lastSeenAt = new Date();
      pollHandle = setInterval(() => {
        void pollOnce().catch(() => {});
      }, ms);
      // Don't keep the process alive solely for this watcher.
      if (typeof pollHandle.unref === "function") pollHandle.unref();
    }

    return stopWatcher;
  }

  function stopWatcher(): void {
    if (unsubscribeLive) {
      unsubscribeLive();
      unsubscribeLive = null;
    }
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  return {
    onApprovalResolved,
    startWatcher,
    stopWatcher,
    /** Exposed for tests; not part of the public Phase D contract. */
    _pollOnce: pollOnce,
  };
}

export type VerdictApprovalBridgeService = ReturnType<typeof verdictApprovalBridge>;
