// AgentDash: durable, key-bound readback handles; consumption proves only one attempt.
import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import { humanActionHandles, type Db } from '@paperclipai/db';
import type { HumanTarget } from '@paperclipai/shared';
import { notFound } from '../errors.js';
import { hashBearerToken } from './board-auth.js';

type Binding = { userId: string; keyId: string; target: HumanTarget };

// Review P2 (#859): handles carry answer text in payload/result. A terminal
// handle is kept for a day after it expires (readback of "what happened"),
// a recovery_required one for seven days after its expiry (the recovery
// window); then it is deleted. The sweep marks an expired prepared handle
// expired and clears its payload; get() does the same when it finds an
// expired prepared handle first. The row itself is deleted a day after expiry.
export const HUMAN_ACTION_HANDLE_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
export const HUMAN_ACTION_HANDLE_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export function humanActionHandleService(db: Db) {
  async function reject(id: string, status: 'denied' | 'stale' | 'expired') {
    // An expired handle can never be confirmed, so its private payload goes now.
    await db.update(humanActionHandles).set({ status, consumedAt: new Date(), ...(status === 'expired' ? { payload: {}, preconditions: {} } : {}) })
      .where(and(eq(humanActionHandles.id, id), eq(humanActionHandles.status, 'prepared')));
  }
  return {
    async prepare(input: Binding & { operationId: string; version: number; payload: Record<string, unknown>; preconditions: Record<string, unknown> }, beforeWrite?: () => void) {
      const handle = randomBytes(32).toString('base64url');
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000);
      beforeWrite?.();
      const [row] = await db.insert(humanActionHandles).values({
        tokenHash: hashBearerToken(handle), actorUserId: input.userId, boardApiKeyId: input.keyId,
        targetKind: input.target.kind, companyId: input.target.kind === 'company' ? input.target.companyId : null,
        operationId: input.operationId, version: input.version, payload: input.payload, preconditions: input.preconditions,
        expiresAt, createdAt,
      }).returning({ id: humanActionHandles.id });
      return { id: row.id, handle, expiresAt: expiresAt.toISOString(), confirmation: 'human_readback' as const };
    },
    async get(handle: string, binding: Binding) {
      const [row] = await db.select().from(humanActionHandles).where(and(
        eq(humanActionHandles.tokenHash, hashBearerToken(handle)),
        eq(humanActionHandles.actorUserId, binding.userId), eq(humanActionHandles.boardApiKeyId, binding.keyId),
        eq(humanActionHandles.targetKind, binding.target.kind),
        binding.target.kind === 'company' ? eq(humanActionHandles.companyId, binding.target.companyId) : isNull(humanActionHandles.companyId),
      ));
      if (!row) throw notFound('Human action handle not found');
      if (row.status === 'prepared' && row.expiresAt.getTime() <= Date.now()) {
        await reject(row.id, 'expired');
        return { ...row, status: 'expired' };
      }
      return row;
    },
    async claim(id: string) {
      // Persist uncertainty BEFORE dispatch. A process crash cannot make the
      // action retryable or make an unknown external effect look completed.
      const [row] = await db.update(humanActionHandles).set({ status: 'recovery_required', consumedAt: new Date() })
        .where(and(eq(humanActionHandles.id, id), eq(humanActionHandles.status, 'prepared'), gt(humanActionHandles.expiresAt, new Date())))
        .returning();
      return row ?? null;
    },
    reject,
    /** Retention sweep; uses the (status, expires_at) index. */
    async sweep(now = new Date()) {
      const expired = await db.update(humanActionHandles)
        .set({ status: 'expired', consumedAt: now, payload: {}, preconditions: {}, result: null })
        .where(and(eq(humanActionHandles.status, 'prepared'), lte(humanActionHandles.expiresAt, now)))
        .returning({ id: humanActionHandles.id });
      const terminal = await db.delete(humanActionHandles)
        .where(and(inArray(humanActionHandles.status, ['completed', 'denied', 'stale', 'expired']),
          lt(humanActionHandles.expiresAt, new Date(now.getTime() - HUMAN_ACTION_HANDLE_TERMINAL_RETENTION_MS))))
        .returning({ id: humanActionHandles.id });
      const recovery = await db.delete(humanActionHandles)
        .where(and(eq(humanActionHandles.status, 'recovery_required'),
          lt(humanActionHandles.expiresAt, new Date(now.getTime() - HUMAN_ACTION_HANDLE_RECOVERY_RETENTION_MS))))
        .returning({ id: humanActionHandles.id });
      return { expired: expired.length, deleted: terminal.length + recovery.length };
    },
    async recordRecovery(id: string, reference: Record<string, unknown>) {
      await db.update(humanActionHandles).set({ result: { reference } })
        .where(and(eq(humanActionHandles.id, id), eq(humanActionHandles.status, 'recovery_required')));
    },
    async refuseClaimed(id: string, status: 'denied' | 'stale') {
      await db.update(humanActionHandles).set({ status })
        .where(and(eq(humanActionHandles.id, id), eq(humanActionHandles.status, 'recovery_required')));
    },
    async finish(id: string, input: { result: Record<string, unknown> }) {
      await db.update(humanActionHandles).set({ status: 'completed', result: input.result })
        .where(and(eq(humanActionHandles.id, id), eq(humanActionHandles.status, 'recovery_required')));
    },
  };
}
