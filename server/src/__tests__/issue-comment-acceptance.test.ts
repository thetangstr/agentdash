import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  activityLog, agentApiKeys, agents, authUsers, boardApiKeys, companies, companyMemberships,
  createDb, featureFlags, heartbeatRuns, issueComments, issueExecutionDecisions,
  issueReferenceMentions, issueThreadInteractions, issueRelations, issueTreeHolds, executionWorkspaces, projects, issues,
} from '@paperclipai/db';
import { issueCommentActions, type IssueCommentContext } from '../services/issue-mutation-actions.js';
import { heartbeatService } from '../services/heartbeat.js';
import { publishLiveEvent } from '../services/live-events.js';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { issueRoutes } from '../routes/issues.js';
import { hashBearerToken } from '../services/board-auth.js';
import type { StorageService } from '../storage/types.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

const effects = vi.hoisted(() => ({ cancel: vi.fn(), wake: vi.fn(), report: vi.fn() }));
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));
// Only the runtime/publication boundary is replaced; accepted rows are real PG.
vi.mock('../services/heartbeat.js', () => ({
  heartbeatService: (db: ReturnType<typeof createDb>) => ({
    getRun: async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0] ?? null,
    getActiveRunForAgent: async () => null,
    cancelRun: async (id: string) => {
      await effects.cancel(id);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
      if (!run) throw new Error('Heartbeat run not found');
      // Match canonical cancelRunInternal: terminal rows return unchanged.
      if (!['queued', 'running', 'scheduled_retry'].includes(run.status)) return run;
      return (await db.update(heartbeatRuns).set({ status: 'cancelled' }).where(eq(heartbeatRuns.id, id)).returning())[0] ?? null;
    },
    wakeup: effects.wake,
    reportRunActivity: effects.report,
  }),
}));

describe('standalone comment acceptance over HTTP and PostgreSQL', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Server | undefined;
  let base: string;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('issue-mutation-acceptance-');
    db = createDb(temp.connectionString);
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: 'authenticated' }));
    app.use('/api', issueRoutes(db, {} as StorageService));
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    effects.cancel.mockReset().mockResolvedValue(undefined);
    effects.wake.mockReset().mockResolvedValue(null);
    effects.report.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await temp?.cleanup();
  });

  async function fixture() {
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'Named human', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(boardApiKeys).values({ userId, name: 'Disposable key', keyHash: hashBearerToken(token), expiresAt: new Date(Date.now() + 60_000) });
    const [company] = await db.insert(companies).values({ name: 'Acceptance fixture', issuePrefix: randomUUID().slice(0, 8) }).returning();
    // Null role requires an explicit assignment grant; company access remains valid.
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: null, status: 'active' });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Assigned worker' }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: 'running' }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: 'Guarded issue', status: 'backlog', assigneeAgentId: agent.id, executionRunId: run.id }).returning();
    return { company, agent, run, issue, token, userId };
  }

  async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    return {
      issue, run,
      comments: await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id)),
      confirmations: await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issue.id)),
      decisions: await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issue.id)),
      references: await db.select().from(issueReferenceMentions).where(eq(issueReferenceMentions.companyId, f.company.id)),
      audit: await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id)),
    };
  }

  it('a worker comment refused for interrupt cannot reopen the issue first', async () => {
    const f = await fixture();
    const token = `pcp_agent_${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: f.company.id, agentId: f.agent.id, name: 'Disposable worker key', keyHash: hashBearerToken(token) });
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
    const before = await snapshot(f);
    const response = await fetch(`${base}/issues/${f.issue.id}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Refused worker interrupt', reopen: true, interrupt: true }),
    });
    expect(response.status).toBe(403);
    expect(await snapshot(f)).toEqual(before);
  });

  async function post(f: Awaited<ReturnType<typeof fixture>>, intent: Record<string, unknown>, token = f.token, runId?: string) {
    return fetch(`${base}/issues/${f.issue.id}/comments`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(runId ? { 'x-paperclip-run-id': runId } : {}) },
      body: JSON.stringify({ body: 'Accepted comment', ...intent }) });
  }
  async function workerToken(f: Awaited<ReturnType<typeof fixture>>) {
    const token = `pcp_agent_${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: f.company.id, agentId: f.agent.id, name: 'Worker', keyHash: hashBearerToken(token) });
    return token;
  }
  function context(f: Awaited<ReturnType<typeof fixture>>): IssueCommentContext {
    return { issueId: f.issue.id, companyId: f.company.id,
      actor: { actorType: 'user', actorId: f.userId, agentId: null, runId: null }, actorKind: 'board',
      intent: { body: 'Prepared comment' }, attribution: {}, validate: async () => undefined };
  }

  // AgentDash (c4-stops): a plain FYI comment on finished work commits and
  // still supersedes pending confirmations, but it neither reopens the issue
  // nor wakes the assignee — reopening needs the explicit intent.
  it('commits a plain comment on a done issue without reopen or wake', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
    await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id,
      kind: 'request_confirmation', payload: { version: 1, prompt: 'Proceed?', supersedeOnUserComment: true } });
    const response = await post(f, {});
    expect(response.status).toBe(201);
    const state = await snapshot(f);
    expect(state.issue.status).toBe('done');
    expect(state.comments).toHaveLength(1);
    expect(state.confirmations[0].status).toBe('expired');
    expect(effects.wake).not.toHaveBeenCalled();
  });

  it.each([{ reopen: true }, { resume: true }])('commits comment/reopen/audits/confirmation atomically for %j', async intent => {
    const f = await fixture();
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
    await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id,
      kind: 'request_confirmation', payload: { version: 1, prompt: 'Proceed?', supersedeOnUserComment: true } });
    effects.wake.mockImplementation(async () => {
      const state = await snapshot(f);
      expect(state.comments).toHaveLength(1);
      expect(state.issue.status).toBe('todo');
      expect(state.confirmations[0].status).toBe('expired');
      expect(state.audit.map(row => row.action)).toEqual(['issue.updated', 'issue.comment_added', 'issue.thread_interaction_expired']);
      return null; // withheld is normal canonical admission, still HTTP 201.
    });
    const response = await post(f, intent);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ body: 'Accepted comment', authorUserId: f.userId });
    expect(effects.wake).toHaveBeenCalledTimes(1);
    expect(effects.wake).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({ reason: 'issue_reopened_via_comment' }));
    expect(publishLiveEvent).toHaveBeenCalledTimes(3);
  });

  it('merges assignee mentions and preserves exact selected interrupt target after reopen', async () => {
    const f = await fixture();
    await db.update(agents).set({ name: 'Worker' }).where(eq(agents.id, f.agent.id));
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
    const [other] = await db.insert(agents).values({ companyId: f.company.id, name: 'Other' }).returning();
    let replacementId = '';
    effects.cancel.mockImplementation(async id => {
      expect(id).toBe(f.run.id);
      expect((await snapshot(f)).comments).toHaveLength(1);
      const [replacement] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'running' }).returning();
      replacementId = replacement.id;
      await db.update(issues).set({ executionRunId: replacement.id }).where(eq(issues.id, f.issue.id));
    });
    const response = await post(f, { body: '@Worker @Other follow up', interrupt: true, reopen: true });
    expect(response.status).toBe(201);
    expect(effects.cancel.mock.calls).toEqual([[f.run.id]]);
    expect(effects.wake.mock.calls.map(call => call[0])).toEqual([f.agent.id, other.id]);
    expect(effects.wake.mock.calls[0][1].payload.interruptedRunId).toBe(f.run.id);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, replacementId)))[0].status).toBe('running');
    const state = await snapshot(f);
    const audit = state.audit.find(row => row.action === 'issue.comment_added')!;
    expect(audit.details).toMatchObject({ requestedInterruptRunId: f.run.id });
    expect(audit.details).not.toHaveProperty('interruptedRunId');
    expect(state.audit.filter(row => row.action === 'heartbeat.cancelled')).toHaveLength(1);
  });

  it('adopts stale checkout only with the accepted comment and suppresses self wake', async () => {
    const f = await fixture(), token = await workerToken(f);
    const [old] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'succeeded' }).returning();
    await db.update(issues).set({ status: 'in_progress', checkoutRunId: old.id, executionRunId: old.id }).where(eq(issues.id, f.issue.id));
    const response = await post(f, {}, token, f.run.id);
    expect(response.status).toBe(201);
    const state = await snapshot(f);
    expect(state.issue).toMatchObject({ checkoutRunId: f.run.id, executionRunId: f.run.id });
    expect(state.audit.map(row => row.action)).toEqual(['issue.checkout_lock_adopted', 'issue.comment_added']);
    expect(state.comments).toHaveLength(1);
    expect(effects.wake).not.toHaveBeenCalled();
    expect(effects.report).toHaveBeenCalledWith(f.run.id);
  });

  it('refuses active checkout conflict without terminal execution cleanup', async () => {
    const f = await fixture(), token = await workerToken(f);
    const [terminal] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'failed' }).returning();
    const [other] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'running' }).returning();
    await db.update(issues).set({ status: 'in_progress', checkoutRunId: other.id, executionRunId: terminal.id }).where(eq(issues.id, f.issue.id));
    const before = await snapshot(f);
    expect((await post(f, {}, token, f.run.id)).status).toBe(409);
    expect(await snapshot(f)).toEqual(before);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it.each(['blocker', 'hold', 'workspace', 'cancelled'] as const)('refuses explicit resume with %s without accepted effects', async guard => {
    const f = await fixture();
    await db.update(issues).set({ status: guard === 'cancelled' ? 'cancelled' : 'blocked' }).where(eq(issues.id, f.issue.id));
    if (guard === 'hold') await db.insert(issueTreeHolds).values({ companyId: f.company.id, rootIssueId: f.issue.id, mode: 'pause' });
    if (guard === 'blocker') {
      const [blocker] = await db.insert(issues).values({ companyId: f.company.id, title: 'Blocker', status: 'todo' }).returning();
      await db.insert(issueRelations).values({ companyId: f.company.id, issueId: blocker.id, relatedIssueId: f.issue.id, type: 'blocks' });
    }
    if (guard === 'workspace') {
      const [project] = await db.insert(projects).values({ companyId: f.company.id, name: 'Project' }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.company.id, projectId: project.id,
        name: 'Closed', mode: 'isolated_workspace', strategyType: 'git_worktree', status: 'archived', closedAt: new Date() }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issue.id));
    }
    const before = await snapshot(f);
    expect((await post(f, { resume: true })).status).toBe(409);
    expect(await snapshot(f)).toEqual(before);
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(effects.wake).not.toHaveBeenCalled();
  });

  it('preparation has no writes/publications and stale private intent snapshot refuses acceptance', async () => {
    const f = await fixture();
    const actions = issueCommentActions(db, { cancelRun: effects.cancel, wakeup: effects.wake, reportRunActivity: effects.report });
    const ctx = context(f), before = await snapshot(f);
    const plan = await actions.prepare(ctx);
    expect(await snapshot(f)).toEqual(before);
    expect(publishLiveEvent).not.toHaveBeenCalled();
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
    const changed = await snapshot(f);
    await expect(actions.accept({ ...ctx, expectedSnapshot: plan.snapshot })).rejects.toThrow('Issue changed');
    expect(await snapshot(f)).toEqual(changed);
  });

  it('late database failure rolls back comment, reopen, references, expiry and all mutation audits', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
    await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id,
      kind: 'request_confirmation', payload: { version: 1, prompt: 'Proceed?', supersedeOnUserComment: true } });
    const [referenced] = await db.insert(issues).values({ companyId: f.company.id, title: 'Referenced', identifier: 'REF-123' }).returning();
    const before = await snapshot(f);
    await db.execute(sql`CREATE FUNCTION fail_comment_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action = 'issue.thread_interaction_expired' THEN RAISE EXCEPTION 'injected late write'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER fail_comment_acceptance BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_comment_acceptance()`);
    try {
      expect((await post(f, { body: `See ${referenced.identifier}`, interrupt: true })).status).toBe(500);
      expect(await snapshot(f)).toEqual(before);
      expect(publishLiveEvent).not.toHaveBeenCalled();
      expect(effects.cancel).not.toHaveBeenCalled();
      expect(effects.wake).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`DROP TRIGGER fail_comment_acceptance ON activity_log`);
      await db.execute(sql`DROP FUNCTION fail_comment_acceptance()`);
    }
  });

  it('known postcommit wake failure reports accepted uncertainty without retry or private text', async () => {
    const f = await fixture();
    effects.wake.mockRejectedValue(new Error('private provider cause'));
    const response = await post(f, { body: 'private comment body' });
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error).toMatch(/Comment accepted.*unresolved/);
    expect(JSON.stringify(payload)).not.toMatch(/private/);
    const state = await snapshot(f);
    expect(state.comments).toHaveLength(1);
    expect(state.audit.filter(row => row.action === 'issue.comment_added')).toHaveLength(1);
    expect(effects.wake).toHaveBeenCalledTimes(1);
    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
  });

  it('a lost commit acknowledgement returns safe uncertainty and does not dispatch or retry', async () => {
    const f = await fixture();
    const original = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(async callback => {
      await original(callback);
      throw new Error('private commit transport cause');
    });
    try {
      const response = await post(f, { body: 'private committed comment' });
      expect(response.status).toBe(500);
      const payload = await response.json();
      expect(payload.error).toMatch(/acceptance is uncertain/);
      expect(JSON.stringify(payload)).not.toMatch(/private/);
      expect((await snapshot(f)).comments).toHaveLength(1);
      expect(publishLiveEvent).not.toHaveBeenCalled();
      expect(effects.wake).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('stores canonical references before publishing accepted success', async () => {
    const f = await fixture();
    const [referenced] = await db.insert(issues).values({ companyId: f.company.id, title: 'Reference', identifier: 'REF-321' }).returning();
    const actions = issueCommentActions(db, { cancelRun: effects.cancel, wakeup: effects.wake, reportRunActivity: effects.report });
    const accepted = await actions.accept({ ...context(f), intent: { body: `See ${referenced.identifier}` } });
    const state = await snapshot(f);
    expect(state.references).toHaveLength(1);
    expect(state.audit[0].details).toMatchObject({ addedReferencedIssues: [{ id: referenced.id, identifier: 'REF-321', title: 'Reference' }] });
    expect(publishLiveEvent).not.toHaveBeenCalled();
    await actions.dispatch(accepted);
    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
    expect(effects.wake).toHaveBeenCalledTimes(1);
  });

  it('worker closed-work comments stay inert, including mentions of other workers', async () => {
    const f = await fixture(), token = await workerToken(f);
    await db.update(agents).set({ name: 'Worker' }).where(eq(agents.id, f.agent.id));
    await db.insert(agents).values({ companyId: f.company.id, name: 'Other' }).returning();
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
    expect((await post(f, { body: '@Worker @Other evidence' }, token)).status).toBe(201);
    expect((await snapshot(f)).issue.status).toBe('done');
    // AgentDash (c4-stops review): an @-mention on a closed issue is FYI —
    // neither the assignee nor the mentioned agent may be woken.
    expect(effects.wake).not.toHaveBeenCalled();
  });

  it('a board @-mention on a cancelled issue does not wake the mentioned agent', async () => {
    const f = await fixture();
    const [other] = await db.insert(agents).values({ companyId: f.company.id, name: 'Other' }).returning();
    await db.update(issues).set({ status: 'cancelled' }).where(eq(issues.id, f.issue.id));
    const response = await post(f, { body: '@Other FYI all done' });
    expect(response.status).toBe(201);
    expect((await snapshot(f)).issue.status).toBe('cancelled');
    expect(effects.wake).not.toHaveBeenCalled();
  });

  it('an @-mention on the explicit reopen comment still wakes the mentioned agent', async () => {
    const f = await fixture();
    await db.update(agents).set({ name: 'Worker' }).where(eq(agents.id, f.agent.id));
    const [other] = await db.insert(agents).values({ companyId: f.company.id, name: 'Other' }).returning();
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
    const response = await post(f, { body: '@Other back online', reopen: true });
    expect(response.status).toBe(201);
    expect((await snapshot(f)).issue.status).toBe('todo');
    expect(effects.wake).toHaveBeenCalledTimes(2);
    expect(effects.wake).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({ reason: 'issue_reopened_via_comment' }));
    expect(effects.wake).toHaveBeenCalledWith(other.id, expect.objectContaining({ reason: 'issue_comment_mentioned' }));
  });

  it('partial postcommit cancellation failure records uncertainty while a later wake is admitted once', async () => {
    const f = await fixture();
    effects.cancel.mockRejectedValue(new Error('private cancel cause'));
    effects.wake.mockResolvedValue({ id: 'admitted-run' });
    const response = await post(f, { interrupt: true });
    expect(response.status).toBe(500);
    expect(effects.cancel).toHaveBeenCalledExactlyOnceWith(f.run.id);
    expect(effects.wake).toHaveBeenCalledTimes(1);
    expect(effects.wake.mock.calls[0][1].payload).not.toHaveProperty('interruptedRunId');
    const state = await snapshot(f);
    expect(state.comments).toHaveLength(1);
    expect(state.audit.map(row => row.action)).toEqual(['issue.comment_added']);
    expect(state.run.status).toBe('running');
  });

  // AgentDash (c4-stops): a plain board comment on a cancelled issue is FYI —
  // it stays cancelled and nobody is woken. An explicit reopen is the only
  // comment path back to todo.
  it('leaves a cancelled issue cancelled on a plain board comment', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'cancelled' }).where(eq(issues.id, f.issue.id));
    expect((await post(f, {})).status).toBe(201);
    expect((await snapshot(f)).issue.status).toBe('cancelled');
    expect(effects.wake).not.toHaveBeenCalled();
  });

  it('preserves the canonical board cancelled follow-up on explicit reopen', async () => {
    const f = await fixture();
    await db.update(issues).set({ status: 'cancelled' }).where(eq(issues.id, f.issue.id));
    expect((await post(f, { reopen: true })).status).toBe(201);
    expect((await snapshot(f)).issue.status).toBe('todo');
    expect(effects.wake).toHaveBeenCalledTimes(1);
  });

  it('requires dedicated restore for an agent reopening a cancelled issue', async () => {
    const f = await fixture(), token = await workerToken(f);
    await db.update(issues).set({ status: 'cancelled' }).where(eq(issues.id, f.issue.id));
    const before = await snapshot(f);
    const response = await post(f, { reopen: true }, token);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/dedicated restore/);
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(['run', 'confirmation', 'intent'] as const)('private prepared comment rejects changed %s effects without accepting writes', async changed => {
    const f = await fixture();
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issue.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id } }).where(eq(heartbeatRuns.id, f.run.id));
    const actions = issueCommentActions(db, { cancelRun: effects.cancel, wakeup: effects.wake, reportRunActivity: effects.report });
    const ctx = { ...context(f), intent: { body: 'Pinned follow-up', interrupt: true } };
    const plan = await actions.prepare(ctx);
    expect(plan.snapshot.interruptRunId).toBe(f.run.id);
    if (changed === 'run') {
      await db.update(heartbeatRuns).set({ status: 'succeeded' }).where(eq(heartbeatRuns.id, f.run.id));
      await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'running', contextSnapshot: { issueId: f.issue.id } });
    } else if (changed === 'confirmation') {
      await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id,
        kind: 'request_confirmation', payload: { version: 1, prompt: 'New question', supersedeOnUserComment: true } });
    } else {
      ctx.intent.body = 'Changed submitted text';
    }
    const before = await snapshot(f);
    await expect(actions.accept({ ...ctx, expectedSnapshot: plan.snapshot })).rejects.toThrow('Issue changed');
    expect(await snapshot(f)).toEqual(before);
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(effects.cancel).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'failed', 'cancelled', 'null', 'throw'] as const)(
    'interprets canonical cancellation result %s after accepting a real comment', async result => {
      const f = await fixture();
      const runtime = heartbeatService(db);
      if (result === 'null' || result === 'throw') {
        vi.spyOn(runtime, 'cancelRun').mockImplementation(async id => {
          await effects.cancel(id);
          if (result === 'throw') throw new Error('Cancellation outcome unavailable');
          return null;
        });
      }
      const actions = issueCommentActions(db, runtime);
      const accepted = await actions.accept({ ...context(f), intent: { body: 'Accepted before run completion', interrupt: true } });
      expect(accepted.plan.interruptRun?.id).toBe(f.run.id);
      expect((await snapshot(f)).comments).toHaveLength(1);
      expect(effects.cancel).not.toHaveBeenCalled();
      expect(publishLiveEvent).not.toHaveBeenCalled();
      if (result !== 'null' && result !== 'throw') {
        await db.update(heartbeatRuns).set({ status: result }).where(eq(heartbeatRuns.id, f.run.id));
      }
      const [replacement] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
        status: 'running', contextSnapshot: { issueId: f.issue.id } }).returning();
      await db.update(issues).set({ executionRunId: replacement.id }).where(eq(issues.id, f.issue.id));

      const dispatched = await actions.dispatch(accepted);
      const cancelled = result === 'cancelled';
      const status = cancelled ? 'confirmed' : result === 'throw' ? 'unknown' : 'withheld';
      expect(dispatched.outcomes).toContainEqual({ effect: 'cancel', targetId: f.run.id, status });
      expect(dispatched.unresolved).toBe(result === 'throw');
      expect(effects.cancel.mock.calls).toEqual([[f.run.id]]);
      expect(effects.wake).toHaveBeenCalledTimes(1);
      const wake = effects.wake.mock.calls[0][1];
      if (cancelled) {
        expect(wake.payload.interruptedRunId).toBe(f.run.id);
        expect(wake.contextSnapshot.interruptedRunId).toBe(f.run.id);
      } else {
        expect(wake.payload).not.toHaveProperty('interruptedRunId');
        expect(wake.contextSnapshot).not.toHaveProperty('interruptedRunId');
        expect(dispatched.outcomes.some(outcome => outcome.effect === 'cancel_audit')).toBe(false);
      }
      const state = await snapshot(f);
      expect(state.comments).toHaveLength(1);
      expect(state.audit.filter(row => row.action === 'heartbeat.cancelled')).toHaveLength(cancelled ? 1 : 0);
      expect(state.run.status).toBe(result === 'null' || result === 'throw' ? 'running' : result);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, replacement.id)))[0].status).toBe('running');
      expect(publishLiveEvent).toHaveBeenCalledTimes(cancelled ? 2 : 1);
    },
  );


  // #881 review P1: heartbeat's recovery-budget and retry writers lock the
  // issue first, then insert a row whose company FK takes FOR KEY SHARE on
  // the company. Acceptance holds the company row as its mutex; with plain
  // FOR UPDATE the two orders deadlocked (40P01). FOR NO KEY UPDATE does not
  // conflict with KEY SHARE, so the heartbeat side finishes and acceptance
  // proceeds after it.
  it('a human comment and a heartbeat-style budget comment on the same issue do not deadlock', async () => {
    const f = await fixture();
    let markLocked!: () => void, release!: () => void;
    const issueLocked = new Promise<void>(resolve => { markLocked = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const heartbeatSide = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issue.id)).for('update');
      markLocked();
      await proceed;
      await tx.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorAgentId: f.agent.id,
        body: 'Automatic recovery budget exhausted. Regression fixture.' });
      await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, f.issue.id));
    });
    await issueLocked;
    const human = post(f, { body: 'Human comment while the reconciler writes' });
    // Wait until acceptance holds the company row and queues behind the issue lock.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`) as unknown as Array<{ waiting: number }>;
      if (rows[0].waiting > 0) break;
      if (Date.now() > deadline) throw new Error('acceptance never queued behind the issue lock');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    release();
    const [heartbeatResult, humanResult] = await Promise.allSettled([heartbeatSide, human]);
    expect(heartbeatResult.status, heartbeatResult.status === 'rejected' ? String(heartbeatResult.reason) : '').toBe('fulfilled');
    expect(humanResult.status).toBe('fulfilled');
    expect((humanResult as PromiseFulfilledResult<Response>).value.status).toBe(201);
    const bodies = (await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).map(row => row.body);
    expect(bodies).toEqual(expect.arrayContaining(['Automatic recovery budget exhausted. Regression fixture.', 'Human comment while the reconciler writes']));
  });

});
