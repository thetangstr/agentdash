import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, agents, companies, createDb, instanceSettings, issues, routineRuns, routines, type Db } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
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
});
