// REVIEW PROBES for PR #999 — not for commit.
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
  approvals,
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
import { resolvePaperclipInstanceRoot, sanitizeFriendlyPathSegment } from "../home-paths.js";
import { approvalAuthorityService } from "../services/approval-authority.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const instanceRoot = resolvePaperclipInstanceRoot();
const companyProjectsRoot = (companyId: string) =>
  path.join(instanceRoot, "projects", sanitizeFriendlyPathSegment(companyId, "company"));

d("PR #999 review probes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupPaths: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-999-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(approvals);
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

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    a.use("/api", projectRoutes(db));
    a.use(errorHandler);
    return a;
  }
  const member = (companyId: string) => ({
    type: "board",
    source: "session",
    userId: `member-${randomUUID()}`,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "member" }],
    isInstanceAdmin: false,
  });
  async function seedCompany(prefix: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Co ${prefix}`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    return id;
  }
  async function seedProject(companyId: string) {
    return (await db.insert(projects).values({ companyId, name: "P" }).returning())[0]!;
  }

  it("PROBE A: remote_managed sourceType exempts an arbitrary host cwd (single step)", async () => {
    const c = await seedCompany("RVA");
    const p = await seedProject(c);
    const res = await request(app(member(c)))
      .post(`/api/projects/${p.id}/workspaces`)
      .send({ name: "x", sourceType: "remote_managed", remoteWorkspaceRef: "r", cwd: "/etc" });
    console.log("PROBE A status", res.status, res.body?.cwd, res.body?.sourceType);
    // then flip back to local_path without resending cwd
    const flip = await request(app(member(c)))
      .patch(`/api/projects/${p.id}/workspaces/${res.body.id}`)
      .send({ sourceType: "local_path" });
    console.log("PROBE A flip", flip.status, flip.body?.cwd, flip.body?.sourceType);
    // and echoing the laundered cwd is grandfathered
    const echo = await request(app(member(c)))
      .patch(`/api/projects/${p.id}/workspaces/${res.body.id}`)
      .send({ cwd: "/etc", sourceType: "non_git_path" });
    console.log("PROBE A echo", echo.status, echo.body?.cwd, echo.body?.sourceType);
    expect(res.status).toBe(403);
    const seeded = (await db.insert(projectWorkspaces).values({ companyId: c, projectId: p.id, name: "l", sourceType: "remote_managed", remoteWorkspaceRef: "r", cwd: "/etc" }).returning())[0]!;
    const f1 = await request(app(member(c))).patch(`/api/projects/${p.id}/workspaces/${seeded.id}`).send({ sourceType: "local_path" });
    const f2 = await request(app(member(c))).patch(`/api/projects/${p.id}/workspaces/${seeded.id}`).send({ sourceType: "non_git_path", cwd: "/etc" });
    const f3 = await request(app(member(c))).patch(`/api/projects/${p.id}/workspaces/${seeded.id}`).send({ name: "rename" });
    console.log("PROBE A seeded flip", f1.status, "flip+echo", f2.status, "rename", f3.status);
    expect(f1.status).toBe(403);
    expect(f2.status).toBe(403);
  });

  it("PROBE B: embedded workspace on project create is confined", async () => {
    const c = await seedCompany("RVB");
    const m = member(c);
    await db.insert(principalPermissionGrants).values({ companyId: c, principalType: "user", principalId: m.userId, permissionKey: "projects:create", grantedByUserId: "g" });
    await db.insert(companyMemberships).values({ companyId: c, principalType: "user", principalId: m.userId, status: "active", membershipRole: "member" });
    const res = await request(app(m))
      .post(`/api/companies/${c}/projects`)
      .send({ name: "P2", workspace: { name: "w", cwd: "/etc" } });
    console.log("PROBE B status", res.status, res.body?.error);
    expect(res.status).toBe(403);
  });

  it("PROBE C: dot-dot traversal out of own managed root into another company's", async () => {
    const a = await seedCompany("RVC");
    const b = await seedCompany("RVD");
    const p = await seedProject(a);
    const cwd = `${companyProjectsRoot(a)}/${p.id}/../../${sanitizeFriendlyPathSegment(b, "company")}/x`;
    const res = await request(app(member(a))).post(`/api/projects/${p.id}/workspaces`).send({ name: "x", cwd });
    console.log("PROBE C status", res.status);
    expect(res.status).toBe(403);
  });

  it("PROBE D: symlink planted inside own managed root pointing outside", async () => {
    const c = await seedCompany("RVE");
    const p = await seedProject(c);
    const dir = path.join(companyProjectsRoot(c), p.id);
    fs.mkdirSync(dir, { recursive: true });
    cleanupPaths.push(companyProjectsRoot(c));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "rv999-out-"));
    cleanupPaths.push(target);
    fs.symlinkSync(target, path.join(dir, "link"));
    const res = await request(app(member(c)))
      .post(`/api/projects/${p.id}/workspaces`)
      .send({ name: "x", cwd: path.join(dir, "link", "sub") });
    console.log("PROBE D status", res.status, res.body?.error);
    expect(res.status).toBe(403);
  });

  it("PROBE E: a registered execution workspace with a wide cwd widens the allow-list", async () => {
    const c = await seedCompany("RVF");
    const p = await seedProject(c);
    // e.g. a run that resolved to an instance-admin-set adapterConfig.cwd of $HOME,
    // or to a grandfathered project cwd
    await db.insert(executionWorkspaces).values({
      companyId: c,
      projectId: p.id,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "w",
      status: "archived",
      providerType: "local_fs",
      cwd: os.homedir(),
    } as any);
    const res = await request(app(member(c)))
      .post(`/api/projects/${p.id}/workspaces`)
      .send({ name: "x", cwd: path.join(os.homedir(), ".ssh") });
    console.log("PROBE E status", res.status);
    expect(res.status).toBe(403);
  });

  it("PROBE F: relative worktreeParentDir with .. is not gated", async () => {
    const c = await seedCompany("RVG");
    const m = member(c);
    const p = (await db.insert(projects).values({ companyId: c, name: "P", createdByUserId: m.userId }).returning())[0]!;
    const res = await request(app(m))
      .patch(`/api/projects/${p.id}`)
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          workspaceStrategy: { type: "git_worktree", worktreeParentDir: "../../../../../../../../tmp/rv999-escape" },
        },
      });
    console.log("PROBE F rel body", JSON.stringify(res.body).slice(0,300));
    const abs = await request(app(m))
      .patch(`/api/projects/${p.id}`)
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          workspaceStrategy: { type: "git_worktree", worktreeParentDir: "/tmp/rv999-escape" },
        },
      });
    console.log("PROBE F relative", res.status, "absolute", abs.status, abs.body?.error);
    expect(abs.status).toBe(403);
    expect(res.status).toBe(403);
  });

  it("PROBE G: emergency override write path still admits an agents:create member", async () => {
    const c = await seedCompany("RVH");
    const userId = `member-${randomUUID()}`;
    await db.insert(principalPermissionGrants).values({
      companyId: c,
      principalType: "user",
      principalId: userId,
      permissionKey: "agents:create",
      grantedByUserId: "granter",
    });
    await db.insert(companyMemberships).values({ companyId: c, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    const approval = (
      await db
        .insert(approvals)
        .values({ companyId: c, type: "budget_override_required", status: "pending", payload: {} })
        .returning()
    )[0]!;
    const authority = approvalAuthorityService(db);
    let outcome = "allowed";
    try {
      await authority.requireEmergencyOverride(approval as any, { userId, source: "session" }, {
        overrideReason: "because",
        revision: (approval as any).revision,
      } as any);
    } catch (err) {
      outcome = `refused: ${(err as Error).message}`;
    }
    console.log("PROBE G", outcome);
    expect(outcome).not.toBe("allowed");
  });
});
