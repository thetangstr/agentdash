import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentApiKeys, agents, authUsers, boardApiKeys, companies, companyMemberships,
  activityLog, createDb, heartbeatRuns, issueComments, issueWorkProducts, issues,
} from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { issueRoutes, workProductSelfAcceptanceRefusal } from '../routes/issues.js';
import { hashBearerToken } from '../services/board-auth.js';
import { ACCEPTANCE_RECORDED_SINCE, workProductService } from '../services/work-products.js';
import type { StorageService } from '../storage/types.js';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

const wakeup = vi.hoisted(() => vi.fn());

vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));
vi.mock('../services/heartbeat.js', () => ({
  heartbeatService: (db: ReturnType<typeof createDb>) => ({
    getRun: async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0] ?? null,
    getActiveRunForAgent: async () => null,
    cancelRun: async () => null,
    wakeup: wakeup.mockResolvedValue(null),
    reportRunActivity: vi.fn().mockResolvedValue(undefined),
  }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (Scan 3 lane I): the review loop. An agent records a deliverable
 * (its run is recorded; it cannot accept its own work), a board user accepts
 * it or sends it back in one server action, and Shipped lists only accepted
 * work.
 */
describeEmbeddedPostgres('review loop: deliverables, request changes, shipped means accepted', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Server | undefined;
  let base: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('work-product-review-loop-');
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

  beforeEach(() => {
    wakeup.mockClear();
  });

  async function fixture() {
    const userId = randomUUID(), boardToken = `pcp_board_${randomUUID()}`, agentToken = `pcp_agent_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'CEO', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(boardApiKeys).values({ userId, name: 'Disposable key', keyHash: hashBearerToken(boardToken), expiresAt: new Date(Date.now() + 60_000) });
    const [company] = await db.insert(companies).values({ name: 'Review loop', issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: 'owner', status: 'active' });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Ivy' }).returning();
    const [other] = await db.insert(agents).values({ companyId: company.id, name: 'Theo' }).returning();
    await db.insert(agentApiKeys).values({ companyId: company.id, agentId: agent.id, name: 'Worker', keyHash: hashBearerToken(agentToken) });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: 'running' }).returning();
    const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: other.id, status: 'succeeded' }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id, title: 'Draft the Japan proposal', status: 'in_progress',
      assigneeAgentId: agent.id, createdByUserId: userId, checkoutRunId: run.id, executionRunId: run.id,
    }).returning();
    return { company, agent, other, run, otherRun, issue, boardToken, agentToken, userId };
  }

  async function call(method: string, url: string, token: string, body?: unknown, runId?: string) {
    return fetch(`${base}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(runId ? { 'x-paperclip-run-id': runId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function shippedIds(companyId: string, token: string) {
    const res = await call('GET', `/companies/${companyId}/work-products?accepted=true`, token);
    expect(res.status).toBe(200);
    return ((await res.json()).items as Array<{ id: string }>).map((item) => item.id);
  }

  it('records the creating run on a work product an agent posts', async () => {
    const f = await fixture();
    const response = await call('POST', `/issues/${f.issue.id}/work-products`, f.agentToken, {
      type: 'pull_request', provider: 'github', title: 'Add itinerary', url: 'https://github.com/acme/site/pull/7', status: 'ready_for_review',
    }, f.run.id);
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.createdByRunId).toBe(f.run.id);
    const [row] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, created.id));
    expect(row!.createdByRunId).toBe(f.run.id);
  });

  it('keeps a body run id only for a board user (same company) or an agent naming its own or the assignee run', async () => {
    const f = await fixture();
    const g = await fixture();
    const post = (token: string, createdByRunId: string) => call('POST', `/issues/${f.issue.id}/work-products`, token, {
      type: 'document', provider: 'paperclip', title: 'Notes', status: 'active', createdByRunId,
    });
    expect((await (await post(f.boardToken, g.run.id)).json()).createdByRunId).toBeNull();
    expect((await (await post(f.boardToken, f.otherRun.id)).json()).createdByRunId).toBe(f.otherRun.id);
    // An agent without a run header: another agent's run is dropped, the assignee's (its own) kept.
    await db.update(issues).set({ status: 'todo', checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    expect((await (await post(f.agentToken, f.otherRun.id)).json()).createdByRunId).toBeNull();
    expect((await (await post(f.agentToken, f.run.id)).json()).createdByRunId).toBe(f.run.id);
  });

  it('an agent cannot accept its own work: approved and merged are refused on create and update, and so is a type change', async () => {
    const f = await fixture();
    const create = (body: Record<string, unknown>) => call('POST', `/issues/${f.issue.id}/work-products`, f.agentToken, {
      type: 'document', provider: 'paperclip', title: 'Self-approved', ...body,
    }, f.run.id);
    expect((await create({ status: 'approved' })).status).toBe(403);
    expect((await create({ status: 'ready_for_review', reviewState: 'approved' })).status).toBe(403);
    expect((await create({ status: 'merged' })).status).toBe(403);
    // Re-review repro 1: the agent picks the type, so a "pull request" it says merged is still refused.
    expect((await create({ type: 'pull_request', provider: 'github', url: 'https://example.com/not-a-pr', status: 'merged' })).status).toBe(403);

    const waiting = await (await create({ status: 'ready_for_review' })).json();
    const patched = await call('PATCH', `/work-products/${waiting.id}`, f.agentToken, { status: 'approved' }, f.run.id);
    expect(patched.status).toBe(403);
    // Re-review repro 2: retyping a document as a merged pull request.
    expect((await call('PATCH', `/work-products/${waiting.id}`, f.agentToken, { type: 'pull_request', status: 'merged' }, f.run.id)).status).toBe(403);
    expect((await call('PATCH', `/work-products/${waiting.id}`, f.agentToken, { type: 'pull_request' }, f.run.id)).status).toBe(403);
    expect((await call('PATCH', `/work-products/${waiting.id}`, f.agentToken, { type: 'document', summary: 'Same type' }, f.run.id)).status).toBe(200);
    const [unchanged] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, waiting.id));
    expect(unchanged).toMatchObject({ type: 'document', status: 'ready_for_review' });
    const [row] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, waiting.id));
    expect(row!.status).toBe('ready_for_review');
    expect(await shippedIds(f.company.id, f.boardToken)).not.toContain(waiting.id);

    // A board user may still record approval directly.
    expect((await call('PATCH', `/work-products/${waiting.id}`, f.boardToken, { status: 'approved' })).status).toBe(200);
  });

  it('an agent marking its own issue done does not ship work recorded since acceptance is recorded', async () => {
    const f = await fixture();
    const product = await workProductService(db).createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Awaiting review', status: 'ready_for_review',
    });
    const response = await call('PATCH', `/issues/${f.issue.id}`, f.agentToken, { status: 'done', comment: 'Finished.' }, f.run.id);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('done');
    expect(await shippedIds(f.company.id, f.boardToken)).not.toContain(product!.id);
  });

  it('a file: URL is not stored and a path-like title is stored as its file name', async () => {
    const f = await fixture();
    const response = await call('POST', `/issues/${f.issue.id}/work-products`, f.agentToken, {
      type: 'document', provider: 'local', title: '/private/tmp/run/tanaka-japan-proposal.md',
      url: 'file:///private/tmp/run/tanaka-japan-proposal.md', status: 'ready_for_review',
    }, f.run.id);
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain('/private/tmp');
    const created = JSON.parse(text);
    expect(created).toMatchObject({ title: 'tanaka-japan-proposal.md', url: null });

    const patched = await call('PATCH', `/work-products/${created.id}`, f.agentToken, { url: 'file:///Users/me/plan.md' }, f.run.id);
    expect(patched.status).toBe(200);
    expect((await patched.json()).url).toBeNull();
  });

  it('the self-acceptance rule covers agents and assistant-grant clients, not board users', () => {
    const merged = { status: 'merged' };
    expect(workProductSelfAcceptanceRefusal({ type: 'agent' }, merged)).not.toBeNull();
    expect(workProductSelfAcceptanceRefusal({ type: 'board', source: 'assistant_grant' }, merged)).not.toBeNull();
    expect(workProductSelfAcceptanceRefusal({ type: 'board', source: 'assistant_grant' }, { status: 'approved' })).not.toBeNull();
    expect(workProductSelfAcceptanceRefusal({ type: 'board', source: 'session' }, merged)).toBeNull();
    expect(workProductSelfAcceptanceRefusal({ type: 'board', source: 'session' }, { type: 'pull_request' }, 'document')).toBeNull();
    expect(workProductSelfAcceptanceRefusal({ type: 'agent' }, { type: 'pull_request' }, 'document')).not.toBeNull();
    expect(workProductSelfAcceptanceRefusal({ type: 'agent' }, { status: 'ready_for_review' })).toBeNull();
  });

  it('request changes: one server action posts the note, sends the issue back, marks waiting work, wakes the assignee', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'in_review', checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    const products = workProductService(db);
    const waiting = await products.createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Proposal', status: 'ready_for_review', reviewState: 'needs_board_review',
    });
    const draft = await products.createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Scratch', status: 'draft',
    });

    // Not for agents, and the note is required.
    expect((await call('POST', `/issues/${f.issue.id}/request-changes`, f.agentToken, { note: 'Self review' }, f.run.id)).status).toBe(403);
    expect((await call('POST', `/issues/${f.issue.id}/request-changes`, f.boardToken, { note: '   ' })).status).toBe(400);
    // Another company's board user cannot reach it.
    const g = await fixture();
    expect((await call('POST', `/issues/${f.issue.id}/request-changes`, g.boardToken, { note: 'No' })).status).toBe(403);

    const response = await call('POST', `/issues/${f.issue.id}/request-changes`, f.boardToken, { note: 'Add Kyoto hotel prices.' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.issue.status).toBe('in_progress');
    expect(body.comment?.body).toBe('Add Kyoto hotel prices.');
    expect(wakeup).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({ reason: 'issue_commented' }));

    const [sentBack] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, waiting!.id));
    expect(sentBack).toMatchObject({ status: 'changes_requested', reviewState: 'changes_requested' });
    const [untouched] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, draft!.id));
    expect(untouched!.status).toBe('draft');
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
    expect(comments.map((c) => c.body)).toContain('Add Kyoto hotel prices.');

    // Nothing left waiting: a second request is refused and changes nothing.
    expect((await call('POST', `/issues/${f.issue.id}/request-changes`, f.boardToken, { note: 'Again' })).status).toBe(409);
  });

  // AgentDash (Scan 4 lane M): after Request changes the agent writes rev 2
  // and moves the issue back to in_review. The deliverable must be waiting
  // for review again, or there is no Accept and Decisions dead-ends.
  it('full loop: request changes, agent resubmits by moving to in_review, deliverable is reviewable again, board accepts', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'in_review', checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    const products = workProductService(db);
    const deliverable = await products.createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Proposal', status: 'ready_for_review', reviewState: 'needs_board_review',
    });

    const sentBack = await call('POST', `/issues/${f.issue.id}/request-changes`, f.boardToken, { note: 'Add Kyoto hotel prices.' });
    expect(sentBack.status).toBe(200);
    const [afterRequest] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, deliverable!.id));
    expect(afterRequest).toMatchObject({ status: 'changes_requested', reviewState: 'changes_requested' });

    // The woken agent checks the issue out, revises, and resubmits.
    await db.update(issues).set({ checkoutRunId: f.run.id, executionRunId: f.run.id }).where(eq(issues.id, f.issue.id));
    const resubmit = await call('PATCH', `/issues/${f.issue.id}`, f.agentToken, { status: 'in_review', comment: 'Revised: added Kyoto hotel prices.' }, f.run.id);
    expect(resubmit.status).toBe(200);
    expect((await resubmit.json()).status).toBe('in_review');
    const [afterResubmit] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, deliverable!.id));
    expect(afterResubmit).toMatchObject({ status: 'ready_for_review', reviewState: 'needs_board_review' });
    const logged = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id));
    expect(logged.some((row) => row.action === 'issue.work_product_updated'
      && (row.details as Record<string, unknown> | null)?.reason === 'resubmitted_for_review'
      && (row.details as Record<string, unknown> | null)?.workProductId === deliverable!.id
      && row.agentId === f.agent.id)).toBe(true);

    // Resubmitting does not let the agent accept its own work.
    expect((await call('PATCH', `/work-products/${deliverable!.id}`, f.agentToken, { status: 'approved' }, f.run.id)).status).toBe(403);
    expect(await shippedIds(f.company.id, f.boardToken)).not.toContain(deliverable!.id);

    // Request changes is available again (something is waiting), and so is Accept.
    const accept = await call('PATCH', `/issues/${f.issue.id}`, f.boardToken, { status: 'done' });
    expect(accept.status).toBe(200);
    const [accepted] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, deliverable!.id));
    expect(accepted).toMatchObject({ status: 'approved', reviewState: 'approved' });
    expect(await shippedIds(f.company.id, f.boardToken)).toContain(deliverable!.id);
  });

  it('moving to in_review leaves deliverables that were not sent back alone', async () => {
    const f = await fixture();
    const products = workProductService(db);
    const draft = await products.createForIssue(f.issue.id, f.company.id, { type: 'document', provider: 'paperclip', title: 'Scratch', status: 'draft' });
    const waiting = await products.createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Waiting', status: 'ready_for_review', reviewState: 'none',
    });
    const approved = await products.createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Accepted earlier', status: 'approved', reviewState: 'approved',
    });
    const response = await call('PATCH', `/issues/${f.issue.id}`, f.agentToken, { status: 'in_review' }, f.run.id);
    expect(response.status).toBe(200);
    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issue.id));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(draft!.id)).toMatchObject({ status: 'draft', metadata: null });
    expect(byId.get(waiting!.id)).toMatchObject({ status: 'ready_for_review', reviewState: 'none', metadata: null });
    expect(byId.get(approved!.id)).toMatchObject({ status: 'approved', reviewState: 'approved', metadata: null });
    const logged = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id));
    expect(logged.filter((row) => (row.details as Record<string, unknown> | null)?.reason === 'resubmitted_for_review')).toHaveLength(0);
  });

  // AgentDash (Scan 4 lane M, canary ACM-4): the board decides to take the
  // sent-back version as it is and closes the issue.
  it('a board user closing the issue accepts a deliverable still in changes_requested; an agent closing it does not', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'in_review', checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    const products = workProductService(db);
    const sentBack = await products.createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Proposal', status: 'ready_for_review', reviewState: 'needs_board_review',
    });
    const draft = await products.createForIssue(f.issue.id, f.company.id, { type: 'document', provider: 'paperclip', title: 'Scratch', status: 'draft' });
    expect((await call('POST', `/issues/${f.issue.id}/request-changes`, f.boardToken, { note: 'Add Kyoto.' })).status).toBe(200);

    // The agent closing its own issue is not acceptance.
    await db.update(issues).set({ checkoutRunId: f.run.id, executionRunId: f.run.id }).where(eq(issues.id, f.issue.id));
    expect((await call('PATCH', `/issues/${f.issue.id}`, f.agentToken, { status: 'done', comment: 'Done.' }, f.run.id)).status).toBe(200);
    const [afterAgent] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, sentBack!.id));
    expect(afterAgent!.status).toBe('changes_requested');
    expect(await shippedIds(f.company.id, f.boardToken)).not.toContain(sentBack!.id);

    // Reopen, then the board closes it: accepted as it is.
    await db.update(issues).set({ status: 'in_progress', checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    expect((await call('PATCH', `/issues/${f.issue.id}`, f.boardToken, { status: 'done' })).status).toBe(200);
    const [accepted] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, sentBack!.id));
    expect(accepted).toMatchObject({ status: 'approved', reviewState: 'approved' });
    expect(await shippedIds(f.company.id, f.boardToken)).toContain(sentBack!.id);
    const [untouched] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, draft!.id));
    expect(untouched!.status).toBe('draft');

    // Reopening withdraws that acceptance and restores what it was.
    expect((await call('PATCH', `/issues/${f.issue.id}`, f.boardToken, { status: 'todo' })).status).toBe(200);
    const [reopened] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, sentBack!.id));
    expect(reopened).toMatchObject({ status: 'changes_requested', reviewState: 'changes_requested' });
    expect(await shippedIds(f.company.id, f.boardToken)).not.toContain(sentBack!.id);
  });

  it('an agent cannot erase or forge the review metadata the server writes', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'in_review', checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    const product = await workProductService(db).createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Proposal', status: 'ready_for_review', reviewState: 'needs_board_review',
    });
    expect((await call('POST', `/issues/${f.issue.id}/request-changes`, f.boardToken, { note: 'Add Kyoto.' })).status).toBe(200);
    await db.update(issues).set({ checkoutRunId: f.run.id, executionRunId: f.run.id }).where(eq(issues.id, f.issue.id));
    expect((await call('PATCH', `/issues/${f.issue.id}`, f.agentToken, { status: 'in_review' }, f.run.id)).status).toBe(200);
    const [before] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
    const stamps = before!.metadata as Record<string, unknown>;
    expect(stamps).toEqual(expect.objectContaining({ changesRequestedAt: expect.any(String), resubmittedAt: expect.any(String) }));

    // metadata {} replaces the object; the server-owned keys survive it.
    expect((await call('PATCH', `/work-products/${product!.id}`, f.agentToken, { metadata: {} }, f.run.id)).status).toBe(200);
    const [kept] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
    expect(kept!.metadata).toEqual({ changesRequestedAt: stamps.changesRequestedAt, resubmittedAt: stamps.resubmittedAt });

    // Client values for those keys are dropped; its own keys are kept.
    const forged = { previousReviewState: 'approved', previousStatus: 'ready_for_review', reason: 'issue_accepted' };
    expect((await call('PATCH', `/work-products/${product!.id}`, f.agentToken, {
      metadata: { acceptance: forged, changesRequestedAt: null, documentKey: 'proposal' },
    }, f.run.id)).status).toBe(200);
    const [afterForge] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
    expect(afterForge!.metadata).toEqual({ documentKey: 'proposal', changesRequestedAt: stamps.changesRequestedAt, resubmittedAt: stamps.resubmittedAt });

    // Nor on create.
    const created = await call('POST', `/issues/${f.issue.id}/work-products`, f.agentToken, {
      type: 'document', provider: 'paperclip', title: 'Second', status: 'ready_for_review',
      metadata: { acceptance: forged, changesRequestedAt: 'x', documentKey: 'second' },
    }, f.run.id);
    expect(created.status).toBe(201);
    expect((await created.json()).metadata).toEqual({ documentKey: 'second' });

    // The board accepts; the agent cannot rewrite the acceptance it carries.
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    expect((await call('PATCH', `/issues/${f.issue.id}`, f.boardToken, { status: 'done' })).status).toBe(200);
    const [accepted] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
    const acceptance = (accepted!.metadata as Record<string, unknown>).acceptance as Record<string, unknown>;
    expect(acceptance).toMatchObject({ reason: 'issue_accepted', previousReviewState: 'needs_board_review', previousStatus: 'ready_for_review' });
    await db.update(issues).set({ status: 'in_progress', checkoutRunId: f.run.id, executionRunId: f.run.id }).where(eq(issues.id, f.issue.id));
    expect((await call('PATCH', `/work-products/${product!.id}`, f.agentToken, { metadata: { acceptance: forged } }, f.run.id)).status).toBe(200);
    const [stillAccepted] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
    expect((stillAccepted!.metadata as Record<string, unknown>).acceptance).toEqual(acceptance);
  });

  it('reopening never restores an approved review state, even if one was stored', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'done', checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    const product = await workProductService(db).createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Proposal', status: 'approved', reviewState: 'approved',
      metadata: { acceptance: { reason: 'issue_accepted', previousReviewState: 'approved', previousStatus: 'ready_for_review' } },
    });
    expect((await call('PATCH', `/issues/${f.issue.id}`, f.boardToken, { status: 'todo' })).status).toBe(200);
    const [reopened] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
    expect(reopened).toMatchObject({ status: 'ready_for_review', reviewState: 'needs_board_review', metadata: null });
  });

  it('legacy work that went through Request changes ships only when accepted, not because the agent closed the issue', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'in_review', checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    const legacy = await workProductService(db).createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Old proposal', status: 'ready_for_review',
      createdAt: new Date(ACCEPTANCE_RECORDED_SINCE.getTime() - 86_400_000),
    });
    expect((await call('POST', `/issues/${f.issue.id}/request-changes`, f.boardToken, { note: 'Redo the budget.' })).status).toBe(200);
    await db.update(issues).set({ checkoutRunId: f.run.id, executionRunId: f.run.id }).where(eq(issues.id, f.issue.id));
    expect((await call('PATCH', `/issues/${f.issue.id}`, f.agentToken, { status: 'in_review' }, f.run.id)).status).toBe(200);
    const [resubmitted] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, legacy!.id));
    expect(resubmitted!.metadata).toEqual(expect.objectContaining({ changesRequestedAt: expect.any(String), resubmittedAt: expect.any(String) }));

    // The agent closing its own issue is not acceptance.
    expect((await call('PATCH', `/issues/${f.issue.id}`, f.agentToken, { status: 'done', comment: 'Done.' }, f.run.id)).status).toBe(200);
    expect(await shippedIds(f.company.id, f.boardToken)).not.toContain(legacy!.id);
  });

  it('Shipped with accepted=true lists only accepted work, including work on done issues recorded before acceptance was', async () => {
    const f = await fixture();
    const products = workProductService(db);
    const [doneIssue] = await db.insert(issues).values({
      companyId: f.company.id, title: 'Done before this release', status: 'done', assigneeAgentId: f.agent.id,
    }).returning();
    const before = new Date(ACCEPTANCE_RECORDED_SINCE.getTime() - 86_400_000);
    const pending = await products.createForIssue(f.issue.id, f.company.id, { type: 'document', provider: 'paperclip', title: 'Pending', status: 'ready_for_review' });
    const approved = await products.createForIssue(f.issue.id, f.company.id, { type: 'document', provider: 'paperclip', title: 'Approved', status: 'approved' });
    const legacy = await products.createForIssue(doneIssue!.id, f.company.id, { type: 'document', provider: 'paperclip', title: 'Legacy', status: 'ready_for_review', createdAt: before });
    const recent = await products.createForIssue(doneIssue!.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Recent', status: 'ready_for_review',
      createdAt: new Date(ACCEPTANCE_RECORDED_SINCE.getTime() + 60_000),
    });
    const sentBack = await products.createForIssue(doneIssue!.id, f.company.id, { type: 'document', provider: 'paperclip', title: 'Sent back', status: 'changes_requested', createdAt: before });

    const all = await call('GET', `/companies/${f.company.id}/work-products`, f.boardToken);
    expect(all.status).toBe(200);
    expect((await all.json()).items.map((item: { id: string }) => item.id).sort())
      .toEqual([pending!.id, approved!.id, legacy!.id, recent!.id, sentBack!.id].sort());

    const shipped = await call('GET', `/companies/${f.company.id}/work-products?accepted=true`, f.boardToken);
    expect(shipped.status).toBe(200);
    const feed = await shipped.json();
    expect(feed.items.map((item: { id: string }) => item.id).sort()).toEqual([approved!.id, legacy!.id].sort());
    expect(feed.total).toBe(2);

    expect((await call('GET', `/companies/${f.company.id}/work-products?accepted=maybe`, f.boardToken)).status).toBe(400);
  });
});
