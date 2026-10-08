import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
// AgentDash: finite named-human operations; no caller-controlled transport paths.
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { companies, type Db } from '@paperclipai/db';
import type { HumanOperationDescriptor, HumanTarget } from '@paperclipai/shared';
import { z } from 'zod';
import { badRequest, conflict, forbidden } from '../errors.js';
import { assertCompanyAccess } from '../routes/authz.js';
import { publishActivity, type ActivityPublication } from './activity-log.js';
import type { ActivityAcceptance } from './activity-log.js';
import { humanActionHandleService } from './human-action-handles.js';
import { foundationAuthority } from './human-control/authority.js';
import { verifiedBoardCredential } from '../middleware/auth.js';

const recoveryReferenceSchema = z.object({
  issueId: z.string().uuid().optional(),
  interactionId: z.string().uuid().optional(),
  enrollmentId: z.string().uuid().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
export type HumanRecoveryReference = z.infer<typeof recoveryReferenceSchema>;

export interface HumanOperationContext { db: Db; req: Request; target: HumanTarget; lock?: boolean; acceptance?: ActivityAcceptance; beforeWrite?: () => void; assertQuestionSource?: import("./issue-thread-interactions.js").QuestionWriteGuards["assertSource"]; authority?: ReturnType<typeof foundationAuthority>; recoveryQuestions?: (issueId: string) => Promise<import('@paperclipai/shared').AskUserQuestionsInteraction[]> }
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
  // Read authorization for an already-applied resource, never mutation resolve:
  // completed questions cannot pass pending-only write preconditions.
  authorizeRecovery?(context: HumanOperationContext, payload: Record<string, unknown>, reference: Record<string, unknown>): Promise<HumanRecoveryReference | null>;
  currentOutput?(context: HumanOperationContext, payload: Record<string, unknown>, value: unknown): Promise<unknown>;
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
  // AgentDash (GH #891): operations a signed-in board SESSION user may apply
  // from the web app, through the same resolve/execute as the board-key
  // prepare/confirm path. Finite on purpose — adding one is a reviewed change.
  const sessionOperations = new Set<string>(['task_recovery.remediate', 'human_questions.recovery.cancel', 'human_questions.replace']);
  function captureSession(req: Request) {
    // Only an interactive browser session of a named user. Board keys use the
    // handle-bound prepare/confirm transport; assistant grants, agents and the
    // implicit local operator are never a named human here.
    const credential = req.verifiedCredential;
    if (req.actor.type !== 'board' || req.actor.source !== 'session' || !req.actor.userId
      || credential?.kind !== 'session' || credential.userId !== req.actor.userId) {
      throw forbidden('A signed-in board user is required for this action');
    }
    return foundationAuthority(req);
  }
  function sessionOperation(id: string, version: number) {
    const op = operation(id, version);
    if (!sessionOperations.has(op.descriptor.operationId) || !op.execute) throw badRequest('This operation is not available to board sessions');
    return op;
  }
  function capture(req: Request) {
    const credential = verifiedBoardCredential(req);
    if (!credential || (credential.expiresAt !== null && credential.expiresAt <= Date.now())) throw forbidden('Named board-key human authentication required');
    return foundationAuthority(req);
  }
  async function identity(req: Request) {
    const authority = capture(req);
    return db.transaction(async tx => {
      const guard = await authority.global(tx as unknown as Db);
      return guard.seal();
    });
  }
  async function protectedOperation<T>(req: Request, target: HumanTarget, op: HumanOperation, payload: Record<string, unknown>, authority: ReturnType<typeof foundationAuthority>,
    work: (ctx: HumanOperationContext, seal: () => Promise<void>) => Promise<T>, recovery = false, lock = true) {
    if (target.kind !== 'company') throw badRequest('Operation does not support this target kind');
    return db.transaction(async tx => {
      const connection = tx as unknown as Db;
      const guard = await authority.stage(connection, { companyId: target.companyId, operationId: op.descriptor.operationId, input: payload, recovery, readOnly: !lock });
      // Review P1 (#859): read-only callbacks (read, recovery readback,
      // current output) do not take row write locks; the stage witnesses
      // (FOR SHARE) already pin what they read.
      const ctx = { ...context(req, target, connection, lock), authority, beforeWrite: guard.checkTime, assertQuestionSource: guard.assertSource, recoveryQuestions: guard.recoveryQuestions };
      await authorize(op, ctx);
      const result = await work(ctx, guard.seal);
      guard.checkTime();
      return result;
    });
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
    const stewardshipAdmin = op.companyAccess === 'instance_admin_stewardship' && ctx.req.actor.isInstanceAdmin;
    if (ctx.target.kind === 'company' && !stewardshipAdmin) {
      assertCompanyAccess(ctx.req, ctx.target.companyId);
    }
    await op.authorize(ctx);
  }
  async function terminalDetails(req: Request, target: HumanTarget, authority: ReturnType<typeof foundationAuthority>, row: Awaited<ReturnType<typeof handles.get>>) {
    const details: { status: string; actionId: string; result?: { reference: HumanRecoveryReference } } = {
      status: row.status,
      actionId: row.id,
    };
    // A key-bound handle proves which action was attempted, not present access
    // to cached domain content. Never return result.value, in any terminal state.
    const reference = row.result?.reference;
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return details;
    try {
      const op = operation(row.operationId, row.version);
      if (!op.authorizeRecovery) return details;
      const current = await protectedOperation(req, target, op, row.payload, authority, async (ctx, seal) => {
        const currentReference = await op.authorizeRecovery!(ctx, row.payload, reference as Record<string, unknown>);
        await seal();
        const parsed = recoveryReferenceSchema.safeParse(currentReference);
        return parsed.success ? parsed.data : null;
      }, true, false);
      if (current) details.result = { reference: current };
    } catch {
      // Refused, missing, or uncertain resource access exposes only action state.
    }
    return details;
  }
  return {
    identity,
    // AgentDash: finite safe recovery discovery for a named browser session.
    async sessionRead(req: Request, input: { target: HumanTarget; operationId: string; version: number; input: Record<string, unknown> }) {
      const authority = captureSession(req), op = operation(input.operationId, input.version);
      if (op.descriptor.operationId !== 'human_questions.recovery.list' || !op.read) throw badRequest('This read is not available to board sessions');
      const parsed = op.input.parse(input.input);
      return protectedOperation(req, input.target, op, parsed, authority, async (ctx, seal) => {
        const result = op.output.parse(JSON.parse(JSON.stringify(await op.read!(ctx, parsed))));
        await seal();
        return result;
      }, false, false);
    },
    /**
     * AgentDash (GH #891): the readback a session user reviews before applying
     * a session operation. Read-only; returns the exact preconditions the
     * apply call must send back unchanged.
     */
    async sessionPreview(req: Request, input: { target: HumanTarget; operationId: string; version: number; input: Record<string, unknown> }) {
      const authority = captureSession(req), op = sessionOperation(input.operationId, input.version), parsed = op.input.parse(input.input);
      return protectedOperation(req, input.target, op, parsed, authority, async (ctx, seal) => {
        const resolved = await op.resolve(ctx, parsed);
        await seal();
        return { target: input.target, operationId: input.operationId, version: input.version,
          readback: { target: input.target, input: resolved.payload, context: resolved.readback ?? {} },
          preconditions: resolved.preconditions };
      }, false, false);
    },
    /**
     * AgentDash (GH #891): one deliberate session action = prepare + confirm.
     * The operation is re-resolved under its locks and must still match the
     * preconditions the person reviewed; attribution is the authenticated
     * session user. No durable handle exists on this path: on an uncertain
     * outcome, read the canonical resource rather than applying again.
     */
    async sessionApply(req: Request, input: { target: HumanTarget; operationId: string; version: number; input: Record<string, unknown>; preconditions: Record<string, unknown> }) {
      const authority = captureSession(req), op = sessionOperation(input.operationId, input.version), payload = op.input.parse(input.input);
      await authority.identity.readPrincipal(db);
      const actionId = randomUUID();
      const publications: ActivityPublication[] = [];
      let result = await protectedOperation(req, input.target, op, payload, authority, async (ctx, seal) => {
        const current = await op.resolve(ctx, payload);
        await seal();
        if (!isDeepStrictEqual(current.preconditions, input.preconditions)) {
          throw conflict('This changed since you reviewed it. Review it again before confirming.');
        }
        return op.execute!({ ...ctx, acceptance: { executor: ctx.db, publications } }, payload, actionId);
      });
      for (const publication of publications) publishActivity(publication);
      if (op.afterCommit) result = await op.afterCommit({ ...context(req, input.target), authority }, payload, result);
      const outputPayload = op.descriptor.operationId === 'human_questions.replace' && result && typeof result === 'object'
        ? { ...payload, interactionId: (result as { interactionId: string }).interactionId } : payload;
      const output = await protectedOperation(req, input.target, op, outputPayload, authority, async (ctx, seal) => {
        const current = op.currentOutput ? await op.currentOutput(ctx, outputPayload, result) : result;
        await seal();
        return op.output.parse(JSON.parse(JSON.stringify(current)));
      }, true, false);
      return { status: 'completed' as const, actionId, result: output };
    },
    async discover(req: Request, target: HumanTarget, pageId?: string, page: { cursor?: string; limit?: number } = {}) {
      const authority = capture(req);
      return db.transaction(async tx => {
        const connection = tx as unknown as Db;
        const guard = await authority.global(connection, target.kind === 'company' ? target.companyId : undefined);
        if (target.kind === 'company' && !guard.value.companies.some(company => company.id === target.companyId)) throw forbidden('Company access denied');
        const allowed: HumanOperationDescriptor[] = [];
        for (const op of operations) {
          if (op.descriptor.targetKind !== target.kind || (pageId && op.descriptor.pageId !== pageId)) continue;
          try { await authorize(op, context(req, target, connection)); allowed.push(op.descriptor); }
          catch (error) { if ((error as {status?:number}).status !== 403) throw error; }
        }
        await guard.seal();
        const cursorIndex = page.cursor ? allowed.findIndex(op => op.operationId === page.cursor) : -1;
        if (page.cursor && cursorIndex < 0) throw badRequest('Unknown discovery cursor');
        const offset = cursorIndex + 1, items = allowed.slice(offset, offset + (page.limit ?? 100));
        authority.identity.checkTime();
        return { target, operations: items, nextCursor: offset + items.length < allowed.length ? items.at(-1)!.operationId : null };
      });
    },
    async read(req: Request, input: { target: HumanTarget; operationId: string; version: number; input: Record<string, unknown> }) {
      const authority = capture(req), op = operation(input.operationId, input.version), parsed = op.input.parse(input.input);
      if (!op.read) throw badRequest('This operation requires prepare and confirm');
      return protectedOperation(req, input.target, op, parsed, authority, async (ctx, seal) => {
        const value = op.output.parse(JSON.parse(JSON.stringify(await op.read!(ctx, parsed))));
        await seal();
        return value;
      }, false, false);
    },
    async prepare(req: Request, input: { target: HumanTarget; operationId: string; version: number; input: Record<string, unknown> }) {
      const authority = capture(req), op = operation(input.operationId, input.version), parsed = op.input.parse(input.input);
      if (!op.execute) throw badRequest('Read operations cannot be prepared');
      return protectedOperation(req, input.target, op, parsed, authority, async (ctx, seal) => {
        const resolved = await op.resolve(ctx, parsed);
        await seal();
        const [company] = input.target.kind === 'company' ? await ctx.db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, input.target.companyId)) : [];
        const prepared = await humanActionHandleService(ctx.db).prepare({ userId: req.actor.userId!, keyId: req.actor.keyId!, target: input.target, operationId: input.operationId, version: input.version, ...resolved }, ctx.beforeWrite);
        return { ...prepared, target: input.target, operationId: input.operationId, version: input.version, readback: { target: input.target, company: company ?? null, input: resolved.payload, context: resolved.readback ?? {} } };
      });
    },
    async confirm(req: Request, input: { target: HumanTarget; handle: string }) {
      const authority = capture(req);
      await authority.identity.readPrincipal(db);
      const binding = { userId: req.actor.userId!, keyId: req.actor.keyId!, target: input.target };
      const row = await handles.get(input.handle, binding);
      if (row.status !== 'prepared') throw conflict('Human action is no longer executable', await terminalDetails(req, input.target, authority, row));
      const op = operation(row.operationId, row.version), payload = op.input.parse(row.payload);
      try {
        await protectedOperation(req, input.target, op, payload, authority, async (ctx, seal) => {
          const current = await op.resolve(ctx, payload);
          await seal();
          if (!isDeepStrictEqual(current.preconditions, row.preconditions)) throw conflict('Human action preconditions changed');
        });
      } catch (error) {
        await handles.reject(row.id, [401,403].includes((error as {status?:number}).status ?? 0) ? 'denied' : 'stale');
        throw error;
      }
      if (!await handles.claim(row.id)) throw conflict('Human action already claimed');
      let committed = false, callbackCompleted = false;
      const publications: ActivityPublication[] = [];
      try {
        let result = await protectedOperation(req, input.target, op, payload, authority, async (ctx, seal) => {
          const current = await op.resolve(ctx, payload);
          await seal();
          if (!isDeepStrictEqual(current.preconditions, row.preconditions)) throw conflict('Human action preconditions changed');
          const value = await op.execute!({ ...ctx, acceptance: { executor: ctx.db, publications } }, payload, row.id);
          const reference = op.recoveryReference?.(value);
          if (!op.afterCommit) await humanActionHandleService(ctx.db).finish(row.id, { result: { value: op.output.parse(JSON.parse(JSON.stringify(value))) } });
          else await humanActionHandleService(ctx.db).recordRecovery(row.id, { operationId: row.operationId, target: input.target, ...reference });
          callbackCompleted = true;
          return value;
        });
        committed = true;
        for (const publication of publications) publishActivity(publication);
        if (op.afterCommit) result = await op.afterCommit({ ...context(req, input.target), authority }, payload, result);
        const outputPayload = op.descriptor.operationId === 'human_questions.replace' && result && typeof result === 'object'
          ? { ...payload, interactionId: (result as { interactionId: string }).interactionId } : payload;
        const output = await protectedOperation(req, input.target, op, outputPayload, authority, async (ctx, seal) => {
          const current = op.currentOutput ? await op.currentOutput(ctx, outputPayload, result) : result;
          await seal();
          return op.output.parse(JSON.parse(JSON.stringify(current)));
        }, true, false);
        if (op.afterCommit) await handles.finish(row.id, { result: { value: output } });
        return { status: 'completed', actionId: row.id, result: output };
      } catch (error) {
        // #883 review: a database error raised inside the transaction callback
        // (deadlock, serialization failure, constraint) rolled the transaction
        // back, so nothing committed and the handle is refused as stale rather
        // than left recovery_required. An error after the callback completed
        // (the COMMIT itself) stays uncertain.
        const sqlState = (error as { code?: unknown; cause?: { code?: unknown } }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;
        const rolledBack = typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState);
        if (!committed && !callbackCompleted && rolledBack) {
          await handles.refuseClaimed(row.id, 'stale');
          throw conflict('Human action was not applied; prepare it again', { status: 'stale', actionId: row.id });
        }
        if (!committed && !callbackCompleted && [400,401,403,404,409,422].includes((error as {status:number}).status)) {
          await handles.refuseClaimed(row.id, [401,403].includes((error as {status:number}).status) ? 'denied' : 'stale');
          throw error;
        }
        const recovery = await handles.get(input.handle, binding);
        throw conflict('Human action requires recovery; inspect the canonical resource before retrying', await terminalDetails(req, input.target, authority, recovery));
      }
    },
  };
}
