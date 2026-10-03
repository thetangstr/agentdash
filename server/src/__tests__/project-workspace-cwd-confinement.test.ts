// AgentDash (security, GH #980): a project workspace `cwd` is the host
// directory runs execute in. It used to accept any absolute path, so any
// company member could point a run at another company's files or anywhere on
// the host. Non-instance-admins are now confined to this company's managed
// roots — the managed checkout dirs of projects they can see and the
// instance workspaces of agents they manage — and only when the EFFECTIVE
// host cwd changes: stored values keep working while the row's sourceType
// also stays put, so the repo paths existing local installs hold still run.
//
// GH #980 review additions: `remote_managed` rows take no host cwd from
// non-admins and never yield one to the heartbeat; a sourceType flip
// re-validates the stored cwd; relative `..` worktree parents are gated like
// absolute ones; and registered executionWorkspaces rows no longer widen the
// allow-list at all. The probes the review used are the last tests here.
import fs from "node:fs";
import os from "node:os";
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
  companyMemberships,
  createDb,
  executionWorkspaces,
  principalPermissionGrants,
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

  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    for (const p of cleanupPaths.splice(0)) fs.rmSync(p, { recursive: true, force: true });
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

  async function seedAgent(companyId: string, name: string, createdByUserId?: string) {
    const rows = await db
      .insert(agents)
      .values({ companyId, name, role: "engineer", status: "idle", adapterType: "process", createdByUserId })
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

  it("lets a member set a cwd inside the instance workspace of an agent they created", async () => {
    const companyId = await seedCompany("CWDE");
    const member = memberActor(companyId);
    const agent = await seedAgent(companyId, "own agent", member.userId as string);
    const project = await seedProject(companyId);
    const app = createApp(member);

    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "Agent ws", cwd: path.join(agentWorkspaceRoot(agent.id), "runs") });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("refuses a member setting a cwd inside the workspace of an agent they do not manage", async () => {
    // GH #980 review: <instance>/workspaces/<agentId> is that agent's dir, so
    // "same company" is not enough — the actor must manage the agent.
    const companyId = await seedCompany("CWDH");
    const agent = await seedAgent(companyId, "unmanaged agent");
    const project = await seedProject(companyId);
    const app = createApp(memberActor(companyId));

    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "Agent ws", cwd: path.join(agentWorkspaceRoot(agent.id), "runs") });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managed workspace roots|agent you manage/i);
  });

  it("refuses a member pointing into a restricted project's managed checkout they cannot see", async () => {
    // GH #980 review: <instance>/projects/<companyId>/<projectId> names a
    // project — an off-list member must not run inside a restricted one.
    const companyId = await seedCompany("CWDI");
    const restricted = await db
      .insert(projects)
      .values({ companyId, name: "Restricted", visibility: "restricted" })
      .returning()
      .then((rows) => rows[0]!);
    const project = await seedProject(companyId);
    const app = createApp(memberActor(companyId));

    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "Sneak", cwd: path.join(companyProjectsRoot(companyId), restricted.id, "repo") });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/project the actor cannot use|managed workspace roots/i);
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

  // ---- GH #980 review probes, as permanent regressions ----

  it("refuses a non-admin remote_managed workspace carrying a host cwd, at write and on flip (probe A)", async () => {
    const companyId = await seedCompany("RVWA");
    const project = await seedProject(companyId);
    const app = createApp(memberActor(companyId));

    // A remote-managed row's cwd is a REMOTE path, not a host one — nothing
    // local may ever run in it, so a member cannot set one.
    const create = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "remote", sourceType: "remote_managed", remoteWorkspaceRef: "ref", cwd: "/etc" });
    expect(create.status).toBe(403);
    expect(create.body.error).toMatch(/remote-managed/i);

    // A row that already holds a laundered cwd (legacy data, or an admin's
    // doing) cannot be flipped to a host source type while the stored value
    // rides the grandfather clause — the effective cwd is re-validated.
    const stored = await db
      .insert(projectWorkspaces)
      .values({
        companyId,
        projectId: project.id,
        name: "legacy-remote",
        sourceType: "remote_managed",
        remoteWorkspaceRef: "ref",
        cwd: "/etc",
      })
      .returning()
      .then((rows) => rows[0]!);

    const flip = await request(app)
      .patch(`/api/projects/${project.id}/workspaces/${stored.id}`)
      .send({ sourceType: "local_path" });
    expect(flip.status).toBe(403);

    const echo = await request(app)
      .patch(`/api/projects/${project.id}/workspaces/${stored.id}`)
      .send({ cwd: "/etc", sourceType: "non_git_path" });
    expect(echo.status).toBe(403);

    const after = await db
      .select({ cwd: projectWorkspaces.cwd, sourceType: projectWorkspaces.sourceType })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, stored.id));
    expect(after[0]).toMatchObject({ cwd: "/etc", sourceType: "remote_managed" });
  });

  it("refuses a host cwd on the workspace embedded in project create (probe B)", async () => {
    const companyId = await seedCompany("RVWB");
    const member = memberActor(companyId);
    // The create route needs a real membership + projects:create grant.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: member.userId as string,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: member.userId as string,
      permissionKey: "projects:create",
      grantedByUserId: "seeder",
    });
    const app = createApp(member);

    const res = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: "P2", workspace: { name: "w", cwd: "/etc" } });

    expect(res.status).toBe(403);
  });

  it("refuses a .. traversal out of the company's managed root (probe C)", async () => {
    const companyA = await seedCompany("RVWC");
    const companyB = await seedCompany("RVWD");
    const project = await seedProject(companyA);
    const app = createApp(memberActor(companyA));

    const cwd = `${companyProjectsRoot(companyA)}/${project.id}/../../${sanitizeFriendlyPathSegment(companyB, "company")}/x`;
    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "x", cwd });

    expect(res.status).toBe(403);
  });

  it("refuses a cwd through a symlink planted inside the managed root (probe D)", async () => {
    const companyId = await seedCompany("RVWE");
    const project = await seedProject(companyId);
    const dir = path.join(companyProjectsRoot(companyId), project.id);
    fs.mkdirSync(dir, { recursive: true });
    cleanupPaths.push(companyProjectsRoot(companyId));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "rv999-out-"));
    cleanupPaths.push(target);
    fs.symlinkSync(target, path.join(dir, "link"));
    const app = createApp(memberActor(companyId));

    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "x", cwd: path.join(dir, "link", "sub") });

    expect(res.status).toBe(403);
    // Either refusal message is correct: the canonicalized path resolves
    // outside the managed root, or the walk spots the link itself.
    expect(res.body.error).toMatch(/symbolic link|managed workspace roots/i);
  });

  it("does not let an executionWorkspaces row widen the allow-list (probe E)", async () => {
    // An archived row holding a wide cwd (e.g. a grandfathered run's $HOME)
    // must not hand that subtree to a member — registered roots are out of
    // the allow-list entirely since the review.
    const companyId = await seedCompany("RVWF");
    const project = await seedProject(companyId);
    await db.insert(executionWorkspaces).values({
      companyId,
      projectId: project.id,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "w",
      status: "archived",
      providerType: "local_fs",
      cwd: os.homedir(),
    } as never);
    const app = createApp(memberActor(companyId));

    const res = await request(app)
      .post(`/api/projects/${project.id}/workspaces`)
      .send({ name: "x", cwd: path.join(os.homedir(), ".ssh") });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managed workspace roots/i);
  });

  it("gates a relative worktreeParentDir containing .. like an absolute one (probe F)", async () => {
    const companyId = await seedCompany("RVWG");
    const member = memberActor(companyId);
    const project = await db
      .insert(projects)
      .values({ companyId, name: "P", createdByUserId: member.userId as string })
      .returning()
      .then((rows) => rows[0]!);
    const app = createApp(member);

    for (const worktreeParentDir of [
      "../../../../../../../../tmp/rv999-escape",
      "/tmp/rv999-escape",
    ]) {
      const res = await request(app)
        .patch(`/api/projects/${project.id}`)
        .send({
          executionWorkspacePolicy: {
            enabled: true,
            workspaceStrategy: { type: "git_worktree", worktreeParentDir },
          },
        });
      expect(res.status, worktreeParentDir).toBe(403);
    }
  });
});
