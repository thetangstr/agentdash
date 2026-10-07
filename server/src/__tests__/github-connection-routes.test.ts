// AgentDash (GH #782): GitHub repo connections, against a real database.
//
// Real routes, real authz, real secrets service (local_encrypted), real
// activity log; only GitHub's API is faked. Every test that handles the token
// greps everything a caller or operator can see for a canary value.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecrets,
  companySecretVersions,
  createDb,
  githubRepoConnections,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { githubConnectionRoutes, AGENT_GIT_CREDENTIAL_LIMIT } from "../routes/github-connection.js";
import { secretRoutes } from "../routes/secrets.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const CANARY = "github_pat_11CANARY0000000000000000_routeCanaryValueThatMustNeverLeak0123";
const ROTATED = "github_pat_11ROTATED000000000000000_rotatedCanaryValueThatMustNeverLeak";

interface FakeRepo {
  status?: number;
  push?: boolean;
  pullsStatus?: number;
  archived?: boolean;
}

function fakeGitHub(repo: FakeRepo = {}) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    if (url.includes("/pulls")) {
      return new Response(JSON.stringify([]), { status: repo.pullsStatus ?? 200 });
    }
    if ((repo.status ?? 200) !== 200) return new Response(`{"message":"echo ${CANARY}"}`, { status: repo.status });
    return new Response(
      JSON.stringify({
        name: "App",
        owner: { login: "Acme" },
        default_branch: "main",
        private: true,
        archived: repo.archived ?? false,
        permissions: { admin: false, push: repo.push ?? true, pull: true },
      }),
      { status: 200 },
    );
  });
  return { fn, calls };
}

describeEmbeddedPostgres("GitHub connection routes", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let logSpies: Array<ReturnType<typeof vi.spyOn>> = [];
  const savedKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "a".repeat(64);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-connection-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    logSpies = (["info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(logger, level));
  });

  afterEach(async () => {
    for (const spy of logSpies) spy.mockRestore();
    await db.delete(activityLog);
    await db.delete(githubRepoConnections);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = savedKey;
    await tempDb?.cleanup();
  });

  async function seedCompany(profile: "default" | "agentdash_mk" = "default") {
    const company = await db
      .insert(companies)
      .values({
        name: `GH ${randomUUID()}`,
        issuePrefix: `G${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: profile,
      })
      .returning()
      .then((rows) => rows[0]!);
    const ownerId = `owner-${randomUUID()}`;
    const memberId = `member-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
      { companyId: company.id, principalType: "user", principalId: memberId, status: "active", membershipRole: "member" },
    ]);
    const board = (userId: string, role: string) => ({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [company.id],
      memberships: [{ companyId: company.id, status: "active", membershipRole: role }],
    });
    return { company, owner: board(ownerId, "owner"), member: board(memberId, "member") };
  }

  function buildApp(actor: Record<string, unknown>, fetchImpl: ReturnType<typeof fakeGitHub>["fn"]) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", githubConnectionRoutes(db, { fetch: fetchImpl as never, env: {} }));
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function observable(...responses: request.Response[]) {
    const activity = await db.select().from(activityLog);
    const versions = await db.select().from(companySecretVersions);
    const connections = await db.select().from(githubRepoConnections);
    return [
      ...responses.map((res) => JSON.stringify(res.body) + res.text),
      JSON.stringify(activity),
      JSON.stringify(versions),
      JSON.stringify(connections),
      ...logSpies.map((spy) => JSON.stringify(spy.mock.calls)),
    ].join("\n");
  }

  it("an owner connects: validated, token stored encrypted, first project + workspace created, token never returned", async () => {
    const { company, owner } = await seedCompany();
    const gh = fakeGitHub();
    const app = buildApp(owner, gh.fn);

    const res = await request(app)
      .put(`/api/companies/${company.id}/github-connections`)
      .send({ repoUrl: "https://github.com/acme/app.git", githubToken: CANARY });

    expect(res.status).toBe(201);
    expect(res.body.projectCreated).toBe(true);
    expect(res.body.connection).toMatchObject({
      companyId: company.id,
      repo: "Acme/App",
      repoUrl: "https://github.com/Acme/App",
      defaultBranch: "main",
      credentialSource: "pat",
      credentialPresent: true,
    });
    // GitHub saw the token as a bearer on exactly the two read-only checks.
    expect(gh.calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/acme/app",
      "https://api.github.com/repos/acme/app/pulls?per_page=1&state=all",
    ]);
    expect(gh.calls.every((call) => call.auth === `Bearer ${CANARY}`)).toBe(true);

    const [workspace] = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.companyId, company.id));
    expect(workspace).toMatchObject({
      sourceType: "git_repo",
      repoUrl: "https://github.com/Acme/App",
      defaultRef: "main",
      cwd: null,
      isPrimary: true,
    });
    const [connection] = await db.select().from(githubRepoConnections);
    expect(connection).toMatchObject({ repoFullName: "acme/app", projectWorkspaceId: workspace!.id });
    // Resolvable through the secrets service, which is what the run path uses.
    expect(await secretService(db).resolveSecretValue(company.id, connection!.secretId!, "latest")).toBe(CANARY);

    const listed = await request(app).get(`/api/companies/${company.id}/github-connections`);
    expect(listed.status).toBe(200);
    expect(listed.body.canManage).toBe(true);
    expect(listed.body.connections).toHaveLength(1);

    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    expect(activity.map((row) => row.action)).toContain("github_connection.connected");
    expect(await observable(res, listed)).not.toContain(CANARY);
  });

  it("rejects a token without push permission, names the permission, and saves nothing", async () => {
    const { company, owner } = await seedCompany();
    const res = await request(buildApp(owner, fakeGitHub({ push: false }).fn))
      .put(`/api/companies/${company.id}/github-connections`)
      .send({ repoUrl: "acme/app", githubToken: CANARY });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Contents: Read and write");
    expect(await db.select().from(githubRepoConnections)).toHaveLength(0);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await observable(res)).not.toContain(CANARY);
  });

  it("rejects a token that cannot open pull requests", async () => {
    const { company, owner } = await seedCompany();
    const res = await request(buildApp(owner, fakeGitHub({ pullsStatus: 403 }).fn))
      .put(`/api/companies/${company.id}/github-connections`)
      .send({ repoUrl: "acme/app", githubToken: CANARY });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Pull requests: Read and write");
    expect(await observable(res)).not.toContain(CANARY);
  });

  it("rejects a token that cannot see the repo, without echoing GitHub's body", async () => {
    const { company, owner } = await seedCompany();
    const res = await request(buildApp(owner, fakeGitHub({ status: 404 }).fn))
      .put(`/api/companies/${company.id}/github-connections`)
      .send({ repoUrl: "acme/app", githubToken: CANARY });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Only select repositories");
    expect(await observable(res)).not.toContain(CANARY);
  });

  it("rejects classic tokens before calling GitHub", async () => {
    const { company, owner } = await seedCompany();
    const gh = fakeGitHub();
    const classic = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const res = await request(buildApp(owner, gh.fn))
      .put(`/api/companies/${company.id}/github-connections`)
      .send({ repoUrl: "acme/app", githubToken: classic });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("fine-grained");
    expect(gh.fn).not.toHaveBeenCalled();
    expect(await observable(res)).not.toContain(classic);
  });

  it("a member can read the connection state but cannot set it", async () => {
    const { company, owner, member } = await seedCompany();
    await request(buildApp(owner, fakeGitHub().fn))
      .put(`/api/companies/${company.id}/github-connections`)
      .send({ repoUrl: "acme/app", githubToken: CANARY })
      .expect(201);

    const gh = fakeGitHub();
    const refused = await request(buildApp(member, gh.fn))
      .put(`/api/companies/${company.id}/github-connections`)
      .send({ repoUrl: "acme/app", githubToken: ROTATED });
    expect(refused.status).toBe(403);
    expect(gh.fn).not.toHaveBeenCalled();

    const listed = await request(buildApp(member, gh.fn)).get(`/api/companies/${company.id}/github-connections`);
    expect(listed.status).toBe(200);
    expect(listed.body.canManage).toBe(false);
    expect(listed.body.connections[0].repo).toBe("Acme/App");

    const [connection] = await db.select().from(githubRepoConnections);
    const deleted = await request(buildApp(member, gh.fn)).delete(
      `/api/companies/${company.id}/github-connections/${connection!.id}`,
    );
    expect(deleted.status).toBe(403);
    expect(await observable(refused, listed, deleted)).not.toContain(CANARY);
  });

  it("GH #1052: a connection into a restricted project is absent for an off-list member", async () => {
    const { company, owner, member } = await seedCompany();
    await request(buildApp(owner, fakeGitHub().fn))
      .put(`/api/companies/${company.id}/github-connections`)
      .send({ repoUrl: "acme/app", githubToken: CANARY })
      .expect(201);
    const [connection] = await db.select().from(githubRepoConnections);
    await db
      .update(projects)
      .set({ visibility: "restricted", createdByUserId: owner.userId })
      .where(eq(projects.id, connection!.projectId));

    const memberList = await request(buildApp(member, fakeGitHub().fn)).get(
      `/api/companies/${company.id}/github-connections`,
    );
    expect(memberList.status).toBe(200);
    expect(memberList.body.connections).toEqual([]);
    expect(JSON.stringify(memberList.body)).not.toContain("Acme/App");

    const ownerList = await request(buildApp(owner, fakeGitHub().fn)).get(
      `/api/companies/${company.id}/github-connections`,
    );
    expect(ownerList.body.connections.map((c: { repo: string }) => c.repo)).toEqual(["Acme/App"]);
  });

  it("is company-scoped: another company's owner can neither read nor set it", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await request(buildApp(a.owner, fakeGitHub().fn))
      .put(`/api/companies/${a.company.id}/github-connections`)
      .send({ repoUrl: "acme/app", githubToken: CANARY })
      .expect(201);
    const read = await request(buildApp(b.owner, fakeGitHub().fn)).get(`/api/companies/${a.company.id}/github-connections`);
    expect(read.status).toBe(403);
    const write = await request(buildApp(b.owner, fakeGitHub().fn))
      .put(`/api/companies/${a.company.id}/github-connections`)
      .send({ repoUrl: "acme/app", githubToken: ROTATED });
    expect(write.status).toBe(403);
    // A projectId from another company is not found, not attached.
    const [projectA] = await db.select().from(projects).where(eq(projects.companyId, a.company.id));
    const cross = await request(buildApp(b.owner, fakeGitHub().fn))
      .put(`/api/companies/${b.company.id}/github-connections`)
      .send({ repoUrl: "acme/app", githubToken: ROTATED, projectId: projectA!.id });
    expect(cross.status).toBe(404);
  });

  it("an instance admin may connect; reconnecting rotates the token in place; disconnect removes it", async () => {
    const { company } = await seedCompany();
    const admin = {
      type: "board",
      userId: "instance-admin",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [company.id],
      memberships: [],
    };
    const app = buildApp(admin, fakeGitHub().fn);
    await request(app)
      .put(`/api/companies/${company.id}/github-connections`)
      .send({ repoUrl: "git@github.com:acme/app.git", githubToken: CANARY })
      .expect(201);
    const [before] = await db.select().from(githubRepoConnections);

    const rotated = await request(app)
      .put(`/api/companies/${company.id}/github-connections`)
      .send({ repoUrl: "https://github.com/acme/app", githubToken: ROTATED });
    expect(rotated.status).toBe(200);
    const all = await db.select().from(githubRepoConnections);
    expect(all).toHaveLength(1);
    expect(all[0]!.secretId).toBe(before!.secretId);
    expect(await secretService(db).resolveSecretValue(company.id, before!.secretId!, "latest")).toBe(ROTATED);
    expect(await db.select().from(projects)).toHaveLength(1);

    const removed = await request(app).delete(`/api/companies/${company.id}/github-connections/${before!.id}`);
    expect(removed.status).toBe(200);
    expect(await db.select().from(githubRepoConnections)).toHaveLength(0);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect(await observable(rotated, removed)).not.toContain(ROTATED);
  });

  describe("the token secret is managed (GH #782 review)", () => {
    async function connected() {
      const seeded = await seedCompany();
      await request(buildApp(seeded.owner, fakeGitHub().fn))
        .put(`/api/companies/${seeded.company.id}/github-connections`)
        .send({ repoUrl: "acme/app", githubToken: CANARY })
        .expect(201);
      const [connection] = await db.select().from(githubRepoConnections).where(eq(githubRepoConnections.companyId, seeded.company.id));
      return { ...seeded, connection: connection!, secretId: connection!.secretId! };
    }

    it("a member cannot rotate, rename or delete it through the generic secrets API", async () => {
      const { member, secretId, company } = await connected();
      const app = buildApp(member, fakeGitHub().fn);
      expect((await request(app).post(`/api/secrets/${secretId}/rotate`).send({ value: ROTATED })).status).toBe(403);
      expect((await request(app).patch(`/api/secrets/${secretId}`).send({ name: "mine" })).status).toBe(403);
      expect((await request(app).delete(`/api/secrets/${secretId}`)).status).toBe(403);
      expect(await secretService(db).resolveSecretValue(company.id, secretId, "latest")).toBe(CANARY);
      const [connection] = await db.select().from(githubRepoConnections);
      expect(connection!.secretId).toBe(secretId);
    });

    it("an owner may still rotate it there", async () => {
      const { owner, secretId, company } = await connected();
      const res = await request(buildApp(owner, fakeGitHub().fn)).post(`/api/secrets/${secretId}/rotate`).send({ value: ROTATED });
      expect(res.status).toBe(200);
      expect(await secretService(db).resolveSecretValue(company.id, secretId, "latest")).toBe(ROTATED);
    });

    it("it is not listed, and nobody can create or rename into the reserved name", async () => {
      const { member, owner, company, connection } = await connected();
      const listed = await request(buildApp(member, fakeGitHub().fn)).get(`/api/companies/${company.id}/secrets`);
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain(connection.secretId!);
      const planted = await request(buildApp(owner, fakeGitHub().fn))
        .post(`/api/companies/${company.id}/secrets`)
        .send({ name: `github-token-${randomUUID()}`, value: ROTATED });
      expect(planted.status).toBe(422);
      const plain = await request(buildApp(member, fakeGitHub().fn))
        .post(`/api/companies/${company.id}/secrets`)
        .send({ name: "ordinary", value: "x" });
      expect(plain.status).toBe(201);
      expect((await request(buildApp(member, fakeGitHub().fn)).patch(`/api/secrets/${plain.body.id}`).send({ name: "github-token-x" })).status).toBe(422);
    });

    it("connect never adopts a pre-existing secret that merely has the expected name", async () => {
      const { company, owner } = await seedCompany();
      const project = await db.insert(projects).values({ companyId: company.id, name: "app" }).returning().then((rows) => rows[0]!);
      const workspace = await db
        .insert(projectWorkspaces)
        .values({ companyId: company.id, projectId: project.id, name: "app", sourceType: "git_repo", repoUrl: "https://github.com/acme/app", isPrimary: true })
        .returning()
        .then((rows) => rows[0]!);
      // Planted before the reservation existed (or by direct DB access).
      const planted = await secretService(db).create(
        company.id,
        { name: `github-token-${workspace.id}`, provider: "local_encrypted", value: ROTATED },
        { userId: "member" },
      );
      await request(buildApp(owner, fakeGitHub().fn))
        .put(`/api/companies/${company.id}/github-connections`)
        .send({ repoUrl: "acme/app", githubToken: CANARY, projectId: project.id })
        .expect(201);
      const [connection] = await db.select().from(githubRepoConnections);
      expect(connection!.secretId).not.toBe(planted.id);
      expect(await secretService(db).resolveSecretValue(company.id, connection!.secretId!, "latest")).toBe(CANARY);
      expect(await secretService(db).resolveSecretValue(company.id, planted.id, "latest")).toBe(ROTATED);
    });

    it("cannot be bound into project or agent env, and a stored binding is skipped at run time", async () => {
      const { company, secretId } = await connected();
      const svc = secretService(db);
      const binding = { GH_TOKEN: { type: "secret_ref", secretId } };
      await expect(svc.normalizeEnvBindingsForPersistence(company.id, binding)).rejects.toThrow(/managed by a connection/);
      await expect(svc.normalizeAdapterConfigForPersistence(company.id, { env: binding })).rejects.toThrow(/managed by a connection/);
      const projectEnv = await svc.resolveEnvBindings(company.id, { ...binding, OTHER: "plain" });
      expect(projectEnv.env).toEqual({ OTHER: "plain" });
      const agentEnv = await svc.resolveAdapterConfigForRuntime(company.id, { env: binding });
      expect(agentEnv.config.env).toEqual({});
      expect(JSON.stringify([projectEnv, agentEnv.config])).not.toContain(CANARY);
    });
  });

  describe("POST /api/agent-git-credential", () => {
    async function seedRun(opts: { status?: string; connectProject?: boolean; assigned?: boolean } = {}) {
      const seeded = await seedCompany();
      await request(buildApp(seeded.owner, fakeGitHub().fn))
        .put(`/api/companies/${seeded.company.id}/github-connections`)
        .send({ repoUrl: "acme/app", githubToken: CANARY })
        .expect(201);
      const [project] = await db.select().from(projects).where(eq(projects.companyId, seeded.company.id));
      const other = await db
        .insert(projects)
        .values({ companyId: seeded.company.id, name: `Other ${randomUUID()}` })
        .returning()
        .then((rows) => rows[0]!);
      const agent = await db
        .insert(agents)
        .values({ companyId: seeded.company.id, name: `Eng ${randomUUID()}`, role: "engineer", status: "running", adapterType: "hermes_local" })
        .returning()
        .then((rows) => rows[0]!);
      const issue = await db
        .insert(issues)
        .values({
          companyId: seeded.company.id,
          projectId: opts.connectProject === false ? other.id : project!.id,
          title: "Add a health badge",
          assigneeAgentId: opts.assigned === false ? null : agent.id,
        })
        .returning()
        .then((rows) => rows[0]!);
      const run = await db
        .insert(heartbeatRuns)
        .values({
          companyId: seeded.company.id,
          agentId: agent.id,
          status: opts.status ?? "running",
          contextSnapshot: { issueId: issue.id },
        })
        .returning()
        .then((rows) => rows[0]!);
      // The actor a run JWT produces: jwtRunId is signed; runId may come from a header.
      const agentActor = (
        jwtRunId: string | null = run.id,
        agentId = agent.id,
        extra: Record<string, unknown> = {},
      ) => ({
        type: "agent",
        agentId,
        companyId: seeded.company.id,
        runId: jwtRunId ?? undefined,
        jwtRunId: jwtRunId ?? undefined,
        source: "agent_jwt",
        ...extra,
      });
      return { ...seeded, project: project!, other, agent, run, issue, agentActor };
    }

    function post(actor: Record<string, unknown>, body = "protocol=https\nhost=github.com\npath=acme/app.git\n\n") {
      return request(buildApp(actor, fakeGitHub().fn))
        .post("/api/agent-git-credential")
        .set("content-type", "text/plain")
        .send(body);
    }

    it("gives a running agent in the connected project a git credential", async () => {
      const { agentActor, run } = await seedRun();
      const res = await post(agentActor());
      expect(res.status).toBe(200);
      expect(res.text).toBe(`username=x-access-token\npassword=${CANARY}\n\n`);
      expect(res.headers["cache-control"]).toBe("no-store");
      const issued = await db.select().from(activityLog).where(eq(activityLog.action, "github_connection.credential_issued"));
      expect(issued).toHaveLength(1);
      expect(issued[0]!.runId).toBe(run.id);
      // The response is the one place the token goes; logs and activity never carry it.
      const activity = JSON.stringify(await db.select().from(activityLog));
      expect(activity).not.toContain(CANARY);
      expect(logSpies.map((spy) => JSON.stringify(spy.mock.calls)).join("\n")).not.toContain(CANARY);
    });

    it("works without a path when the project has exactly one connection (manual `git credential fill`)", async () => {
      const { agentActor } = await seedRun();
      const res = await post(agentActor(), "protocol=https\nhost=github.com\n\n");
      expect(res.status).toBe(200);
      expect(res.text).toContain(CANARY);
    });

    it("refuses: another repo, another host, http, a finished run, another agent's run, another project, a board user", async () => {
      const { agentActor, owner, company, run } = await seedRun();
      expect((await post(agentActor(), "protocol=https\nhost=github.com\npath=evil/repo.git\n\n")).status).toBe(404);
      expect((await post(agentActor(), "protocol=https\nhost=gitlab.com\npath=acme/app.git\n\n")).status).toBe(404);
      expect((await post(agentActor(), "protocol=http\nhost=github.com\npath=acme/app.git\n\n")).status).toBe(404);
      expect((await post(agentActor(null))).status).toBe(403);
      expect((await post(agentActor(randomUUID()))).status).toBe(404);
      const intruder = await db
        .insert(agents)
        .values({ companyId: company.id, name: `Other ${randomUUID()}`, role: "engineer", status: "idle", adapterType: "hermes_local" })
        .returning()
        .then((rows) => rows[0]!);
      // A different agent of the same company presenting this run's id.
      expect((await post(agentActor(run.id, intruder.id))).status).toBe(404);
      const board = await post(owner);
      expect(board.status).toBe(403);
      expect(board.text).not.toContain(CANARY);
    });

    it("refuses a run that is not running", async () => {
      const { agentActor } = await seedRun({ status: "succeeded" });
      expect((await post(agentActor())).status).toBe(404);
    });

    it("refuses a run in a project with no connection", async () => {
      const { agentActor } = await seedRun({ connectProject: false });
      expect((await post(agentActor())).status).toBe(404);
    });

    it("refuses when the agent is not the assignee of the run's issue", async () => {
      const { agentActor } = await seedRun({ assigned: false });
      expect((await post(agentActor())).status).toBe(404);
    });

    it("refuses a run whose context names a project but no issue (wakeup context is not trusted)", async () => {
      const seeded = await seedRun();
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { projectId: seeded.project.id } })
        .where(eq(heartbeatRuns.id, seeded.run.id));
      expect((await post(seeded.agentActor())).status).toBe(404);
    });

    it("refuses a long-lived agent API key even with a valid running run id in the header", async () => {
      const { agentActor, run } = await seedRun();
      const res = await post(agentActor(null, undefined, { source: "agent_key", keyId: randomUUID(), runId: run.id }));
      expect(res.status).toBe(403);
      expect(res.text).not.toContain(CANARY);
    });

    it("refuses a run JWT presenting another run's id in the header", async () => {
      const { agentActor, run } = await seedRun();
      const res = await post(agentActor(randomUUID(), undefined, { runId: run.id }));
      expect(res.status).toBe(403);
    });

    it("refuses an evaluator (read-only) principal", async () => {
      const { agentActor } = await seedRun();
      expect((await post(agentActor(undefined, undefined, { readOnly: true }))).status).toBe(403);
    });

    it("rate-limits credential requests per run", async () => {
      const { agentActor } = await seedRun();
      const app = buildApp(agentActor(), fakeGitHub().fn);
      const body = "protocol=https\nhost=github.com\npath=acme/app.git\n\n";
      for (let i = 0; i < AGENT_GIT_CREDENTIAL_LIMIT.max; i += 1) {
        expect((await request(app).post("/api/agent-git-credential").set("content-type", "text/plain").send(body)).status).toBe(200);
      }
      const limited = await request(app).post("/api/agent-git-credential").set("content-type", "text/plain").send(body);
      expect(limited.status).toBe(429);
      expect(limited.text).not.toContain(CANARY);
    });
  });
});
