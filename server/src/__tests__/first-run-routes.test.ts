// AgentDash (GH #786): the hosted first run, against a real database.
// Real routes, authz, services and tier policy; the heartbeat wakeup and the
// Hermes provider status are injected.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  githubRepoConnections,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { firstRunRoutes } from "../routes/first-run.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("first-run routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const saved: Record<string, string | undefined> = {};
  let providerConfigured = true;
  let hosted = true;
  const wakeups: Array<{ agentId: string; issueId: unknown }> = [];

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "STRIPE_SECRET_KEY", "AGENTDASH_BILLING_DISABLED", "AGENTDASH_DEFAULT_ADAPTER"]) {
      saved[key] = process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), "first-run-routes-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "first-run-test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.AGENTDASH_BILLING_DISABLED;
    delete process.env.AGENTDASH_DEFAULT_ADAPTER;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-first-run-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    providerConfigured = true;
    hosted = true;
    wakeups.length = 0;
    delete process.env.STRIPE_SECRET_KEY;
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(githubRepoConnections);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });

  async function seed(opts: { profile?: "default" | "agentdash_mk"; connect?: boolean; extraAgents?: string[] } = {}) {
    const company = await db
      .insert(companies)
      .values({
        name: `FR ${randomUUID()}`,
        issuePrefix: `F${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: opts.profile ?? "default",
      })
      .returning()
      .then((rows) => rows[0]!);
    const ownerId = `owner-${randomUUID()}`;
    const memberId = `member-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
      { companyId: company.id, principalType: "user", principalId: memberId, status: "active", membershipRole: "member" },
    ]);
    const cos = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Chief of Staff", role: "chief_of_staff", status: "idle", adapterType: "hermes_local" })
      .returning()
      .then((rows) => rows[0]!);
    for (const role of opts.extraAgents ?? []) {
      await db.insert(agents).values({ companyId: company.id, name: `${role} ${randomUUID()}`, role, status: "idle", adapterType: "hermes_local" });
    }
    let projectId: string | null = null;
    if (opts.connect !== false) {
      const project = await db.insert(projects).values({ companyId: company.id, name: "app" }).returning().then((rows) => rows[0]!);
      const workspace = await db
        .insert(projectWorkspaces)
        .values({ companyId: company.id, projectId: project.id, name: "app", sourceType: "git_repo", repoUrl: "https://github.com/acme/app", isPrimary: true })
        .returning()
        .then((rows) => rows[0]!);
      await db.insert(githubRepoConnections).values({
        companyId: company.id,
        projectId: project.id,
        projectWorkspaceId: workspace.id,
        repoFullName: "acme/app",
        repoOwner: "acme",
        repoName: "app",
        credentialSource: "pat",
      });
      projectId = project.id;
    }
    const board = (userId: string, role: string) => ({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [company.id],
      memberships: [{ companyId: company.id, status: "active", membershipRole: role }],
    });
    return { company, cos, projectId, owner: board(ownerId, "owner"), member: board(memberId, "member") };
  }

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use(
      "/api",
      firstRunRoutes(db, {
        isHostedBox: () => hosted,
        hermesProviderConfigured: async () => providerConfigured,
        heartbeat: {
          wakeup: vi.fn(async (agentId: string, opts: { payload?: Record<string, unknown> }) => {
            wakeups.push({ agentId, issueId: opts.payload?.issueId });
            return null;
          }),
        } as never,
      }),
    );
    a.use(errorHandler);
    return a;
  }

  it("resumes at the first incomplete step: model, then repo, then first issue, then done", async () => {
    const { company, owner } = await seed({ connect: false });
    providerConfigured = false;
    const get = () => request(app(owner)).get(`/api/companies/${company.id}/first-run`);

    let res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applies: true, nextStep: "model", canManage: true, model: { required: true, done: false } });
    expect(res.body.suggestions).toHaveLength(3);

    providerConfigured = true;
    expect((await get()).body.nextStep).toBe("repo");

    const project = await db.insert(projects).values({ companyId: company.id, name: "app" }).returning().then((rows) => rows[0]!);
    const workspace = await db
      .insert(projectWorkspaces)
      .values({ companyId: company.id, projectId: project.id, name: "app", sourceType: "git_repo", repoUrl: "https://github.com/acme/app" })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(githubRepoConnections).values({
      companyId: company.id,
      projectId: project.id,
      projectWorkspaceId: workspace.id,
      repoFullName: "acme/app",
      repoOwner: "acme",
      repoName: "app",
    });
    res = await get();
    expect(res.body).toMatchObject({ nextStep: "first_issue", repo: { done: true, repo: "acme/app", projectId: project.id } });

    await request(app(owner)).post(`/api/companies/${company.id}/first-run/first-issue`).send({ title: "Add a health badge" }).expect(201);
    res = await get();
    expect(res.body.nextStep).toBe("done");
    expect(res.body.firstIssue).toMatchObject({ done: true, title: "Add a health badge", assigneeName: "Engineer" });
  });

  // AgentDash: GitHub is optional; a company that ships without a repo works without code.
  it("reports work shipped without a repo, and not once a repo is connected", async () => {
    const { company, owner } = await seed({ connect: false });
    const get = () => request(app(owner)).get(`/api/companies/${company.id}/first-run`);
    expect((await get()).body.repo).toMatchObject({ done: false, shippedWithoutRepo: false });

    await db.insert(issues).values({ companyId: company.id, title: "Draft the launch post", status: "in_review" });
    expect((await get()).body.repo.shippedWithoutRepo).toBe(false);

    await db.insert(issues).values({ companyId: company.id, title: "Market scan", status: "done" });
    const res = await get();
    expect(res.body.nextStep).toBe("repo");
    expect(res.body.repo).toMatchObject({ done: false, shippedWithoutRepo: true });

    const connected = await seed();
    await db.insert(issues).values({ companyId: connected.company.id, title: "Shipped", status: "done" });
    const connectedRes = await request(app(connected.owner)).get(`/api/companies/${connected.company.id}/first-run`);
    expect(connectedRes.body.repo).toMatchObject({ done: true, shippedWithoutRepo: false });
  });

  it("shows the Home nudge on a hosted box for a new company", async () => {
    const { company, owner } = await seed({ connect: false });
    const res = await request(app(owner)).get(`/api/companies/${company.id}/first-run`);
    expect(res.body).toMatchObject({ applies: true, showHomeNudge: true });
  });

  it("never shows the Home nudge off a hosted box, but /setup still applies", async () => {
    hosted = false;
    const { company, owner } = await seed({ connect: false });
    const res = await request(app(owner)).get(`/api/companies/${company.id}/first-run`);
    expect(res.body).toMatchObject({ applies: true, showHomeNudge: false });
  });

  it("does not nudge an established company that already has issues on upgrade", async () => {
    const { company, owner } = await seed({ connect: false });
    await db.update(companies).set({ createdAt: new Date("2026-06-01T00:00:00.000Z") }).where(eq(companies.id, company.id));
    await db.insert(issues).values({ companyId: company.id, title: "Existing work" });
    const res = await request(app(owner)).get(`/api/companies/${company.id}/first-run`);
    expect(res.body).toMatchObject({ applies: true, showHomeNudge: false, nextStep: "repo" });
  });

  it("still nudges an old company that has no issues yet", async () => {
    const { company, owner } = await seed({ connect: false });
    await db.update(companies).set({ createdAt: new Date("2026-06-01T00:00:00.000Z") }).where(eq(companies.id, company.id));
    const res = await request(app(owner)).get(`/api/companies/${company.id}/first-run`);
    expect(res.body.showHomeNudge).toBe(true);
  });

  it("does not nudge an agentdash_mk company", async () => {
    const { company, owner } = await seed({ profile: "agentdash_mk", connect: false });
    const res = await request(app(owner)).get(`/api/companies/${company.id}/first-run`);
    expect(res.body).toMatchObject({ applies: false, showHomeNudge: false });
  });

  it("skips the model step when the box is not hosted", async () => {
    hosted = false;
    const { company, owner } = await seed();
    const res = await request(app(owner)).get(`/api/companies/${company.id}/first-run`);
    expect(res.body).toMatchObject({ model: { required: false, done: true }, nextStep: "first_issue" });
  });

  it("does not apply to an agentdash_mk workspace", async () => {
    const { company, owner } = await seed({ profile: "agentdash_mk" });
    const res = await request(app(owner)).get(`/api/companies/${company.id}/first-run`);
    expect(res.body.applies).toBe(false);
  });

  it("creates the first issue in the connected project, hires an engineer, assigns and wakes it; idempotent", async () => {
    const { company, cos, projectId, owner } = await seed();
    const res = await request(app(owner))
      .post(`/api/companies/${company.id}/first-run/first-issue`)
      .send({ title: "  Add a health badge to the README  " });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.issue).toMatchObject({ title: "Add a health badge to the README", status: "todo", projectId });

    const engineer = await db.select().from(agents).where(eq(agents.id, res.body.hiredAgentId)).then((rows) => rows[0]!);
    expect(engineer).toMatchObject({ role: "engineer", adapterType: "hermes_local", reportsTo: cos.id, status: "idle" });
    const [issue] = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(issue).toMatchObject({ assigneeAgentId: engineer.id, originKind: "first_run" });
    expect(issue!.description).toContain("acme/app");
    expect(wakeups).toEqual([{ agentId: engineer.id, issueId: issue!.id }]);
    const actions = (await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["agent.created", "issue.created"]));

    const again = await request(app(owner)).post(`/api/companies/${company.id}/first-run/first-issue`).send({ title: "Something else" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, hiredAgentId: null, issue: { id: issue!.id } });
    expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(2);
    expect(wakeups).toHaveLength(1);
  });

  it("refuses the first issue on a hosted box until the model key is set", async () => {
    const { company, owner } = await seed();
    hosted = true;
    providerConfigured = false;
    const res = await request(app(owner)).post(`/api/companies/${company.id}/first-run/first-issue`).send({ title: "Fix a bug" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("model provider key");
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(1);
    expect(wakeups).toHaveLength(0);

    providerConfigured = true;
    expect((await request(app(owner)).post(`/api/companies/${company.id}/first-run/first-issue`).send({ title: "Fix a bug" })).status).toBe(201);
  });

  it("reports canConfigureModel for the instance admin only", async () => {
    const { company, owner } = await seed();
    expect((await request(app(owner)).get(`/api/companies/${company.id}/first-run`)).body.canConfigureModel).toBe(false);
    const admin = { ...owner, isInstanceAdmin: true };
    expect((await request(app(admin)).get(`/api/companies/${company.id}/first-run`)).body.canConfigureModel).toBe(true);
  });

  it("reuses an existing engineer instead of hiring", async () => {
    const { company, owner } = await seed({ extraAgents: ["engineer"] });
    const res = await request(app(owner)).post(`/api/companies/${company.id}/first-run/first-issue`).send({ title: "Fix a bug" });
    expect(res.status).toBe(201);
    expect(res.body.hiredAgentId).toBeNull();
    expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(2);
  });

  it("refuses without a connected repo", async () => {
    const { company, owner } = await seed({ connect: false });
    const res = await request(app(owner)).post(`/api/companies/${company.id}/first-run/first-issue`).send({ title: "Fix a bug" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Connect a GitHub repository first");
  });

  it("returns the Free cap payload when there is no room to hire an engineer", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_first_run";
    const { company, owner } = await seed({ extraAgents: ["general", "general"] });
    const res = await request(app(owner)).post(`/api/companies/${company.id}/first-run/first-issue`).send({ title: "Fix a bug" });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("agent_cap_exceeded");
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(0);
  });

  it("is admin-only and company-scoped", async () => {
    const a = await seed();
    const b = await seed();
    expect((await request(app(a.member)).post(`/api/companies/${a.company.id}/first-run/first-issue`).send({ title: "x" })).status).toBe(403);
    const memberView = await request(app(a.member)).get(`/api/companies/${a.company.id}/first-run`);
    expect(memberView.status).toBe(200);
    expect(memberView.body.canManage).toBe(false);
    expect((await request(app(b.owner)).get(`/api/companies/${a.company.id}/first-run`)).status).toBe(403);
    expect((await request(app(b.owner)).post(`/api/companies/${a.company.id}/first-run/first-issue`).send({ title: "x" })).status).toBe(403);
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("requires a sentence", async () => {
    const { company, owner } = await seed();
    const res = await request(app(owner)).post(`/api/companies/${company.id}/first-run/first-issue`).send({ title: "   " });
    expect(res.status).toBe(400);
  });
});
