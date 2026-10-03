// AgentDash (security, GH #980): a project workspace `cwd` is the host
// directory runs execute in. It used to accept any absolute path, so any
// company member could point a run at another company's files or anywhere on
// the host. Non-instance-admins are now confined to this company's managed
// roots — the managed project checkout dirs, the instance workspaces of this
// company's agents, and registered execution-workspace dirs — and only when
// a cwd is being SET, so the repo-path values existing local installs hold
// keep working while they are resent unchanged.
import path from "node:path";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/index.js";
import {
  resolvePaperclipInstanceRoot,
  sanitizeFriendlyPathSegment,
} from "../home-paths.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

const instanceRoot = resolvePaperclipInstanceRoot();
const companyProjectsRoot = (companyId: string) =>
  path.join(instanceRoot, "projects", sanitizeFriendlyPathSegment(companyId, "company"));
const agentWorkspaceRoot = (agentId: string) =>
  path.join(instanceRoot, "workspaces", agentId);

describeEmbeddedPostgres("project workspace cwd confinement (GH #980)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cwd-confinement-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).actor = actor;
      next();
    });
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function memberActor(companyId: string) {
    return {
      type: "board",
      source: "session",
      userId: `member-${randomUUID()}`,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "member" }],
      isInstanceAdmin: false,
    };
  }

  function instanceAdminActor(companyId: string) {
    return { ...memberActor(companyId), isInstanceAdmin: true };
  }

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Co ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedProject(companyId: string) {
    const rows = await db
      .insert(projects)
      .values({ companyId, name: "Project" })
      .returning();
    return rows[0]!;
  }

  async function seedAgent(companyId: string, name: string) {
    const rows = await db
      .insert(agents)
      .values({ companyId, name, role: "engineer", status: "idle", adapterType: "process" })
      .returning();
    return rows[0]!;
  }

  it("lets a member set a cwd inside the company's managed project root", async () => {
    const companyId = await seedCompany("CWDA");
    const project = await seedProject(companyId);
    const app = createApp(memberActor(companyId));

    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "Managed", cwd: path.join(companyProjectsRoot(companyId), project.id, "repo") });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.cwd).toContain(companyProjectsRoot(companyId));
  });

  it("refuses a member setting a cwd outside every managed root", async () => {
    const companyId = await seedCompany("CWDB");
    const project = await seedProject(companyId);
    const app = createApp(memberActor(companyId));

    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "Escape", cwd: "/tmp/agentdash-cwd-escape" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managed workspace roots/i);
  });

  it("refuses a member setting a cwd inside ANOTHER company's managed roots", async () => {
    const companyA = await seedCompany("CWDC");
    const companyB = await seedCompany("CWDD");
    const agentB = await seedAgent(companyB, "foreign agent");
    const project = await seedProject(companyA);
    const app = createApp(memberActor(companyA));

    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "Cross company", cwd: path.join(agentWorkspaceRoot(agentB.id), "checkout") });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managed workspace roots/i);
  });

  it("lets a member set a cwd inside an instance workspace of their own company's agent", async () => {
    const companyId = await seedCompany("CWDE");
    const agent = await seedAgent(companyId, "own agent");
    const project = await seedProject(companyId);
    const app = createApp(memberActor(companyId));

    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "Agent ws", cwd: path.join(agentWorkspaceRoot(agent.id), "runs") });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("lets an instance admin set any cwd", async () => {
    const companyId = await seedCompany("CWDF");
    const project = await seedProject(companyId);
    const app = createApp(instanceAdminActor(companyId));

    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "Legacy repo", cwd: "/tmp/agentdash-legacy-repo" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("grandfathers a stored non-managed cwd while it is resent unchanged, and blocks changing it", async () => {
    const companyId = await seedCompany("CWDG");
    const project = await seedProject(companyId);
    // A pre-existing install keeps its repo path; a member PATCH that only
    // touches other fields — or resends the same cwd — must keep working.
    const stored = await db
      .insert(projectWorkspaces)
      .values({
        companyId,
        projectId: project.id,
        name: "legacy-repo",
        sourceType: "local_path",
        cwd: "/tmp/agentdash-grandfathered-repo",
        isPrimary: true,
      })
      .returning()
      .then((rows) => rows[0]!);
    const app = createApp(memberActor(companyId));

    const echo = await request(app)
      .patch(`/api/projects/${project.id}/workspaces/${stored.id}`)
      .send({ cwd: "/tmp/agentdash-grandfathered-repo" });
    expect(echo.status, JSON.stringify(echo.body)).toBe(200);

    const rename = await request(app)
      .patch(`/api/projects/${project.id}/workspaces/${stored.id}`)
      .send({ name: "renamed" });
    expect(rename.status, JSON.stringify(rename.body)).toBe(200);

    const moved = await request(app)
      .patch(`/api/projects/${project.id}/workspaces/${stored.id}`)
      .send({ cwd: "/tmp/agentdash-grandfathered-other" });
    expect(moved.status).toBe(403);
    expect(moved.body.error).toMatch(/managed workspace roots/i);

    const after = await db
      .select({ cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, stored.id));
    expect(after[0]?.cwd).toBe("/tmp/agentdash-grandfathered-repo");
  });
});
