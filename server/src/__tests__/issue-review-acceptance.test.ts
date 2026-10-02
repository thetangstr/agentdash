import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activityLog, agentApiKeys, agents, authUsers, boardApiKeys, companies, companyMemberships,
  createDb, heartbeatRuns, issueWorkProducts, issues,
} from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { issueRoutes } from '../routes/issues.js';
import { hashBearerToken } from '../services/board-auth.js';
import { workProductService } from '../services/work-products.js';
import type { StorageService } from '../storage/types.js';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));
vi.mock('../services/heartbeat.js', () => ({
  heartbeatService: (db: ReturnType<typeof createDb>) => ({
    getRun: async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0] ?? null,
    getActiveRunForAgent: async () => null,
    cancelRun: async () => null,
    wakeup: vi.fn().mockResolvedValue(null),
    reportRunActivity: vi.fn().mockResolvedValue(undefined),
  }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (MVP launch lane B, item 6): a board user moving an issue to done
 * is the acceptance of what the agent shipped. The issue's `ready_for_review`
 * work products are recorded as approved in the same write, so the Shipped
 * feed stops saying "ready for review". An agent closing its own issue is not
 * an acceptance.
 */
describeEmbeddedPostgres('accepting an issue accepts its deliverables', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Server | undefined;
  let base: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('issue-review-acceptance-');
    db = createDb(temp.connectionString);
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: 'authenticated' }));
    app.use('/api', issueRoutes(db, {} as StorageService));
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await temp?.cleanup();
  });

  async function fixture() {
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'CEO', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(boardApiKeys).values({ userId, name: 'Disposable key', keyHash: hashBearerToken(token), expiresAt: new Date(Date.now() + 60_000) });
    const [company] = await db.insert(companies).values({ name: 'Review fixture', issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: 'owner', status: 'active' });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Writer' }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: 'running' }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id, title: 'Write the launch brief', status: 'in_review',
      assigneeAgentId: agent.id, createdByUserId: userId,
    }).returning();
    const products = workProductService(db);
    const ready = await products.createForIssue(issue.id, company.id, {
      type: 'document', provider: 'paperclip', title: 'Launch brief', status: 'ready_for_review', reviewState: 'needs_board_review',
    });
    const draft = await products.createForIssue(issue.id, company.id, {
      type: 'document', provider: 'paperclip', title: 'Scratch notes', status: 'draft', reviewState: 'none',
    });
    return { company, agent, run, issue, token, userId, readyId: ready!.id, draftId: draft!.id };
  }

  async function patch(issueId: string, intent: Record<string, unknown>, token: string, runId?: string) {
    return fetch(`${base}/issues/${issueId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(runId ? { 'x-paperclip-run-id': runId } : {}) },
      body: JSON.stringify(intent),
    });
  }

  async function product(id: string) {
    const [row] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, id));
    return row!;
  }

  it('a board user moving the issue to done marks ready_for_review work products approved, and the Shipped feed says so', async () => {
    const f = await fixture();
    const response = await patch(f.issue.id, { status: 'done' }, f.token);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('done');

    expect(await product(f.readyId)).toMatchObject({ status: 'approved', reviewState: 'approved' });
    // Only deliverables that were waiting for review are accepted.
    expect(await product(f.draftId)).toMatchObject({ status: 'draft', reviewState: 'none' });

    const feed = await workProductService(db).listForCompany(f.company.id);
    const shipped = feed.items.find((item) => item.id === f.readyId);
    expect(shipped).toMatchObject({ status: 'approved', reviewState: 'approved', issue: { status: 'done' } });

    const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
    const accepted = audit.filter((row) => row.action === 'issue.work_product_updated');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.details).toMatchObject({ workProductId: f.readyId, status: 'approved', reason: 'issue_accepted' });
  });

  it('a board update that does not move the issue to done leaves work products alone', async () => {
    const f = await fixture();
    const response = await patch(f.issue.id, { title: 'Write the launch brief, v2' }, f.token);
    expect(response.status).toBe(200);
    expect(await product(f.readyId)).toMatchObject({ status: 'ready_for_review', reviewState: 'needs_board_review' });
  });

  it('an agent moving its own issue to done is not an acceptance', async () => {
    const f = await fixture();
    const token = `pcp_agent_${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: f.company.id, agentId: f.agent.id, name: 'Worker', keyHash: hashBearerToken(token) });
    await db.update(issues).set({ status: 'in_progress', checkoutRunId: f.run.id, executionRunId: f.run.id }).where(eq(issues.id, f.issue.id));
    const response = await patch(f.issue.id, { status: 'done' }, token, f.run.id);
    expect(response.status).toBe(200);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(issue!.status).toBe('done');
    expect(await product(f.readyId)).toMatchObject({ status: 'ready_for_review', reviewState: 'needs_board_review' });
  });
});
