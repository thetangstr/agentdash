import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  activityLog, agents, companies, companyMemberships, createDb, executionWorkspaces,
  goals, heartbeatRuns, instanceSettings, issueComments, issueLabels, issueReferenceMentions,
  issueRelations, issueThreadInteractions, issues, labels, projects, projectWorkspaces, routineRuns, routines,
} from '@paperclipai/db';
import { issueService } from '../services/issues.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { issueReferenceService } from '../services/issue-references.js';
import { routineService } from '../services/routines.js';
import { insertActivity, publishActivity, logActivity, setPluginEventBus, type ActivityPublication } from '../services/activity-log.js';
import { instanceSettingsService, readInstanceGeneralSettings, readInstanceExperimentalSettings } from '../services/instance-settings.js';
import { publishLiveEvent } from '../services/live-events.js';
import type { PluginEventBus } from '../services/plugin-event-bus.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));
vi.mock('../services/heartbeat.js', () => ({ heartbeatService: () => ({ wakeup: () => { throw new Error('Unexpected runtime dispatch'); } }) }));

// Actual PostgreSQL rows and rollback; only publication/runtime boundaries are faked.
describe('issue acceptance DB primitives', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const emit = vi.fn(async () => ({ errors: [] }));
  const rollback = new Error('rollback accepted work');
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('issue-acceptance-primitives-');
    db = createDb(temp.connectionString);
    setPluginEventBus({ emit } as unknown as PluginEventBus);
  }, 20_000);
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture(status = 'in_progress') {
    const [company] = await db.insert(companies).values({ name: 'Primitives', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Worker' }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: 'running' }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: 'Original', status, assigneeAgentId: agent.id, updatedAt: new Date(0) }).returning();
    return { company, agent, run, issue, svc: issueService(db) };
  }
  async function readIssue(id: string) { return (await db.select().from(issues).where(eq(issues.id, id)))[0]; }
  function audit(f: Awaited<ReturnType<typeof fixture>>) {
    return { companyId: f.company.id, actorType: 'user' as const, actorId: 'human', action: 'issue.comment.created', entityType: 'issue', entityId: f.issue.id };
  }

  it('rolls back comment and recency without creating absent settings', async () => {
    const f = await fixture();
    await db.delete(instanceSettings);
    await expect(db.transaction(async tx => {
      const comment = await f.svc.addComment(f.issue.id, 'Accepted text', { userId: 'human' }, tx);
      expect(comment.authorUserId).toBe('human');
      expect(await tx.select().from(instanceSettings)).toEqual([]);
      expect(await tx.select().from(issueComments).where(eq(issueComments.id, comment.id))).toHaveLength(1);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toEqual([]);
    expect(await readIssue(f.issue.id)).toEqual(f.issue);
    expect(await db.select().from(instanceSettings)).toEqual([]);
  });

  it('reads canonical normalized settings without creating or changing the singleton', async () => {
    await db.delete(instanceSettings);
    const defaults = await instanceSettingsService(db).get();
    await db.delete(instanceSettings);
    expect(await readInstanceGeneralSettings(db)).toEqual(defaults.general);
    expect(await readInstanceExperimentalSettings(db)).toEqual(defaults.experimental);
    expect(await db.select().from(instanceSettings)).toEqual([]);

    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true, keyboardShortcuts: true });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true, enableEnvironments: true });
    const configured = await instanceSettingsService(db).get();
    const before = await db.select().from(instanceSettings);
    expect(await readInstanceGeneralSettings(db)).toEqual(configured.general);
    expect(await readInstanceExperimentalSettings(db)).toEqual(configured.experimental);
    expect(await db.select().from(instanceSettings)).toEqual(before);

    await db.update(instanceSettings).set({ general: { censorUsernameInLogs: 'invalid' }, experimental: { enableIsolatedWorkspaces: 'invalid' } });
    const invalid = await db.select().from(instanceSettings);
    expect(await readInstanceGeneralSettings(db)).toEqual(defaults.general);
    expect(await readInstanceExperimentalSettings(db)).toEqual(defaults.experimental);
    expect(await instanceSettingsService(db).getGeneral()).toEqual(defaults.general);
    expect(await instanceSettingsService(db).getExperimental()).toEqual(defaults.experimental);
    expect(await db.select().from(instanceSettings)).toEqual(invalid);
  });

  it('reads actual transaction-local settings and leaves root settings unchanged on rollback', async () => {
    await db.delete(instanceSettings);
    const before = await instanceSettingsService(db).get();
    await expect(db.transaction(async tx => {
      await instanceSettingsService(tx as typeof db).updateGeneral({ censorUsernameInLogs: true });
      await instanceSettingsService(tx as typeof db).updateExperimental({ enableIsolatedWorkspaces: true });
      expect((await readInstanceGeneralSettings(tx)).censorUsernameInLogs).toBe(true);
      expect((await readInstanceExperimentalSettings(tx)).enableIsolatedWorkspaces).toBe(true);
      expect(await readInstanceGeneralSettings(db)).toEqual(before.general);
      expect(await readInstanceExperimentalSettings(db)).toEqual(before.experimental);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await instanceSettingsService(db).get()).toEqual(before);
  });

  it('does not initialize settings for known-missing root update/comment targets', async () => {
    await db.delete(instanceSettings);
    const svc = issueService(db);
    expect(await svc.update(randomUUID(), { title: 'Missing' })).toBeNull();
    expect(await db.select().from(instanceSettings)).toEqual([]);
    await expect(svc.addComment(randomUUID(), 'Missing', { userId: 'human' })).rejects.toThrow('Issue not found');
    expect(await db.select().from(instanceSettings)).toEqual([]);
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps lazy initialization in canonical getters and root primitive wrappers', async () => {
    const f = await fixture();
    const roots = [
      () => instanceSettingsService(db).getGeneral(),
      () => instanceSettingsService(db).getExperimental(),
      () => f.svc.update(f.issue.id, { title: 'Root update' }),
      () => f.svc.addComment(f.issue.id, 'Root comment', { userId: 'human' }),
      () => logActivity(db, audit(f)),
    ];
    for (const root of roots) {
      await db.delete(instanceSettings);
      await root();
      expect(await db.select().from(instanceSettings)).toHaveLength(1);
    }
    expect((await readIssue(f.issue.id)).title).toBe('Root update');
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toHaveLength(1);
    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
  });

  it.each(['update', 'activity'] as const)('avoids settings/issue lock inversion for prelocked %s acceptance', async operation => {
    const f = await fixture();
    await db.delete(instanceSettings);
    let settingsReady!: () => void;
    const settingsGate = new Promise<void>(resolve => { settingsReady = resolve; });
    let issueReady!: () => void;
    const issueGate = new Promise<void>(resolve => { issueReady = resolve; });
    const backendIds: number[] = [];
    let publication: ActivityPublication | undefined;
    const body = `Evidence at ${os.homedir()}/work`;

    // A owns the actual singleton initialization lock, then needs the issue.
    const comment = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '6s'`);
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      backendIds.push(Number(backend.pid));
      await instanceSettingsService(tx as typeof db).updateGeneral({ censorUsernameInLogs: true });
      settingsReady();
      await issueGate;
      return f.svc.addComment(f.issue.id, body, { agentId: f.agent.id, runId: f.run.id }, tx);
    });
    // B already owns the issue before entering any primitive. A local helper
    // lock reorder cannot fix this supported caller-owned transaction path.
    const accepted = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '6s'`);
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      backendIds.push(Number(backend.pid));
      await settingsGate;
      await tx.select().from(issues).where(eq(issues.id, f.issue.id)).for('update');
      issueReady();
      if (operation === 'activity') {
        publication = await insertActivity(tx, { ...audit(f), details: { accessToken: 'secret-value', path: body } });
      }
      const updated = await f.svc.update(f.issue.id, { title: `Accepted ${operation}`, executionWorkspaceId: randomUUID() }, tx);
      // A's uncommitted settings are invisible here: defaults disable isolated
      // workspaces, and reads must not create another singleton or wait on A.
      expect(updated?.executionWorkspaceId).toBeNull();
      expect(await tx.select().from(instanceSettings)).toEqual([]);
      return updated;
    });
    const results = await Promise.allSettled([comment, accepted]);
    expect(new Set(backendIds).size).toBe(2);
    expect(results.map(result => {
      if (result.status === 'fulfilled') return { status: result.status };
      const error = result.reason as { code?: string; cause?: { code?: string; message?: string }; message?: string };
      return { status: result.status, code: error.code ?? error.cause?.code, message: error.cause?.message ?? error.message };
    })).toEqual([{ status: 'fulfilled' }, { status: 'fulfilled' }]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorAgentId: f.agent.id, authorUserId: null, createdByRunId: f.run.id });
    expect(comments[0].body).not.toContain(os.homedir());
    expect((await readIssue(f.issue.id)).title).toBe(`Accepted ${operation}`);
    expect((await instanceSettingsService(db).getGeneral()).censorUsernameInLogs).toBe(true);
    const audits = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
    expect(audits).toHaveLength(operation === 'activity' ? 1 : 0);
    if (operation === 'activity') {
      // B used normalized missing-row defaults, not A's uncommitted settings.
      expect(audits[0]).toMatchObject({ origin: 'server', actorType: 'user', actorId: 'human', entityId: f.issue.id });
      expect(audits[0].details?.path).toBe(body);
      expect(audits[0].details?.accessToken).not.toBe('secret-value');
      expect(publication?.liveEvent.payload?.details).toEqual(audits[0].details);
    }
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('preserves root and transaction comment attribution and username redaction', async () => {
    const f = await fixture();
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    const body = `Evidence at ${os.homedir()}/work`;
    const root = await f.svc.addComment(f.issue.id, body, { agentId: f.agent.id, runId: f.run.id });
    const composed = await db.transaction(tx => f.svc.addComment(f.issue.id, body, { agentId: f.agent.id, runId: f.run.id }, tx));
    for (const comment of [root, composed]) {
      expect(comment).toMatchObject({ authorAgentId: f.agent.id, authorUserId: null, createdByRunId: f.run.id, companyId: f.company.id, issueId: f.issue.id });
      expect(comment.body).not.toContain(os.homedir());
      expect((await db.select().from(issueComments).where(eq(issueComments.id, comment.id)))[0]).toEqual(comment);
    }
    expect((await readIssue(f.issue.id)).updatedAt.getTime()).toBeGreaterThan(f.issue.updatedAt.getTime());
    await expect(f.svc.addComment(randomUUID(), 'Missing', {})).rejects.toThrow('Issue not found');
  });

  it('uses transaction-local assignees, workspaces, defaults and labels for update', async () => {
    const f = await fixture();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await expect(db.transaction(async tx => {
      const [agent] = await tx.insert(agents).values({ companyId: f.company.id, name: 'New worker' }).returning();
      const [goal] = await tx.insert(goals).values({ companyId: f.company.id, title: 'Local goal' }).returning();
      const [project] = await tx.insert(projects).values({ companyId: f.company.id, name: 'Local project', goalId: goal.id }).returning();
      const [workspace] = await tx.insert(projectWorkspaces).values({ companyId: f.company.id, projectId: project.id, name: 'Local workspace' }).returning();
      const [execution] = await tx.insert(executionWorkspaces).values({ companyId: f.company.id, projectId: project.id, name: 'Local execution', mode: 'isolated', strategyType: 'git_worktree' }).returning();
      const [label] = await tx.insert(labels).values({ companyId: f.company.id, name: 'Local label', color: '#000000' }).returning();
      const updated = await f.svc.update(f.issue.id, { assigneeAgentId: agent.id, projectId: project.id, projectWorkspaceId: workspace.id, executionWorkspaceId: execution.id, labelIds: [label.id] }, tx);
      expect(updated).toMatchObject({ assigneeAgentId: agent.id, projectId: project.id, goalId: goal.id, projectWorkspaceId: workspace.id, executionWorkspaceId: execution.id, labelIds: [label.id] });
      await tx.insert(companyMemberships).values({ companyId: f.company.id, principalType: 'user', principalId: 'transaction-human', status: 'active' });
      expect(await f.svc.update(f.issue.id, { assigneeAgentId: null, assigneeUserId: 'transaction-human' }, tx)).toMatchObject({ assigneeUserId: 'transaction-human' });
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await readIssue(f.issue.id)).toEqual(f.issue);
    expect(await db.select().from(issueLabels).where(eq(issueLabels.issueId, f.issue.id))).toEqual([]);
  });

  it('expires confirmations and touches recency only on the supplied executor', async () => {
    const f = await fixture();
    const [confirmation] = await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id, kind: 'request_confirmation', payload: { version: 1, prompt: 'Proceed?', supersedeOnUserComment: true } }).returning();
    await expect(db.transaction(async tx => {
      const expired = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(f.issue, { id: randomUUID(), authorUserId: 'human' }, { userId: 'human' }, tx);
      expect(expired).toHaveLength(1);
      expect(expired[0].status).toBe('expired');
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, confirmation.id)))[0]).toEqual(confirmation);
    expect(await readIssue(f.issue.id)).toEqual(f.issue);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it('rolls back routine status bookkeeping and reads the transaction-local issue status', async () => {
    const f = await fixture('done');
    const [routine] = await db.insert(routines).values({ companyId: f.company.id, title: 'Routine' }).returning();
    const [run] = await db.insert(routineRuns).values({ companyId: f.company.id, routineId: routine.id, source: 'manual', status: 'running' }).returning();
    await db.update(issues).set({ originKind: 'routine_execution', originRunId: run.id }).where(eq(issues.id, f.issue.id));
    await expect(db.transaction(async tx => {
      const result = await routineService(db).syncRunStatusForIssue(f.issue.id, tx);
      expect(result?.status).toBe('completed');
      await tx.update(issues).set({ status: 'blocked' }).where(eq(issues.id, f.issue.id));
      expect(await routineService(db).syncRunStatusForIssue(f.issue.id, tx)).toMatchObject({ status: 'failed', failureReason: 'Execution issue moved to blocked' });
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, run.id)))[0]).toEqual(run);
  });

  it('rolls back the composed DB rows and projections on a late label validation failure', async () => {
    const f = await fixture();
    const [target] = await db.insert(issues).values({ companyId: f.company.id, title: 'Reference target', identifier: 'PRIM-17' }).returning();
    const [confirmation] = await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id, kind: 'request_confirmation', payload: { version: 1, prompt: 'Proceed?', supersedeOnUserComment: true } }).returning();
    const [routine] = await db.insert(routines).values({ companyId: f.company.id, title: 'Routine' }).returning();
    const [run] = await db.insert(routineRuns).values({ companyId: f.company.id, routineId: routine.id, source: 'manual', status: 'running' }).returning();
    await db.update(issues).set({ originKind: 'routine_execution', originRunId: run.id }).where(eq(issues.id, f.issue.id));
    const before = await readIssue(f.issue.id);
    const refs = issueReferenceService(db);
    const publications: ActivityPublication[] = [];
    await expect(db.transaction(async tx => {
      expect((await refs.listIssueReferenceSummary(f.issue.id, tx)).outbound).toEqual([]);
      const comment = await f.svc.addComment(f.issue.id, 'See PRIM-17', { userId: 'human' }, tx);
      await refs.syncComment(comment.id, tx);
      await f.svc.update(f.issue.id, { status: 'done', description: 'PRIM-17', blockedByIssueIds: [target.id] }, tx);
      await refs.syncIssue(f.issue.id, tx);
      expect((await refs.listIssueReferenceSummary(f.issue.id, tx)).outbound[0]).toMatchObject({ issue: { id: target.id }, mentionCount: 2 });
      const expired = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(f.issue, comment, { userId: 'human' }, tx);
      expect(expired).toHaveLength(1);
      publications.push(await insertActivity(tx, audit(f)));
      expect((await routineService(db).syncRunStatusForIssue(f.issue.id, tx))?.status).toBe('completed');
      // Label validation runs after the issue UPDATE, forcing a genuine late failure.
      await f.svc.update(f.issue.id, { title: 'Never persisted', labelIds: [randomUUID()] }, tx);
    })).rejects.toThrow('One or more labels');
    expect(publications).toHaveLength(1);
    expect(await readIssue(f.issue.id)).toEqual(before);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toEqual([]);
    expect(await db.select().from(issueReferenceMentions).where(eq(issueReferenceMentions.sourceIssueId, f.issue.id))).toEqual([]);
    expect(await db.select().from(issueRelations).where(eq(issueRelations.issueId, f.issue.id))).toEqual([]);
    expect((await refs.listIssueReferenceSummary(f.issue.id)).outbound).toEqual([]);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, confirmation.id)))[0]).toEqual(confirmation);
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, run.id)))[0]).toEqual(run);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps root update atomic on late validation, preserves missing null and transaction status guards', async () => {
    const f = await fixture();
    await expect(f.svc.update(f.issue.id, { title: 'Rejected', labelIds: [randomUUID()] })).rejects.toThrow('One or more labels');
    expect(await readIssue(f.issue.id)).toEqual(f.issue);
    expect(await f.svc.update(randomUUID(), { title: 'Absent' })).toBeNull();
    await expect(db.transaction(async tx => {
      await tx.update(issues).set({ status: 'done', assigneeAgentId: null }).where(eq(issues.id, f.issue.id));
      await f.svc.update(f.issue.id, { status: 'in_progress' }, tx);
    })).rejects.toThrow('in_progress issues require an assignee');
    expect(await readIssue(f.issue.id)).toEqual(f.issue);
  });

  it('preserves compatibility stale/unowned adoption, cleanup and ownership conflicts', async () => {
    const f = await fixture();
    const [old] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'failed' }).returning();
    await db.update(issues).set({ checkoutRunId: old.id, executionRunId: old.id }).where(eq(issues.id, f.issue.id));
    expect(await f.svc.assertCheckoutOwner(f.issue.id, f.agent.id, f.run.id)).toMatchObject({ adoptedFromRunId: old.id, checkoutRunId: f.run.id, executionRunId: f.run.id });
    await expect(f.svc.assertCheckoutOwner(f.issue.id, f.agent.id, old.id)).rejects.toThrow('Issue run ownership conflict');
    await db.update(issues).set({ checkoutRunId: null, executionRunId: old.id }).where(eq(issues.id, f.issue.id));
    expect(await f.svc.assertCheckoutOwner(f.issue.id, f.agent.id, f.run.id)).toMatchObject({ adoptedFromRunId: null, checkoutRunId: f.run.id, executionRunId: f.run.id });
    await db.update(issues).set({ executionRunId: old.id }).where(eq(issues.id, f.issue.id));
    await expect(f.svc.assertCheckoutOwner(f.issue.id, randomUUID(), f.run.id)).rejects.toThrow('Issue run ownership conflict');
    expect((await readIssue(f.issue.id)).executionRunId).toBeNull();
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
  });

  it('evaluates terminal cleanup and stale adoption without mutations, then applies once', async () => {
    const f = await fixture();
    const [old] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'succeeded' }).returning();
    await db.update(issues).set({ checkoutRunId: old.id, executionRunId: old.id }).where(eq(issues.id, f.issue.id));
    const before = await readIssue(f.issue.id);
    const check = await f.svc.evaluateCheckoutOwner(f.issue.id, f.agent.id, f.run.id);
    expect(check).toMatchObject({ current: { checkoutRunId: old.id, executionRunId: old.id }, clearExecutionRunId: old.id, adoptedFromRunId: old.id, adopt: true });
    expect(await readIssue(f.issue.id)).toEqual(before);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
    await expect(db.transaction(async tx => {
      expect(await f.svc.applyCheckoutOwner(check, tx)).toMatchObject({ checkoutRunId: f.run.id, executionRunId: f.run.id, adoptedFromRunId: old.id });
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await readIssue(f.issue.id)).toEqual(before);
    await db.transaction(tx => f.svc.applyCheckoutOwner(check, tx));
    const accepted = await readIssue(f.issue.id);
    const repeated = await f.svc.evaluateCheckoutOwner(f.issue.id, f.agent.id, f.run.id);
    await db.transaction(tx => f.svc.applyCheckoutOwner(repeated, tx));
    expect(await readIssue(f.issue.id)).toEqual(accepted);
    expect(await f.svc.assertCheckoutOwner(f.issue.id, f.agent.id, f.run.id)).toMatchObject({ adoptedFromRunId: null, checkoutRunId: f.run.id });
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('leaves terminal cleanup untouched on pure ownership refusal and rechecks accepted plans', async () => {
    const f = await fixture();
    const [old] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: 'failed' }).returning();
    await db.update(issues).set({ executionRunId: old.id }).where(eq(issues.id, f.issue.id));
    const before = await readIssue(f.issue.id);
    await expect(f.svc.evaluateCheckoutOwner(f.issue.id, randomUUID(), f.run.id)).rejects.toThrow('Issue run ownership conflict');
    expect(await readIssue(f.issue.id)).toEqual(before);
    const check = await f.svc.evaluateCheckoutOwner(f.issue.id, f.agent.id, f.run.id);
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
    await expect(db.transaction(tx => f.svc.applyCheckoutOwner(check, tx))).rejects.toThrow('Issue run ownership conflict');
    expect((await readIssue(f.issue.id)).executionRunId).toBe(old.id);
  });

  it('inserts sanitized audit without publication until explicit postcommit publish; rollback discards it', async () => {
    const f = await fixture();
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    const input = { ...audit(f), details: { accessToken: 'secret-value', path: `${os.homedir()}/work`, safe: 'kept' } };
    let discarded: ActivityPublication | undefined;
    await expect(db.transaction(async tx => {
      discarded = await insertActivity(tx, input);
      expect(await tx.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toHaveLength(1);
      expect(publishLiveEvent).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      throw rollback;
    })).rejects.toBe(rollback);
    expect(discarded).toBeDefined();
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    const publication = await db.transaction(tx => insertActivity(tx, input));
    const [row] = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
    expect(row.origin).toBe('server');
    expect(row.details?.accessToken).not.toBe('secret-value');
    expect(row.details?.path).not.toContain(os.homedir());
    expect(row.details?.safe).toBe('kept');
    expect(publishLiveEvent).not.toHaveBeenCalled();
    publishActivity(publication);
    expect(publishLiveEvent).toHaveBeenCalledWith({ companyId: f.company.id, type: 'activity.logged', payload: { actorType: input.actorType, actorId: input.actorId, action: input.action, entityType: 'issue', entityId: f.issue.id, agentId: null, runId: null, details: row.details } });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'issue.comment.created', companyId: f.company.id, payload: { ...row.details, agentId: null, runId: null } }));
    await logActivity(db, audit(f));
    expect(publishLiveEvent).toHaveBeenCalledTimes(2);
  });
});
