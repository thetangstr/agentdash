import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, companies, companyMemberships, createDb, issues, issueThreadInteractions, projects } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { waitingOnYouService } from '../services/waiting-on-you.js';
import { projectAccess } from '@paperclipai/db';
import { agentService } from '../services/agents.js';
import { heartbeatService } from '../services/heartbeat.js';
import { agentRuns, agentWakeupRequests, heartbeatRuns } from '@paperclipai/db';
import { issueService } from '../services/issues.js';
import { workforceService } from '../services/workforce.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { askUserQuestionsQuestionSchema } from '@paperclipai/shared';

describe('workforce question ownership, input and sharing', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('workforce-questions-'); db = createDb(temp.connectionString); });
  afterAll(async () => { await temp?.cleanup(); });
  async function fixture(project = false) {
    const [company] = await db.insert(companies).values({ name: 'Question test', issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: 'owner', status: 'active', membershipRole: 'owner' });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: 'owner' }).returning();
    const svc = workforceService(db);
    await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, { userId: 'owner' });
    const issue = await svc.startFirstJob(company.id, agent.id, { userId: 'owner' });
    if (project) {
      const [p] = await db.insert(projects).values({ companyId: company.id, name: 'Private project' }).returning();
      await db.update(issues).set({ projectId: p.id }).where(eq(issues.id, issue.id));
    }
    return { company, agent, issue, svc, questions: issueThreadInteractionService(db) };
  }
  const input = (key = 'offer') => ({ kind: 'ask_user_questions' as const, continuationPolicy: 'wake_assignee' as const, payload: { version: 1 as const, questions: [{ id: key, prompt: 'What is the offer?', selectionMode: 'text' as const, required: true, companyFactKey: key, options: [] }] } });
  const answer = (text = '  Private campaign offer  ') => ({ answers: [{ questionId: 'offer', optionIds: [], text }] });
  it('allows empty options only for text questions', () => {
    expect(askUserQuestionsQuestionSchema.safeParse(input().payload.questions[0]).success).toBe(true);
    expect(askUserQuestionsQuestionSchema.safeParse({ ...input().payload.questions[0], selectionMode: 'single' }).success).toBe(false);
    expect(askUserQuestionsQuestionSchema.safeParse({ ...input().payload.questions[0], options: [{ id: 'x', label: 'x' }] }).success).toBe(false);
  });
  it('pins the accountable human and validates trimmed text, combinations and duplicate answers', async () => {
    const { issue, agent, questions } = await fixture();
    const q = await questions.create(issue, input(), { agentId: agent.id });
    expect(q.payload).toMatchObject({ answerOwnerUserId: 'owner' });
    for (const invalid of [answer('  '), { answers: [{ questionId: 'offer', optionIds: ['x'], text: 'Offer' }] }, { answers: [...answer().answers, ...answer().answers] }]) {
      await expect(questions.answerQuestions(issue, q.id, invalid, { userId: 'owner' })).rejects.toMatchObject({ status: 422 });
    }
    await expect(questions.answerQuestions(issue, q.id, answer(), { userId: 'other' })).rejects.toMatchObject({ status: 403 });
    await expect(questions.answerQuestions(issue, q.id, answer(), { agentId: agent.id })).rejects.toMatchObject({ status: 403 });
    const saved = await questions.answerQuestions(issue, q.id, answer(), { userId: 'owner' });
    expect(saved.result).toMatchObject({ answers: [{ questionId: 'offer', optionIds: [], text: 'Private campaign offer' }] });
    await expect(questions.answerQuestions(issue, q.id, answer(), { userId: 'owner' })).rejects.toMatchObject({ status: 409 });
  });
  it('strips an agent-supplied answer owner on a non-workforce issue (review P2)', async () => {
    const { company, questions } = await fixture();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: 'someone-else', status: 'active', membershipRole: 'member' });
    const [plain] = await db.insert(agents).values({ companyId: company.id, name: 'Unenrolled', adapterType: 'codex_local' }).returning();
    const [job] = await db.insert(issues).values({ companyId: company.id, title: 'Ordinary job', status: 'todo', assigneeAgentId: plain.id }).returning();
    const body = { kind: 'ask_user_questions' as const, continuationPolicy: 'wake_assignee' as const,
      payload: { version: 1 as const, answerOwnerUserId: 'someone-else', questions: [{ id: 'q', prompt: 'Which?', selectionMode: 'text' as const, required: true, options: [] }] } };
    const byAgent = await questions.create(job, body, { agentId: plain.id });
    expect(byAgent.payload).not.toHaveProperty('answerOwnerUserId');
    const byHuman = await questions.create(job, body, { userId: 'owner' });
    expect(byHuman.payload).toMatchObject({ answerOwnerUserId: 'someone-else' });
  });
  it('uses an unshared answer only for its own task and readiness', async () => {
    const { company, issue, agent, questions, svc } = await fixture();
    const q = await questions.create(issue, input(), { agentId: agent.id });
    await questions.answerQuestions(issue, q.id, answer(), { userId: 'owner' });
    expect((await svc.getBrief(company.id)).facts).toEqual([]);
    expect((await svc.getReadiness(company.id, agent.id))?.missingFactKeys).not.toContain('offer');
    expect(await svc.getRuntimeContext(company.id, agent.id, issue.id)).toMatchObject({ taskFacts: [{ key: 'offer', value: 'Private campaign offer', issueId: issue.id }] });
    expect(await svc.getRuntimeContext(company.id, agent.id)).toMatchObject({ taskFacts: [] });
    const [other] = await db.insert(issues).values({ companyId: company.id, title: 'Another job', assigneeAgentId: agent.id }).returning();
    expect(await svc.getRuntimeContext(company.id, agent.id, other.id)).toMatchObject({ taskFacts: [] });
  });
  it('atomically publishes explicit company sharing once across concurrent answers and fresh service/new hire', async () => {
    const { company, issue, agent, questions, svc } = await fixture();
    const q = await questions.create(issue, input(), { agentId: agent.id });
    const results = await Promise.allSettled([1, 2].map(() => questions.answerQuestions(issue, q.id, { ...answer(), shareWithCompany: true }, { userId: 'owner' })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(await workforceService(db).getBrief(company.id)).toMatchObject({ revision: 1, confirmedByUserId: 'owner', facts: [{ key: 'offer', value: 'Private campaign offer' }] });
    const [hire] = await db.insert(agents).values({ companyId: company.id, name: 'New hire', adapterType: 'codex_local' }).returning();
    await svc.enroll(company.id, hire.id, { templateId: 'marketing-content' }, { userId: 'owner' });
    expect((await svc.getRuntimeContext(company.id, hire.id))?.brief.facts[0].value).toBe('Private campaign offer');
  });
  it('rejects project sharing atomically but accepts a private task answer', async () => {
    const { company, issue, agent, questions, svc } = await fixture(true);
    const q = await questions.create(issue, input(), { agentId: agent.id });
    await expect(questions.answerQuestions(issue, q.id, { ...answer(), shareWithCompany: true }, { userId: 'owner' })).rejects.toMatchObject({ status: 422 });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, q.id)))[0].status).toBe('pending');
    await questions.answerQuestions(issue, q.id, answer(), { userId: 'owner' });
    expect((await svc.getBrief(company.id)).revision).toBe(0);
  });
  it('rejects unknown keys, peer agents, foreign issues and absent/inactive owners', async () => {
    const { company, issue, agent, questions } = await fixture();
    const other = await fixture();
    await expect(questions.create(issue, input('madeUp'), { agentId: agent.id })).rejects.toMatchObject({ status: 422 });
    await expect(questions.create(issue, input(), { agentId: other.agent.id })).rejects.toMatchObject({ status: 403 });
    await expect(questions.create({ id: other.issue.id, companyId: company.id }, input(), { agentId: agent.id })).rejects.toMatchObject({ status: 404 });
    await db.update(agents).set({ autonomy: 'stewarded', accountableUserId: null }).where(eq(agents.id, agent.id));
    await expect(questions.create(issue, input(), { agentId: agent.id })).rejects.toMatchObject({ status: 409 });
    await db.update(agents).set({ autonomy: 'autonomous', accountableUserId: 'owner' }).where(eq(agents.id, agent.id));
    const q = await questions.create(issue, input(), { agentId: agent.id });
    await db.update(companyMemberships).set({ status: 'inactive' }).where(eq(companyMemberships.companyId, company.id));
    await expect(questions.answerQuestions(issue, q.id, answer(), { userId: 'owner' })).rejects.toMatchObject({ status: 409 });
  });
  it('rejects completion with required inputs and late required questions on closed jobs', async () => {
    const { issue, agent, questions } = await fixture();
    const q = await questions.create(issue, input(), { agentId: agent.id });
    await expect(issueService(db).update(issue.id, { status: 'done' })).rejects.toMatchObject({ status: 409 });
    await questions.answerQuestions(issue, q.id, answer(), { userId: 'owner' });
    await workforceService(db).updateBrief(issue.companyId, { expectedRevision: 0, sources: [], facts: ['audience', 'brandVoice', 'approvedClaims'].map(key => ({ key, value: 'Approved input', sourceReference: 'human' })) }, { userId: 'owner' });
    expect(await issueService(db).update(issue.id, { status: 'done' })).toMatchObject({ status: 'done' });
    await expect(questions.create(issue, input('audience'), { agentId: agent.id })).rejects.toMatchObject({ status: 409 });
  });
  it.each([false, true])('rejects cancelled-to-done with unresolved task input and complete company facts (reassigned: %s)', async (reassigned) => {
    const { company, issue, agent, questions, svc } = await fixture();
    await svc.updateBrief(company.id, { expectedRevision: 0, sources: [], facts: ['offer', 'audience', 'brandVoice', 'approvedClaims'].map(key => ({ key, value: 'Approved input', sourceReference: 'human' })) }, { userId: 'owner' });
    expect((await svc.getReadiness(company.id, agent.id))?.missingFactKeys).toEqual([]);
    const q = await questions.create(issue, { ...input(), payload: { version: 1, questions: [{ id: 'date', prompt: 'Launch date?', selectionMode: 'text', required: true, options: [] }] } }, { agentId: agent.id });
    if (reassigned) {
      const [other] = await db.insert(agents).values({ companyId: company.id, name: 'Unenrolled worker', adapterType: 'codex_local' }).returning();
      await issueService(db).update(issue.id, { assigneeAgentId: other.id });
    }
    expect(await issueService(db).update(issue.id, { status: 'cancelled' })).toMatchObject({ status: 'cancelled' });
    await expect(issueService(db).update(issue.id, { status: 'done' })).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe('cancelled');
    await questions.answerQuestions(issue, q.id, { answers: [{ questionId: 'date', optionIds: [], text: 'October 12' }] }, { userId: 'owner' });
    expect(await issueService(db).update(issue.id, { status: 'done' })).toMatchObject({ status: 'done' });
  });
  it('rejects unsupported enrollment without partial state and adapter edits after enrollment', async () => {
    const { company, agent, svc } = await fixture();
    const [ordinary] = await db.insert(agents).values({ companyId: company.id, name: 'Custom', adapterType: 'process' }).returning();
    await expect(svc.enroll(company.id, ordinary.id, { templateId: 'marketing-content' }, { userId: 'owner' })).rejects.toMatchObject({ status: 422 });
    expect(await svc.getEnrollment(company.id, ordinary.id)).toBeNull();
    await expect(agentService(db).update(agent.id, { adapterType: 'http' })).rejects.toMatchObject({ status: 422 });
    expect(await agentService(db).update(ordinary.id, { adapterType: 'http' })).toMatchObject({ adapterType: 'http' });
  });
  it('suppresses repeated forged answer wakes before creating runs or charging executed quota and genuinely resumes once', async () => {
    const { company, issue, agent, questions } = await fixture();
    const q = await questions.create(issue, input(), { agentId: agent.id });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const wake = () => heartbeat.wakeup(agent.id, { source: 'on_demand', reason: 'issue_interaction_resolved', contextSnapshot: { issueId: issue.id, interactionId: q.id, interactionStatus: 'answered', paperclipWorkforce: { ready: true } } });
    expect(await wake()).toBeNull();
    expect(await wake()).toBeNull();
    expect(await heartbeat.wakeup(agent.id, { source: "timer" })).toBeNull();
    expect(await heartbeat.wakeup(agent.id, { source: "on_demand" })).toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id))).toEqual([]);
    expect(await db.select().from(agentRuns).where(eq(agentRuns.agentId, agent.id))).toEqual([]);
    await questions.cancelQuestions(issue, q.id, {}, { userId: 'owner' });
    expect(await wake()).toBeNull();
    const replacement = await questions.create(issue, input(), { agentId: agent.id });
    await questions.answerQuestions(issue, replacement.id, answer(), { userId: 'owner' });
    const resumed = await wake();
    expect(resumed).not.toBeNull();
    await wake();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id))).filter(r => r.status === 'running')).toHaveLength(1);
  });
  it('claim gate cancels already queued dependent work before start accounting while unrelated work runs', async () => {
    const { company, issue, agent, questions } = await fixture();
    const q = await questions.create(issue, input(), { agentId: agent.id });
    const [queued] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: 'queued', contextSnapshot: { issueId: issue.id, interactionId: q.id, interactionStatus: 'answered' } }).returning();
    const [other] = await db.insert(issues).values({ companyId: company.id, assigneeAgentId: agent.id, title: 'Independent job', status: 'todo' }).returning();
    await heartbeatService(db, { autoDispatchQueuedRuns: false }).wakeup(agent.id, { source: 'on_demand', contextSnapshot: { issueId: other.id } });
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
    expect(saved).toMatchObject({ status: 'cancelled', startedAt: null, errorCode: 'workforce_input_pending' });
    expect(await db.select().from(agentRuns).where(eq(agentRuns.heartbeatRunId, queued.id))).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id))).find(r => r.id !== queued.id)?.status).toBe('running');
  });
  it('pins, holds and privately delivers required task questions without a company fact key', async () => {
    const { company, issue, agent, questions, svc } = await fixture();
    const taskQuestion = { ...input(), payload: { version: 1 as const, questions: [{ id: 'launchDate', prompt: 'When should this campaign launch?', required: true, selectionMode: 'text' as const, options: [] }] } };
    const q = await questions.create(issue, taskQuestion, { agentId: agent.id });
    expect(q.payload).toMatchObject({ answerOwnerUserId: 'owner' });
    const inbox = waitingOnYouService(db);
    expect((await inbox.list(company.id, { type: 'board', userId: 'owner' })).pendingQuestions).toEqual([expect.objectContaining({ interactionId: q.id })]);
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    expect(await heartbeat.wakeup(agent.id, { contextSnapshot: { issueId: issue.id } })).toBeNull();
    await expect(issueService(db).update(issue.id, { status: 'done' })).rejects.toMatchObject({ status: 409 });
    await questions.answerQuestions(issue, q.id, { answers: [{ questionId: 'launchDate', optionIds: [], text: 'October 12' }] }, { userId: 'owner' });
    expect((await svc.getRuntimeContext(company.id, agent.id, issue.id))?.taskFacts).toEqual([expect.objectContaining({ key: 'launchDate', value: 'October 12', issueId: issue.id })]);
    expect((await inbox.list(company.id, { type: 'board', userId: 'owner' })).pendingQuestionsTotal).toBe(0);
    expect((await svc.getBrief(company.id)).facts).toEqual([]);
    expect(await heartbeat.wakeup(agent.id, { contextSnapshot: { issueId: issue.id } })).not.toBeNull();
  });
  it('retains a still-active pinned question owner after accountability changes', async () => {
    const { company, issue, agent, questions } = await fixture();
    const q = await questions.create(issue, input(), { agentId: agent.id });
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: 'new-owner', status: 'active' });
    await db.update(agents).set({ accountableUserId: 'new-owner' }).where(eq(agents.id, agent.id));
    expect(await questions.answerQuestions(issue, q.id, answer(), { userId: 'owner' })).toMatchObject({ status: 'answered', resolvedByUserId: 'owner' });
  });
  it('projects named questions only to their active owner with an uncapped count and visible issue scope', async () => {
    const { company, issue, agent, questions } = await fixture();
    const q = await questions.create(issue, input(), { agentId: agent.id });
    const inbox = waitingOnYouService(db);
    const owner = { type: 'board', userId: 'owner' };
    expect(await inbox.list(company.id, owner)).toMatchObject({ total: 0, pendingQuestionsTotal: 1, pendingQuestions: [{ interactionId: q.id, issueId: issue.id, answerOwnerUserId: 'owner' }] });
    expect((await inbox.list(company.id, { type: 'board', userId: 'peer' })).pendingQuestions).toEqual([]);
    expect((await inbox.list(company.id, { type: 'board', source: 'local_implicit' })).pendingQuestions).toEqual([]);
    const other = await fixture();
    expect((await inbox.list(other.company.id, owner)).pendingQuestions).toEqual([]);
    await db.insert(issueThreadInteractions).values(Array.from({ length: 50 }, () => ({ companyId: company.id, issueId: issue.id, kind: 'ask_user_questions', status: 'pending', payload: q.payload })));
    const capped = await inbox.list(company.id, owner);
    expect(capped.pendingQuestions).toHaveLength(50);
    expect(capped.pendingQuestionsTotal).toBe(51);
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, issue.id));
    expect((await inbox.list(company.id, owner)).pendingQuestionsTotal).toBe(0);
  });
  it('question ownership cannot disclose restricted project content', async () => {
    const { company, issue, agent, questions } = await fixture(true);
    const [job] = await db.select().from(issues).where(eq(issues.id, issue.id));
    await db.update(companyMemberships).set({ membershipRole: 'member' }).where(eq(companyMemberships.companyId, company.id));
    await db.update(projects).set({ visibility: 'restricted', createdByUserId: 'another-person' }).where(eq(projects.id, job.projectId!));
    const q = await questions.create(issue, input(), { agentId: agent.id });
    const inbox = waitingOnYouService(db);
    expect((await inbox.list(company.id, { type: 'board', userId: 'owner' })).pendingQuestionsTotal).toBe(0);
    await expect(questions.answerQuestions(issue, q.id, answer(), { userId: 'owner' })).rejects.toMatchObject({ status: 404 });
    await db.insert(projectAccess).values({ projectId: job.projectId!, principalType: 'user', principalId: 'owner', grantedByUserId: 'grantor' });
    expect((await inbox.list(company.id, { type: 'board', userId: 'owner' })).pendingQuestions[0].interactionId).toBe(q.id);
    await db.update(companyMemberships).set({ status: 'inactive' }).where(eq(companyMemberships.companyId, company.id));
    expect((await inbox.list(company.id, { type: 'board', userId: 'owner' })).pendingQuestionsTotal).toBe(0);
  });
  it('durably deduplicates concurrent first-job wakes, retries an unstarted cancellation and never reruns completed work', async () => {
    const { company, issue, agent } = await fixture();
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const wake = () => heartbeat.wakeup(agent.id, { source: 'on_demand', reason: 'workforce_first_job', idempotencyKey: `workforce-first-job:${issue.id}`, contextSnapshot: { issueId: issue.id } });
    await Promise.all([wake(), wake()]);
    let runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id));
    expect(runs).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: 'cancelled', startedAt: null, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runs[0].id));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issue.id));
    await wake();
    runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id));
    expect(runs).toHaveLength(2);
    const started = runs.find(r => r.status === 'running')!;
    await db.update(heartbeatRuns).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(heartbeatRuns.id, started.id));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issue.id));
    await wake();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id))).toHaveLength(2);
  });
  it('allows initial discovery with missing company facts but rejects completion without sufficient input', async () => {
    const { issue, agent } = await fixture();
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    expect(await heartbeat.wakeup(agent.id, { contextSnapshot: { issueId: issue.id } })).not.toBeNull();
    await expect(issueService(db).update(issue.id, { status: 'done' })).rejects.toMatchObject({ status: 409 });
  });
  it('keeps marked required holds through reassignment to an unenrolled worker and cancel/reopen', async () => {
    const { company, issue, agent, questions, svc } = await fixture();
    const q = await questions.create(issue, input(), { agentId: agent.id });
    const [other] = await db.insert(agents).values({ companyId: company.id, name: 'Unenrolled worker', adapterType: 'codex_local' }).returning();
    await issueService(db).update(issue.id, { assigneeAgentId: other.id });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    expect(await heartbeat.wakeup(other.id, { contextSnapshot: { issueId: issue.id } })).toBeNull();
    await issueService(db).update(issue.id, { status: 'cancelled' });
    await issueService(db).update(issue.id, { status: 'todo' });
    expect(await heartbeat.wakeup(other.id, { contextSnapshot: { issueId: issue.id } })).toBeNull();
    await expect(issueService(db).update(issue.id, { status: 'done' })).rejects.toMatchObject({ status: 409 });
    expect((await svc.getReadiness(company.id, agent.id))?.phase).not.toBe('ready');
    await questions.answerQuestions(issue, q.id, answer(), { userId: 'owner' });
    expect(await heartbeat.wakeup(other.id, { contextSnapshot: { issueId: issue.id } })).not.toBeNull();
  });
  it('retains cancelled required holds until sufficient input explicitly replaces them', async () => {
    const { company, issue, agent, questions, svc } = await fixture();
    const q = await questions.create(issue, input(), { agentId: agent.id });
    await questions.cancelQuestions(issue, q.id, {}, { userId: 'owner' });
    expect((await waitingOnYouService(db).list(company.id, { type: 'board', userId: 'owner' })).pendingQuestionsTotal).toBe(0);
    expect(await svc.getReadiness(company.id, agent.id)).toMatchObject({ phase: 'needs_input', pendingQuestionIds: [q.id] });
    const replacement = await questions.create(issue, input(), { agentId: agent.id });
    await questions.answerQuestions(issue, replacement.id, answer(), { userId: 'owner' });
    expect((await svc.getReadiness(company.id, agent.id))?.pendingQuestionIds).toEqual([]);
  });
  it('requires explicit no-key replacement and rejects foreign fact keys after reassignment', async () => {
    const { company, issue, agent, questions, svc } = await fixture();
    const taskInput = { ...input(), payload: { version: 1 as const, questions: [{ id: 'date', prompt: 'Launch date?', selectionMode: 'text' as const, required: true, options: [] }] } };
    const q = await questions.create(issue, taskInput, { agentId: agent.id });
    await questions.cancelQuestions(issue, q.id, {}, { userId: 'owner' });
    const unrelated = await questions.create(issue, taskInput, { agentId: agent.id });
    await questions.answerQuestions(issue, unrelated.id, { answers: [{ questionId: 'date', optionIds: [], text: 'Tuesday' }] }, { userId: 'owner' });
    expect((await svc.getReadiness(company.id, agent.id))?.pendingQuestionIds).toContain(q.id);
    const [other] = await db.insert(agents).values({ companyId: company.id, name: 'Unenrolled', adapterType: 'codex_local' }).returning();
    await issueService(db).update(issue.id, { assigneeAgentId: other.id });
    const replacement = { ...taskInput, payload: { ...taskInput.payload, replacesInteractionId: q.id } };
    await expect(questions.create(issue, { ...replacement, payload: { ...replacement.payload, questions: [...replacement.payload.questions, input('madeUp').payload.questions[0]] } }, { userId: 'owner' })).rejects.toMatchObject({ status: 422 });
    const resolved = await questions.create(issue, replacement, { userId: 'owner' });
    await questions.answerQuestions(issue, resolved.id, { answers: [{ questionId: 'date', optionIds: [], text: 'Wednesday' }] }, { userId: 'owner' });
    expect(await heartbeatService(db, { autoDispatchQueuedRuns: false }).wakeup(other.id, { contextSnapshot: { issueId: issue.id } })).not.toBeNull();
  });

});
