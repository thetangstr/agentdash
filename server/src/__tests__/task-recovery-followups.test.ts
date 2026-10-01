// AgentDash (GH #891): follow-ups to the named-human recovery permit (#890).
//  - F-A: checkout / lock adoption / agent PATCH cannot hand an exhausted issue
//    to any run except the exact permit-bound run.
//  - "Authorize one run": a signed-in board SESSION user reaches the same
//    task_recovery.remediate operation; board keys, assistant grants, agents
//    and the implicit local operator cannot use the session route.
//  - F4: authorizing needs a company admin or someone who manages the agent.
//  - A bound run refused by an earlier start check finalizes its permit.
//  - The "permit consumed" row is the system's, with the authorizer in details.
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { activityLog, agents, authSessions, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueRelations, issues } from '@paperclipai/db';
import { errorHandler } from '../middleware/error-handler.js';
import { heartbeatService } from '../services/heartbeat.ts';
import { issueService } from '../services/issues.ts';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: 'done', provider: 'test', model: 'test' })),
);

vi.mock('../adapters/index.ts', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.ts')>('../adapters/index.ts');
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping task-recovery follow-up tests: ${embeddedPostgresSupport.reason ?? 'unsupported environment'}`);
}

type ActorKind = 'session' | 'board_key' | 'assistant_grant' | 'agent' | 'local_implicit';

describeEmbeddedPostgres('task recovery follow-ups (GH #891)', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let server: Server | undefined;
  let base: string;
  let holdDispatch = false;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('task-recovery-891-');
    db = createDb(temp.connectionString);
    heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const gatedHeartbeat = {
      ...heartbeat,
      dispatchQueuedRunsForAgent: async (agentId: string) => (holdDispatch ? [] : heartbeat.dispatchQueuedRunsForAgent(agentId)),
    };
    const bridge = await import('../routes/human-control.js');
    const app = express();
    app.use(express.json());
    // Test actor middleware: the real session middleware needs better-auth;
    // here the header names the actor shape the real middleware would build.
    app.use(async (req, _res, next) => {
      const kind = (req.header('x-test-actor') ?? 'session') as ActorKind;
      const userId = req.header('x-test-user') ?? '';
      const sessionId = req.header('x-test-session') ?? '';
      const memberships = userId
        ? await db.select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
          .from(companyMemberships)
          .where(and(eq(companyMemberships.principalType, 'user'), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, 'active')))
        : [];
      const r = req as Request & { actor: Record<string, unknown>; verifiedCredential?: unknown };
      if (kind === 'agent') {
        r.actor = { type: 'agent', agentId: req.header('x-test-agent'), companyId: memberships[0]?.companyId, source: 'agent_key' };
      } else if (kind === 'local_implicit') {
        r.actor = { type: 'board', userId: 'local-board', source: 'local_implicit', isInstanceAdmin: true, companyIds: [], memberships: [] };
      } else {
        r.actor = { type: 'board', userId, companyIds: memberships.map((m) => m.companyId), memberships, isInstanceAdmin: false, source: kind };
        if (kind === 'session') r.verifiedCredential = { kind: 'session', sessionId, userId };
        if (kind === 'assistant_grant') r.verifiedCredential = { kind: 'assistant', origin: 'test' };
      }
      next();
    });
    app.use('/api/human-control', bridge.humanControlRoutes(db, { heartbeat: gatedHeartbeat }));
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/human-control`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await temp?.cleanup();
  });

  async function person(companyId: string, role: string) {
    const userId = randomUUID(), sessionId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: `Person ${role}`, email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(authSessions).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: 'user', principalId: userId, membershipRole: role, status: 'active' });
    return { userId, sessionId };
  }

  async function seed(options: { agentAccountableUserId?: string | null; agentCreatedByUserId?: string | null } = {}) {
    const [company] = await db.insert(companies).values({ name: 'Recovery 891', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const admin = await person(company.id, 'admin');
    const agentId = randomUUID(), issueId = randomUUID(), refusedRunId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId: company.id, name: 'Maya', role: 'engineer', status: 'idle',
      adapterType: 'codex_local', adapterConfig: {}, runtimeConfig: {}, permissions: {},
      accountableUserId: options.agentAccountableUserId ?? null, createdByUserId: options.agentCreatedByUserId ?? null,
    });
    await db.insert(issues).values({
      id: issueId, companyId: company.id, title: 'Exhausted task', status: 'blocked', priority: 'medium',
      assigneeAgentId: agentId, issueNumber: 1, identifier: `${company.issuePrefix}-1`,
      executionState: {
        recoveryBudget: {
          status: 'exhausted', exhaustedBy: ['cost'],
          usage: { automaticRetries: 1, providerTurns: 12, providerTokens: 500_000, providerCostUsd: 0.25, runtimeMs: 300_000 },
          limits: { automaticRetries: 1, providerTurns: 12, providerTokens: 500_000, providerCostUsd: 0.25, runtimeMs: 300_000 },
          exhaustedAt: '2026-03-20T00:00:00.000Z', sourceRunId: null, refusedRunId,
        },
      },
    });
    return { company, admin, agentId, issueId };
  }

  async function call(path: string, body: unknown, actor: { kind?: ActorKind; userId?: string; sessionId?: string; agentId?: string }) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-actor': actor.kind ?? 'session',
        'x-test-user': actor.userId ?? '',
        'x-test-session': actor.sessionId ?? '',
        'x-test-agent': actor.agentId ?? '',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  const permitOf = async (issueId: string) => {
    const [row] = await db.select({ executionState: issues.executionState }).from(issues).where(eq(issues.id, issueId));
    return ((row?.executionState as Record<string, unknown> | null)?.recoveryBudget as Record<string, unknown> | undefined)?.remediation as Record<string, unknown> | undefined;
  };
  const liveRunsFor = (companyId: string, issueId: string) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
    sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
  ));

  async function authorizeAsSession(issueId: string, who: { userId: string; sessionId: string }) {
    const preview = await call(`/issues/${issueId}/recovery-run/preview`, {}, who);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    return call(`/issues/${issueId}/recovery-run/authorize`, { preconditions: preview.body.preconditions }, who);
  }

  it('a session admin reviews then authorizes exactly one run; the consumed row is the system\'s', async () => {
    const { company, admin, agentId, issueId } = await seed();
    const preview = await call(`/issues/${issueId}/recovery-run/preview`, {}, admin);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.readback.context.issue).toMatchObject({ issueId, assigneeAgentName: 'Maya', exhausted: true });
    // Reviewing creates nothing.
    expect(await permitOf(issueId)).toBeUndefined();
    expect(await liveRunsFor(company.id, issueId)).toHaveLength(0);

    const applied = await call(`/issues/${issueId}/recovery-run/authorize`, { preconditions: preview.body.preconditions }, admin);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.status).toBe('completed');
    const permit = await permitOf(issueId);
    expect(permit).toMatchObject({ status: 'consumed', authorizedByUserId: admin.userId, authorizedVia: 'session', assigneeAgentId: agentId });

    const authorized = await db.select().from(activityLog).where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, 'issue.task_recovery_authorized')));
    expect(authorized).toHaveLength(1);
    expect(authorized[0]).toMatchObject({ actorType: 'user', actorId: admin.userId });
    expect(authorized[0].details).toMatchObject({ grantedVia: 'session' });
    const consumed = await db.select().from(activityLog).where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, 'issue.task_recovery_permit_consumed')));
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ actorType: 'system', actorId: 'system' });
    expect(consumed[0].details).toMatchObject({ permitGrantedByUserId: admin.userId, permitGrantedVia: 'session', runId: permit!.runId });

    // A second authorization while the marker holds a consumed permit is a
    // fresh decision, but replaying the old preconditions is refused.
    const replay = await call(`/issues/${issueId}/recovery-run/authorize`, { preconditions: preview.body.preconditions }, admin);
    expect(replay.status).toBe(409);
  });

  it('refuses preconditions that do not match what is on the issue now, and mints nothing', async () => {
    const { company, admin, issueId } = await seed();
    const preview = await call(`/issues/${issueId}/recovery-run/preview`, {}, admin);
    const tampered = { ...preview.body.preconditions, exhaustedAt: '2020-01-01T00:00:00.000Z' };
    const applied = await call(`/issues/${issueId}/recovery-run/authorize`, { preconditions: tampered }, admin);
    expect(applied.status).toBe(409);
    expect(await permitOf(issueId)).toBeUndefined();
    expect(await liveRunsFor(company.id, issueId)).toHaveLength(0);
  });

  it.each(['board_key', 'assistant_grant', 'agent', 'local_implicit'] as const)('the session route refuses a %s caller', async (kind) => {
    const { company, admin, agentId, issueId } = await seed();
    const actor = { kind, userId: admin.userId, sessionId: admin.sessionId, agentId };
    const preview = await call(`/issues/${issueId}/recovery-run/preview`, {}, actor);
    expect(preview.status).toBeGreaterThanOrEqual(400);
    expect(preview.status).toBeLessThan(500);
    const applied = await call(`/issues/${issueId}/recovery-run/authorize`, { preconditions: {} }, actor);
    expect(applied.status).toBeGreaterThanOrEqual(400);
    expect(applied.status).toBeLessThan(500);
    expect(await permitOf(issueId)).toBeUndefined();
    expect(await liveRunsFor(company.id, issueId)).toHaveLength(0);
  });

  it('a session user of another company gets 404, not a hint the issue exists', async () => {
    const { issueId } = await seed();
    const other = await seed();
    const res = await call(`/issues/${issueId}/recovery-run/preview`, {}, other.admin);
    expect(res.status).toBe(404);
  });

  it('F4: a plain member (or legacy viewer) cannot authorize; the agent\'s accountable person or creator can', async () => {
    const { company, issueId } = await seed();
    for (const role of ['member', 'viewer']) {
      const plain = await person(company.id, role);
      const res = await call(`/issues/${issueId}/recovery-run/preview`, {}, plain);
      expect(res.status, role).toBe(403);
      expect(res.body.error).toContain('manages this issue');
    }
    expect(await permitOf(issueId)).toBeUndefined();

    const accountableCompany = await seed();
    const accountable = await person(accountableCompany.company.id, 'member');
    await db.update(agents).set({ accountableUserId: accountable.userId }).where(eq(agents.id, accountableCompany.agentId));
    holdDispatch = true;
    try {
      const applied = await authorizeAsSession(accountableCompany.issueId, accountable);
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    } finally {
      holdDispatch = false;
    }
    expect(await permitOf(accountableCompany.issueId)).toMatchObject({ status: 'authorized', authorizedByUserId: accountable.userId });

    const createdCompany = await seed();
    const creator = await person(createdCompany.company.id, 'member');
    await db.update(agents).set({ createdByUserId: creator.userId }).where(eq(agents.id, createdCompany.agentId));
    holdDispatch = true;
    try {
      expect((await authorizeAsSession(createdCompany.issueId, creator)).status).toBe(200);
    } finally {
      holdDispatch = false;
    }
  });

  it('F-A: an agent in an unrelated live run cannot check out or adopt an exhausted issue', async () => {
    const { company, agentId, issueId } = await seed();
    const issuesSvc = issueService(db);
    // A live run of the same agent that does not name this issue (a timer run).
    const [timerRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId, invocationSource: 'timer', triggerDetail: 'system', status: 'running', contextSnapshot: {},
    }).returning();

    await expect(issuesSvc.checkout(issueId, agentId, ['blocked'], timerRun.id)).rejects.toMatchObject({ status: 409 });
    await expect(issuesSvc.checkout(issueId, agentId, ['blocked'], null)).rejects.toMatchObject({ status: 409 });
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after.status).toBe('blocked');
    expect(after.checkoutRunId).toBeNull();

    // A board user moves it to in_progress (allowed; it does not clear the
    // block). The timer run still cannot adopt the execution lock.
    await db.update(issues).set({ status: 'in_progress' }).where(eq(issues.id, issueId));
    await expect(issuesSvc.assertCheckoutOwner(issueId, agentId, timerRun.id)).rejects.toMatchObject({ status: 409 });
    const [stillUnowned] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(stillUnowned.checkoutRunId).toBeNull();
    expect(stillUnowned.executionRunId).toBeNull();
  });

  it('F-A: the exact permit-bound run, once claimed, can check the issue out', async () => {
    const { company, admin, agentId, issueId } = await seed();
    const applied = await authorizeAsSession(issueId, admin);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const permit = await permitOf(issueId);
    expect(permit?.status).toBe('consumed');
    const issuesSvc = issueService(db);
    const checkedOut = await issuesSvc.checkout(issueId, agentId, ['blocked'], permit!.runId as string);
    expect(checkedOut).toMatchObject({ status: 'in_progress', checkoutRunId: permit!.runId });
    // A sibling run of the same agent is still refused.
    const [sibling] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId, invocationSource: 'timer', triggerDetail: 'system', status: 'running', contextSnapshot: {},
    }).returning();
    await expect(issuesSvc.checkout(issueId, agentId, ['in_progress'], sibling.id)).rejects.toMatchObject({ status: 409 });
  });

  it('a bound run refused by an earlier start check finalizes its permit as denied, recorded by the system', async () => {
    const { company, admin, agentId, issueId } = await seed();
    holdDispatch = true;
    try {
      expect((await authorizeAsSession(issueId, admin)).status).toBe(200);
    } finally {
      holdDispatch = false;
    }
    expect(await permitOf(issueId)).toMatchObject({ status: 'authorized' });
    // An unresolved blocker appears before the authorized run starts: the
    // claim's dependency check cancels the run before it can use the permit.
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId, companyId: company.id, title: 'New prerequisite', status: 'todo', priority: 'medium',
      issueNumber: 2, identifier: `${company.issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({ companyId: company.id, issueId: blockerId, relatedIssueId: issueId, type: 'blocks' });
    const [bound] = await liveRunsFor(company.id, issueId);
    expect(bound).toBeTruthy();
    await heartbeat.dispatchQueuedRunsForAgent(agentId);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, bound.id));
    expect(run.status).toBe('cancelled');
    const permit = await permitOf(issueId);
    expect(permit?.status).toBe('denied');
    expect(String(permit?.denialReason ?? '')).toContain('stopped before it started');
    const denied = await db.select().from(activityLog).where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, 'issue.task_recovery_permit_denied')));
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0]).toMatchObject({ actorType: 'system', actorId: 'system' });
    expect(denied[0].details).toMatchObject({ permitGrantedByUserId: admin.userId, runId: bound.id });
  });
});
