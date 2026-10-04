import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  activityLog, agentApiKeys, agents, authUsers, boardApiKeys, companies, companyMemberships,
  createDb, goals, featureFlags, heartbeatRuns, issueComments, issueExecutionDecisions,
  issueReferenceMentions, issueThreadInteractions, issueRelations, issueLabels, labels, routineRuns, routines, executionWorkspaces, projects, issueTreeHolds, issues,
} from '@paperclipai/db';
import { issueCommentActions } from '../services/issue-mutation-actions.js';
import { issueService } from '../services/issues.js';
import { issuePatchActions, type IssuePatchContext } from '../services/issue-patch-actions.js';
import { normalizeIssueExecutionPolicy } from '../services/issue-execution-policy.js';
import { workforceService } from '../services/workforce.js';
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

describe('canonical issue mutation acceptance over HTTP and PostgreSQL', () => {
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
      labels: await db.select().from(issueLabels).where(eq(issueLabels.issueId, f.issue.id)),
      relations: await db.select().from(issueRelations).where(eq(issueRelations.companyId, f.company.id)),
      routines: await db.select().from(routineRuns).where(eq(routineRuns.companyId, f.company.id)),
      decisions: await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issue.id)),
      references: await db.select().from(issueReferenceMentions).where(eq(issueReferenceMentions.companyId, f.company.id)),
      audit: await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id)),
    };
  }

  it.each(['assignment', 'dod'] as const)('refused interrupt plus %s leaves accepted state unchanged', async (guard) => {
    const f = await fixture();
    if (guard === 'dod') await db.insert(featureFlags).values({ companyId: f.company.id, flagKey: 'dod_guard_enabled', enabled: true });
    const before = await snapshot(f);
    const response = await fetch(`${base}/issues/${f.issue.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'Do not interrupt on refusal', interrupt: true, ...(guard === 'assignment' ? { assigneeAgentId: null } : { status: 'todo' }) }),
    });
    expect(response.status).toBe(guard === 'assignment' ? 403 : 422);
    expect(await snapshot(f)).toEqual(before);
  });

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

  async function patch(f: Awaited<ReturnType<typeof fixture>>, intent: Record<string, unknown>, token = f.token, runId?: string) {
    return fetch(`${base}/issues/${f.issue.id}`, { method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(runId ? { 'x-paperclip-run-id': runId } : {}) },
      body: JSON.stringify(intent) });
  }
  async function workerToken(f: Awaited<ReturnType<typeof fixture>>) {
    const token = `pcp_agent_${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: f.company.id, agentId: f.agent.id, name: 'Worker', keyHash: hashBearerToken(token) });
    return token;
  }
  function context(f: Awaited<ReturnType<typeof fixture>>, intent: IssuePatchContext['intent'] = { comment: 'Prepared comment' }): IssuePatchContext {
    return { issueId: f.issue.id, companyId: f.company.id,
      actor: { actorType: 'user', actorId: f.userId, agentId: null, runId: null }, actorKind: 'board',
      intent, attribution: {}, validate: async () => undefined, validateResume: async () => undefined, validateAssignment: async () => undefined };
  }
  async function approvalFixture() {
    const f = await fixture();
    const policy = normalizeIssueExecutionPolicy({ stages: [{ id: randomUUID(), type: 'approval', participants: [{ type: 'user', userId: f.userId }] }] })!;
    await db.update(issues).set({ status: 'in_review', assigneeAgentId: null, assigneeUserId: f.userId,
      executionPolicy: { ...policy }, executionState: { status: 'pending', currentStageId: policy.stages[0].id,
        currentStageIndex: 0, currentStageType: 'approval', currentParticipant: { type: 'user', userId: f.userId },
        returnAssignee: { type: 'agent', agentId: f.agent.id }, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null } }).where(eq(issues.id, f.issue.id));
    const [referenced] = await db.insert(issues).values({ companyId: f.company.id, title: 'Reference', identifier: `REF-${Math.floor(Math.random() * 1000000)}` }).returning();
    await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id,
      kind: 'request_confirmation', payload: { version: 1, prompt: 'Proceed?', supersedeOnUserComment: true } });
    const [routine] = await db.insert(routines).values({ companyId: f.company.id, title: 'Routine' }).returning();
    const [routineRun] = await db.insert(routineRuns).values({ companyId: f.company.id, routineId: routine.id, source: 'manual', status: 'running', linkedIssueId: f.issue.id }).returning();
    await db.update(issues).set({ originKind: 'routine_execution', originId: routine.id, originRunId: routineRun.id }).where(eq(issues.id, f.issue.id));
    return { ...f, referenced, routineRun };
  }

  it('commits combined update, decision, comment, references, confirmation and routine state before publishing', async () => {
    const f = await approvalFixture();
    effects.cancel.mockImplementation(async selectedId => {
      // Read through the root connection at the first runtime boundary. The
      // full accepted state must already be visible outside the transaction.
      const committed = await snapshot(f);
      expect(selectedId).toBe(f.run.id);
      expect(committed.decisions).toHaveLength(1);
      expect(committed.comments).toHaveLength(1);
      expect(committed.references).toHaveLength(2);
      expect(committed.confirmations[0].status).toBe('expired');
      expect(committed.routines[0].status).toBe('completed');
    });
    const response = await patch(f, { status: 'done', description: `See ${f.referenced.identifier}`, comment: `Approved ${f.referenced.identifier}`, interrupt: true });
    expect(response.status).toBe(200);
    const value = await response.json(), state = await snapshot(f);
    expect(value).toMatchObject({ status: 'done', comment: { authorUserId: f.userId }, referencedIssueIdentifiers: [f.referenced.identifier] });
    expect(state.comments).toHaveLength(1);
    expect(state.decisions).toHaveLength(1);
    expect(state.issue.executionState).toMatchObject({ lastDecisionId: state.decisions[0].id, status: 'completed' });
    expect(state.decisions[0]).toMatchObject({ actorUserId: f.userId, outcome: 'approved' });
    expect(state.references).toHaveLength(2);
    expect(state.confirmations[0].status).toBe('expired');
    expect(state.routines[0].status).toBe('completed');
    expect(state.audit.map(row => row.action)).toEqual(['issue.updated', 'issue.comment_added', 'issue.thread_interaction_expired', 'heartbeat.cancelled']);
    expect(new Set(state.audit.map(row => row.details?.mutationId)).size).toBe(1);
    expect(state.audit[0].details).toMatchObject({ _previous: { status: 'in_review' }, requestedInterruptRunId: f.run.id });
    expect(state.audit[0].details).not.toHaveProperty('interruptedRunId');
    expect(effects.cancel).toHaveBeenCalledExactlyOnceWith(f.run.id);
  });

  it('late audit fault rolls back decision, references, confirmation, routine and every accepted row', async () => {
    const f = await approvalFixture(), before = await snapshot(f);
    await db.execute(sql`CREATE FUNCTION fail_patch_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action = 'issue.thread_interaction_expired' THEN RAISE EXCEPTION 'injected late patch write'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER fail_patch_acceptance BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_patch_acceptance()`);
    try {
      expect((await patch(f, { status: 'done', description: f.referenced.identifier, comment: f.referenced.identifier, interrupt: true })).status).toBe(500);
      expect(await snapshot(f)).toEqual(before);
      expect(publishLiveEvent).not.toHaveBeenCalled();
      expect(effects.cancel).not.toHaveBeenCalled();
      expect(effects.wake).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`DROP TRIGGER fail_patch_acceptance ON activity_log`);
      await db.execute(sql`DROP FUNCTION fail_patch_acceptance()`);
    }
  });

  it.each(['label', 'review', 'host', 'worker'] as const)('refuses %s with no accepted state or runtime effects', async guard => {
    const f = await fixture();
    let token = f.token;
    const intent: Record<string, unknown> = { comment: 'Refused', interrupt: true };
    if (guard === 'label') intent.labelIds = [randomUUID()];
    if (guard === 'review') intent.reviewRequest = { instructions: 'No review stage' };
    if (guard === 'host') intent.executionWorkspaceSettings = { workspaceStrategy: { provisionCommand: 'private command' } };
    if (guard === 'worker') token = await workerToken(f);
    const before = await snapshot(f), response = await patch(f, intent, token);
    expect(response.status).toBe(guard === 'host' || guard === 'worker' ? 403 : 422);
    expect(await snapshot(f)).toEqual(before);
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(effects.cancel).not.toHaveBeenCalled();
  });

  it('preserves BLOCKED latest own comment guard and accepted stale checkout adoption', async () => {
    const f = await fixture(), token = await workerToken(f);
    const [old] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'succeeded' }).returning();
    await db.update(issues).set({ status: 'in_progress', checkoutRunId: old.id, executionRunId: old.id }).where(eq(issues.id, f.issue.id));
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorAgentId: f.agent.id, body: 'BLOCKED: required input missing' });
    const response = await patch(f, { status: 'done' }, token, f.run.id);
    expect(response.status).toBe(200);
    const state = await snapshot(f);
    expect(state.issue.status).toBe('blocked');
    expect(state.audit.map(row => row.action)).toEqual(['issue.checkout_lock_adopted', 'issue.updated']);
    expect(effects.report).toHaveBeenCalledExactlyOnceWith(f.run.id);
  });

  it('late invalid label rolls back stale checkout adoption and audit', async () => {
    const f = await fixture(), token = await workerToken(f);
    const [old] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'succeeded' }).returning();
    await db.update(issues).set({ status: 'in_progress', checkoutRunId: old.id, executionRunId: old.id }).where(eq(issues.id, f.issue.id));
    const before = await snapshot(f);
    expect((await patch(f, { title: 'Rejected', labelIds: [randomUUID()] }, token, f.run.id)).status).toBe(422);
    expect(await snapshot(f)).toEqual(before);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it('prepare is read-only and pins normalized assignee identity across rename', async () => {
    const f = await fixture();
    const [other] = await db.insert(agents).values({ companyId: f.company.id, name: 'Reviewer' }).returning();
    const actions = issuePatchActions(db, heartbeatService(db));
    const input = context(f, { assigneeAgentId: 'Reviewer', comment: 'Prepared' });
    const original = structuredClone(input.intent), before = await snapshot(f);
    const plan = await actions.prepare(input);
    expect(plan.intent.assigneeAgentId).toBe(other.id);
    expect(input.intent).toEqual(original);
    expect(await snapshot(f)).toEqual(before);
    expect(publishLiveEvent).not.toHaveBeenCalled();
    await db.update(agents).set({ name: 'Renamed' }).where(eq(agents.id, other.id));
    await db.insert(agents).values({ companyId: f.company.id, name: 'Reviewer' });
    const accepted = await actions.accept({ ...plan.context, expectedSnapshot: plan.snapshot });
    expect(accepted.status).toBe('committed');
    expect(accepted.issue.assigneeAgentId).toBe(other.id);
    expect((await snapshot(f)).comments).toHaveLength(1);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it.each(['issue', 'confirmation', 'intent'] as const)('stale %s private pin refuses before any accepted writes', async change => {
    const f = await fixture(), actions = issuePatchActions(db, heartbeatService(db));
    const plan = await actions.prepare(context(f, { title: 'Prepared', comment: 'Prepared' }));
    if (change === 'issue') await db.update(issues).set({ title: 'Changed' }).where(eq(issues.id, f.issue.id));
    if (change === 'confirmation') await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id,
      kind: 'request_confirmation', payload: { version: 1, prompt: 'New question', supersedeOnUserComment: true } });
    const before = await snapshot(f);
    await expect(actions.accept({ ...plan.context, expectedSnapshot: plan.snapshot,
      ...(change === 'intent' ? { intent: { title: 'Other', comment: 'Prepared' } } : {}) })).rejects.toThrow('Issue changed');
    expect(await snapshot(f)).toEqual(before);
    expect(effects.wake).not.toHaveBeenCalled();
  });

  it.each(['running', 'succeeded', 'failed', 'cancelled', 'null', 'throw'] as const)('deduplicates exact cancellation and interprets canonical %s result', async result => {
    const f = await fixture();
    await db.update(issues).set({ status: 'todo' }).where(eq(issues.id, f.issue.id));
    const runtime = heartbeatService(db), actions = issuePatchActions(db, runtime);
    const accepted = await actions.accept(context(f, { status: 'cancelled', comment: 'Accepted', interrupt: true }));
    const [replacement] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'running' }).returning();
    await db.update(issues).set({ executionRunId: replacement.id }).where(eq(issues.id, f.issue.id));
    if (['succeeded', 'failed', 'cancelled'].includes(result)) await db.update(heartbeatRuns).set({ status: result }).where(eq(heartbeatRuns.id, f.run.id));
    if (result === 'null') vi.spyOn(runtime, 'cancelRun').mockResolvedValueOnce(null);
    if (result === 'throw') effects.cancel.mockRejectedValueOnce(new Error('private runtime fault'));
    const outcome = await actions.dispatch(accepted);
    await actions.dispatch(accepted);
    const state = await snapshot(f), confirmed = result === 'running' || result === 'cancelled';
    expect(outcome.outcomes.filter(row => row.effect === 'cancel')).toEqual([{ effect: 'cancel', targetId: f.run.id,
      status: confirmed ? 'confirmed' : result === 'throw' ? 'unknown' : 'withheld' }]);
    expect(state.audit.filter(row => row.action === 'heartbeat.cancelled')).toHaveLength(confirmed ? 1 : 0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, replacement.id)))[0].status).toBe('running');
    expect(effects.cancel).toHaveBeenCalledTimes(result === 'null' ? 0 : 1);
    expect(effects.wake).toHaveBeenCalledTimes(1);
    expect(effects.wake.mock.calls[0][1].payload.interruptedRunId).toBe(confirmed ? f.run.id : undefined);
    expect(outcome.status).toBe(result === 'throw' ? 'partial' : 'confirmed');
  });

  it('merged wakes preserve mention precedence and parent/dependent recipient issue keys', async () => {
    const f = await fixture();
    await db.update(agents).set({ name: 'Worker' }).where(eq(agents.id, f.agent.id));
    const [parent] = await db.insert(issues).values({ companyId: f.company.id, title: 'Parent', status: 'todo', assigneeAgentId: f.agent.id }).returning();
    const [dependent] = await db.insert(issues).values({ companyId: f.company.id, title: 'Dependent', status: 'blocked', assigneeAgentId: f.agent.id }).returning();
    await db.insert(issueRelations).values({ companyId: f.company.id, issueId: f.issue.id, relatedIssueId: dependent.id, type: 'blocks' });
    await db.update(issues).set({ status: 'todo', parentId: parent.id }).where(eq(issues.id, f.issue.id));
    expect((await patch(f, { status: 'done', comment: '@Worker completed' })).status).toBe(200);
    const wakes = effects.wake.mock.calls.map(([agentId, request]) => ({ agentId, issueId: request.payload.issueId, reason: request.reason }));
    expect(wakes).toEqual([
      { agentId: f.agent.id, issueId: f.issue.id, reason: 'issue_comment_mentioned' },
      { agentId: f.agent.id, issueId: dependent.id, reason: 'issue_blockers_resolved' },
      { agentId: f.agent.id, issueId: parent.id, reason: 'issue_children_completed' },
    ]);
  });

  it('execution stage assignment wake stays canonical', async () => {
    const f = await fixture();
    const [reviewer] = await db.insert(agents).values({ companyId: f.company.id, name: 'Reviewer' }).returning();
    await db.update(issues).set({ status: 'todo', executionPolicy: { ...normalizeIssueExecutionPolicy({ stages: [{ type: 'review', participants: [{ type: 'agent', agentId: reviewer.id }] }] })! } }).where(eq(issues.id, f.issue.id));
    const response = await patch(f, { status: 'done', comment: 'Ready for review' });
    expect(response.status).toBe(200);
    expect((await snapshot(f)).issue).toMatchObject({ status: 'in_review', assigneeAgentId: reviewer.id });
    expect(effects.wake).toHaveBeenCalledExactlyOnceWith(reviewer.id, expect.objectContaining({ reason: 'execution_review_requested',
      contextSnapshot: expect.objectContaining({ executionStage: expect.objectContaining({ wakeRole: 'reviewer' }) }) }));
  });

  it('lost commit acknowledgement reports bounded uncertainty and never dispatches', async () => {
    const f = await fixture(), original = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(async callback => { await original(callback); throw new Error('private commit cause'); });
    try {
      const response = await patch(f, { title: 'Committed', comment: 'Private accepted text', interrupt: true });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Issue update acceptance is uncertain. Read the issue before retrying.' });
      expect((await snapshot(f)).comments).toHaveLength(1);
      expect(publishLiveEvent).not.toHaveBeenCalled();
      expect(effects.cancel).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('postcommit failure after cancellation reports accepted uncertainty without repeat', async () => {
    const f = await fixture();
    effects.wake.mockRejectedValueOnce(new Error('private provider cause'));
    const response = await patch(f, { title: 'Committed', comment: 'Private comment', interrupt: true });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Issue update accepted, but follow-up effects are unresolved. Read the issue before retrying.' });
    const state = await snapshot(f);
    expect(state.issue.title).toBe('Committed');
    expect(state.comments).toHaveLength(1);
    expect(state.run.status).toBe('cancelled');
    expect(effects.cancel).toHaveBeenCalledTimes(1);
    expect(effects.wake).toHaveBeenCalledTimes(1);
  });
  it('a changed blocker outcome invalidates the private prepared action', async () => {
    const f = await fixture(), actions = issuePatchActions(db, heartbeatService(db));
    await db.update(issues).set({ status: 'blocked' }).where(eq(issues.id, f.issue.id));
    const plan = await actions.prepare(context(f, { comment: 'Follow up' }));
    const [blocker] = await db.insert(issues).values({ companyId: f.company.id, title: 'New blocker', status: 'todo' }).returning();
    await db.insert(issueRelations).values({ companyId: f.company.id, issueId: blocker.id, relatedIssueId: f.issue.id, type: 'blocks' });
    const before = await snapshot(f);
    await expect(actions.accept({ ...plan.context, expectedSnapshot: plan.snapshot })).rejects.toThrow('Issue changed');
    expect(await snapshot(f)).toEqual(before);
  });

  it('required workforce inputs refuse completion and interrupt atomically', async () => {
    const f = await fixture();
    await db.update(agents).set({ adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: f.userId }).where(eq(agents.id, f.agent.id));
    await workforceService(db).enroll(f.company.id, f.agent.id, { templateId: 'marketing-content' }, { userId: f.userId });
    const before = await snapshot(f);
    expect((await patch(f, { status: 'done', comment: 'Cannot finish without inputs', interrupt: true })).status).toBe(409);
    expect(await snapshot(f)).toEqual(before);
    expect(effects.cancel).not.toHaveBeenCalled();
  });

  it.each(['blocker', 'hold', 'cancelled'] as const)('PATCH explicit resume preserves %s refusal', async guard => {
    const f = await fixture();
    await db.update(issues).set({ status: guard === 'cancelled' ? 'cancelled' : 'blocked' }).where(eq(issues.id, f.issue.id));
    if (guard === 'hold') await db.insert(issueTreeHolds).values({ companyId: f.company.id, rootIssueId: f.issue.id, mode: 'pause' });
    if (guard === 'blocker') {
      const [blocker] = await db.insert(issues).values({ companyId: f.company.id, title: 'Blocker', status: 'todo' }).returning();
      await db.insert(issueRelations).values({ companyId: f.company.id, issueId: blocker.id, relatedIssueId: f.issue.id, type: 'blocks' });
    }
    const before = await snapshot(f);
    expect((await patch(f, { comment: 'Refused follow up', resume: true, interrupt: true })).status).toBe(409);
    expect(await snapshot(f)).toEqual(before);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  // AgentDash (c4-stops): a plain human comment on a cancelled issue is inert
  // — reopening takes the explicit flag.
  it.each([false, true])('PATCH human cancelled follow up %s reopen', async reopen => {
    const f = await fixture();
    await db.update(issues).set({ status: 'cancelled' }).where(eq(issues.id, f.issue.id));
    expect((await patch(f, { comment: 'Human follow up', ...(reopen ? { reopen: true } : {}) })).status).toBe(200);
    expect((await snapshot(f)).issue.status).toBe(reopen ? 'todo' : 'cancelled');
  });

  it('closed workspace permits human field edits but refuses comment and worker work', async () => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: 'Project' }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.company.id, projectId: project.id,
      name: 'Closed', mode: 'isolated_workspace', strategyType: 'git_worktree', status: 'archived', closedAt: new Date() }).returning();
    await db.update(issues).set({ projectId: project.id, executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issue.id));
    expect((await patch(f, { title: 'Human field edit', hiddenAt: '2026-09-28T00:00:00.000Z' })).status).toBe(200);
    const before = await snapshot(f);
    expect(before.issue.hiddenAt?.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect((await patch(f, { comment: 'No closed workspace work', interrupt: true })).status).toBe(409);
    expect((await patch(f, { title: 'Worker work' }, await workerToken(f))).status).toBe(409);
    expect(await snapshot(f)).toEqual(before);
  });

  it('refreshes request-bound assignment policy and DoD through the transaction executor', async () => {
    const f = await fixture(), actions = issuePatchActions(db, heartbeatService(db));
    let validatedExecutor: unknown;
    const input = context(f, { status: 'todo' });
    input.validate = async executor => { validatedExecutor = executor; };
    const plan = await actions.prepare(input);
    expect(validatedExecutor).toBe(db);
    await db.insert(featureFlags).values({ companyId: f.company.id, flagKey: 'dod_guard_enabled', enabled: true });
    const before = await snapshot(f);
    await expect(actions.accept(plan.context)).rejects.toMatchObject({ status: 422, body: expect.objectContaining({ code: 'DOD_REQUIRED' }) });
    expect(validatedExecutor).not.toBe(db);
    expect(await snapshot(f)).toEqual(before);
  });

  it('preserves company-scoped UUID assignee normalization refusal', async () => {
    const f = await fixture(), foreign = await fixture();
    // Assignment grant is present so the canonical resolver's 404 is observable.
    await db.update(companyMemberships).set({ membershipRole: 'owner' }).where(eq(companyMemberships.companyId, f.company.id));
    const before = await snapshot(f);
    const response = await patch(f, { assigneeAgentId: foreign.agent.id, comment: 'Refused cross-company assignment', interrupt: true });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'Agent not found' });
    expect(await snapshot(f)).toEqual(before);
  });

  it('prepared title edit tolerates unrelated comment recency and description changes', async () => {
    const f = await fixture(), actions = issuePatchActions(db, heartbeatService(db));
    await db.insert(issues).values({ companyId: f.company.id, title: 'Retained reference', identifier: 'KEEP-123' });
    await db.update(issues).set({ description: 'See KEEP-123' }).where(eq(issues.id, f.issue.id));
    const plan = await actions.prepare(context(f, { title: 'Prepared title' }));
    await issueService(db).addComment(f.issue.id, 'Unrelated recency', { userId: f.userId });
    await db.update(issues).set({ description: 'Unrelated prose before KEEP-123' }).where(eq(issues.id, f.issue.id));
    const accepted = await actions.accept({ ...plan.context, expectedSnapshot: plan.snapshot });
    expect(accepted.issue.title).toBe('Prepared title');
  });

  async function goalFixture() {
    const f = await fixture();
    const [first, second] = await db.insert(goals).values([
      { companyId: f.company.id, title: 'First', level: 'company', status: 'active', createdAt: new Date('2025-01-01') },
      { companyId: f.company.id, title: 'Second', level: 'company', status: 'active', createdAt: new Date('2025-02-01') },
    ]).returning();
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: 'Fallback project', goalId: first.id }).returning();
    return { ...f, first, second, project };
  }

  it.each(['project', 'company'] as const)('pins the effective %s fallback goal before acceptance', async source => {
    const f = await goalFixture(), actions = issuePatchActions(db, heartbeatService(db));
    const plan = await actions.prepare(context(f, { projectId: source === 'project' ? f.project.id : null, goalId: null }));
    if (source === 'project') await db.update(projects).set({ goalId: f.second.id }).where(eq(projects.id, f.project.id));
    else await db.update(goals).set({ status: 'cancelled' }).where(eq(goals.id, f.first.id));
    const before = await snapshot(f);
    await expect(actions.accept({ ...plan.context, expectedSnapshot: plan.snapshot })).rejects.toThrow('Issue changed');
    expect(await snapshot(f)).toEqual(before);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it('prepares and accepts the same effective fallback without pinning irrelevant goal content', async () => {
    const f = await goalFixture(), actions = issuePatchActions(db, heartbeatService(db));
    const plan = await actions.prepare(context(f, { projectId: f.project.id, goalId: null }));
    expect(plan.domain.patch.goalId).toBe(f.first.id);
    await db.update(goals).set({ title: 'Unrelated goal title' }).where(eq(goals.id, f.first.id));
    const accepted = await actions.accept({ ...plan.context, expectedSnapshot: plan.snapshot });
    expect(accepted.issue.goalId).toBe(plan.domain.patch.goalId);
  });

  it('an explicit goal does not depend on unused project and company fallback choices', async () => {
    const f = await goalFixture(), actions = issuePatchActions(db, heartbeatService(db));
    const plan = await actions.prepare(context(f, { projectId: f.project.id, goalId: f.first.id }));
    await db.update(projects).set({ goalId: f.second.id }).where(eq(projects.id, f.project.id));
    await db.update(goals).set({ status: 'cancelled' }).where(eq(goals.id, f.first.id));
    expect((await actions.accept({ ...plan.context, expectedSnapshot: plan.snapshot })).issue.goalId).toBe(f.first.id);
  });

  it('read-only preparation rejects workforce completion before any checkout attempt', async () => {
    const f = await fixture(), actions = issuePatchActions(db, heartbeatService(db));
    await db.update(agents).set({ adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: f.userId }).where(eq(agents.id, f.agent.id));
    await workforceService(db).enroll(f.company.id, f.agent.id, { templateId: 'marketing-content' }, { userId: f.userId });
    const [old] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'succeeded' }).returning();
    await db.update(issues).set({ status: 'in_progress', checkoutRunId: old.id, executionRunId: old.id }).where(eq(issues.id, f.issue.id));
    const input = { ...context(f, { status: 'done' }), actorKind: 'agent', actor: { actorType: 'agent' as const, actorId: f.agent.id, agentId: f.agent.id, runId: f.run.id } };
    const before = await snapshot(f);
    vi.mocked(publishLiveEvent).mockClear();
    await expect(actions.prepare(input)).rejects.toThrow('Required workforce input');
    await db.execute(sql`CREATE SEQUENCE checkout_attempt_probe`);
    await db.execute(sql`CREATE FUNCTION probe_checkout_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.checkout_run_id IS DISTINCT FROM OLD.checkout_run_id THEN PERFORM nextval('checkout_attempt_probe'); END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER probe_checkout_attempt BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION probe_checkout_attempt()`);
    try {
      await expect(actions.accept(input)).rejects.toThrow('Required workforce input');
      const probe = await db.execute(sql`SELECT is_called FROM checkout_attempt_probe`);
      expect(probe[0].is_called).toBe(false);
      expect(await snapshot(f)).toEqual(before);
      expect(publishLiveEvent).not.toHaveBeenCalled();
      expect(effects.cancel).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`DROP TRIGGER probe_checkout_attempt ON issues`);
      await db.execute(sql`DROP FUNCTION probe_checkout_attempt()`);
      await db.execute(sql`DROP SEQUENCE checkout_attempt_probe`);
    }
  });

  it.each([false, true])('reopening comments pin their derived goal (changed=%s)', async changed => {
    const f = await goalFixture(), actions = issueCommentActions(db, heartbeatService(db));
    await db.update(issues).set({ status: 'done', projectId: f.project.id }).where(eq(issues.id, f.issue.id));
    const input = { ...context(f), intent: { body: 'Reopen with fallback', reopen: true } };
    const plan = await actions.prepare(input);
    if (changed) await db.update(projects).set({ goalId: f.second.id }).where(eq(projects.id, f.project.id));
    const before = await snapshot(f);
    if (changed) {
      await expect(actions.accept({ ...input, expectedSnapshot: plan.snapshot })).rejects.toThrow('Issue changed');
      expect(await snapshot(f)).toEqual(before);
    } else {
      await actions.accept({ ...input, expectedSnapshot: plan.snapshot });
      expect((await snapshot(f)).issue.goalId).toBe(f.first.id);
    }
  });

  it.each(['label', 'self-blocker', 'cycle', 'assignee', 'workspace', 'unassigned-start'] as const)(
    'SELECT-only domain preparation rejects %s without writes', async guard => {
      const f = await fixture(), actions = issuePatchActions(db, heartbeatService(db));
      let intent: IssuePatchContext['intent'];
      if (guard === 'label') intent = { labelIds: [randomUUID()] };
      else if (guard === 'self-blocker') intent = { blockedByIssueIds: [f.issue.id] };
      else if (guard === 'cycle') {
        const [other] = await db.insert(issues).values({ companyId: f.company.id, title: 'Cycle target' }).returning();
        await db.insert(issueRelations).values({ companyId: f.company.id, issueId: f.issue.id, relatedIssueId: other.id, type: 'blocks' });
        intent = { blockedByIssueIds: [other.id] };
      } else if (guard === 'assignee') {
        await db.update(agents).set({ status: 'terminated' }).where(eq(agents.id, f.agent.id));
        intent = { assigneeAgentId: f.agent.id };
      } else if (guard === 'workspace') intent = { projectWorkspaceId: randomUUID() };
      else intent = { status: 'in_progress', assigneeAgentId: null };
      const before = await snapshot(f);
      await expect(db.transaction(async tx => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        return actions.prepare(context(f, intent), tx);
      })).rejects.toMatchObject({ status: guard === 'workspace' ? 404 : guard === 'assignee' ? 409 : 422 });
      expect(await snapshot(f)).toEqual(before);
      expect(publishLiveEvent).not.toHaveBeenCalled();
      expect(effects.cancel).not.toHaveBeenCalled();
    },
  );

  it('domain preparation reads transaction-local fallback state with a SELECT-only executor', async () => {
    const f = await goalFixture(), actions = issuePatchActions(db, heartbeatService(db));
    await expect(db.transaction(async tx => {
      await tx.update(projects).set({ goalId: f.second.id }).where(eq(projects.id, f.project.id));
      const plan = await actions.prepare(context(f, { projectId: f.project.id, goalId: null }), tx);
      expect(plan.domain.patch.goalId).toBe(f.second.id);
      throw new Error('rollback local fallback');
    })).rejects.toThrow('rollback local fallback');
    await db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const plan = await actions.prepare(context(f, { projectId: f.project.id, goalId: null }), tx);
      expect(plan.domain.patch.goalId).toBe(f.first.id);
    });
  });

  it('field-only intent ignores unrelated workflow configuration, DoD and non-reference recency', async () => {
    const f = await fixture(), actions = issuePatchActions(db, heartbeatService(db));
    const plan = await actions.prepare(context(f, { title: 'Prepared independent field' }));
    const policy = normalizeIssueExecutionPolicy({ stages: [{ id: randomUUID(), type: 'review', participants: [{ type: 'user', userId: f.userId }] }] })!;
    await db.update(issues).set({ status: 'todo', description: 'Unrelated prose', executionPolicy: policy,
      definitionOfDone: { items: [{ id: 'irrelevant', text: 'Unrelated DoD' }] }, updatedAt: new Date() }).where(eq(issues.id, f.issue.id));
    expect((await actions.accept({ ...plan.context, expectedSnapshot: plan.snapshot })).issue.title).toBe('Prepared independent field');
  });

  it('body-only comments do not evaluate or apply an unrelated domain update', async () => {
    const f = await goalFixture(), actions = issueCommentActions(db, heartbeatService(db));
    // This imported legacy state would fail the domain's single-assignee guard.
    await db.update(issues).set({ assigneeUserId: f.userId }).where(eq(issues.id, f.issue.id));
    const input = { ...context(f), intent: { body: 'Communication without reopening' } };
    const plan = await actions.prepare(input);
    expect(plan.reopened).toBe(false);
    await db.update(goals).set({ status: 'cancelled' }).where(eq(goals.id, f.first.id));
    await actions.accept({ ...input, expectedSnapshot: plan.snapshot });
    const state = await snapshot(f);
    expect(state.issue.goalId).toBeNull();
    expect(state.comments).toHaveLength(1);
  });

});
