import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, companies, companyMemberships, cosOnboardingStates, assistantConversations, assistantMessages, createDb } from '@paperclipai/db';
import { isAgentPlanPayload, assistantPrepareHireSchema } from '@paperclipai/shared';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { agentRoutes } from '../routes/agents.js';
import { onboardingV2Routes } from '../routes/onboarding-v2.js';
import { workforceService } from '../services/workforce.js';
import { agentInstructionRefreshService } from '../services/agent-instruction-refresh.js';
import { agentService } from '../services/agents.js';
import { errorHandler } from '../middleware/index.js';
const llm = vi.hoisted(() => vi.fn());
vi.mock('../services/dispatch-llm.js', () => ({ dispatchLLM: llm }));

const plan = (workforceTemplateId?: string) => ({ rationale: 'Grow demand', alignmentToShortTerm: 'Campaign', alignmentToLongTerm: 'Revenue', agents: [{ name: 'Ari', role: 'Content writer', adapterType: 'codex_local', responsibilities: ['Write'], kpis: ['Drafts'], ...(workforceTemplateId ? { workforceTemplateId } : {}) }] });

describe('workforce hiring entry points', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousStripe = process.env.STRIPE_SECRET_KEY, previousBilling = process.env.AGENTDASH_BILLING_DISABLED;
  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_local_hiring'; delete process.env.AGENTDASH_BILLING_DISABLED;
    home = await mkdtemp(path.join(tmpdir(), 'workforce-hiring-')); process.env.PAPERCLIP_HOME = home;
    temp = await startEmbeddedPostgresTestDatabase('workforce-hiring-'); db = createDb(temp.connectionString);
  });
  afterAll(async () => { if (previousStripe === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousStripe; if (previousBilling === undefined) delete process.env.AGENTDASH_BILLING_DISABLED; else process.env.AGENTDASH_BILLING_DISABLED = previousBilling; await temp?.cleanup(); await rm(home, { recursive: true, force: true }); if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome; });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Hiring', planTier: 'pro_active', issuePrefix: randomUUID().slice(0, 8), requireBoardApprovalForNewAgents: false }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "owner", membershipRole: "admin", status: "active" });
    const cos = await agentService(db).create(company.id, { name: 'Configured leader', role: 'chief_of_staff', adapterType: 'codex_local' });
    const [conversation] = await db.insert(assistantConversations).values({ companyId: company.id, userId: 'owner', assistantAgentId: cos.id }).returning();
    await db.insert(cosOnboardingStates).values({ conversationId: conversation.id, phase: "plan" });
    const board = { type: 'board', source: 'local_implicit', isInstanceAdmin: true, userId: 'owner' };
    function app(actor: Record<string, unknown> = board) {
      const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
      app.use('/api', agentRoutes(db)); app.use('/api/onboarding', onboardingV2Routes(db)); app.use(errorHandler); return app;
    }
    return { company, cos, conversation, app };
  }
  async function assertSelected(companyId: string, agentId: string) {
    const svc = workforceService(db);
    expect(await svc.getEnrollment(companyId, agentId)).toMatchObject({ templateId: 'marketing-content', templateVersion: 1, skillInstallError: null });
    expect((await svc.getEnrollment(companyId, agentId))!.installedSkillKeys).toHaveLength(1);
    expect((await svc.getReadiness(companyId, agentId))!.phase).not.toBe('ready');
  }
  it.each(['agents', 'agent-hires'])('ordinary %s installs selected skills after create and preserves custom instructions', async endpoint => {
    const f = await fixture();
    const response = await request(f.app()).post(`/api/companies/${f.company.id}/${endpoint}`).send({ name: 'Ari', adapterType: 'codex_local', workforceTemplateId: 'marketing-content', instructionsBundle: { files: { 'AGENTS.md': '# Custom company writer' } } });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const agent = response.body.agent ?? response.body;
    await assertSelected(f.company.id, agent.id);
    const saved = await agentService(db).getById(agent.id);
    expect(await readFile(saved!.adapterConfig.instructionsFilePath as string, 'utf8')).toContain('Custom company writer');
    await agentInstructionRefreshService({ db }).refreshIfStale(agent.id);
    expect(await readFile(saved!.adapterConfig.instructionsFilePath as string, "utf8")).toContain("Custom company writer");
    expect((await workforceService(db).getRuntimeContext(f.company.id, agent.id))!.template.procedures.length).toBeGreaterThan(0);
  });
  it.each(['agents', 'agent-hires'])('ordinary %s rejects member-selected templates while preserving ordinary hiring', async endpoint => {
    const f = await fixture();
    const member = { type: 'board', source: 'session', userId: 'member', companyIds: [f.company.id], memberships: [{ companyId: f.company.id, status: 'active', membershipRole: 'member' }] };
    const response = await request(f.app(member)).post(`/api/companies/${f.company.id}/${endpoint}`).send({ name: 'Ari', adapterType: 'codex_local', workforceTemplateId: 'marketing-content' });
    expect(response.status).toBe(403);
    expect(await db.select().from(agents).where(eq(agents.companyId, f.company.id))).toHaveLength(1);
    const legacy = await request(f.app()).post(`/api/companies/${f.company.id}/${endpoint}`).send({ name: 'Custom', adapterType: 'codex_local' });
    expect(legacy.status).toBe(201);
    expect(await workforceService(db).getEnrollment(f.company.id, (legacy.body.agent ?? legacy.body).id)).toBeNull();
  });
  it('single proposal uses company leader adapter and explicit selection', async () => {
    const f = await fixture();
    llm.mockResolvedValue('```json\n' + JSON.stringify({ name: 'Ari', role: 'Writer', oneLineOkr: 'Draft campaign', rationale: 'Demand', workforceTemplateId: 'marketing-content' }) + '\n```');
    const response = await request(f.app()).post('/api/onboarding/agent/confirm').send({ companyId: f.company.id, conversationId: f.conversation.id, reportsToAgentId: f.cos.id });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((await agentService(db).getById(response.body.agent.id))!.adapterType).toBe('codex_local');
    await assertSelected(f.company.id, response.body.agent.id);
    expect((await agentService(db).getById(response.body.agent.id))!.adapterConfig.instructionsFilePath).toEqual(expect.any(String));
  });
  it('saved team plan preserves selection and installs after transaction commits', async () => {
    const f = await fixture();
    await db.insert(assistantMessages).values({ conversationId: f.conversation.id, role: 'assistant', content: '', cardKind: 'agent_plan_proposal_v1', cardPayload: plan('marketing-content') });
    const response = await request(f.app()).post('/api/onboarding/confirm-plan').send({ conversationId: f.conversation.id });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    await assertSelected(f.company.id, response.body.createdAgentIds[0]);
    const saved = await agentService(db).getById(response.body.createdAgentIds[0]);
    expect(saved!.adapterConfig.instructionsFilePath).toEqual(expect.any(String));
    expect(await readFile(saved!.adapterConfig.instructionsFilePath as string, "utf8")).toContain("workforce-learning");
  });
  it('refuses unknown selected templates in saved plans before creating agents', async () => {
    const f = await fixture();
    await db.insert(assistantMessages).values({ conversationId: f.conversation.id, role: 'assistant', content: '', cardKind: 'agent_plan_proposal_v1', cardPayload: plan('invented') });
    const response = await request(f.app()).post('/api/onboarding/confirm-plan').send({ conversationId: f.conversation.id });
    expect(response.status).toBe(400);
    expect(await db.select().from(agents).where(eq(agents.companyId, f.company.id))).toHaveLength(1);
  });
  it.each(['agents', 'agent-hires'])('ordinary %s supports the local operator without a named account', async endpoint => {
    const f = await fixture();
    const response = await request(f.app({ type: 'board', source: 'local_implicit', isInstanceAdmin: true })).post(`/api/companies/${f.company.id}/${endpoint}`).send({ name: 'Local writer', adapterType: 'codex_local', workforceTemplateId: 'marketing-content' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    await assertSelected(f.company.id, (response.body.agent ?? response.body).id);
  });
  it.each(['agents', 'agent-hires'])('ordinary %s denies template selection even to agents with hiring capability', async endpoint => {
    const f = await fixture();
    await agentService(db).update(f.cos.id, { permissions: { canCreateAgents: true } });
    const response = await request(f.app({ type: 'agent', companyId: f.company.id, agentId: f.cos.id })).post(`/api/companies/${f.company.id}/${endpoint}`).send({ name: 'Ari', adapterType: 'codex_local', workforceTemplateId: 'marketing-content' });
    expect(response.status).toBe(403);
    expect(await db.select().from(agents).where(eq(agents.companyId, f.company.id))).toHaveLength(1);
  });
  it.each(['agents', 'agent-hires'])('ordinary %s refuses unknown IDs without creating or substituting a worker', async endpoint => {
    const f = await fixture();
    const response = await request(f.app()).post(`/api/companies/${f.company.id}/${endpoint}`).send({ name: 'Ari', adapterType: 'codex_local', workforceTemplateId: 'invented' });
    expect(response.status).toBe(400);
    expect(await db.select().from(agents).where(eq(agents.companyId, f.company.id))).toHaveLength(1);
  });
  it('keeps unselected single and saved-team hires compatible', async () => {
    const f = await fixture();
    llm.mockResolvedValue('```json\n' + JSON.stringify({ name: 'Custom', role: 'General helper', oneLineOkr: 'Help', rationale: 'Custom' }) + '\n```');
    const single = await request(f.app()).post('/api/onboarding/agent/confirm').send({ companyId: f.company.id, conversationId: f.conversation.id, reportsToAgentId: f.cos.id });
    expect(single.status, JSON.stringify(single.body)).toBe(201);
    expect(await workforceService(db).getEnrollment(f.company.id, single.body.agent.id)).toBeNull();
    await db.insert(assistantMessages).values({ conversationId: f.conversation.id, role: 'assistant', content: '', cardKind: 'agent_plan_proposal_v1', cardPayload: plan() });
    const team = await request(f.app()).post('/api/onboarding/confirm-plan').send({ conversationId: f.conversation.id });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    expect(await workforceService(db).getEnrollment(f.company.id, team.body.createdAgentIds[0])).toBeNull();
  });
  it('refuses unknown single proposals and cross-company reporting agents', async () => {
    const f = await fixture(), foreign = await fixture();
    const propose = (workforceTemplateId: string) => llm.mockResolvedValue('```json\n' + JSON.stringify({ name: 'Ari', role: 'Writer', oneLineOkr: 'Draft campaign', rationale: 'Demand', workforceTemplateId }) + '\n```');
    propose('invented');
    const invalid = await request(f.app()).post('/api/onboarding/agent/confirm').send({ companyId: f.company.id, conversationId: f.conversation.id, reportsToAgentId: f.cos.id });
    expect(invalid.status).toBe(400);
    propose('marketing-content');
    const cross = await request(f.app()).post('/api/onboarding/agent/confirm').send({ companyId: f.company.id, conversationId: f.conversation.id, reportsToAgentId: foreign.cos.id });
    expect(cross.status).toBe(404);
    expect(await db.select().from(agents).where(eq(agents.companyId, f.company.id))).toHaveLength(1);
  });
  it('enforces direction authority on both onboarding materializers', async () => {
    const f = await fixture();
    const member = { type: 'board', source: 'session', userId: 'member', companyIds: [f.company.id], memberships: [{ companyId: f.company.id, status: 'active', membershipRole: 'member' }] };
    llm.mockResolvedValue('```json\n' + JSON.stringify({ name: 'Ari', role: 'Writer', oneLineOkr: 'Draft campaign', rationale: 'Demand', workforceTemplateId: 'marketing-content' }) + '\n```');
    const single = await request(f.app(member)).post('/api/onboarding/agent/confirm').send({ companyId: f.company.id, conversationId: f.conversation.id, reportsToAgentId: f.cos.id });
    expect(single.status).toBe(403);
    await db.insert(assistantMessages).values({ conversationId: f.conversation.id, role: 'assistant', content: '', cardKind: 'agent_plan_proposal_v1', cardPayload: plan('marketing-content') });
    const team = await request(f.app(member)).post('/api/onboarding/confirm-plan').send({ conversationId: f.conversation.id });
    expect(team.status).toBe(403);
    expect(await db.select().from(agents).where(eq(agents.companyId, f.company.id))).toHaveLength(1);
  });
  it('honors explicit single-hire selection when the proposed display role is custom', async () => {
    const f = await fixture();
    llm.mockResolvedValue('```json\n' + JSON.stringify({ name: 'Ari', role: 'General helper', oneLineOkr: 'Help with launch', rationale: 'Custom' }) + '\n```');
    const response = await request(f.app()).post('/api/onboarding/agent/confirm').send({ companyId: f.company.id, conversationId: f.conversation.id, reportsToAgentId: f.cos.id, workforceTemplateId: 'marketing-content' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    await assertSelected(f.company.id, response.body.agent.id);
    expect((await agentService(db).getById(response.body.agent.id))!.role).toBe('general');
  });
  it('revises a saved plan and confirms its retained selection', async () => {
    const f = await fixture();
    await db.insert(assistantMessages).values({ conversationId: f.conversation.id, role: 'assistant', content: '', cardKind: 'agent_plan_proposal_v1', cardPayload: plan('marketing-content') });
    const revised = plan('marketing-content'); revised.agents[0].name = 'Renamed';
    llm.mockResolvedValue('```json\n' + JSON.stringify({ plan: revised }) + '\n```');
    const response = await request(f.app()).post('/api/onboarding/revise-plan').send({ conversationId: f.conversation.id, revisionText: 'Rename Ari to Renamed' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const confirm = await request(f.app()).post('/api/onboarding/confirm-plan').send({ conversationId: f.conversation.id });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(201);
    await assertSelected(f.company.id, confirm.body.createdAgentIds[0]);
    expect((await agentService(db).getById(confirm.body.createdAgentIds[0]))!.name).toBe('Renamed');
  });
  it('accepts selected plans on every native prompt adapter without permitting custom runners', () => {
    for (const adapterType of ['claude_local', 'codex_local', 'gemini_local', 'cursor', 'opencode_local', 'pi_local', 'acpx_local', 'openclaw_gateway', 'hermes_local']) {
      const payload = plan('marketing-content'); payload.agents[0].adapterType = adapterType;
      expect(isAgentPlanPayload(payload), adapterType).toBe(true);
    }
    const unsupported = plan('marketing-content'); unsupported.agents[0].adapterType = 'process';
    expect(isAgentPlanPayload(unsupported)).toBe(false);
  });
  it('validates legacy plans, rejects unknown selection and retains assistant selection', () => {
    expect(isAgentPlanPayload(plan())).toBe(true);
    expect(isAgentPlanPayload(plan('invented'))).toBe(false);
    expect(assistantPrepareHireSchema.parse({ role: 'writer', reason: 'campaign', workforceTemplateId: 'marketing-content' })).toHaveProperty('workforceTemplateId', 'marketing-content');
  });
});
