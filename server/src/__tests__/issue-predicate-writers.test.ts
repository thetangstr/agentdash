import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { companies, createDb, goals, issues, issueRelations, issueThreadInteractions, issueTreeHolds, assistantConversations, cosOnboardingStates, agents, activityLog } from '@paperclipai/db';
import { publishLiveEvent } from '../services/live-events.js';
import { type ActivityPublication } from '../services/activity-log.js';
import { documentService } from '../services/documents.js';
import { issueService } from '../services/issues.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { issueTreeControlService } from '../services/issue-tree-control.js';
import { featureFlagsService } from '../services/feature-flags.js';
import { goalService } from '../services/goals.js';
import { materializeOnboardingGoals } from '../services/materialize-onboarding-goals.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));

function gate() { let open!: () => void; const promise = new Promise<void>(r => { open = r; }); return { promise, open }; }
const question = { kind: 'ask_user_questions' as const, continuationPolicy: 'none' as const, payload: { version: 1 as const, questions: [{ id: 'answer', prompt: 'What next?', selectionMode: 'text' as const, required: true, options: [] }] } };
const confirmation = { kind: 'request_confirmation' as const, continuationPolicy: 'none' as const, payload: { version: 1 as const, prompt: 'Proceed?', supersedeOnUserComment: true } };
const actor = { actorType: 'user' as const, actorId: 'human', userId: 'human' };

describe('participating predicate writers on real PostgreSQL', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('predicate-writers-'); db = createDb(temp.connectionString); }, 20000);
  afterAll(async () => { await temp?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Predicate', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [issue, blocker] = await db.insert(issues).values(['Target', 'Blocker'].map(title => ({ companyId: company.id, title, status: 'backlog' }))).returning();
    return { company, issue, blocker };
  }

  // NO KEY UPDATE deliberately permits FK KEY SHARE. A plain INSERT with a
  // company FK is not evidence that the predicate writer joined the mutex.
  async function mustWait(companyId: string, run: () => Promise<unknown>, label: string) {
    const locked = gate(), release = gate(); let ownerPid = 0, settled = false;
    const owner = db.transaction(async tx => {
      ownerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
      await tx.select().from(companies).where(eq(companies.id, companyId)).for('no key update');
      locked.open(); await release.promise;
    });
    await locked.promise;
    const writer = run().finally(() => { settled = true; });
    // pg_stat_activity reports whatever statement a blocked backend is running
    // when sampled, and more than one backend can be queued behind the owner —
    // asserting on rows[0] of a single sample races that ordering and flaked
    // on a non-mutex statement. Collect every blocked backend and every
    // statement observed across the wait window instead.
    const blockedStatements = new Map<number, Set<string>>();
    try {
      const capturedQueries = () => [...blockedStatements.values()].flatMap(statements => [...statements]);
      const until = Date.now() + 3000;
      while (!settled && Date.now() < until) {
        const rows = await db.execute(sql`select pid, query, pg_blocking_pids(pid) blockers from pg_stat_activity where ${ownerPid} = any(pg_blocking_pids(pid))`);
        for (const row of rows) {
          const pid = Number(row.pid);
          if (pid === ownerPid) continue;
          const statements = blockedStatements.get(pid) ?? new Set<string>();
          statements.add(String(row.query));
          blockedStatements.set(pid, statements);
        }
        if (capturedQueries().some(query => /companies.*for (?:no key )?update/i.test(query))) break;
        await new Promise(resolve => setImmediate(resolve));
      }
      const captured = capturedQueries();
      expect(blockedStatements.size, `${label} must wait at company mutex before predicates/writes; settled=${settled}`).toBeGreaterThan(0);
      expect(
        captured.some(query => /companies.*for (?:no key )?update/i.test(query)),
        `${label} captured no companies FOR UPDATE among blocked statements: ${captured.join(' | ')}`,
      ).toBe(true);
      console.log(JSON.stringify({ label, ownerPid, writerPids: [...blockedStatements.keys()], captured }));
    } finally { release.open(); await owner; await writer; }
  }

  it.each(['goal-create', 'goal-update', 'goal-remove', 'dod-insert', 'blocks-add', 'blocks-clear', 'question-create', 'question-cancel', 'question-answer', 'question-replace', 'confirmation-create', 'confirmation-accept', 'confirmation-reject', 'confirmation-comment-expiry', 'hold-create', 'hold-release', 'materialize'] as const)('%s waits before accepted predicate changes', async kind => {
    const f = await fixture(); const svc = issueThreadInteractionService(db);
    let run: () => Promise<unknown>;
    if (kind.startsWith('goal')) {
      const existing = kind === 'goal-create' ? null : await goalService(db).create(f.company.id, { title: 'Old', level: 'company' });
      run = () => kind === 'goal-create' ? goalService(db).create(f.company.id, { title: 'First', level: 'company' }) : kind === 'goal-update' ? goalService(db).update(existing!.id, { status: 'active' }) : goalService(db).remove(existing!.id);
    } else if (kind === 'dod-insert') run = () => featureFlagsService(db).set(f.company.id, 'dod_guard_enabled', true);
    else if (kind.startsWith('blocks')) {
      if (kind === 'blocks-clear') await db.insert(issueRelations).values({ companyId: f.company.id, issueId: f.blocker.id, relatedIssueId: f.issue.id, type: 'blocks' });
      run = () => issueService(db).update(f.issue.id, { blockedByIssueIds: kind === 'blocks-clear' ? [] : [f.blocker.id] });
    } else if (kind.startsWith('question')) {
      const q = kind === 'question-create' ? null : await svc.create(f.issue, question, actor);
      if (kind === 'question-replace') await svc.cancelQuestions(f.issue, q!.id, {}, actor);
      run = () => kind === 'question-create' ? svc.create(f.issue, question, actor) : kind === 'question-cancel' ? svc.cancelQuestions(f.issue, q!.id, {}, actor) : kind === 'question-answer' ? svc.answerQuestions(f.issue, q!.id, { answers: [{ questionId: 'answer', optionIds: [], text: 'Proceed' }] }, actor) : svc.create(f.issue, { ...question, payload: { ...question.payload, replacesInteractionId: q!.id } }, actor);
    } else if (kind.startsWith('confirmation')) {
      const c = kind === 'confirmation-create' ? null : await svc.create(f.issue, confirmation, actor);
      run = () => kind === 'confirmation-create' ? svc.create(f.issue, confirmation, actor) : kind === 'confirmation-accept' ? svc.acceptInteraction(f.issue, c!.id, {}, actor) : kind === 'confirmation-reject' ? svc.rejectInteraction(f.issue, c!.id, {}, actor) : svc.expireRequestConfirmationsSupersededByComment(f.issue, { id: randomUUID(), authorUserId: 'human' }, actor);
    } else if (kind.startsWith('hold')) {
      const tree = issueTreeControlService(db);
      const hold = kind === 'hold-create' ? null : await tree.createHold(f.company.id, f.issue.id, { mode: 'pause', actor });
      run = () => kind === 'hold-create' ? tree.createHold(f.company.id, f.issue.id, { mode: 'pause', actor }) : tree.releaseHold(f.company.id, f.issue.id, hold!.hold.id, { actor });
    } else {
      const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'CoS' }).returning();
      const [conversation] = await db.insert(assistantConversations).values({ companyId: f.company.id, userId: 'human' }).returning();
      await db.insert(cosOnboardingStates).values({ conversationId: conversation.id, goals: { longTerm: 'First company goal' } });
      run = () => materializeOnboardingGoals({ db })({ companyId: f.company.id, conversationId: conversation.id, ownerAgentId: agent.id });
    }
    await mustWait(f.company.id, run, kind);
    // The committed writer result is visible through another root connection.
    if (kind === 'blocks-add' || kind === 'blocks-clear') expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, f.issue.id))).toHaveLength(kind === 'blocks-add' ? 1 : 0);
    if (kind === 'confirmation-accept' || kind === 'confirmation-reject' || kind === 'confirmation-comment-expiry') expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issue.id)))[0].status).toBe(kind === 'confirmation-accept' ? 'accepted' : kind === 'confirmation-reject' ? 'rejected' : 'expired');
    if (kind === 'materialize') expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toHaveLength(1);
  });
  it.each(['create', 'revise', 'restore', 'delete'] as const)('document %s participates before changing confirmation targets', async operation => {
    const f = await fixture(), docs = documentService(db);
    const first = operation === 'create' ? null : await docs.upsertIssueDocument({ issueId: f.issue.id, key: 'plan', format: 'markdown', body: 'First' });
    if (operation === 'restore') await docs.upsertIssueDocument({ issueId: f.issue.id, key: 'plan', format: 'markdown', body: 'Second', baseRevisionId: first!.document.latestRevisionId });
    await mustWait(f.company.id, () => operation === 'delete' ? docs.deleteIssueDocument(f.issue.id, 'plan') : operation === 'restore' ? docs.restoreIssueDocumentRevision({ issueId: f.issue.id, key: 'plan', revisionId: first!.document.latestRevisionId! }) : docs.upsertIssueDocument({ issueId: f.issue.id, key: 'plan', format: 'markdown', body: 'New', baseRevisionId: first?.document.latestRevisionId }), `document-${operation}`);
  });

  it('an obsolete document completion does not expire a confirmation on the current revision', async () => {
    const f = await fixture(), docs = documentService(db), svc = issueThreadInteractionService(db);
    const first = await docs.upsertIssueDocument({ issueId: f.issue.id, key: 'plan', format: 'markdown', body: 'First' });
    const second = await docs.upsertIssueDocument({ issueId: f.issue.id, key: 'plan', format: 'markdown', body: 'Second', baseRevisionId: first.document.latestRevisionId });
    const c = await svc.create(f.issue, { ...confirmation, payload: { ...confirmation.payload, target: { type: 'issue_document', issueId: f.issue.id, documentId: second.document.id, key: 'plan', revisionId: second.document.latestRevisionId!, revisionNumber: 2 } } }, actor);
    expect(await svc.expireStaleRequestConfirmationsForIssueDocument(f.issue, first.document, actor)).toEqual([]);
    expect((await svc.getById(c.id))?.status).toBe('pending');
    await docs.deleteIssueDocument(f.issue.id, 'plan');
    const accepted = await svc.acceptInteraction(f.issue, c.id, {}, actor);
    expect(accepted.interaction).toMatchObject({ status: 'expired', result: { outcome: 'stale_target' } });
    expect(accepted.continuationIssue).toBeNull();
  });

  it.each(['success', 'rollback', 'unknown-ack', 'publication-failure'] as const)('materialization root %s retains actual commit publication boundary', async outcome => {
    const f = await fixture();
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'CoS' }).returning();
    const [conversation] = await db.insert(assistantConversations).values({ companyId: f.company.id, userId: 'human' }).returning();
    await db.insert(cosOnboardingStates).values({ conversationId: conversation.id, goals: { longTerm: 'Long goal', shortTerm: 'Short goal' } });
    vi.mocked(publishLiveEvent).mockReset();
    const input = { companyId: f.company.id, conversationId: conversation.id, ownerAgentId: agent.id };
    const root = new Proxy(db, { get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return async (callback: (tx: unknown) => Promise<unknown>) => {
        const result = await target.transaction(async tx => {
          const value = await callback(tx);
          expect(await tx.select().from(goals).where(eq(goals.companyId, f.company.id))).toHaveLength(2);
          expect(await tx.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toHaveLength(2);
          expect(await db.select().from(goals).where(eq(goals.companyId, f.company.id))).toEqual([]);
          expect(publishLiveEvent).not.toHaveBeenCalled();
          if (outcome === 'rollback') throw new Error('after staged audit rollback');
          return value;
        });
        if (outcome === 'unknown-ack') throw new Error('unknown commit acknowledgement');
        return result;
      };
    } });
    if (outcome === 'publication-failure') vi.mocked(publishLiveEvent).mockImplementation(() => { throw new Error('publication unavailable'); });
    try {
      const operation = materializeOnboardingGoals({ db: root })(input);
      if (outcome === 'success') await operation;
      else await expect(operation).rejects.toThrow(outcome === 'rollback' ? 'after staged audit' : outcome === 'unknown-ack' ? 'unknown commit' : 'publication unavailable');
      const committed = outcome === 'rollback' ? 0 : 2;
      expect(await db.select().from(goals).where(eq(goals.companyId, f.company.id))).toHaveLength(committed);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toHaveLength(committed);
      expect(publishLiveEvent).toHaveBeenCalledTimes(outcome === 'success' ? 2 : outcome === 'publication-failure' ? 1 : 0);
    } finally { vi.mocked(publishLiveEvent).mockReset(); }
  });

  it('materialization supplied acceptance writes only on the actual outer executor and never flushes a savepoint', async () => {
    const f = await fixture();
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'CoS' }).returning();
    const [conversation] = await db.insert(assistantConversations).values({ companyId: f.company.id, userId: 'human' }).returning();
    await db.insert(cosOnboardingStates).values({ conversationId: conversation.id, goals: { longTerm: 'Goal' } });
    const publications: ActivityPublication[] = [];
    vi.mocked(publishLiveEvent).mockReset();
    await expect(db.transaction(async tx => {
      await materializeOnboardingGoals({ db })({ companyId: f.company.id, conversationId: conversation.id, ownerAgentId: agent.id }, { executor: tx as typeof db, publications });
      expect(await tx.select().from(goals).where(eq(goals.companyId, f.company.id))).toHaveLength(1);
      expect(await db.select().from(goals).where(eq(goals.companyId, f.company.id))).toEqual([]);
      expect(publishLiveEvent).not.toHaveBeenCalled();
      throw new Error('caller rollback');
    })).rejects.toThrow('caller rollback');
    expect(await db.select().from(goals).where(eq(goals.companyId, f.company.id))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it.each(['target-first', 'blocker-first'] as const)('opposite new block edges cannot commit a cycle (%s)', async order => {
    const f = await fixture(), ready = gate(), proceed = gate();
    const first = order === 'target-first' ? f.issue : f.blocker, second = order === 'target-first' ? f.blocker : f.issue;
    let writerPid = 0;
    const one = db.transaction(async tx => {
      writerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
      await issueService(db).update(first.id, { blockedByIssueIds: [second.id] }, tx);
      ready.open(); await proceed.promise;
    });
    await ready.promise;
    const two = issueService(db).update(second.id, { blockedByIssueIds: [first.id] }).then(value => ({ value }), error => ({ error }));
    try {
      let observed: Record<string, unknown> | undefined;
      const until = Date.now() + 3000;
      while (!observed && Date.now() < until) {
        observed = (await db.execute(sql`select pid, query, pg_blocking_pids(pid) blockers from pg_stat_activity where ${writerPid} = any(pg_blocking_pids(pid))`))[0];
        if (!observed) await new Promise(resolve => setImmediate(resolve));
      }
      expect(observed).toBeDefined(); expect(Number(observed!.pid)).not.toBe(writerPid);
      console.log(JSON.stringify({ order, writerPid, observed }));
    } finally { proceed.open(); }
    await one;
    expect(await two).toMatchObject({ error: { status: 422, message: 'Blocking relations cannot contain cycles' } });
    expect(await db.select().from(issueRelations).where(eq(issueRelations.companyId, f.company.id))).toMatchObject([{ issueId: second.id, relatedIssueId: first.id }]);
  });

  it('supplied hold create/release remain on the caller executor and roll back together', async () => {
    const f = await fixture();
    await expect(db.transaction(async tx => {
      const acceptance = { executor: tx as typeof db, publications: [] };
      const hold = await issueTreeControlService(db).createHold(f.company.id, f.issue.id, { mode: 'pause', actor }, acceptance);
      expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, f.company.id))).toEqual([]);
      const released = await issueTreeControlService(db).releaseHold(f.company.id, f.issue.id, hold.hold.id, { actor }, acceptance);
      expect(released.status).toBe('released');
      throw new Error('outer hold rollback');
    })).rejects.toThrow('outer hold rollback');
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, f.company.id))).toEqual([]);
  });

  it('supplied restore refreshes current cancelled status and rolls back status and hold releases', async () => {
    const f = await fixture(), svc = issueTreeControlService(db);
    const cancel = await svc.createHold(f.company.id, f.issue.id, { mode: 'cancel', actor });
    await db.update(issues).set({ status: 'cancelled' }).where(eq(issues.id, f.issue.id));
    const restore = await svc.createHold(f.company.id, f.issue.id, { mode: 'restore', actor });
    await expect(db.transaction(async tx => {
      const result = await svc.restoreIssueStatusesForHold(f.company.id, f.issue.id, restore.hold.id, { actor }, { executor: tx as typeof db, publications: [] });
      expect(result.updatedIssueIds).toContain(f.issue.id);
      expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe('cancelled');
      throw new Error('outer restore rollback');
    })).rejects.toThrow('outer restore rollback');
    expect((await svc.getHold(f.company.id, cancel.hold.id))?.status).toBe('active');
    expect((await svc.getHold(f.company.id, restore.hold.id))?.status).toBe('active');
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe('cancelled');
  });

  it('rejects a supplied goal deletion executor missing delete before reading or writing', async () => {
    const f = await fixture(), goal = await goalService(db).create(f.company.id, { title: 'Keep', level: 'company' });
    const executor = new Proxy(db, { get(target, key, receiver) {
      if (key === 'delete') return undefined;
      if (key === 'select') return () => { throw new Error('Malformed executor must be rejected before reads'); };
      return Reflect.get(target, key, receiver);
    } });
    await expect(goalService(db).remove(goal.id, { executor, publications: [] })).rejects.toThrow('Goal deletion requires a delete-capable executor');
    expect((await goalService(db).getById(goal.id))?.title).toBe('Keep');
  });

  it('goal movement waits on both old and new company candidate sets', async () => {
    const a = await fixture(), b = await fixture();
    const goal = await goalService(db).create(a.company.id, { title: 'Moving candidate', level: 'company' });
    await mustWait(b.company.id, () => goalService(db).update(goal.id, { companyId: b.company.id }), 'goal-new-company');
    expect((await goalService(db).getById(goal.id))?.companyId).toBe(b.company.id);
    await mustWait(b.company.id, () => goalService(db).update(goal.id, { companyId: a.company.id }), 'goal-old-company');
    expect((await goalService(db).getById(goal.id))?.companyId).toBe(a.company.id);
  });

  it('supplied document expiry has no captured-root write escape', async () => {
    const f = await fixture(), docs = documentService(db), svc = issueThreadInteractionService(db);
    const first = await docs.upsertIssueDocument({ issueId: f.issue.id, key: 'plan', format: 'markdown', body: 'First' });
    const c = await svc.create(f.issue, { ...confirmation, payload: { ...confirmation.payload, target: { type: 'issue_document', key: 'plan', revisionId: first.document.latestRevisionId!, documentId: first.document.id } } }, actor);
    const second = await docs.upsertIssueDocument({ issueId: f.issue.id, key: 'plan', format: 'markdown', body: 'Second', baseRevisionId: first.document.latestRevisionId });
    await expect(db.transaction(async tx => {
      const expired = await svc.expireStaleRequestConfirmationsForIssueDocument(f.issue, second.document, actor, { executor: tx as typeof db, publications: [] });
      expect(expired).toMatchObject([{ id: c.id, status: 'expired', result: { outcome: 'stale_target' } }]);
      expect((await svc.getById(c.id))?.status).toBe('pending');
      throw new Error('outer expiry rollback');
    })).rejects.toThrow('outer expiry rollback');
    expect((await svc.getById(c.id))?.status).toBe('pending');
  });

});
