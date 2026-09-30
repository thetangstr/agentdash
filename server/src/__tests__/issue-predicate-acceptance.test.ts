import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { activityLog, agents, authUsers, boardApiKeys, companies, companyMemberships, createDb, goals, heartbeatRuns, issueComments, issueRelations, issueThreadInteractions, issues, projects, type Db } from '@paperclipai/db';
import { documentService } from '../services/documents.js';
import { issueService } from '../services/issues.js';
import { issuePatchActions, type IssuePatchContext } from '../services/issue-patch-actions.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { issueTreeControlService } from '../services/issue-tree-control.js';
import { featureFlagsService } from '../services/feature-flags.js';
import { goalService } from '../services/goals.js';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { issueRoutes } from '../routes/issues.js';
import { hashBearerToken } from '../services/board-auth.js';
import type { StorageService } from '../storage/types.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
const effects = vi.hoisted(() => ({ cancelled: [] as string[], wake: vi.fn(), report: vi.fn() }));
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));
vi.mock('../services/heartbeat.js', () => ({ heartbeatService: (db: Db) => ({
  getRun: async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0],
  getActiveRunForAgent: async () => null,
  cancelRun: async (id: string) => { effects.cancelled.push(id); return (await db.update(heartbeatRuns).set({ status: 'cancelled' }).where(eq(heartbeatRuns.id, id)).returning())[0]; },
  wakeup: effects.wake, reportRunActivity: effects.report,
}) }));
function gate() { let open!: () => void; const promise = new Promise<void>(r => { open = r; }); return { promise, open }; }
const cInput = { kind: 'request_confirmation' as const, payload: { version: 1 as const, prompt: 'Proceed?', supersedeOnUserComment: true } };

describe('composed predicate acceptance over canonical HTTP and real PostgreSQL', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, server: Server, base: string;
  let lockTable: unknown = companies;
  let onCompanyLock: (() => Promise<void>) | undefined, acceptancePid = 0;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('predicate-http-'); db = createDb(temp.connectionString);
    const routeDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return (callback: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => {
        acceptancePid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
        return callback(new Proxy(tx, { get(t, k, r) {
          if (k !== 'select') return Reflect.get(t, k, r);
          return (...args: unknown[]) => {
            const query = (t.select as Function)(...args), from = query.from.bind(query);
            query.from = (table: unknown) => {
              const builder = from(table), originalFor = builder.for.bind(builder);
              builder.for = (mode: string) => {
                const result = originalFor(mode);
                if (table !== lockTable || mode !== 'update' || !onCompanyLock) return result;
                const hook = onCompanyLock; onCompanyLock = undefined;
                return { then: (resolve: Function, reject: Function) => Promise.resolve(result).then(async rows => { await hook(); return rows; }).then(resolve, reject) };
              };
              return builder;
            };
            return query;
          };
        } }));
      });
    } });
    const app = express(); app.use(express.json()); app.use(actorMiddleware(db, { deploymentMode: 'authenticated' }));
    app.use('/api', issueRoutes(routeDb, {} as StorageService)); app.use(errorHandler);
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  }, 20000);
  beforeEach(() => { effects.cancelled.length = 0; vi.clearAllMocks(); onCompanyLock = undefined; });
  afterAll(async () => { if (server) await new Promise<void>(r => server.close(() => r())); await temp?.cleanup(); });
  async function fixture() {
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'Human', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(boardApiKeys).values({ userId, name: 'Disposable', keyHash: hashBearerToken(token), expiresAt: new Date(Date.now() + 60000) });
    const [company] = await db.insert(companies).values({ name: 'Predicate acceptance', issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: 'owner', status: 'active' });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Worker', autonomy: 'autonomous', accountableUserId: userId, adapterType: 'codex_local' }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: 'running' }).returning();
    const [issue, blocker] = await db.insert(issues).values(['Target', 'Blocker'].map(title => ({ companyId: company.id, title, status: 'backlog', assigneeAgentId: agent.id, executionRunId: run.id }))).returning();
    return { userId, token, company, agent, run, issue, blocker };
  }
  async function blockedBy(pid: number, label: string) {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const rows = await db.execute(sql`select pid, query, pg_blocking_pids(pid) blockers from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`);
      if (rows.length) { console.log(JSON.stringify({ label, ownerPid: pid, blocked: rows })); return rows; }
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`No actual PostgreSQL blocking observed: ${label}`);
  }
  async function read(f: Awaited<ReturnType<typeof fixture>>) {
    return { issue: (await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0], run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0], comments: await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id)), audits: await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id)) };
  }

  it.each(['blocks-add', 'blocks-clear', 'confirmation-create', 'confirmation-reject', 'dod-insert', 'dod-definition', 'hold-create', 'hold-release', 'goal-first', 'goal-preferred', 'project-fallback'] as const)('%s orders both writer-first and acceptance-first with durable effects', async kind => {
    for (const order of ['writer-first', 'acceptance-first'] as const) {
      const f = await fixture(), entered = gate(), proceed = gate(), writerReady = gate();
      const actor = { userId: f.userId }, treeActor = { actorType: 'user' as const, actorId: f.userId, userId: f.userId };
      let writerPid = 0, selectedGoal: string | null = null;
      let intent: Record<string, unknown> = { title: 'Accepted', comment: 'Accepted comment', interrupt: true };
      let expectedWriterFirst = 200, expectedAcceptanceFirst = 200;
      let write: (connection: Db) => Promise<unknown>;
      if (kind.startsWith('blocks')) {
        if (kind === 'blocks-clear') await db.insert(issueRelations).values({ companyId: f.company.id, issueId: f.blocker.id, relatedIssueId: f.issue.id, type: 'blocks' });
        intent.status = 'in_progress'; expectedWriterFirst = kind === 'blocks-add' ? 422 : 200; expectedAcceptanceFirst = kind === 'blocks-clear' ? 422 : 200;
        write = c => issueService(c).update(f.issue.id, { blockedByIssueIds: kind === 'blocks-add' ? [f.blocker.id] : [] });
      } else if (kind.startsWith('confirmation')) {
        const c = kind === 'confirmation-create' ? null : await issueThreadInteractionService(db).create(f.issue, cInput, actor);
        write = connection => kind === 'confirmation-create' ? issueThreadInteractionService(connection).create(f.issue, cInput, actor) : issueThreadInteractionService(connection).rejectInteraction(f.issue, c!.id, {}, actor);
      } else if (kind.startsWith('dod')) {
        intent.status = 'todo'; expectedWriterFirst = 422;
        if (kind === 'dod-definition') {
          await featureFlagsService(db).set(f.company.id, 'dod_guard_enabled', true);
          await db.update(issues).set({ definitionOfDone: { summary: 'Checked delivery', criteria: [{ id: 'checked', text: 'Ship checked work', done: false }] } }).where(eq(issues.id, f.issue.id));
        }
        write = c => kind === 'dod-insert' ? featureFlagsService(c).set(f.company.id, 'dod_guard_enabled', true) : issueService(c).update(f.issue.id, { definitionOfDone: null });
      } else if (kind.startsWith('hold')) {
        await db.update(issues).set({ status: 'blocked' }).where(eq(issues.id, f.issue.id));
        intent = { comment: 'Resume', resume: true, interrupt: true };
        const hold = kind === 'hold-create' ? null : await issueTreeControlService(db).createHold(f.company.id, f.issue.id, { mode: 'pause', actor: treeActor });
        expectedWriterFirst = kind === 'hold-create' ? 409 : 200; expectedAcceptanceFirst = kind === 'hold-release' ? 409 : 200;
        write = c => kind === 'hold-create' ? issueTreeControlService(c).createHold(f.company.id, f.issue.id, { mode: 'pause', actor: treeActor }) : issueTreeControlService(c).releaseHold(f.company.id, f.issue.id, hold!.hold.id, { actor: treeActor });
      } else {
        intent.goalId = null;
        if (kind === 'goal-first') { selectedGoal = randomUUID(); write = c => goalService(c).create(f.company.id, { id: selectedGoal!, title: 'First company candidate', level: 'company', status: 'active' }); }
        else {
          const older = await goalService(db).create(f.company.id, { title: 'Older', level: 'company', status: 'planned', createdAt: new Date(0) });
          const current = await goalService(db).create(f.company.id, { title: 'Current', level: 'company', status: 'active', createdAt: new Date(1000) });
          selectedGoal = older.id;
          if (kind === 'project-fallback') {
            expectedWriterFirst = 409;
            const [project] = await db.insert(projects).values({ companyId: f.company.id, name: 'Project', goalId: current.id }).returning();
            await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issue.id));
            write = c => c.transaction(tx => tx.update(projects).set({ goalId: older.id }).where(eq(projects.id, project.id)));
          } else write = c => goalService(c).update(older.id, { status: 'active' });
        }
      }
      const before = await read(f);
      const writerDb = new Proxy(db, { get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver);
        return (callback: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => {
          writerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
          if (order === 'acceptance-first') writerReady.open();
          const result = await callback(tx);
          if (order === 'writer-first') { writerReady.open(); await proceed.promise; }
          return result;
        });
      } });
      let writing: Promise<unknown>;
      lockTable = kind === 'project-fallback' ? issues : companies;
      if (order === 'acceptance-first') onCompanyLock = async () => { entered.open(); await proceed.promise; };
      else { writing = write(writerDb); await writerReady.promise; }
      const request = fetch(`${base}/issues/${f.issue.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify(intent) });
      if (order === 'acceptance-first') { await entered.promise; writing = write(writerDb); await writerReady.promise; }
      // Attach immediately: canonical competing writer can legitimately refuse
      // after acceptance closes the job or expires its pending confirmation.
      const writerOutcome = writing!.then(value => ({ value }), error => ({ error }));
      try {
        const rows = await blockedBy(order === 'writer-first' ? writerPid : acceptancePid, `${kind}/${order}`);
        expect(Number(rows[0].pid)).not.toBe(order === 'writer-first' ? writerPid : acceptancePid);
        expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toEqual([]);
        expect(effects.cancelled).toEqual([]);
      } finally { proceed.open(); }
      const response = await request;
      const outcome = await writerOutcome;
      if (order === 'acceptance-first' && ['confirmation-reject'].includes(kind)) {
        expect(outcome).toMatchObject({ error: { status: 409 } });
      } else {
        expect(outcome, `${kind}/${order} competing writer must commit`).not.toHaveProperty('error');
      }
      const expected = order === 'writer-first' ? expectedWriterFirst : expectedAcceptanceFirst;
      expect(response.status, `${kind}/${order}: ${JSON.stringify(await response.clone().json())}`).toBe(expected);
      const after = await read(f);
      if (expected === 200) {
        expect(after.comments).toHaveLength(1); expect(after.run.status).toBe('cancelled');
        expect(effects.cancelled).toEqual([f.run.id]);
        expect(after.audits.some(a => a.action === 'issue.comment_added')).toBe(true);
        if (selectedGoal && order === 'writer-first') expect(after.issue.goalId).toBe(selectedGoal);
      } else {
        expect(after.comments).toEqual([]); expect(after.run.status).toBe('running'); expect(effects.cancelled).toEqual([]);
        expect(after.audits.filter(a => ['issue.updated', 'issue.comment_added', 'heartbeat.cancelled'].includes(a.action))).toEqual(before.audits.filter(a => ['issue.updated', 'issue.comment_added', 'heartbeat.cancelled'].includes(a.action)));
        expect(after.issue.checkoutRunId).toBe(before.issue.checkoutRunId);
      }
      effects.cancelled.length = 0;
    }
  }, 20000);
  it.each(['revise', 'restore', 'delete'] as const)('document %s and canonical confirmation acceptance serialize in both orders', async operation => {
    for (const order of ['writer-first', 'acceptance-first'] as const) {
      const f = await fixture(), entered = gate(), proceed = gate(), ready = gate();
      const docs = documentService(db), svc = issueThreadInteractionService(db);
      const first = await docs.upsertIssueDocument({ issueId: f.issue.id, key: 'plan', format: 'markdown', body: 'First' });
      const current = operation === 'restore' ? await docs.upsertIssueDocument({ issueId: f.issue.id, key: 'plan', format: 'markdown', body: 'Second', baseRevisionId: first.document.latestRevisionId }) : first;
      const confirmation = await svc.create(f.issue, { ...cInput, continuationPolicy: 'none', payload: { ...cInput.payload, target: { type: 'issue_document', issueId: f.issue.id, documentId: current.document.id, key: 'plan', revisionId: current.document.latestRevisionId!, revisionNumber: current.document.latestRevisionNumber } } }, { userId: f.userId });
      let writerPid = 0;
      const writerDb = new Proxy(db, { get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver);
        return (callback: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => {
          writerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
          if (order === 'acceptance-first') ready.open();
          const result = await callback(tx);
          if (order === 'writer-first') { ready.open(); await proceed.promise; }
          return result;
        });
      } });
      const write = () => operation === 'delete' ? documentService(writerDb).deleteIssueDocument(f.issue.id, 'plan') : operation === 'restore' ? documentService(writerDb).restoreIssueDocumentRevision({ issueId: f.issue.id, key: 'plan', revisionId: first.document.latestRevisionId! }) : documentService(writerDb).upsertIssueDocument({ issueId: f.issue.id, key: 'plan', format: 'markdown', body: 'Next', baseRevisionId: current.document.latestRevisionId });
      let writing: Promise<unknown>;
      lockTable = companies;
      if (order === 'acceptance-first') onCompanyLock = async () => { entered.open(); await proceed.promise; };
      else { writing = write(); await ready.promise; }
      const request = fetch(`${base}/issues/${f.issue.id}/interactions/${confirmation.id}/accept`, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: '{}' });
      if (order === 'acceptance-first') { await entered.promise; writing = write(); await ready.promise; }
      try {
        await blockedBy(order === 'writer-first' ? writerPid : acceptancePid, `document-${operation}/${order}`);
        expect(writerPid).not.toBe(acceptancePid);
        expect((await svc.getById(confirmation.id))?.status).toBe('pending');
        expect((await read(f)).audits).toEqual([]);
      } finally { proceed.open(); }
      const response = await request; await writing!;
      expect(response.status).toBe(200);
      expect((await svc.getById(confirmation.id))?.status).toBe(order === 'writer-first' ? 'expired' : 'accepted');
      expect((await read(f)).audits.map(a => a.action)).toEqual([order === 'writer-first' ? 'issue.thread_interaction_expired' : 'issue.thread_interaction_accepted']);
      expect((await read(f)).run.status).toBe('running'); expect(effects.cancelled).toEqual([]);
    }
  }, 20000);

  it.each(['new-goal', 'preferred-goal', 'confirmation', 'cycle'] as const)('refuses prepared %s changes without accepted rows or runtime effects', async kind => {
    const f = await fixture();
    let intent: IssuePatchContext['intent'] = { title: 'Pinned', comment: 'Pinned comment', interrupt: true };
    let mutate: () => Promise<unknown>;
    if (kind === 'cycle') {
      intent.blockedByIssueIds = [f.blocker.id];
      mutate = () => issueService(db).update(f.blocker.id, { blockedByIssueIds: [f.issue.id] });
    } else if (kind === 'confirmation') mutate = () => issueThreadInteractionService(db).create(f.issue, cInput, { userId: f.userId });
    else {
      intent.goalId = null;
      const older = kind === 'preferred-goal' ? await goalService(db).create(f.company.id, { title: 'Older', level: 'company', status: 'planned', createdAt: new Date(0) }) : null;
      if (older) await goalService(db).create(f.company.id, { title: 'Current', level: 'company', status: 'active', createdAt: new Date(1000) });
      mutate = () => older ? goalService(db).update(older.id, { status: 'active' }) : goalService(db).create(f.company.id, { title: 'First', level: 'company', status: 'active' });
    }
    const runtime = { cancelRun: async () => { throw new Error('Rejected action must not dispatch'); }, wakeup: async () => { throw new Error('Rejected action must not wake'); }, reportRunActivity: async () => undefined };
    const actions = issuePatchActions(db, runtime as any);
    const context: IssuePatchContext = { issueId: f.issue.id, companyId: f.company.id, actor: { actorType: 'user', actorId: f.userId, agentId: null, runId: null }, actorKind: 'board', intent, attribution: {}, validate: async () => undefined, validateAssignment: async () => undefined, validateResume: async () => undefined };
    const plan = await actions.prepare(context);
    await mutate(); const before = await read(f);
    await expect(actions.accept({ ...plan.context, expectedSnapshot: plan.snapshot })).rejects.toThrow(kind === 'cycle' ? 'cycles' : 'Issue changed');
    expect(await read(f)).toEqual(before); expect(effects.cancelled).toEqual([]);
  });

});
