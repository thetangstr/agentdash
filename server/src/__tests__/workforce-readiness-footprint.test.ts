import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, companies, companyContext, createDb, issues, issueThreadInteractions, issueWorkProducts, verdicts, workforceEnrollments, type Db } from '@paperclipai/db';
import type { AskUserQuestionsPayload } from '@paperclipai/shared';
import { workforceIssueInputs, type WorkforceInputObservation, type WorkforceQuestionSource, type WorkforceQuestionDependency } from '../services/workforce-inputs.js';
import { workforceService } from '../services/workforce.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

// Real persisted legacy/partial rows deliberately exercise the native parser and
// answer traversal; no authority mock or reconstructed causal algorithm.
describe('private native workforce readiness footprint', () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase('readiness-footprint-'); db = createDb(temporary.connectionString); });
  afterAll(async () => { await temporary?.cleanup(); });

  const q = (id: string, companyFactKey?: string, required = true): AskUserQuestionsPayload['questions'][number] => ({ id, prompt: `Private prompt ${id}`, selectionMode: 'text', required, options: [], ...(companyFactKey ? { companyFactKey } : {}) });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Footprint', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Worker', adapterType: 'codex_local' }).returning();
    const [job] = await db.insert(issues).values({ companyId: company.id, title: 'First job', assigneeAgentId: agent.id, status: 'todo' }).returning();
    const [enrollment] = await db.insert(workforceEnrollments).values({ companyId: company.id, agentId: agent.id, templateId: 'marketing-content', templateVersion: 1, firstJobIssueId: job.id }).returning();
    let order = 0;
    async function row(questions: AskUserQuestionsPayload['questions'], options: {
      id?: string; owner?: string; status?: string; answers?: Record<string, string>; replaces?: string;
      template?: string; resolvedByUserId?: string | null; resolvedByAgentId?: string | null;
    } = {}) {
      const owner = options.owner ?? 'alice';
      const [stored] = await db.insert(issueThreadInteractions).values({
        id: options.id, companyId: company.id, issueId: job.id, kind: 'ask_user_questions',
        status: options.status ?? (options.answers ? 'answered' : 'pending'),
        createdAt: new Date(1700000000000 + order++ * 1000),
        resolvedByUserId: options.resolvedByUserId === undefined ? (options.answers ? owner : null) : options.resolvedByUserId,
        resolvedByAgentId: options.resolvedByAgentId,
        payload: { version: 1, answerOwnerUserId: owner, workforceAgentId: agent.id, workforceEnrollmentId: enrollment.id, workforceTemplateId: options.template ?? 'marketing-content', workforceTemplateVersion: 1, questions, ...(options.replaces ? { replacesInteractionId: options.replaces } : {}) },
        result: options.answers ? { version: 1, answers: Object.entries(options.answers).map(([questionId, text]) => ({ questionId, text, optionIds: [] })) } : null,
      }).returning();
      return stored;
    }
    async function approved(keys: string[]) {
      await db.insert(companyContext).values({ companyId: company.id, contextType: 'workforce_brief', key: 'current', value: JSON.stringify({ revision: 1, facts: keys.map(key => ({ key, value: 'Approved input', sourceReference: 'human' })), sources: [], confirmedByUserId: 'human', updatedAt: null }) });
    }
    async function input() {
      const observations: WorkforceInputObservation[] = [];
      const plain = await workforceIssueInputs(db, company.id, agent.id, job.id);
      const observed = await workforceIssueInputs(db, company.id, agent.id, job.id, { observeSources: value => observations.push(value) });
      expect(observed).toEqual(plain);
      expect(Object.keys(observed).sort()).toEqual(['missingFactKeys', 'pendingQuestionIds', 'taskFacts']);
      expect(observations).toHaveLength(1);
      expect(JSON.stringify(observations)).not.toContain('Private prompt');
      expect(JSON.stringify(observations)).not.toContain('SECRET_VALUE');
      return { result: observed, observation: observations[0] };
    }
    async function readiness() {
      const observations: WorkforceQuestionDependency[][] = [];
      const svc = workforceService(db);
      const plain = await svc.getReadiness(company.id, agent.id);
      const observed = await svc.getReadiness(company.id, agent.id, { observeSources: value => observations.push(value) });
      expect(observed).toEqual(plain);
      expect(observations).toHaveLength(1);
      expect(JSON.stringify(observed)).not.toMatch(/observeSources|pendingSources|answerCauses|taskFactSources/);
      return { result: observed, sources: observations[0] };
    }
    return { company, agent, job, enrollment, row, approved, input, readiness };
  }
  const ids = (sources: WorkforceQuestionSource[]) => sources.map(source => source.interactionId);

  it.each(['pending', 'cancelled'])('retains exact unresolved %s row without disclosing contents', async status => {
    const f = await fixture();
    const row = await f.row([q('date')], { status });
    const input = await f.input();
    expect(input.result.pendingQuestionIds).toEqual([row.id]);
    expect(input.observation.pendingSources).toEqual([expect.objectContaining({ kind: 'interaction', interactionId: row.id, companyId: f.company.id, issueId: f.job.id, status, answerOwnerUserId: 'alice', resolvedByUserId: null, resolvedByAgentId: null })]);
    const readiness = await f.readiness();
    expect(ids(readiness.sources)).toEqual([row.id]);
    expect(readiness.sources[0].roles).toEqual(['required_question']);
  });

  it('keeps actual answering owner and traversal prefix for each replaced row', async () => {
    const f = await fixture();
    const a = await f.row([q('a')], { owner: 'alice', status: 'cancelled' });
    const b = await f.row([q('b')], { owner: 'bob', status: 'cancelled', replaces: a.id });
    const c = await f.row([q('c')], { owner: 'carol', replaces: b.id, answers: { c: 'SECRET_VALUE' } });
    const { result, observation } = await f.input();
    expect(result.pendingQuestionIds).toEqual([]);
    expect(observation.answerCauses.map(cause => [cause.interactionId, cause.answeringInteractionId, ids(cause.path)])).toEqual([
      [c.id, c.id, [c.id]], [b.id, c.id, [c.id, b.id]], [a.id, c.id, [c.id, b.id, a.id]],
    ]);
    expect(observation.answerCauses[2].path[0]).toMatchObject({ answerOwnerUserId: 'carol', resolvedByUserId: 'carol' });
    const readiness = await f.readiness();
    expect(ids(readiness.sources)).toEqual([c.id, b.id, a.id]);
    expect(readiness.sources.map(source => [source.interactionId, source.roles])).toEqual([
      [c.id, ['sufficient_answer']], [b.id, ['replacement_path', 'replacement_target']], [a.id, ['replacement_target']],
    ]);
    expect(observation.pendingSources.map(source => source.roles)).toEqual([
      ['sufficient_answer'], ['replacement_path', 'replacement_target'], ['replacement_target'],
    ]);
  });

  it('uses a partial answer fact to suppress another row and only retains the overwritten winner', async () => {
    const f = await fixture();
    await f.row([q('offer', 'offer', false)], { answers: { offer: 'Old value' } });
    const partial = await f.row([q('offer', 'offer'), q('date')], { owner: 'bob', answers: { offer: 'SECRET_VALUE' } });
    const target = await f.row([q('offer', 'offer')]);
    const { result, observation } = await f.input();
    expect(result.pendingQuestionIds).toEqual([partial.id]);
    expect(result.taskFacts).toEqual([{ companyFactKey: 'offer', key: 'offer', value: 'SECRET_VALUE', issueId: f.job.id, sourceReference: `interaction:${partial.id}/question:offer` }]);
    expect(observation.taskFactSources).toEqual([expect.objectContaining({ mapKey: 'fact:offer', questionId: 'offer', companyFactKey: 'offer', sourceReference: `interaction:${partial.id}/question:offer`, source: expect.objectContaining({ interactionId: partial.id }) })]);
    expect(ids(observation.pendingSources)).toEqual([partial.id, target.id]);
    const readiness = await f.readiness();
    expect(ids(readiness.sources)).toEqual([partial.id, target.id]);
    expect(readiness.sources.map(source => source.roles)).toEqual([['task_fact', 'required_question'], ['required_question']]);
    expect(observation.pendingSources.map(source => source.roles)).toEqual([['required_question', 'task_fact'], ['required_question']]);
  });

  it('keeps an incomplete replacement and its predecessor unresolved while retaining partial facts', async () => {
    const f = await fixture();
    const original = await f.row([q('date')], { status: 'cancelled' });
    const partial = await f.row([q('offer', 'offer'), q('date')], { owner: 'bob', replaces: original.id, answers: { offer: 'SECRET_VALUE' } });
    const { result, observation } = await f.input();
    expect(result.pendingQuestionIds).toEqual([original.id, partial.id]);
    expect(result.taskFacts.map(fact => fact.key)).toEqual(['offer']);
    expect(observation.answerCauses).toEqual([]);
    expect(ids(observation.pendingSources)).toEqual([original.id, partial.id]);
    // Missing-fact consumption precedes pending consumption; identities dedupe.
    expect(ids((await f.readiness()).sources)).toEqual([partial.id, original.id]);
  });

  it('ignores optional-only and invalid-template history but retains an approved-key row with a required keyless question', async () => {
    const f = await fixture();
    await f.row([q('optional', undefined, false)], { status: 'cancelled' });
    await f.row([q('foreign')], { template: 'unavailable' });
    await f.approved(['offer']);
    const target = await f.row([q('offer', 'offer'), q('date')]);
    const { result, observation } = await f.input();
    expect(result.pendingQuestionIds).toEqual([target.id]);
    expect(ids(observation.pendingSources)).toEqual([target.id]);
    expect(ids((await f.readiness()).sources)).toEqual([target.id]);
  });

  it('prefers sufficient answer cause without demanding an alternate fact supplier', async () => {
    const f = await fixture();
    const original = await f.row([q('pricing', 'pricing')], { template: 'sales-support' });
    const answer = await f.row([q('date')], { replaces: original.id, owner: 'bob', answers: { date: 'SECRET_VALUE' } });
    const unused = await f.row([q('pricing', 'pricing', false)], { template: 'sales-support', owner: 'carol', answers: { pricing: 'unused' } });
    const { observation } = await f.input();
    expect(observation.taskFactSources.some(fact => fact.source.interactionId === unused.id)).toBe(true);
    expect(ids(observation.pendingSources)).toEqual([answer.id, original.id]);
    expect(ids((await f.readiness()).sources)).toEqual([answer.id, original.id]);
  });

  it('approved facts shadow answered history and overwritten private facts entirely', async () => {
    const f = await fixture();
    await f.row([q('offer', 'offer')], { answers: { offer: 'SECRET_VALUE' } });
    await f.row([q('offer', 'offer')]);
    await f.approved(['offer']);
    const { result, observation } = await f.input();
    expect(result.pendingQuestionIds).toEqual([]);
    expect(result.taskFacts).toHaveLength(1);
    expect(observation.pendingSources).toEqual([]);
    expect((await f.readiness()).sources).toEqual([]);
  });

  it('retains pending fact dependencies outside enrollment keys even with a mismatched assignee', async () => {
    const f = await fixture();
    const source = await f.row([q('pricing', 'pricing', false)], { template: 'sales-support', answers: { pricing: 'SECRET_VALUE' } });
    const target = await f.row([q('pricing', 'pricing')], { template: 'sales-support' });
    expect(ids((await f.readiness()).sources)).toEqual([target.id, source.id]);
    const [other] = await db.insert(agents).values({ companyId: f.company.id, name: 'Other', adapterType: 'codex_local' }).returning();
    await db.update(issues).set({ assigneeAgentId: other.id }).where(eq(issues.id, f.job.id));
    const { result, observation } = await f.input();
    expect(result.pendingQuestionIds).toEqual([]);
    expect(result.taskFacts).toEqual([]);
    expect(ids(observation.pendingSources)).toEqual([target.id, source.id]);
    const readiness = await f.readiness();
    expect(readiness.result).toMatchObject({ phase: 'needs_input', pendingQuestionIds: [], missingFactKeys: ['offer', 'audience', 'brandVoice', 'approvedClaims'] });
    expect(readiness.sources).toEqual([]);
  });

  it.each([false, true])('keeps only the pending row when a required key is missing (first: %s)', async first => {
    const f = await fixture();
    const source = await f.row([q('pricing', 'pricing', false)], { template: 'sales-support', answers: { pricing: 'SECRET_VALUE' } });
    const target = await f.row(first ? [q('missing'), q('pricing', 'pricing')] : [q('pricing', 'pricing'), q('missing'), q('alsoPricing', 'pricing')], { template: 'sales-support' });
    const { result, observation } = await f.input();
    expect(result.pendingQuestionIds).toEqual([target.id]);
    expect(ids(observation.pendingSources)).toEqual([target.id]);
    expect(ids((await f.readiness()).sources)).toEqual([target.id]);
    expect(observation.taskFactSources[0].source.interactionId).toBe(source.id);
  });

  it('selects a required company fact winner but omits unused keyless and non-required runtime facts', async () => {
    const f = await fixture();
    await f.row([q('date', undefined, false)], { answers: { date: 'SECRET_VALUE' } });
    await f.row([q('pricing', 'pricing', false)], { template: 'sales-support', answers: { pricing: 'Unused runtime' } });
    const source = await f.row([q('offer', 'offer', false)], { answers: { offer: 'First' } });
    const winner = await f.row([q('offer', 'offer', false)], { owner: 'bob', answers: { offer: 'Winner' } });
    const { result, observation } = await f.input();
    expect(result.taskFacts.map(fact => fact.key)).toEqual(['date', 'pricing', 'offer']);
    expect(observation.pendingSources).toEqual([]);
    const readiness = await f.readiness();
    expect(readiness.result?.missingFactKeys).toEqual(['audience', 'brandVoice', 'approvedClaims']);
    expect(ids(readiness.sources)).toEqual([winner.id]);
    expect(ids(readiness.sources)).not.toContain(source.id);
  });

  it('records a missing predecessor only on its unused candidate path', async () => {
    const f = await fixture();
    const missing = randomUUID();
    const source = await f.row([q('date')], { replaces: missing, answers: { date: 'SECRET_VALUE' } });
    const { observation } = await f.input();
    expect(observation.answerCauses.map(cause => ids(cause.path))).toEqual([[source.id], [source.id, missing]]);
    expect(observation.answerCauses[1].path[1]).toEqual({ kind: 'missing_replacement', companyId: f.company.id, issueId: f.job.id, interactionId: missing });
    expect(ids(observation.pendingSources)).toEqual([source.id]);
    expect(ids((await f.readiness()).sources)).toEqual([source.id]);
  });

  it('stops on cycles and preserves predecessor causes when a later direct answer overwrites itself', async () => {
    const f = await fixture();
    const aId = randomUUID(), bId = randomUUID();
    await f.row([q('a')], { id: aId, replaces: bId, answers: { a: 'SECRET_VALUE' } });
    await f.row([q('b')], { id: bId, owner: 'bob', replaces: aId, answers: { b: 'Second' } });
    const { result, observation } = await f.input();
    expect(result.pendingQuestionIds).toEqual([]);
    expect(observation.answerCauses.map(cause => [cause.interactionId, cause.answeringInteractionId, ids(cause.path)])).toEqual([[aId, aId, [aId]], [bId, bId, [bId]]]);
    expect(ids((await f.readiness()).sources)).toEqual([aId, bId]);
  });

  it('does not accept a mismatched human or agent resolver as sufficient answer or fact', async () => {
    const f = await fixture();
    const mismatch = await f.row([q('offer', 'offer')], { answers: { offer: 'SECRET_VALUE' }, resolvedByUserId: 'bob' });
    const agent = await f.row([q('offer', 'offer')], { answers: { offer: 'SECRET_VALUE' }, resolvedByAgentId: f.agent.id });
    const { result, observation } = await f.input();
    expect(result.pendingQuestionIds).toEqual([mismatch.id, agent.id]);
    expect(result.taskFacts).toEqual([]);
    expect(observation.answerCauses).toEqual([]);
    expect(ids((await f.readiness()).sources)).toEqual([mismatch.id, agent.id]);
  });

  it('uses all and only winning unapproved facts for a fully satisfied multi-required row', async () => {
    const f = await fixture();
    await f.approved(['offer']);
    await f.row([q('offer', 'offer', false)], { answers: { offer: 'Shadowed' } });
    const pricing = await f.row([q('pricing', 'pricing', false)], { template: 'sales-support', answers: { pricing: 'SECRET_VALUE' } });
    const customer = await f.row([q('idealCustomer', 'idealCustomer', false)], { template: 'sales-support', owner: 'bob', answers: { idealCustomer: 'SECRET_VALUE' } });
    const target = await f.row([q('offer', 'offer'), q('pricing', 'pricing'), q('idealCustomer', 'idealCustomer'), q('repeat', 'pricing')], { template: 'sales-support' });
    const { result, observation } = await f.input();
    expect(result.pendingQuestionIds).toEqual([]);
    expect(ids(observation.pendingSources)).toEqual([target.id, pricing.id, customer.id]);
    expect(ids((await f.readiness()).sources)).toEqual([target.id, pricing.id, customer.id]);
  });

  it('does not retraverse an already answered predecessor or replace its older sufficient cause', async () => {
    const f = await fixture();
    const aId = randomUUID(), bId = randomUUID(), cId = randomUUID();
    await f.row([q('a')], { id: aId, replaces: bId, answers: { a: 'SECRET_VALUE' } });
    await f.row([q('b')], { id: bId, replaces: cId, owner: 'bob', status: 'cancelled' });
    await f.row([q('c')], { id: cId, replaces: aId, owner: 'carol', answers: { c: 'Second answer' } });
    const { observation } = await f.input();
    expect(observation.answerCauses.map(cause => [cause.interactionId, cause.answeringInteractionId, ids(cause.path)])).toEqual([
      [aId, aId, [aId]], [bId, aId, [aId, bId]], [cId, cId, [cId]],
    ]);
    expect(ids((await f.readiness()).sources)).toEqual([aId, bId, cId]);
  });

  it.each([
    ['unlearned', 'learning'], ['stale', 'refresh_needed'], ['missing skills', 'learning'],
    ['failed skills', 'learning'], ['working', 'working'], ['artifact', 'awaiting_review'], ['accepted', 'ready'],
  ])('publishes the same consumed input sources on the %s return path', async (state, phase) => {
    const f = await fixture();
    await f.approved(['audience', 'brandVoice', 'approvedClaims']);
    const source = await f.row([q('offer', 'offer')], { answers: { offer: 'SECRET_VALUE' } });
    await db.update(workforceEnrollments).set({
      learnedBriefRevision: state === 'unlearned' ? null : state === 'stale' ? 0 : 1,
      installedSkillKeys: state === 'missing skills' ? [] : [`company/${f.company.id}/workforce-marketing-content-v1`],
      skillInstallError: state === 'failed skills' ? 'Test failure' : null,
    }).where(eq(workforceEnrollments.id, f.enrollment.id));
    if (state === 'artifact' || state === 'accepted') {
      await db.insert(issueWorkProducts).values({ companyId: f.company.id, issueId: f.job.id, type: 'document', provider: 'test', title: 'Artifact', status: 'ready', url: 'https://example.invalid/artifact', updatedAt: new Date(1700000000000) });
    }
    if (state === 'accepted') await db.insert(verdicts).values({ companyId: f.company.id, entityType: 'issue', issueId: f.job.id, reviewerUserId: 'neutral-reviewer', outcome: 'passed' });
    const { result, sources } = await f.readiness();
    expect(result).toMatchObject({ phase, missingFactKeys: [], pendingQuestionIds: [] });
    expect(ids(sources)).toEqual([source.id]);
    expect(sources[0].roles).toEqual(['task_fact', 'sufficient_answer']);
  });

  it('does not publish a footprint for readiness paths that throw before returning', async () => {
    const f = await fixture();
    const observations: WorkforceQuestionDependency[][] = [];
    const svc = workforceService(db);
    await db.update(workforceEnrollments).set({ templateId: 'unavailable' }).where(eq(workforceEnrollments.id, f.enrollment.id));
    await expect(svc.getReadiness(f.company.id, f.agent.id, { observeSources: value => observations.push(value) })).rejects.toMatchObject({ status: 409 });
    const other = await fixture();
    await db.update(workforceEnrollments).set({ templateId: 'marketing-content', firstJobIssueId: other.job.id }).where(eq(workforceEnrollments.id, f.enrollment.id));
    await expect(svc.getReadiness(f.company.id, f.agent.id, { observeSources: value => observations.push(value) })).rejects.toMatchObject({ status: 404 });
    expect(observations).toEqual([]);
  });

  it('observes empty successful early returns without inventing sources', async () => {
    const f = await fixture();
    await f.input();
    await db.update(workforceEnrollments).set({ firstJobIssueId: null }).where(eq(workforceEnrollments.id, f.enrollment.id));
    expect((await f.readiness()).sources).toEqual([]);
    await db.delete(workforceEnrollments).where(eq(workforceEnrollments.id, f.enrollment.id));
    expect(await f.readiness()).toEqual({ result: null, sources: [] });
    await f.input();
    const observations: WorkforceInputObservation[] = [];
    expect(await workforceIssueInputs(db, f.company.id, f.agent.id, randomUUID(), { observeSources: value => observations.push(value) })).toEqual({ pendingQuestionIds: [], missingFactKeys: [], taskFacts: [] });
    expect(observations).toEqual([{ pendingSources: [], taskFactSources: [], answerCauses: [] }]);
  });
});
