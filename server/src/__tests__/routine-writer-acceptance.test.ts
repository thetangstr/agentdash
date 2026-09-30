import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { issuePatchActions, type IssuePatchContext } from '../services/issue-patch-actions.js';
import { issueCurrentAuthority } from '../services/issue-current-authority.js';
import { insertActivity } from '../services/activity-log.js';
import { publishLiveEvent } from '../services/live-events.js';
import { unprocessable } from '../errors.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, agents, companies, createDb, heartbeatRuns, instanceSettings, issues, routineRuns, routineTriggers, routines, type Db } from '@paperclipai/db';
import { routineService } from '../services/routines.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
const injection = vi.hoisted(() => ({ create: null as null | ((original: any, ...args: any[]) => Promise<any>) }));
vi.mock('../services/issues.js', async () => { const actual = await vi.importActual<typeof import('../services/issues.js')>('../services/issues.js'); return { ...actual, issueService: (...args: Parameters<typeof actual.issueService>) => { const svc = actual.issueService(...args); return { ...svc, create: (...values: any[]) => injection.create ? injection.create(svc.create, ...values) : (svc.create as any)(...values) }; } }; });
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));

describe('routine actual writer acceptance', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('routine-writer-'); db = createDb(temp.connectionString); await db.insert(instanceSettings).values({}); });
  afterEach(() => { injection.create = null; });
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Disposable routine', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Fake runtime', role: 'engineer', adapterType: 'process', status: 'idle' }).returning();
    const [routine] = await db.insert(routines).values({ companyId: company.id, title: 'Dispatch {{value}}', assigneeAgentId: agent.id, concurrencyPolicy: 'coalesce_if_active' }).returning();
    return { company, agent, routine };
  }
  it.each(['null', 'throw', 'invalid', 'terminal'] as const)('%s acknowledgment retains accepted issue with persisted uncertainty, and replay never wakes', async kind => {
    const f = await fixture();
    const wakeup = vi.fn(async () => { if (kind === 'throw') throw new Error('secret from adapter'); return kind === 'null' ? null : kind === 'invalid' ? { id: randomUUID() } : { id: randomUUID(), status: 'succeeded' }; });
    const svc = routineService(db, { heartbeat: { wakeup } });
    const result = await svc.runRoutine(f.routine.id, { source: 'manual', idempotencyKey: 'original' });
    expect(result).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/^routine_dispatch_unconfirmed:/), linkedIssueId: expect.any(String) });
    expect(result.failureReason).not.toContain('secret from adapter');
    expect((await db.select().from(issues).where(eq(issues.id, result.linkedIssueId!)))).toHaveLength(1);
    expect(await svc.runRoutine(f.routine.id, { source: 'manual', idempotencyKey: 'original' })).toEqual(result);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });
  it('acceptance is committed before wake and original pending coalesces during the outside-lock barrier', async () => {
    const f = await fixture(); let committed = false;
    const wakeup = vi.fn(async (agentId: string, opts: any) => {
      const issueId = opts.contextSnapshot.issueId;
      const [original] = await db.select().from(routineRuns).where(eq(routineRuns.linkedIssueId, issueId));
      expect(original).toMatchObject({ status: 'received', failureReason: 'routine_dispatch_unconfirmed:pending' });
      await db.transaction(async tx => { await tx.execute(sql`set local lock_timeout = '500ms'`); await tx.execute(sql`select id from companies where id = ${f.company.id} for update nowait`); await tx.execute(sql`select id from routines where id = ${f.routine.id} for update nowait`); });
      committed = true;
      const coalesced = await routineService(db, { heartbeat: { wakeup: vi.fn() } }).runRoutine(f.routine.id, { source: 'manual' });
      expect(coalesced).toMatchObject({ status: 'coalesced', linkedIssueId: issueId, coalescedIntoRunId: original.id });
      const [row] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId, status: 'queued', invocationSource: 'assignment', contextSnapshot: { issueId } }).returning();
      return row;
    });
    const result = await routineService(db, { heartbeat: { wakeup } }).runRoutine(f.routine.id, { source: 'manual' });
    expect(committed).toBe(true); expect(result.status).toBe('issue_created'); expect(wakeup).toHaveBeenCalledTimes(1);
  });
  it('unknown acceptance acknowledgment retains pending and never wakes or replays callback', async () => {
    const f = await fixture(); let callbacks = 0;
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return async (work: any) => { await target.transaction(async tx => { callbacks++; return work(tx); }); throw new Error('lost acknowledgement'); }; } });
    const wakeup = vi.fn(async () => null);
    await expect(routineService(root, { heartbeat: { wakeup } }).runRoutine(f.routine.id, { source: 'manual' })).rejects.toMatchObject({ status: 409, details: { persistenceOutcome: 'unknown', stage: 'acceptance' } });
    expect(callbacks).toBe(1); expect(wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id))).toEqual([expect.objectContaining({ status: 'received', linkedIssueId: expect.any(String) })]);
  });

  it.each(['coalesce_if_active', 'skip_if_active', 'always_enqueue'])('%s preserves fingerprint independence and exact original idempotency', async policy => {
    const f = await fixture(); await db.update(routines).set({ concurrencyPolicy: policy }).where(eq(routines.id, f.routine.id));
    const wakeup = vi.fn(async () => null), svc = routineService(db, { heartbeat: { wakeup } });
    const first = await svc.runRoutine(f.routine.id, { source: 'manual', payload: { scope: 1 }, idempotencyKey: 'same' });
    const replay = await svc.runRoutine(f.routine.id, { source: 'manual', payload: { scope: 999 }, idempotencyKey: 'same' }); expect(replay).toEqual(first);
    const second = await svc.runRoutine(f.routine.id, { source: 'manual', payload: { scope: 1 } });
    expect(second.status).toBe(policy === 'always_enqueue' ? 'failed' : policy === 'skip_if_active' ? 'skipped' : 'coalesced');
    expect(second.linkedIssueId === first.linkedIssueId).toBe(policy !== 'always_enqueue');
    const independent = await svc.runRoutine(f.routine.id, { source: 'manual', payload: { scope: 2 } }); expect(independent.linkedIssueId).not.toBe(first.linkedIssueId);
    expect(wakeup).toHaveBeenCalledTimes(policy === 'always_enqueue' ? 3 : 2);
  });
  it('ordinary failed execution does not become a pending blocker; legacy default retains original protection', async () => {
    const f = await fixture(), wakeup = vi.fn(async () => null), svc = routineService(db, { heartbeat: { wakeup } });
    const first = await svc.runRoutine(f.routine.id, { source: 'manual' });
    await db.update(issues).set({ originFingerprint: 'default' }).where(eq(issues.id, first.linkedIssueId!));
    expect((await svc.runRoutine(f.routine.id, { source: 'manual', payload: { unrelated: true } })).status).toBe('coalesced');
    await db.update(routineRuns).set({ failureReason: 'Execution failed normally' }).where(eq(routineRuns.id, first.id));
    expect((await svc.runRoutine(f.routine.id, { source: 'manual' })).linkedIssueId).not.toBe(first.linkedIssueId);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });
  it('idempotency is scoped by source and exact trigger as well as company/routine', async () => {
    const f = await fixture(); await db.update(routines).set({ concurrencyPolicy: 'always_enqueue' }).where(eq(routines.id, f.routine.id));
    const triggers = await db.insert(routineTriggers).values([1, 2].map(() => ({ companyId: f.company.id, routineId: f.routine.id, kind: 'api', enabled: true }))).returning();
    const wakeup = vi.fn(async () => null), svc = routineService(db, { heartbeat: { wakeup } });
    const ids = [];
    for (const request of [{ source: 'manual' as const }, { source: 'api' as const }, ...triggers.map(t => ({ source: 'api' as const, triggerId: t.id }))]) {
      const a = await svc.runRoutine(f.routine.id, { ...request, idempotencyKey: 'key' });
      expect((await svc.runRoutine(f.routine.id, { ...request, idempotencyKey: 'key' })).id).toBe(a.id); ids.push(a.id);
    }
    expect(new Set(ids).size).toBe(4); expect(wakeup).toHaveBeenCalledTimes(4);
  });
  it.each(['done', 'blocked', 'cancelled'])('concurrent actual %s is preserved by followup and sync', async status => {
    const f = await fixture(); let issueId = '';
    const wakeup = vi.fn(async (_agentId: string, opts: any) => { issueId = opts.contextSnapshot.issueId; await db.update(issues).set({ status }).where(eq(issues.id, issueId)); await routineService(db, { heartbeat: { wakeup: vi.fn() } }).syncRunStatusForIssue(issueId); return null; });
    const result = await routineService(db, { heartbeat: { wakeup } }).runRoutine(f.routine.id, { source: 'manual' });
    expect(result.linkedIssueId).toBe(issueId);
    expect(result.status).toBe(status === 'done' ? 'completed' : 'failed');
    if (status === 'blocked') expect(result.failureReason).toMatch(/^routine_dispatch_unconfirmed:/);
    else expect(result.failureReason ?? '').not.toMatch(/^routine_dispatch_unconfirmed:/);
  });
  it('throw after durable queue retains both rows and never retries wake', async () => {
    const f = await fixture();
    const wakeup = vi.fn(async (agentId: string, opts: any) => { await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId, status: 'queued', invocationSource: 'assignment', contextSnapshot: { issueId: opts.contextSnapshot.issueId } }); throw new Error('after durable queue'); });
    const svc = routineService(db, { heartbeat: { wakeup } }), result = await svc.runRoutine(f.routine.id, { source: 'manual', idempotencyKey: 'once' });
    expect(result.failureReason).toMatch(/^routine_dispatch_unconfirmed:thrown/); expect(result.linkedIssueId).toBeTruthy();
    expect((await svc.runRoutine(f.routine.id, { source: 'manual', idempotencyKey: 'once' })).id).toBe(result.id);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(1); expect(wakeup).toHaveBeenCalledTimes(1);
  });
  it.each(['unknown', 'rollback'])('postwake %s acknowledgment returns uncertainty without fictional failed row', async failure => {
    const f = await fixture(); let callbacks = 0;
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return async (work: any) => { callbacks++; if (callbacks === 2 && failure === 'rollback') throw new Error('cannot begin followup'); const result = await target.transaction(work); if (callbacks === 2) throw new Error('lost followup acknowledgment'); return result; }; } });
    const wakeup = vi.fn(async () => null);
    await expect(routineService(root, { heartbeat: { wakeup } }).runRoutine(f.routine.id, { source: 'manual' })).rejects.toMatchObject({ status: 409, details: { stage: 'postwake_ack' } });
    const [original] = await db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id));
    expect(original.status).toBe(failure === 'unknown' ? 'failed' : 'received'); expect(original.linkedIssueId).toBeTruthy(); expect(wakeup).toHaveBeenCalledTimes(1); expect(callbacks).toBe(2);
  });
  it.each(['domain', 'unique', 'unexpected'])('actual savepoint handles %s failure and collector rollback on the exact executor', async kind => {
    const f = await fixture(); let acceptedPair: any; let issueBackend = 0; let ownerBackend = 0;
    const [heartbeat] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'queued', invocationSource: 'assignment' }).returning();
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return (work: any) => target.transaction(async tx => { ownerBackend = Number((await tx.execute(sql`select pg_backend_pid() pid`))[0].pid); return work(tx); }); } });
    injection.create = async (create, companyId, data, pair) => {
      acceptedPair = pair; issueBackend = Number((await pair.executor.execute(sql`select pg_backend_pid() pid`))[0].pid);
      pair.publications.push(await insertActivity(pair.executor, { companyId, actorType: 'system', actorId: 'fixture', action: 'routine.savepoint', entityType: 'routine', entityId: f.routine.id }));
      const created = await create(companyId, data, pair);
      if (kind === 'unique') {
        await pair.executor.update(issues).set({ executionRunId: heartbeat.id }).where(eq(issues.id, created.id));
        await create(companyId, { ...data, executionRunId: heartbeat.id }, pair);
      }
      if (kind === 'unexpected') throw new Error('connection failure');
      throw unprocessable('Expected domain refusal');
    };
    vi.mocked(publishLiveEvent).mockClear(); const wakeup = vi.fn(async () => null);
    const operation = routineService(root, { heartbeat: { wakeup } }).runRoutine(f.routine.id, { source: 'manual' });
    if (kind === 'unexpected') await expect(operation).rejects.toThrow('connection failure');
    else expect(await operation).toMatchObject({ status: 'failed', linkedIssueId: null });
    expect(issueBackend).toBe(ownerBackend); expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
    expect(acceptedPair.publications).toHaveLength(kind === 'unexpected' ? 1 : 0); expect(publishLiveEvent).not.toHaveBeenCalled(); expect(wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id))).toHaveLength(kind === 'unexpected' ? 0 : 1);
  });
  function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { open, promise }; }
  it.each(['writer-first', 'acceptance-first'])('routine and canonical acceptance serialize %s on distinct observed PostgreSQL backends', async order => {
    const f = await fixture(); const [parent] = await db.insert(issues).values({ companyId: f.company.id, title: 'Parent' }).returning();
    await db.update(routines).set({ parentIssueId: parent.id }).where(eq(routines.id, f.routine.id));
    const ready = gate(), release = gate(); let ownerPid = 0; let transactionCount = 0;
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return (work: any) => target.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '6s'`); const result = await work(tx);
      if (++transactionCount === 1 && order === 'writer-first') { ownerPid = Number((await tx.execute(sql`select pg_backend_pid() pid`))[0].pid); ready.open(); await release.promise; } return result;
    }); } });
    const authority = issueCurrentAuthority({ actor: { type: 'board', source: 'local_implicit' } } as Request);
    const context: IssuePatchContext = { issueId: parent.id, companyId: f.company.id, actor: { actorType: 'user', actorId: 'local', agentId: null, runId: null }, actorKind: 'board', intent: { title: 'Accepted parent' }, attribution: {}, validate: async () => undefined, validateResume: async () => undefined, validateAssignment: async () => undefined,
      stageAuthority: async (...args) => { const guard = await authority(...args); if (order === 'acceptance-first') { ownerPid = Number((await args[0].execute(sql`select pg_backend_pid() pid`))[0].pid); ready.open(); await release.promise; } return guard; } };
    const write = () => routineService(root, { heartbeat: { wakeup: vi.fn(async () => null) } }).runRoutine(f.routine.id, { source: 'manual' });
    const accept = () => issuePatchActions(db, { wakeup: vi.fn(), cancelRun: vi.fn(), reportRunActivity: vi.fn() } as any).accept(context);
    const first = order === 'writer-first' ? write() : accept(); await Promise.race([ready.promise, first.then(() => { throw new Error('Owner escaped barrier'); })]);
    const second = order === 'writer-first' ? accept() : write(); const settled = Promise.allSettled([first, second]);
    let blocked: any; const deadline = Date.now() + 4000;
    try { while (Date.now() < deadline) { const [row] = await db.execute(sql`select pid, query, pg_blocking_pids(pid) blockers from pg_stat_activity where ${ownerPid} = any(pg_blocking_pids(pid))`); if (row) { blocked = row; break; } await new Promise(resolve => setImmediate(resolve)); }
      expect(blocked).toBeTruthy(); expect(Number(blocked.pid)).not.toBe(ownerPid); expect(blocked.query).toMatch(/companies.*for (?:no key )?update/i); console.log(JSON.stringify({ order, ownerPid, waiter: blocked }));
    } finally { release.open(); }
    expect((await settled).map(row => row.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await db.select().from(issues).where(eq(issues.parentId, parent.id)); expect(rows).toHaveLength(1);
  });
  it('supplied create publishes its collector only after acceptance commit and before wake', async () => {
    const f = await fixture(); let publications: any; vi.mocked(publishLiveEvent).mockClear();
    injection.create = async (create, companyId, data, pair) => {
      publications = pair.publications; pair.publications.push(await insertActivity(pair.executor, { companyId, actorType: 'system', actorId: 'fixture', action: 'routine.accepted', entityType: 'routine', entityId: f.routine.id }));
      expect(publishLiveEvent).not.toHaveBeenCalled(); return create(companyId, data, pair);
    };
    const wakeup = vi.fn(async () => {
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toHaveLength(1);
      expect(publishLiveEvent).toHaveBeenCalledTimes(1); return null;
    });
    const result = await routineService(db, { heartbeat: { wakeup } }).runRoutine(f.routine.id, { source: 'manual' });
    expect(result.linkedIssueId).toBeTruthy(); expect(publications).toHaveLength(1); expect(publishLiveEvent).toHaveBeenCalledTimes(1);
  });
  it.each(['malformed-id', 'wrong-agent', 'terminal-persisted'])('%s never fabricates successful queue association', async kind => {
    const f = await fixture(); let linked = '';
    const wakeup = vi.fn(async (agentId: string, opts: any) => {
      linked = opts.contextSnapshot.issueId;
      if (kind === 'malformed-id') return { id: '-'.repeat(36) };
      const [other] = await db.insert(agents).values({ companyId: f.company.id, name: 'Other', role: 'engineer', adapterType: 'process' }).returning();
      const [row] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: kind === 'wrong-agent' ? other.id : agentId, status: kind === 'terminal-persisted' ? 'succeeded' : 'queued', invocationSource: 'assignment', contextSnapshot: { issueId: linked } }).returning(); return row;
    });
    const result = await routineService(db, { heartbeat: { wakeup } }).runRoutine(f.routine.id, { source: 'manual' });
    expect(result).toMatchObject({ status: 'failed', linkedIssueId: linked, failureReason: expect.stringMatching(/^routine_dispatch_unconfirmed:/) });
    expect((await db.select().from(issues).where(eq(issues.id, linked)))[0].status).toBe('todo');
  });
  it('followup never overwrites a newer firing result on the same trigger', async () => {
    const f = await fixture(); const [trigger] = await db.insert(routineTriggers).values({ companyId: f.company.id, routineId: f.routine.id, kind: 'api' }).returning();
    const later = new Date(Date.now() + 60000);
    const wakeup = vi.fn(async () => { await db.update(routineTriggers).set({ lastFiredAt: later, lastResult: 'Newer result' }).where(eq(routineTriggers.id, trigger.id)); return null; });
    await routineService(db, { heartbeat: { wakeup } }).runRoutine(f.routine.id, { source: 'api', triggerId: trigger.id });
    expect((await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id)))[0]).toMatchObject({ lastFiredAt: later, lastResult: 'Newer result' });
  });

  it.each(['routine', 'link', 'company'])('sync refuses mismatched %s provenance instead of changing an original run', async kind => {
    const f = await fixture(), svc = routineService(db, { heartbeat: { wakeup: vi.fn(async () => null) } });
    const original = await svc.runRoutine(f.routine.id, { source: 'manual' });
    if (kind === 'routine') await db.update(issues).set({ originId: randomUUID(), status: 'done' }).where(eq(issues.id, original.linkedIssueId!));
    if (kind === 'link') { await db.update(routineRuns).set({ linkedIssueId: null }).where(eq(routineRuns.id, original.id)); await db.update(issues).set({ status: 'done' }).where(eq(issues.id, original.linkedIssueId!)); }
    if (kind === 'company') { const [foreign] = await db.insert(companies).values({ name: 'Other scope', issuePrefix: randomUUID().slice(0, 8) }).returning(); await db.update(issues).set({ companyId: foreign.id, status: 'done' }).where(eq(issues.id, original.linkedIssueId!)); }
    const [before] = await db.select().from(routineRuns).where(eq(routineRuns.id, original.id));
    expect(await svc.syncRunStatusForIssue(original.linkedIssueId!)).toBeNull();
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, original.id)))[0]).toEqual(before);
  });

});
