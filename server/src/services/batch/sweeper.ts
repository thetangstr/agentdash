import { and, eq, inArray, lt, or, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { batchOperationItems, batchOperations } from "@paperclipai/db";
import { BATCH_HEARTBEAT_STALE_MS, BATCH_REASON_CODES, type BatchOrigin } from "@paperclipai/shared";
import { runWithBatchActivityContext } from "../../lib/batch-activity-context.js";
import { logActivity } from "../activity-log.js";
import { recountBatch } from "./runner.js";

/**
 * AgentDash admin powers, part 2: the batch sweeper. Runs at boot and every 5
 * minutes (server/src/index.ts), and is safe with more than one replica: every
 * transition is a conditional UPDATE, so only one sweeper wins each batch.
 *
 * - A `running` batch whose heartbeat is more than 60 seconds old stopped (a
 *   restart, a crash). It becomes `interrupted`. Items that were being sent
 *   become `unknown` — they may have landed and are never resent — and items
 *   never sent become `refused` with `batch_interrupted`.
 * - A `previewed` batch past its expiry becomes `expired`. Nothing is deleted;
 *   the rows are the audit record.
 */
export async function interruptBatch(db: Db, batchId: string): Promise<boolean> {
  const [batch] = await db
    .update(batchOperations)
    .set({ status: "interrupted", completedAt: new Date() })
    .where(and(eq(batchOperations.id, batchId), eq(batchOperations.status, "running")))
    .returning();
  if (!batch) return false;
  const now = new Date();
  await db
    .update(batchOperationItems)
    .set({
      outcome: "unknown",
      reasonCode: BATCH_REASON_CODES.interrupted,
      reason: "The batch stopped while this record was being changed. It may or may not have changed; check it before trying again.",
      updatedAt: now,
    })
    .where(and(eq(batchOperationItems.batchId, batchId), eq(batchOperationItems.outcome, "applying")));
  await db
    .update(batchOperationItems)
    .set({
      outcome: "refused",
      reasonCode: BATCH_REASON_CODES.interrupted,
      reason: "The batch stopped before reaching this record; nothing was done to it.",
      updatedAt: now,
    })
    .where(and(eq(batchOperationItems.batchId, batchId), eq(batchOperationItems.outcome, "pending")));
  const counts = await recountBatch(db, batchId);
  await runWithBatchActivityContext({ batchId, companyId: batch.companyId, origin: batch.origin as BatchOrigin }, () =>
    logActivity(db, {
      companyId: batch.companyId,
      actorType: "system",
      actorId: "batch-sweeper",
      action: "batch.interrupted",
      entityType: "batch",
      entityId: batchId,
      details: { kind: batch.kind, counts, createdByUserId: batch.createdByUserId },
    }));
  return true;
}

export async function sweepBatches(db: Db, now = new Date()): Promise<{ interrupted: number; expired: number }> {
  const staleBefore = new Date(now.getTime() - BATCH_HEARTBEAT_STALE_MS);
  const stale = await db
    .select({ id: batchOperations.id })
    .from(batchOperations)
    .where(and(
      eq(batchOperations.status, "running"),
      or(lt(batchOperations.executorHeartbeatAt, staleBefore), isNull(batchOperations.executorHeartbeatAt)),
    ));
  let interrupted = 0;
  for (const { id } of stale) if (await interruptBatch(db, id)) interrupted++;
  const expired = await db
    .update(batchOperations)
    .set({ status: "expired" })
    .where(and(eq(batchOperations.status, "previewed"), lt(batchOperations.expiresAt, now)))
    .returning({ id: batchOperations.id });
  return { interrupted, expired: expired.length };
}

/** Test helper and admin tooling: the open (unsettled) items of a batch. */
export async function openBatchItemCount(db: Db, batchId: string): Promise<number> {
  const rows = await db
    .select({ id: batchOperationItems.id })
    .from(batchOperationItems)
    .where(and(eq(batchOperationItems.batchId, batchId), inArray(batchOperationItems.outcome, ["pending", "applying"])));
  return rows.length;
}
