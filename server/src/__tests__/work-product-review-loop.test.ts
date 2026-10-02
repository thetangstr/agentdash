import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentApiKeys, agents, authUsers, boardApiKeys, companies, companyMemberships,
  createDb, heartbeatRuns, issueWorkProducts, issues,
} from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { issueRoutes } from '../routes/issues.js';
import { hashBearerToken } from '../services/board-auth.js';
import { documentService } from '../services/documents.js';
import { workProductService } from '../services/work-products.js';
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
 * (a local file becomes an issue document; the run is recorded), a board user
 * accepts it or sends it back, and Shipped lists only accepted work.
 */
describeEmbeddedPostgres('review loop: deliverables, request changes, shipped means accepted', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Server | undefined;
  let base: string;
  let scratch: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('work-product-review-loop-');
    db = createDb(temp.connectionString);
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-loop-')));
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
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
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
    const workspace = await fs.mkdtemp(path.join(scratch, 'agent-'));
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Ivy', adapterConfig: { cwd: workspace } }).returning();
    await db.insert(agentApiKeys).values({ companyId: company.id, agentId: agent.id, name: 'Worker', keyHash: hashBearerToken(agentToken) });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: 'running' }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id, title: 'Draft the Japan proposal', status: 'in_progress',
      assigneeAgentId: agent.id, createdByUserId: userId, checkoutRunId: run.id, executionRunId: run.id,
    }).returning();
    return { company, agent, run, issue, boardToken, agentToken, userId, workspace };
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

  it('drops a body run id that belongs to another company', async () => {
    const f = await fixture();
    const g = await fixture();
    const response = await call('POST', `/issues/${f.issue.id}/work-products`, f.boardToken, {
      type: 'document', provider: 'paperclip', title: 'Notes', status: 'active', createdByRunId: g.run.id,
    });
    expect(response.status).toBe(201);
    expect((await response.json()).createdByRunId).toBeNull();
  });

  it('reads a local deliverable from the agent workspace into an issue document and never stores the path', async () => {
    const f = await fixture();
    const file = path.join(f.workspace, 'tanaka-japan-proposal.md');
    await fs.writeFile(file, '# Tanaka family, 10 days in Japan\n\nDay 1: Tokyo.\n');
    const response = await call('POST', `/issues/${f.issue.id}/work-products`, f.agentToken, {
      type: 'document', provider: 'local', title: file, url: pathToFileURL(file).href, status: 'ready_for_review',
    }, f.run.id);
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain('file:');
    expect(text).not.toContain(f.workspace);
    const created = JSON.parse(text);
    expect(created.url).toBeNull();
    expect(created.title).toBe('tanaka-japan-proposal.md');
    expect(created.metadata).toMatchObject({
      documentKey: 'deliverable-tanaka-japan-proposal',
      localFile: { ingested: true, filename: 'tanaka-japan-proposal.md' },
    });
    const doc = await documentService(db).getIssueDocumentByKey(f.issue.id, 'deliverable-tanaka-japan-proposal');
    expect(doc?.body).toContain('Day 1: Tokyo.');

    // Recording it again updates the same document instead of failing.
    await fs.writeFile(file, '# Tanaka family, 10 days in Japan\n\nDay 1: Tokyo. Day 2: Hakone.\n');
    const again = await call('POST', `/issues/${f.issue.id}/work-products`, f.agentToken, {
      type: 'document', provider: 'local', title: 'Tanaka proposal', url: pathToFileURL(file).href, status: 'ready_for_review',
    }, f.run.id);
    expect(again.status).toBe(201);
    const updated = await documentService(db).getIssueDocumentByKey(f.issue.id, 'deliverable-tanaka-japan-proposal');
    expect(updated?.body).toContain('Day 2: Hakone.');
  });

  it('refuses to read files outside the agent workspace, through traversal, or of a binary type', async () => {
    const f = await fixture();
    const outside = path.join(scratch, `outside-${randomUUID()}.md`);
    await fs.writeFile(outside, 'secret');
    await fs.writeFile(path.join(f.workspace, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ url: pathToFileURL(outside).href }, 'not_found'],
      [{ provider: 'local', metadata: { path: `../${path.basename(outside)}` } }, 'not_found'],
      [{ url: 'file:///etc/passwd' }, 'not_found'],
      [{ url: pathToFileURL(path.join(f.workspace, 'photo.png')).href }, 'unsupported_type'],
    ];
    for (const [extra, reason] of cases) {
      const response = await call('POST', `/issues/${f.issue.id}/work-products`, f.agentToken, {
        type: 'document', provider: 'custom', title: 'Deliverable', status: 'ready_for_review', ...extra,
      }, f.run.id);
      expect(response.status).toBe(201);
      const text = await response.text();
      expect(text).not.toContain('secret');
      expect(text).not.toContain(outside);
      const created = JSON.parse(text);
      expect(created.url).toBeNull();
      expect(created.metadata).toEqual({ localFile: { ingested: false, reason } });
    }
    const docs = await documentService(db).listIssueDocuments(f.issue.id);
    expect(docs).toHaveLength(0);
  });

  it('a board user posting a file: URL gets no read and no stored path', async () => {
    const f = await fixture();
    const file = path.join(f.workspace, 'notes.md');
    await fs.writeFile(file, 'notes');
    const response = await call('POST', `/issues/${f.issue.id}/work-products`, f.boardToken, {
      type: 'document', provider: 'custom', title: 'Notes', url: pathToFileURL(file).href, status: 'active',
    });
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.url).toBeNull();
    expect(created.metadata).toEqual({ localFile: { ingested: false, reason: 'not_agent' } });
  });

  it('request changes: the note is a comment that wakes the assignee, and the deliverable is sent back', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'in_review', checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issue.id));
    const product = await workProductService(db).createForIssue(f.issue.id, f.company.id, {
      type: 'document', provider: 'paperclip', title: 'Proposal', status: 'ready_for_review', reviewState: 'needs_board_review',
    });
    const response = await call('PATCH', `/issues/${f.issue.id}`, f.boardToken, { status: 'in_progress', comment: 'Add Kyoto hotel prices.' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('in_progress');
    expect(body.comment?.body).toBe('Add Kyoto hotel prices.');
    expect(wakeup).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({ reason: 'issue_commented' }));

    const sentBack = await call('PATCH', `/work-products/${product!.id}`, f.boardToken, { status: 'changes_requested', reviewState: 'changes_requested' });
    expect(sentBack.status).toBe(200);
    expect(await sentBack.json()).toMatchObject({ status: 'changes_requested', reviewState: 'changes_requested' });
  });

  it('Shipped with accepted=true lists only accepted work, including work on issues done before acceptance was recorded', async () => {
    const f = await fixture();
    const products = workProductService(db);
    const [doneIssue] = await db.insert(issues).values({
      companyId: f.company.id, title: 'Done before this release', status: 'done', assigneeAgentId: f.agent.id,
    }).returning();
    const pending = await products.createForIssue(f.issue.id, f.company.id, { type: 'document', provider: 'paperclip', title: 'Pending', status: 'ready_for_review' });
    const approved = await products.createForIssue(f.issue.id, f.company.id, { type: 'document', provider: 'paperclip', title: 'Approved', status: 'approved' });
    const legacy = await products.createForIssue(doneIssue!.id, f.company.id, { type: 'document', provider: 'paperclip', title: 'Legacy', status: 'ready_for_review' });
    const sentBack = await products.createForIssue(doneIssue!.id, f.company.id, { type: 'document', provider: 'paperclip', title: 'Sent back', status: 'changes_requested' });

    const all = await call('GET', `/companies/${f.company.id}/work-products`, f.boardToken);
    expect(all.status).toBe(200);
    expect((await all.json()).items.map((item: { id: string }) => item.id).sort())
      .toEqual([pending!.id, approved!.id, legacy!.id, sentBack!.id].sort());

    const shipped = await call('GET', `/companies/${f.company.id}/work-products?accepted=true`, f.boardToken);
    expect(shipped.status).toBe(200);
    const feed = await shipped.json();
    expect(feed.items.map((item: { id: string }) => item.id).sort()).toEqual([approved!.id, legacy!.id].sort());
    expect(feed.total).toBe(2);
    expect(feed.monthTotal.count).toBe(2);

    expect((await call('GET', `/companies/${f.company.id}/work-products?accepted=maybe`, f.boardToken)).status).toBe(400);
  });
});
