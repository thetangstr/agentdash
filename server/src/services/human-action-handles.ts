// AgentDash: durable, key-bound readback handles; consumption proves only one attempt.
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { humanActionHandles, type Db } from '@paperclipai/db';
import type { HumanTarget } from '@paperclipai/shared';
import { notFound } from '../errors.js';
import { hashBearerToken } from './board-auth.js';

type Binding = { userId: string; keyId: string; target: HumanTarget };
export function humanActionHandleService(db: Db) {
  async function reject(id: string, status: 'denied' | 'stale' | 'expired') {
    await db.update(humanActionHandles).set({ status, consumedAt: new Date() })
      .where(and(eq(humanActionHandles.id, id), eq(humanActionHandles.status, 'prepared')));
  }
  return {
    async prepare(input: Binding & { operationId: string; version: number; payload: Record<string, unknown>; preconditions: Record<string, unknown> }) {
      const handle = randomBytes(32).toString('base64url');
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000);
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
