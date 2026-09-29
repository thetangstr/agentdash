import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, companies, companyContext, createDb, goals, issues, verdicts, companySkills, issueThreadInteractions, workforceEnrollments, activityLog, issueWorkProducts } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import * as service from '../services/workforce.js';
import { workProductService } from '../services/work-products.js';
import { documentService } from '../services/documents.js';
import { readPaperclipSkillSyncPreference } from '@paperclipai/adapter-utils/server-utils';
import { agentService } from '../services/agents.js';

// These tests catch lost updates, cross-company association leaks, duplicate jobs,
// and acceptance granted from an agent's assertion instead of persisted evidence.
describe('workforce persisted contracts', () => {
  let skillHome: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const owner = { userId: 'owner' };
  beforeAll(async () => {
    skillHome = await mkdtemp(path.join(tmpdir(), 'workforce-skills-'));
    process.env.PAPERCLIP_HOME = skillHome;
    temp = await startEmbeddedPostgresTestDatabase('agentdash-workforce-');
    db = createDb(temp.connectionString);
  });
  afterAll(async () => { await temp?.cleanup(); await rm(skillHome, { recursive: true, force: true }); if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome; });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Workforce test', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Worker', adapterType: 'codex_local', adapterConfig: { custom: 'preserved' } }).returning();
    return { company, agent, svc: service.workforceService(db) };
  }
  const input = { expectedRevision: 0, sources: [{ id: 'owner-input', label: 'Owner intake', content: 'We provide tax preparation.' }], facts: [{ key: 'offer', value: 'Tax preparation', sourceReference: 'Owner intake' }] };
  it('returns empty brief and atomically rejects one competing edit while retaining immutable history', async () => {
    const { company, svc } = await fixture();
    expect(await svc.getBrief(company.id)).toMatchObject({ revision: 0, sources: [], facts: [], confirmedByUserId: null });
    const writes = await Promise.allSettled([svc.updateBrief(company.id, input, owner), svc.updateBrief(company.id, input, owner)]);
    expect(writes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find(x => x.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    await svc.updateBrief(company.id, { expectedRevision: 1, sources: [], facts: [] }, owner);
    const rows = await db.select().from(companyContext).where(and(eq(companyContext.companyId, company.id), eq(companyContext.contextType, 'workforce_brief_revision')));
    expect(rows.map(x => JSON.parse(x.value).revision).sort()).toEqual([1, 2]);
    expect(JSON.parse(rows.find(x => x.key === '1')!.value).facts[0].value).toBe('Tax preparation');
  });
  it('validates duplicate keys and limits before publishing', async () => {
    const { company, svc } = await fixture();
    await expect(svc.updateBrief(company.id, { ...input, facts: [...input.facts, ...input.facts] }, owner)).rejects.toBeDefined();
    await expect(svc.updateBrief(company.id, { ...input, sources: [{ ...input.sources[0], content: 'x'.repeat(12001) }] }, owner)).rejects.toBeDefined();
    expect((await svc.getBrief(company.id)).revision).toBe(0);
  });
  it('pins enrollment, preserves config, scopes all agent lookups, and acknowledges only current revision', async () => {
    const { company, agent, svc } = await fixture();
    const other = await fixture();
    const first = await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, owner);
    expect(await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, owner)).toMatchObject({ id: first.id, templateVersion: 1 });
    await expect(svc.enroll(company.id, agent.id, { templateId: 'sales-support' }, owner)).rejects.toMatchObject({ status: 409 });
    for (const lookup of [() => svc.getEnrollment(other.company.id, agent.id), () => svc.getReadiness(other.company.id, agent.id), () => svc.getRuntimeContext(other.company.id, agent.id)]) await expect(lookup()).rejects.toMatchObject({ status: 404 });
    await svc.updateBrief(company.id, input, owner);
    await expect(svc.acknowledgeLearning(company.id, agent.id, 0, { agentId: agent.id })).rejects.toMatchObject({ status: 409 });
    await expect(svc.acknowledgeLearning(company.id, agent.id, 1, { agentId: other.agent.id })).rejects.toMatchObject({ status: 403 });
    expect(await svc.acknowledgeLearning(company.id, agent.id, 1, { agentId: agent.id })).toMatchObject({ learnedBriefRevision: 1 });
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0].adapterConfig).toEqual({ custom: 'preserved' });
  });
  it('keeps agent proposals separate and rejects private or invented source references', async () => {
    const { company, agent, svc } = await fixture();
    await svc.updateBrief(company.id, input, owner);
    await expect(svc.proposeFacts(company.id, agent.id, { facts: input.facts, sourceReferences: ['private-answer'] })).rejects.toMatchObject({ status: 400 });
    const proposal = await svc.proposeFacts(company.id, agent.id, { facts: input.facts, sourceReferences: ['owner-input'] });
    expect(proposal).toMatchObject({ status: 'proposed', agentId: agent.id });
    expect((await svc.getBrief(company.id)).revision).toBe(1);
  });
  it('creates one normal assigned first job under concurrent requests and links a company goal', async () => {
    const { company, agent, svc } = await fixture();
    const [goal] = await db.insert(goals).values({ companyId: company.id, title: 'Qualified leads', level: 'company', status: 'active' }).returning();
    await svc.enroll(company.id, agent.id, { templateId: 'sales-support', goalId: goal.id }, owner);
    const [a, b] = await Promise.all([svc.startFirstJob(company.id, agent.id, owner), svc.startFirstJob(company.id, agent.id, owner)]);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ companyId: company.id, assigneeAgentId: agent.id, originKind: 'workforce_onboarding', goalId: goal.id });
    expect(a.definitionOfDone?.criteria.length).toBeGreaterThan(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(1);
    const events = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, company.id),
      eq(activityLog.entityId, a.id),
      eq(activityLog.action, 'issue.created'),
    ));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'user', actorId: 'owner', entityType: 'issue',
      details: { title: a.title, identifier: a.identifier },
    });
  });
  it('requires artifact and latest neutral pass, then invalidates learning when approved context changes', async () => {
    const { company, agent, svc } = await fixture();
    await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, owner);
    await svc.ensureSkillsInstalled(company.id, agent.id, owner);
    const facts = ['offer', 'audience', 'brandVoice', 'approvedClaims'].map(key => ({ key, value: 'Confirmed owner input', sourceReference: 'Owner intake' }));
    await svc.updateBrief(company.id, { ...input, facts }, owner);
    await svc.acknowledgeLearning(company.id, agent.id, 1, owner);
    const job = await svc.startFirstJob(company.id, agent.id, owner);
    const addVerdict = async (outcome: string, reviewerAgentId?: string) => (await db.insert(verdicts).values({ companyId: company.id, entityType: 'issue', issueId: job.id, outcome, reviewerUserId: reviewerAgentId ? null : 'reviewer', reviewerAgentId: reviewerAgentId ?? null }).returning())[0];
    await addVerdict('passed');
    expect((await svc.getReadiness(company.id, agent.id))?.phase).not.toBe('ready');
    await documentService(db).upsertIssueDocument({ issueId: job.id, key: 'deliverable', title: 'Campaign brief', format: 'markdown', body: 'A real campaign draft with audience, approved offer and a concrete call to action.', createdByAgentId: agent.id });
    for (const outcome of ['failed', 'escalated_to_human', 'pending']) {
      await addVerdict(outcome);
      expect((await svc.getReadiness(company.id, agent.id))?.phase).not.toBe('ready');
    }
    await addVerdict('passed', agent.id);
    expect((await svc.getReadiness(company.id, agent.id))?.phase).not.toBe('ready');
    const pass = await addVerdict('passed');
    expect(await svc.getReadiness(company.id, agent.id)).toMatchObject({ phase: 'ready', acceptedVerdictId: pass.id });
    await db.update(issues).set({ status: 'cancelled' }).where(eq(issues.id, job.id));
    expect((await svc.getReadiness(company.id, agent.id))?.phase).not.toBe('ready');
    await svc.updateBrief(company.id, { ...input, facts, expectedRevision: 1 }, owner);
    expect((await svc.getReadiness(company.id, agent.id))?.phase).toBe('refresh_needed');
  });
  it('core creation records a chosen template without mutating ordinary creation', async () => {
    const { company, svc } = await fixture();
    const ordinary = await agentService(db).create(company.id, { name: 'Ordinary' });
    expect(await svc.getEnrollment(company.id, ordinary.id)).toBeNull();
    const templated = await agentService(db).create(company.id, { name: 'Marketing', adapterType: 'codex_local', workforceTemplateId: 'marketing-content' });
    expect(await svc.getEnrollment(company.id, templated.id)).toMatchObject({ templateId: 'marketing-content', templateVersion: 1 });
  });
  it('rejects a goal from another company without creating an enrollment', async () => {
    const { company, agent, svc } = await fixture();
    const other = await fixture();
    const [goal] = await db.insert(goals).values({ companyId: other.company.id, title: 'Private objective' }).returning();
    await expect(svc.enroll(company.id, agent.id, { templateId: 'sales-support', goalId: goal.id }, owner)).rejects.toMatchObject({ status: 404 });
    expect(await svc.getEnrollment(company.id, agent.id)).toBeNull();
  });
  it('keeps cancellation unresolved and scopes questions to the dependent first job', async () => {
    const { company, agent, svc } = await fixture();
    await svc.enroll(company.id, agent.id, { templateId: 'sales-support' }, owner);
    const job = await svc.startFirstJob(company.id, agent.id, owner);
    const [question] = await db.insert(issueThreadInteractions).values({ companyId: company.id, issueId: job.id, kind: 'ask_user_questions', status: 'cancelled', payload: { version: 1, workforceAgentId: agent.id, workforceEnrollmentId: (await svc.getEnrollment(company.id, agent.id))!.id, workforceTemplateId: 'sales-support', workforceTemplateVersion: 1, questions: [{ id: 'price', prompt: 'What price is approved?', required: true, selectionMode: 'single', options: [{ id: 'a', label: '$50' }] }] } }).returning();
    expect(await svc.getReadiness(company.id, agent.id)).toMatchObject({ phase: 'needs_input', pendingQuestionIds: [question.id] });
  });
  it('keeps accepted work unready until pinned skills are installed and recovers after retry', async () => {
    const { company, agent, svc } = await fixture();
    await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, owner);
    await svc.updateBrief(company.id, { ...input, facts: ['offer', 'audience', 'brandVoice', 'approvedClaims'].map(key => ({ key, value: 'Approved', sourceReference: 'Owner intake' })) }, owner);
    await svc.acknowledgeLearning(company.id, agent.id, 1, owner);
    const job = await svc.startFirstJob(company.id, agent.id, owner);
    await documentService(db).upsertIssueDocument({ issueId: job.id, key: 'deliverable', title: 'Campaign', format: 'markdown', body: 'Actual source-backed campaign draft', createdByAgentId: agent.id });
    const [pass] = await db.insert(verdicts).values({ companyId: company.id, entityType: 'issue', issueId: job.id, outcome: 'passed', reviewerUserId: 'reviewer' }).returning();
    expect(await svc.getReadiness(company.id, agent.id)).toMatchObject({ phase: 'learning', acceptedVerdictId: pass.id });
    await svc.ensureSkillsInstalled(company.id, agent.id, owner);
    expect((await svc.getReadiness(company.id, agent.id))?.phase).toBe('ready');
    const blockedHome = path.join(skillHome, 'blocked-retry'); await writeFile(blockedHome, 'blocked');
    process.env.PAPERCLIP_HOME = blockedHome;
    try { expect((await svc.ensureSkillsInstalled(company.id, agent.id, owner)).skillInstallError).toBeTruthy(); }
    finally { process.env.PAPERCLIP_HOME = skillHome; }
    const failed = await svc.getReadiness(company.id, agent.id);
    expect(failed).toMatchObject({ phase: 'learning', acceptedVerdictId: pass.id });
    expect(failed?.reason).toMatch(/skill.*install/i);
    await svc.ensureSkillsInstalled(company.id, agent.id, owner);
    expect(await svc.getReadiness(company.id, agent.id)).toMatchObject({ phase: 'ready', acceptedVerdictId: pass.id });
  });
  it('retries failed local installation, pins actual skill files and preserves existing assignments', async () => {
    const { company, agent, svc } = await fixture();
    await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, owner);
    const blockedHome = path.join(skillHome, 'not-a-directory');
    await writeFile(blockedHome, 'blocked');
    process.env.PAPERCLIP_HOME = blockedHome;
    try {
      const failed = await svc.ensureSkillsInstalled(company.id, agent.id, owner);
      expect(failed.skillInstallError).toBeTruthy();
      expect(failed.installedSkillKeys).toEqual([]);
    } finally { process.env.PAPERCLIP_HOME = skillHome; }
    const [first, second] = await Promise.all([svc.ensureSkillsInstalled(company.id, agent.id, owner), svc.ensureSkillsInstalled(company.id, agent.id, owner)]);
    expect(first.skillInstallError).toBeNull();
    expect(second.skillInstallError).toBeNull();
    expect(second.installedSkillKeys).toEqual(first.installedSkillKeys);
    expect(first.installedSkillKeys).toHaveLength(1);
    const skillRows = await db.select().from(companySkills).where(and(eq(companySkills.companyId, company.id), eq(companySkills.slug, 'workforce-marketing-content-v1')));
    expect(skillRows).toHaveLength(1);
    expect(await readFile(path.join(skillRows[0].sourceLocator!, 'SKILL.md'), 'utf8')).toBe(skillRows[0].markdown);
    const [updated] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(updated.adapterConfig.custom).toBe('preserved');
    expect(readPaperclipSkillSyncPreference(updated.adapterConfig).desiredSkills).toContain(first.installedSkillKeys[0]);
  });
  it('returns bounded approved runtime facts without proposed private knowledge', async () => {
    const { company, agent, svc } = await fixture();
    await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, owner);
    await svc.updateBrief(company.id, { ...input, sources: [{ ...input.sources[0], content: 'a'.repeat(12000) }] }, owner);
    await svc.proposeFacts(company.id, agent.id, { facts: [{ key: 'audience', value: 'Unconfirmed audience', sourceReference: 'owner-input' }], sourceReferences: ['owner-input'] });
    const context = await svc.getRuntimeContext(company.id, agent.id);
    expect(context?.brief.facts.map(f => f.key)).toEqual(['offer']);
    expect(context?.brief.sources[0].content.length).toBeLessThanOrEqual(500);
    expect((await svc.getBrief(company.id)).sources[0].content).toHaveLength(12000);
  });
  it('rejects corrupted cross-company enrollment associations even when both foreign keys exist', async () => {
    const { company, agent, svc } = await fixture(); const other = await fixture();
    await db.insert(workforceEnrollments).values({ companyId: other.company.id, agentId: agent.id, templateId: 'marketing-content', templateVersion: 1 });
    await expect(svc.getEnrollment(other.company.id, agent.id)).rejects.toMatchObject({ status: 404 });
    expect(await svc.getEnrollment(company.id, agent.id)).toBeNull();
  });

  it('repairs a missing curated skill file when retrying an existing installation', async () => {
    const { company, agent, svc } = await fixture();
    await svc.enroll(company.id, agent.id, { templateId: 'sales-support' }, owner);
    const installed = await svc.ensureSkillsInstalled(company.id, agent.id, owner);
    expect(installed.skillInstallError).toBeNull();
    const [skill] = await db.select().from(companySkills).where(and(eq(companySkills.companyId, company.id), eq(companySkills.key, installed.installedSkillKeys[0])));
    const file = path.join(skill.sourceLocator!, 'SKILL.md');
    await rm(file);
    await svc.ensureSkillsInstalled(company.id, agent.id, owner);
    expect(await readFile(file, 'utf8')).toBe(skill.markdown);
  });

  it('preserves a concurrent config edit committed immediately before skill assignment', async () => {
    const { company, agent, svc } = await fixture();
    await svc.enroll(company.id, agent.id, { templateId: 'sales-support' }, owner);
    let edited = false;
    // Delay the actual SQL execution, not its result. All writes and transactions
    // are real PostgreSQL; this hook fixes the interleaving at the agent UPDATE.
    function beforeAgentUpdate(query: any): any {
      return new Proxy(query, {
        get(target, property) {
          if (property === 'then') return async (resolve: any, reject: any) => {
            try {
              if (!edited) {
                edited = true;
                await agentService(db).update(agent.id, { adapterConfig: {
                  custom: 'new instructions', model: 'new model',
                  paperclipSkillSync: { customSetting: 'preserve', desiredSkills: ['company/existing-skill'] },
                } });
              }
              return target.then(resolve, reject);
            } catch (error) { return reject(error); }
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function'
            ? (...args: unknown[]) => beforeAgentUpdate(value.apply(target, args))
            : value;
        },
      });
    }
    const racedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') return (fn: any) => target.transaction(tx => fn(new Proxy(tx, {
          get(transaction, key) {
            if (key === 'update') return (table: any) => {
              const query = transaction.update(table);
              return table === agents ? beforeAgentUpdate(query) : query;
            };
            const value = Reflect.get(transaction, key);
            return typeof value === 'function' ? value.bind(transaction) : value;
          },
        })));
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const installed = await service.workforceService(racedDb).ensureSkillsInstalled(company.id, agent.id, owner);
    expect(installed.skillInstallError).toBeNull();
    const [current] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(current.adapterConfig).toMatchObject({ custom: 'new instructions', model: 'new model', paperclipSkillSync: { customSetting: 'preserve' } });
    expect(readPaperclipSkillSyncPreference(current.adapterConfig).desiredSkills).toEqual(expect.arrayContaining(['company/existing-skill', ...installed.installedSkillKeys]));
  });

  it('accepts a work product without a document and requires new review after it changes', async () => {
    const { company, agent, svc } = await fixture();
    await svc.enroll(company.id, agent.id, { templateId: 'sales-support' }, owner);
    await svc.ensureSkillsInstalled(company.id, agent.id, owner);
    await svc.updateBrief(company.id, { expectedRevision: 0, sources: [], facts: ['offer', 'pricing', 'idealCustomer', 'qualificationRules'].map(key => ({ key, value: 'Approved', sourceReference: 'Owner' })) }, owner);
    await svc.acknowledgeLearning(company.id, agent.id, 1, owner);
    const job = await svc.startFirstJob(company.id, agent.id, owner);
    const product = await workProductService(db).createForIssue(job.id, company.id, { type: 'document', provider: 'local', title: 'Sales brief', url: 'https://example.test/approved-sales-brief', status: 'ready' });
    expect(await documentService(db).listIssueDocuments(job.id)).toEqual([]);
    const [pass] = await db.insert(verdicts).values({ companyId: company.id, entityType: 'issue', issueId: job.id, reviewerUserId: 'reviewer', outcome: 'passed' }).returning();
    expect(await svc.getReadiness(company.id, agent.id)).toMatchObject({ phase: 'ready', acceptedVerdictId: pass.id });
    await db.update(issueWorkProducts).set({ summary: 'Revised deliverable', updatedAt: new Date(pass.createdAt.getTime() + 1000) }).where(eq(issueWorkProducts.id, product!.id));
    expect(await svc.getReadiness(company.id, agent.id)).toMatchObject({ phase: 'awaiting_review', acceptedVerdictId: null });
  });

  it('reviews only a selected sourced proposal once and preserves other knowledge', async () => {
    const { company, agent, svc } = await fixture();
    await svc.updateBrief(company.id, input, owner);
    const proposal = await svc.proposeFacts(company.id, agent.id, { facts: [{ key: 'audience', value: 'Small businesses', sourceReference: 'owner-input' }], sourceReferences: ['owner-input'] });
    const other = await svc.proposeFacts(company.id, agent.id, { facts: [{ key: 'brandVoice', value: 'Unconfirmed', sourceReference: 'owner-input' }], sourceReferences: ['owner-input'] });
    expect(typeof svc.reviewProposal).toBe('function');
    const results = await Promise.allSettled([svc.reviewProposal(company.id, proposal.id, { decision: 'approve', expectedRevision: 1 }, owner), svc.reviewProposal(company.id, proposal.id, { decision: 'approve', expectedRevision: 1 }, owner)]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(x => x.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(await svc.getBrief(company.id)).toMatchObject({ revision: 2, sources: input.sources, facts: [...input.facts, { key: 'audience', value: 'Small businesses', sourceReference: 'owner-input' }] });
    expect(await svc.listProposals(company.id, owner)).toEqual(expect.arrayContaining([expect.objectContaining({ id: proposal.id, status: 'approved', reviewedByUserId: 'owner' }), expect.objectContaining({ id: other.id, status: 'proposed' })]));
    await expect(svc.reviewProposal(company.id, other.id, { decision: 'approve', expectedRevision: 2 }, owner)).rejects.toMatchObject({ status: 409 });
    await svc.reviewProposal(company.id, other.id, { decision: 'reject', expectedRevision: 2 }, owner);
    expect((await svc.getBrief(company.id)).revision).toBe(2);
  });
  it('rejects stale and cross-company proposal reviews and agent publication', async () => {
    const { company, agent, svc } = await fixture(); const other = await fixture();
    await svc.updateBrief(company.id, input, owner);
    const proposal = await svc.proposeFacts(company.id, agent.id, { facts: input.facts, sourceReferences: ['owner-input'] });
    expect(typeof svc.reviewProposal).toBe('function');
    await expect(svc.reviewProposal(other.company.id, proposal.id, { decision: 'approve', expectedRevision: 1 }, owner)).rejects.toMatchObject({ status: 404 });
    await expect(svc.reviewProposal(company.id, proposal.id, { decision: 'approve', expectedRevision: 1 }, { agentId: agent.id })).rejects.toMatchObject({ status: 403 });
    await svc.updateBrief(company.id, { expectedRevision: 1, sources: [], facts: [] }, owner);
    await expect(svc.reviewProposal(company.id, proposal.id, { decision: 'approve', expectedRevision: 2 }, owner)).rejects.toMatchObject({ status: 409 });
    expect((await svc.getBrief(company.id)).facts).toEqual([]);
  });
  it('updates declared targets atomically without altering role, instructions, or the first job snapshot', async () => {
    const { company, agent, svc } = await fixture(); const other = await fixture();
    const [goal] = await db.insert(goals).values({ companyId: company.id, title: 'Demand' }).returning();
    const [foreign] = await db.insert(goals).values({ companyId: other.company.id, title: 'Private' }).returning();
    await svc.enroll(company.id, agent.id, { templateId: 'sales-support', objective: 'Original', goalId: goal.id }, owner);
    const job = await svc.startFirstJob(company.id, agent.id, owner);
    expect(typeof svc.updateEnrollment).toBe('function');
    await expect(svc.updateEnrollment(company.id, agent.id, { objective: 'Must not persist', goalId: foreign.id }, owner)).rejects.toMatchObject({ status: 404 });
    expect((await svc.getEnrollment(company.id, agent.id))?.objective).toBe('Original');
    const updated = await svc.updateEnrollment(company.id, agent.id, { objective: 'Qualify 20 leads', metrics: ['20 qualified leads'], goalId: null }, owner);
    expect(updated).toMatchObject({ templateId: 'sales-support', templateVersion: 1, objective: 'Qualify 20 leads', metrics: ['20 qualified leads'], goalId: null });
    expect((await svc.startFirstJob(company.id, agent.id, owner)).goalId).toBe(job.goalId);
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0].adapterConfig).toEqual({ custom: 'preserved' });
    await expect(svc.updateEnrollment(other.company.id, agent.id, { metrics: [] }, owner)).rejects.toMatchObject({ status: 404 });
  });

  it('rolls back oversized proposal approval without review credit or partial publication', async () => {
    const { company, agent, svc } = await fixture();
    await svc.updateBrief(company.id, { ...input, facts: Array.from({ length: 40 }, (_, i) => ({ key: `key-${i}`, value: 'Approved', sourceReference: 'owner-input' })) }, owner);
    const proposal = await svc.proposeFacts(company.id, agent.id, { facts: [{ key: 'extra', value: 'Too many', sourceReference: 'owner-input' }], sourceReferences: ['owner-input'] });
    await expect(svc.reviewProposal(company.id, proposal.id, { decision: 'approve', expectedRevision: 1 }, owner)).rejects.toBeDefined();
    expect((await svc.getBrief(company.id)).revision).toBe(1);
    expect((await svc.listProposals(company.id, owner))[0].status).toBe('proposed');
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, 'workforce.proposal_approved')))).toHaveLength(0);
  });

});
