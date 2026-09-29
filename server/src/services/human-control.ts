import { isDeepStrictEqual } from 'node:util';
// AgentDash: finite named-human operations; no caller-controlled transport paths.
import type { Request } from 'express';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { boardApiKeys, companies, type Db } from '@paperclipai/db';
import type { HumanOperationDescriptor, HumanTarget } from '@paperclipai/shared';
import { z } from 'zod';
import { badRequest, conflict, forbidden } from '../errors.js';
import { assertCompanyAccess } from '../routes/authz.js';
import { boardAuthService } from './board-auth.js';
import { humanActionHandleService } from './human-action-handles.js';

export interface HumanOperationContext { db: Db; req: Request; target: HumanTarget; lock?: boolean }
export interface HumanOperation {
  descriptor: HumanOperationDescriptor;
  // Omitted policy always retains canonical membership access.
  companyAccess?: 'canonical' | 'instance_admin_stewardship';
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  authorize(context: HumanOperationContext): void | Promise<void>;
  resolve(context: HumanOperationContext, input: Record<string, unknown>): Promise<{ payload: Record<string, unknown>; preconditions: Record<string, unknown>; readback?: Record<string, unknown> }>;
  read?(context: HumanOperationContext, input: Record<string, unknown>): Promise<unknown>;
  recoveryReference?(value: unknown): Record<string, unknown>;
  afterCommit?(context: HumanOperationContext, payload: Record<string, unknown>, result: unknown): Promise<unknown>;
  execute?(context: HumanOperationContext, payload: Record<string, unknown>, actionId: string): Promise<unknown>;
}
export function humanControlService(db: Db, operations: HumanOperation[]) {
  const registry = new Map(operations.map(operation => [operation.descriptor.operationId, operation]));
  if (registry.size !== operations.length) throw new Error('Duplicate human operation registration');
  for (const op of operations) {
    if (op.companyAccess === 'instance_admin_stewardship' && !['human_questions.stewardship.assign', 'human_questions.stewardship.transfer'].includes(op.descriptor.operationId)) throw new Error('Instance administrator exception is restricted to canonical stewardship operations');
  }
  const handles = humanActionHandleService(db);
  async function identity(req: Request, connection = db) {
    if (req.actor.type !== 'board' || req.actor.source !== 'board_key' || !req.actor.userId || !req.actor.keyId) throw forbidden('Named board-key human authentication required');
    const [key] = await connection.select({ id: boardApiKeys.id }).from(boardApiKeys).where(and(eq(boardApiKeys.id, req.actor.keyId), eq(boardApiKeys.userId, req.actor.userId), isNull(boardApiKeys.revokedAt), or(isNull(boardApiKeys.expiresAt), gt(boardApiKeys.expiresAt, new Date()))));
    const access = await boardAuthService(connection).resolveBoardAccess(req.actor.userId);
    if (!key || !access.user) throw forbidden('Human connection is no longer authorized');
    // Re-resolve the original authenticated principal; never manufacture another actor.
    req.actor.companyIds = access.companyIds; req.actor.memberships = access.memberships; req.actor.isInstanceAdmin = access.isInstanceAdmin;
    const choices = connection.select({ id: companies.id, name: companies.name }).from(companies);
    const accessibleCompanies = access.isInstanceAdmin ? await choices : access.companyIds.length ? await choices.where(inArray(companies.id, access.companyIds)) : [];
    return { companies: accessibleCompanies, source: 'board_key', user: access.user, isInstanceAdmin: access.isInstanceAdmin, memberships: access.memberships, targets: [{ kind: 'self' }, { kind: 'instance' }, { kind: 'public' }, ...accessibleCompanies.map(company => ({ kind: 'company', companyId: company.id }))] };
  }
  function operation(id: string, version: number) {
    const result = registry.get(id as HumanOperationDescriptor['operationId']);
    if (!result || result.descriptor.version !== version) throw badRequest('Unknown human operation or version');
    return result;
  }
  function context(req: Request, target: HumanTarget, connection = db, lock = false): HumanOperationContext {
    return { req, target, db: connection, lock };
  }
  async function authorize(op: HumanOperation, ctx: HumanOperationContext) {
    if (op.descriptor.targetKind !== ctx.target.kind) throw badRequest('Operation does not support this target kind');
    if (ctx.target.kind === 'company' && !(op.companyAccess === 'instance_admin_stewardship' && ctx.req.actor.isInstanceAdmin)) assertCompanyAccess(ctx.req, ctx.target.companyId);
    await op.authorize(ctx);
  }
  return {
    identity,
    async discover(req: Request, target: HumanTarget, pageId?: string, page: { cursor?: string; limit?: number } = {}) {
      const actor = await identity(req);
      if (target.kind === 'company' && !actor.companies.some(company => company.id === target.companyId)) throw forbidden('Company access denied');
      const allowed: HumanOperationDescriptor[] = [];
      for (const op of operations) {
        if (op.descriptor.targetKind !== target.kind || (pageId && op.descriptor.pageId !== pageId)) continue;
        try { await authorize(op, context(req, target)); allowed.push(op.descriptor); }
        catch (error) { if ((error as {status?:number}).status !== 403) throw error; }
      }
      const cursorIndex = page.cursor ? allowed.findIndex(op => op.operationId === page.cursor) : -1;
      if (page.cursor && cursorIndex < 0) throw badRequest('Unknown discovery cursor');
      const offset = cursorIndex + 1;
      const items = allowed.slice(offset, offset + (page.limit ?? 100));
      return { target, operations: items, nextCursor: offset + items.length < allowed.length ? items.at(-1)!.operationId : null };
    },
    async read(req: Request, input: { target: HumanTarget; operationId: string; version: number; input: Record<string, unknown> }) {
      await identity(req);
      const op = operation(input.operationId, input.version), parsed = op.input.parse(input.input);
      if (!op.read) throw badRequest('This operation requires prepare and confirm');
      const ctx = context(req, input.target); await authorize(op, ctx);
      return op.output.parse(JSON.parse(JSON.stringify(await op.read(ctx, parsed))));
    },
    async prepare(req: Request, input: { target: HumanTarget; operationId: string; version: number; input: Record<string, unknown> }) {
      await identity(req);
      const op = operation(input.operationId, input.version), parsed = op.input.parse(input.input);
      if (!op.execute) throw badRequest('Read operations cannot be prepared');
      const ctx = context(req, input.target); await authorize(op, ctx);
      const resolved = await op.resolve(ctx, parsed);
      const [company] = input.target.kind === 'company' ? await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, input.target.companyId)) : [];
      const prepared = await handles.prepare({ userId: req.actor.userId!, keyId: req.actor.keyId!, target: input.target, operationId: input.operationId, version: input.version, ...resolved });
      return { ...prepared, target: input.target, operationId: input.operationId, version: input.version, readback: { target: input.target, company: company ?? null, input: resolved.payload, context: resolved.readback ?? {} } };
    },
    async confirm(req: Request, input: { target: HumanTarget; handle: string }) {
      await identity(req);
      const row = await handles.get(input.handle, { userId: req.actor.userId!, keyId: req.actor.keyId!, target: input.target });
      if (row.status !== 'prepared') throw conflict('Human action is no longer executable', { status: row.status, actionId: row.id, result: row.result });
      const op = operation(row.operationId, row.version);
      try {
        await authorize(op, context(req, input.target));
        const current = await op.resolve(context(req, input.target), op.input.parse(row.payload));
        if (!isDeepStrictEqual(current.preconditions, row.preconditions)) throw conflict('Human action preconditions changed');
      } catch (error) {
        await handles.reject(row.id, (error as {status?:number}).status === 403 ? 'denied' : 'stale');
        throw error;
      }
      if (!await handles.claim(row.id)) throw conflict('Human action already claimed');
      let committed = false;
      try {
        let result = await db.transaction(async tx => {
          const connection = tx as unknown as Db;
          if (input.target.kind === 'company') await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, input.target.companyId)).for('update');
          const ctx = context(req, input.target, connection, true);
          await identity(req, connection);
          await authorize(op, ctx);
          const current = await op.resolve(ctx, op.input.parse(row.payload));
          if (!isDeepStrictEqual(current.preconditions, row.preconditions)) throw conflict('Human action preconditions changed');
          const value = await op.execute!(ctx, row.payload, row.id);
          if (!op.afterCommit) {
            const output = op.output.parse(JSON.parse(JSON.stringify(value)));
            await humanActionHandleService(connection).finish(row.id, { result: { value: output } });
            return output;
          }
          await humanActionHandleService(connection).recordRecovery(row.id, { operationId: row.operationId, target: input.target, ...(op.recoveryReference?.(value) ?? {}) });
          return value;
        });
        committed = true;
        if (op.afterCommit) {
          result = op.output.parse(JSON.parse(JSON.stringify(await op.afterCommit(context(req, input.target), row.payload, result))));
          await handles.finish(row.id, { result: { value: result } });
        }
        return { status: 'completed', actionId: row.id, result };
      } catch (error) {
        if (!committed && [400, 403, 404, 409, 422].includes((error as {status:number}).status)) {
          await handles.refuseClaimed(row.id, (error as {status:number}).status === 403 ? 'denied' : 'stale');
          throw error;
        }
        const recovery = await handles.get(input.handle, { userId: req.actor.userId!, keyId: req.actor.keyId!, target: input.target });
        // No unknown exception/private payload is echoed or mislabeled success.
        throw conflict('Human action requires recovery; inspect the canonical resource before retrying', { status: 'recovery_required', actionId: row.id, operationId: row.operationId, target: input.target, result: recovery.result });
      }
    },
  };
}
