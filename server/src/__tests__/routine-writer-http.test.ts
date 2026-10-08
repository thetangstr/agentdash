import { companyLockQuery, observeExpectedWaiter } from './helpers/observed-lock-wait.js';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, agents, companies, createDb, instanceSettings, issues, routineRuns, routineTriggers, routines, type Db } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { publishLiveEvent } from '../services/live-events.js';
import { routineRoutes } from '../routes/routines.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
const runtime = vi.hoisted(() => ({ wakeup: vi.fn(async () => null as unknown) }));
vi.mock('../services/heartbeat.js', () => ({ heartbeatService: () => runtime }));
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));

describe('canonical routine HTTP acceptance and readback', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  const servers: Server[] = [];
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('routine-http-'); db = createDb(temp.connectionString); await db.insert(instanceSettings).values({}); });
  afterAll(async () => { for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve())); await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
  async function fixture(root: Db = db) {
    runtime.wakeup.mockReset().mockResolvedValue(null);
    const [company] = await db.insert(companies).values({ name: 'HTTP disposable', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Fake', role: 'engineer', adapterType: 'process' }).returning();
    const [routine] = await db.insert(routines).values({ companyId: company.id, title: 'HTTP routine', assigneeAgentId: agent.id }).returning();
    const app = express(); app.use(express.json()); app.use(actorMiddleware(root, { deploymentMode: 'local_trusted' })); app.use('/api', routineRoutes(root)); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const post = () => fetch(`${base}/routines/${routine.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'manual', idempotencyKey: 'original' }) });
    return { company, routine, base, post };
  }
  it('returns persisted failed+linked HTTP202 and identical replay with one wake', async () => {
    const f = await fixture(); const response = await f.post(); expect(response.status).toBe(202); const run = await response.json();
    expect(run).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/^routine_dispatch_unconfirmed:null/), linkedIssueId: expect.any(String) });
    expect(await (await f.post()).json()).toEqual(run); expect(runtime.wakeup).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issues).where(eq(issues.id, run.linkedIssueId))).toHaveLength(1);
    const readback = await fetch(`${f.base}/routines/${f.routine.id}/runs`); expect(readback.status).toBe(200); expect(await readback.json()).toEqual([expect.objectContaining({ id: run.id, linkedIssueId: run.linkedIssueId })]);
  });
  it.each(['acceptance', 'postwake_ack'])('%s lost acknowledgment returns private HTTP409; readback and replay use durable state', async stage => {
    let transactions = 0;
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return async (work: any) => { transactions++; const result = await target.transaction(work); if (transactions === (stage === 'acceptance' ? 1 : 2)) throw new Error('private diagnostic sentinel'); return result; }; } });
    const f = await fixture(root), response = await f.post(); expect(response.status).toBe(409); const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('private diagnostic sentinel'); expect(body.details).toMatchObject({ persistenceOutcome: 'unknown', stage });
    const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id)); expect(stored.linkedIssueId).toBeTruthy();
    const replay = await f.post(); expect(replay.status).toBe(202); expect(await replay.json()).toMatchObject({ id: stored.id, status: stage === 'acceptance' ? 'received' : 'failed', linkedIssueId: stored.linkedIssueId });
    expect(runtime.wakeup).toHaveBeenCalledTimes(stage === 'acceptance' ? 0 : 1);
  });
  it('manual audit failure cannot obscure a known persisted linked result', async () => {
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'insert') return Reflect.get(target, key, receiver); return (table: any) => { if (table === activityLog) throw new Error('audit temporarily unavailable'); return target.insert(table); }; } });
    const f = await fixture(root), response = await f.post(); expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'failed', linkedIssueId: expect.any(String) }); expect(runtime.wakeup).toHaveBeenCalledTimes(1);
  });
  it.each(['new', 'existing'] as const)('public webhook %s receipt observes a pause that wins after preflight', async kind => {
    const f = await fixture();
    const [trigger] = await db.insert(routineTriggers).values({ companyId: f.company.id, routineId: f.routine.id,
      kind: 'webhook', publicId: randomUUID(), signingMode: 'none' }).returning();
    const fire = () => fetch(`${f.base}/routine-triggers/public/${trigger.publicId}/fire`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'original' }, body: '{}' });
    let receipt: unknown;
    if (kind === 'existing') { const first = await fire(); expect(first.status).toBe(202); receipt = await first.json(); }
    const before = {
      routine: await db.select().from(routines).where(eq(routines.id, f.routine.id)),
      trigger: await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id)),
      runs: await db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id)),
      issues: await db.select().from(issues).where(eq(issues.companyId, f.company.id)),
      audits: await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id)),
      company: await db.select().from(companies).where(eq(companies.id, f.company.id)),
    };
    runtime.wakeup.mockClear(); vi.mocked(publishLiveEvent).mockClear();
    let ready!: () => void, release!: () => void, ownerPid = 0;
    const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const pause = db.transaction(async tx => {
      await tx.execute(sql`select id from companies where id = ${f.company.id} for update`);
      await tx.update(routines).set({ status: 'paused' }).where(eq(routines.id, f.routine.id));
      ownerPid = Number((await tx.execute(sql`select pg_backend_pid() pid`))[0].pid);
      ready(); await releasePromise;
    });
    await Promise.race([readyPromise, pause.then(() => { throw new Error('Pause escaped barrier'); })]);
    const pending = fire(); let blocked: any;
    try {
      blocked = await observeExpectedWaiter({ sample: () => db.execute(sql`select pid, query, pg_blocking_pids(pid) blockers from pg_stat_activity where ${ownerPid} = any(pg_blocking_pids(pid))`), ownerPid, contender: pending, label: `webhook-${kind}`, expectedQuery: companyLockQuery, timeoutMs: 4000 });
    } finally { release(); await Promise.allSettled([pause, pending]); }
    await pause; const response = await pending;
    expect(blocked).toBeTruthy(); expect(Number(blocked.pid)).not.toBe(ownerPid);
    expect(blocked.query).toMatch(/companies.*for (?:no key )?update/i);
    console.log(JSON.stringify({ order: `pause-before-webhook-${kind}-acceptance`, ownerPid, waiter: blocked }));
    expect(response.status).toBe(kind === 'new' ? 409 : 202);
    expect(await response.json()).toEqual(kind === 'new' ? { error: 'Routine trigger is not active' } : receipt);
    expect(await db.select().from(routines).where(eq(routines.id, f.routine.id))).toEqual([{ ...before.routine[0], status: 'paused' }]);
    expect(await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id))).toEqual(before.trigger);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, f.routine.id))).toEqual(before.runs);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toEqual(before.issues);
    const audits = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
    expect(audits.filter(row => before.audits.some(prior => prior.id === row.id))).toEqual(before.audits);
    const newAudits = audits.filter(row => !before.audits.some(prior => prior.id === row.id));
    // Existing receipt returns retain the baseline post-dispatch audit; they never accept new work.
    expect(newAudits).toEqual(kind === 'new' ? [] : [expect.objectContaining({ action: 'routine.run_triggered',
      actorId: 'routine-webhook', entityId: before.runs[0].id, details: { routineId: f.routine.id,
        triggerId: trigger.id, source: 'webhook', status: before.runs[0].status } })]);
    expect(await db.select().from(companies).where(eq(companies.id, f.company.id))).toEqual(before.company);
    expect(runtime.wakeup).not.toHaveBeenCalled();
    expect(publishLiveEvent).toHaveBeenCalledTimes(kind === 'new' ? 0 : 1);
    if (kind === 'existing') expect(publishLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'activity.logged', payload: expect.objectContaining({ action: 'routine.run_triggered', entityId: before.runs[0].id }) }));
    // A fresh public request still obeys the earlier inactive preflight, even with an existing key.
    const inactive = await fire(); expect(inactive.status).toBe(409);
    expect(await inactive.json()).toEqual({ error: 'Routine trigger is not active' });
  });
  it('paused routine still accepts an explicit manual HTTP run', async () => {
    const f = await fixture(); await db.update(routines).set({ status: 'paused' }).where(eq(routines.id, f.routine.id));
    const response = await f.post(); expect(response.status).toBe(202); const run = await response.json();
    expect(run).toMatchObject({ source: 'manual', status: 'failed', linkedIssueId: expect.any(String),
      failureReason: expect.stringMatching(/^routine_dispatch_unconfirmed:null:/) });
    expect(await db.select().from(issues).where(eq(issues.id, run.linkedIssueId))).toHaveLength(1);
    expect(runtime.wakeup).toHaveBeenCalledTimes(1);
    expect((await db.select().from(routines).where(eq(routines.id, f.routine.id)))[0].status).toBe('paused');
  });

});
