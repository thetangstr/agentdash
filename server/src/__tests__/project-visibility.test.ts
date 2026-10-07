import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// These fixtures inject req.actor without running the auth middleware, so no
// verified credential exists. Current-authority witnesses are covered with the
// real middleware in issue-current-authority.test.ts.
vi.mock("../services/issue-current-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-current-authority.js")>()),
  issueCurrentAuthority: () => undefined,
}));

import {
  agents,
  companies,
  companyMemberships,
  createDb,
  activityLog,
  approvals,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
  projectAccess,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectRoutes } from "../routes/projects.js";
import { issueRoutes } from "../routes/issues.js";
import { assistantRoutes } from "../routes/assistant.js";
import { activityRoutes } from "../routes/activity.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { verdictRoutes } from "../routes/verdicts.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { logActivity } from "../services/activity-log.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * A5 (2026-08-16), the leak test: one restricted project, walked from every
 * angle by every kind of actor, against the REAL routers and a REAL database.
 *
 * The property: to an actor off the access list, a restricted project and
 * everything inside it is NONEXISTENT — absent from lists, 404 on detail
 * (never 403: confirming existence is itself the leak). Falsification for
 * each case is removing the one visibility condition from the query it
 * covers; the named case must fail.
 */
describeEmbeddedPostgres("restricted project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OPEN_PROJECT = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const OPEN_ISSUE = randomUUID();
  const SECRET_ISSUE = randomUUID();
  const LEAD_AGENT = randomUUID();
  const OUTSIDE_AGENT = randomUUID();
  const SECRET_IDENTIFIER = "VISSEC-1";
  const SECRET_COMMENT = randomUUID();
  const SECRET_DOCUMENT = randomUUID();
  const SECRET_WORK_PRODUCT = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-visibility-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Visibility Co" });
    for (const [userId, role] of [
      ["admin-user", "admin"],
      ["sam", "member"],
      ["member-user", "member"],
    ] as const) {
      await db.insert(companyMemberships).values({
        companyId: COMPANY,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: role,
      });
    }
    await db.insert(agents).values([
      { id: LEAD_AGENT, companyId: COMPANY, name: "Lead", role: "general" },
      { id: OUTSIDE_AGENT, companyId: COMPANY, name: "Outside", role: "general" },
    ]);
    await db.insert(projects).values([
      { id: OPEN_PROJECT, companyId: COMPANY, name: "Open project", createdByUserId: "admin-user" },
      {
        id: SECRET_PROJECT,
        companyId: COMPANY,
        name: "Sam's restricted project",
        createdByUserId: "sam",
        visibility: "restricted",
        leadAgentId: LEAD_AGENT,
      },
    ]);
    await db.insert(projectAccess).values({
      projectId: SECRET_PROJECT,
      principalType: "agent",
      principalId: LEAD_AGENT,
      grantedByUserId: "sam",
    });
    await db.insert(issues).values([
      { id: OPEN_ISSUE, companyId: COMPANY, projectId: OPEN_PROJECT, title: "Open issue", status: "todo" },
      {
        id: SECRET_ISSUE,
        companyId: COMPANY,
        projectId: SECRET_PROJECT,
        identifier: SECRET_IDENTIFIER,
        title: "Secret issue",
        status: "todo",
      },
    ]);
    await db.insert(issueComments).values({
      id: SECRET_COMMENT,
      companyId: COMPANY,
      issueId: SECRET_ISSUE,
      authorUserId: "sam",
      body: "Secret comment body",
    });
    await db.insert(documents).values({
      id: SECRET_DOCUMENT,
      companyId: COMPANY,
      title: "Secret plan",
      latestBody: "Secret document body",
      createdByUserId: "sam",
    });
    await db.insert(issueDocuments).values({
      companyId: COMPANY,
      issueId: SECRET_ISSUE,
      documentId: SECRET_DOCUMENT,
      key: "plan",
    });
    await db.insert(issueWorkProducts).values({
      id: SECRET_WORK_PRODUCT,
      companyId: COMPANY,
      issueId: SECRET_ISSUE,
      type: "document",
      provider: "custom",
      title: "Secret work product",
      status: "active",
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appAs(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", projectRoutes(db));
    app.use("/api", issueRoutes(db));
    app.use("/api", assistantRoutes(db));
    app.use("/api", activityRoutes(db));
    app.use("/api", issueTreeControlRoutes(db));
    app.use("/api", verdictRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use("/api", approvalRoutes(db));
    app.use("/api", executionWorkspaceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const asUser = (userId: string, role: string) => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [COMPANY],
    memberships: [{ companyId: COMPANY, membershipRole: role, status: "active" }],
  });
  const asAgent = (agentId: string) => ({
    type: "agent",
    agentId,
    companyId: COMPANY,
    source: "agent_key",
    companyIds: [COMPANY],
  });

  it("project list: creator and admin see it; another member does not", async () => {
    const names = async (actor: Record<string, unknown>) =>
      (await request(appAs(actor)).get(`/api/companies/${COMPANY}/projects`)).body.map(
        (p: { name: string }) => p.name,
      );

    expect(await names(asUser("sam", "member"))).toContain("Sam's restricted project");
    expect(await names(asUser("admin-user", "admin"))).toContain("Sam's restricted project");
    const memberSees = await names(asUser("member-user", "member"));
    expect(memberSees).toContain("Open project");
    expect(memberSees).not.toContain("Sam's restricted project");
  });

  it("project detail: 404 for an off-list member — never 403", async () => {
    const res = await request(appAs(asUser("member-user", "member"))).get(`/api/projects/${SECRET_PROJECT}`);
    expect(res.status).toBe(404);

    expect(
      (await request(appAs(asUser("sam", "member"))).get(`/api/projects/${SECRET_PROJECT}`)).status,
    ).toBe(200);
    expect(
      (await request(appAs(asUser("admin-user", "admin"))).get(`/api/projects/${SECRET_PROJECT}`)).status,
    ).toBe(200);
  });

  describe("GH #917: project mutations check visibility before edit authority", () => {
    it("PATCH is 404, not 403, for an off-list member — and nothing is written", async () => {
      const res = await request(appAs(asUser("member-user", "member")))
        .patch(`/api/projects/${SECRET_PROJECT}`)
        .send({ name: "renamed-by-offlist" });
      expect(res.status).toBe(404);
      const row = await db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, SECRET_PROJECT))
        .then((rows) => rows[0]);
      expect(row?.name).toBe("Sam's restricted project");
    });

    it("access list read/replace and delete are 404 for an off-list member, never 403", async () => {
      const app = appAs(asUser("member-user", "member"));
      expect((await request(app).get(`/api/projects/${SECRET_PROJECT}/access`)).status).toBe(404);
      expect(
        (await request(app).put(`/api/projects/${SECRET_PROJECT}/access`).send({ access: [] }))
          .status,
      ).toBe(404);
      expect((await request(app).delete(`/api/projects/${SECRET_PROJECT}`)).status).toBe(404);
    });

    it("the creator keeps write authority; a listed agent is visible but never an editor", async () => {
      const res = await request(appAs(asUser("sam", "member")))
        .patch(`/api/projects/${SECRET_PROJECT}`)
        .send({ name: "Sam renamed it" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Sam renamed it");

      const agentRes = await request(appAs(asAgent(LEAD_AGENT)))
        .patch(`/api/projects/${SECRET_PROJECT}`)
        .send({ name: "agent must not write" });
      expect(agentRes.status).toBe(403);

      // Restore the shared fixture so later name-based assertions do not
      // depend on test order.
      await db
        .update(projects)
        .set({ name: "Sam's restricted project" })
        .where(eq(projects.id, SECRET_PROJECT));
    });
  });

  /**
   * GH #1052: the workspace sub-routes of a restricted project follow the
   * same rule as the project itself. Off-list, the project does not exist:
   * every read and write is 404 and nothing is written. Falsification:
   * drop the `assertProjectVisible` call from any one handler and its case
   * returns 200/201/422 instead of 404.
   */
  describe("GH #1052: project workspace routes obey the project rule", () => {
    const SECRET_WS = randomUUID();
    const createdWorkspaceIds: string[] = [];

    beforeAll(async () => {
      await db.insert(projectWorkspaces).values({
        id: SECRET_WS,
        companyId: COMPANY,
        projectId: SECRET_PROJECT,
        name: "Secret repo checkout",
        sourceType: "git_repo",
        repoUrl: "https://github.com/acme/secret-repo",
      });
    });

    afterAll(async () => {
      for (const id of [SECRET_WS, ...createdWorkspaceIds]) {
        await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, id));
      }
    });

    const workspaceRow = async (id: string) =>
      db
        .select({ name: projectWorkspaces.name })
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);

    const workspaceCount = async () =>
      (await db.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(eq(projectWorkspaces.projectId, SECRET_PROJECT)))
        .length;

    for (const [label, actor] of [
      ["an off-list member", () => asUser("member-user", "member")],
      ["an off-list agent", () => asAgent(OUTSIDE_AGENT)],
    ] as const) {
      it(`list: 404 for ${label}, and no workspace data in the body`, async () => {
        const res = await request(appAs(actor())).get(`/api/projects/${SECRET_PROJECT}/workspaces`);
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain("secret-repo");
      });

      it(`create, update and delete: 404 for ${label}, nothing written`, async () => {
        const app = appAs(actor());
        const before = await workspaceCount();
        const created = await request(app)
          .post(`/api/projects/${SECRET_PROJECT}/workspaces`)
          .send({ name: "planted", sourceType: "git_repo", repoUrl: "https://github.com/acme/planted" });
        const patched = await request(app)
          .patch(`/api/projects/${SECRET_PROJECT}/workspaces/${SECRET_WS}`)
          .send({ name: "renamed-by-offlist" });
        const deleted = await request(app).delete(`/api/projects/${SECRET_PROJECT}/workspaces/${SECRET_WS}`);
        if (created.status === 201) createdWorkspaceIds.push(created.body.id);
        expect({ create: created.status, update: patched.status, delete: deleted.status }).toEqual({
          create: 404,
          update: 404,
          delete: 404,
        });
        expect(await workspaceCount()).toBe(before);
        expect((await workspaceRow(SECRET_WS))?.name).toBe("Secret repo checkout");
        expect(await workspaceRow(SECRET_WS)).not.toBeNull();
      });

      it(`runtime services and commands: 404 for ${label} on every action`, async () => {
        const app = appAs(actor());
        for (const kind of ["runtime-services", "runtime-commands"]) {
          for (const action of ["start", "stop", "restart", "run"]) {
            const res = await request(app)
              .post(`/api/projects/${SECRET_PROJECT}/workspaces/${SECRET_WS}/${kind}/${action}`)
              .send({});
            expect({ kind, action, status: res.status }).toEqual({ kind, action, status: 404 });
          }
        }
      });
    }

    it("on-list actors keep access: creator and admin read and write, the listed agent reads", async () => {
      for (const actor of [asUser("sam", "member"), asUser("admin-user", "admin"), asAgent(LEAD_AGENT)]) {
        const res = await request(appAs(actor)).get(`/api/projects/${SECRET_PROJECT}/workspaces`);
        expect(res.status).toBe(200);
        expect(res.body.map((w: { id: string }) => w.id)).toContain(SECRET_WS);
      }

      for (const [actor, name] of [
        [asUser("sam", "member"), "creator workspace"],
        [asUser("admin-user", "admin"), "admin workspace"],
      ] as const) {
        const app = appAs(actor);
        const created = await request(app)
          .post(`/api/projects/${SECRET_PROJECT}/workspaces`)
          .send({ name, sourceType: "git_repo", repoUrl: "https://github.com/acme/on-list" });
        expect(created.status).toBe(201);
        createdWorkspaceIds.push(created.body.id);

        const patched = await request(app)
          .patch(`/api/projects/${SECRET_PROJECT}/workspaces/${created.body.id}`)
          .send({ name: `${name} renamed` });
        expect(patched.status).toBe(200);
        expect(patched.body.name).toBe(`${name} renamed`);

        // The visibility check passes; the request then reaches the handler's
        // own validation (this repo-only workspace has no local path).
        const runtime = await request(app)
          .post(`/api/projects/${SECRET_PROJECT}/workspaces/${created.body.id}/runtime-services/start`)
          .send({});
        expect(runtime.status).toBe(422);

        const deleted = await request(app).delete(`/api/projects/${SECRET_PROJECT}/workspaces/${created.body.id}`);
        expect(deleted.status).toBe(200);
      }
    });

    it("an open project's workspaces stay readable to every member", async () => {
      const res = await request(appAs(asUser("member-user", "member"))).get(`/api/projects/${OPEN_PROJECT}/workspaces`);
      expect(res.status).toBe(200);
    });
  });

  it("issue list: the restricted project's issues vanish for an off-list member", async () => {
    const titles = async (actor: Record<string, unknown>) => {
      const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/issues`);
      const list = Array.isArray(res.body) ? res.body : res.body.issues;
      return (list ?? []).map((i: { title: string }) => i.title);
    };

    const member = await titles(asUser("member-user", "member"));
    expect(member).toContain("Open issue");
    expect(member).not.toContain("Secret issue");
    expect(await titles(asUser("sam", "member"))).toContain("Secret issue");
    expect(await titles(asUser("admin-user", "admin"))).toContain("Secret issue");
  });

  it("issue detail: 404 for an off-list member", async () => {
    expect(
      (await request(appAs(asUser("member-user", "member"))).get(`/api/issues/${SECRET_ISSUE}`)).status,
    ).toBe(404);
    expect(
      (await request(appAs(asUser("sam", "member"))).get(`/api/issues/${SECRET_ISSUE}`)).status,
    ).toBe(200);
  });

  it("agents: the lead agent (on the access list) sees it; another agent does not", async () => {
    expect(
      (await request(appAs(asAgent(LEAD_AGENT))).get(`/api/projects/${SECRET_PROJECT}`)).status,
    ).toBe(200);
    expect(
      (await request(appAs(asAgent(OUTSIDE_AGENT))).get(`/api/projects/${SECRET_PROJECT}`)).status,
    ).toBe(404);
    const res = await request(appAs(asAgent(OUTSIDE_AGENT))).get(
      `/api/companies/${COMPANY}/issues`,
    );
    const list = Array.isArray(res.body) ? res.body : res.body.issues;
    expect((list ?? []).map((i: { title: string }) => i.title)).not.toContain("Secret issue");
  });

  // AgentDash consolidation PR-A (review H3): the assistant digest and its
  // changed[] feed obey the same rule — a restricted project is nonexistent.
  it("assistant digest: 404 on the restricted projectId, and changed[] omits its rows", async () => {
    for (const [issueId, title] of [[OPEN_ISSUE, "Open issue"], [SECRET_ISSUE, "Secret issue"]] as const) {
      await logActivity(db, {
        companyId: COMPANY,
        actorType: "user",
        actorId: "admin-user",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: "todo", title },
      });
    }
    const digestFor = (actor: Record<string, unknown>, query = "") =>
      request(appAs(actor)).get(`/api/companies/${COMPANY}/assistant/digest${query}`);

    expect((await digestFor(asUser("member-user", "member"), `?projectId=${SECRET_PROJECT}`)).status).toBe(404);
    expect((await digestFor(asUser("sam", "member"), `?projectId=${SECRET_PROJECT}`)).status).toBe(200);
    expect((await digestFor(asUser("admin-user", "admin"), `?projectId=${SECRET_PROJECT}`)).status).toBe(200);
    expect((await digestFor(asUser("member-user", "member"), `?projectId=${randomUUID()}`)).status).toBe(404);

    const member = await digestFor(asUser("member-user", "member"));
    expect(member.status).toBe(200);
    const memberTitles = member.body.changed.items.map((row: { title: string | null }) => row.title);
    expect(memberTitles).toContain("Open issue");
    expect(JSON.stringify(member.body)).not.toContain("Secret issue");
    expect(JSON.stringify(member.body)).not.toContain(SECRET_ISSUE);

    const sam = await digestFor(asUser("sam", "member"));
    expect(sam.body.changed.items.map((row: { title: string | null }) => row.title)).toContain("Secret issue");
  });

  it("a legacy operator row is a member here too — no residual privilege", async () => {
    const res = await request(appAs(asUser("member-user", "operator"))).get(
      `/api/projects/${SECRET_PROJECT}`,
    );
    expect(res.status).toBe(404);
  });

  /**
   * GH #830 adjacent gap (PR 8): the detail route above was guarded, but
   * every sub-route under it (comments, documents, heartbeat-context, PATCH,
   * attachments, work products, ...) served the same restricted issue to
   * anyone holding its id, and create/PATCH could file or move an issue
   * into a restricted project. Falsification: drop the `assertIssueIdVisible`
   * call from the `router.param("id")` guard in routes/issues.ts, or the
   * `assertIssueWriteTargetsVisible` call from create/PATCH — the named
   * cases go 200/201.
   */
  describe("GH #830: every /issues/:id/* route obeys the project rule", () => {
    const offListActors = () =>
      [
        ["an off-list board member", asUser("member-user", "member")],
        ["an off-list agent", asAgent(OUTSIDE_AGENT)],
      ] as const;
    const onListActors = () =>
      [
        ["the creator", asUser("sam", "member")],
        ["the listed lead agent", asAgent(LEAD_AGENT)],
      ] as const;

    const secretReadRoutes = () => [
      `/api/issues/${SECRET_ISSUE}/comments`,
      `/api/issues/${SECRET_ISSUE}/comments/${SECRET_COMMENT}`,
      `/api/issues/${SECRET_ISSUE}/documents`,
      `/api/issues/${SECRET_ISSUE}/documents/plan`,
      `/api/issues/${SECRET_ISSUE}/documents/plan/revisions`,
      `/api/issues/${SECRET_ISSUE}/heartbeat-context`,
      `/api/issues/${SECRET_IDENTIFIER}/heartbeat-context`,
      `/api/issues/${SECRET_IDENTIFIER}/comments`,
      `/api/issues/${SECRET_ISSUE}/work-products`,
      `/api/issues/${SECRET_ISSUE}/attachments`,
      `/api/issues/${SECRET_ISSUE}/approvals`,
      `/api/issues/${SECRET_ISSUE}/interactions`,
      `/api/issues/${SECRET_ISSUE}/child-contributions`,
      `/api/issues/${SECRET_ISSUE}/feedback-votes`,
      `/api/issues/${SECRET_ISSUE}/activity`,
      `/api/issues/${SECRET_ISSUE}/runs`,
      `/api/issues/${SECRET_ISSUE}/live-runs`,
      `/api/issues/${SECRET_IDENTIFIER}/active-run`,
      `/api/issues/${SECRET_ISSUE}/tree-control/state`,
      `/api/issues/${SECRET_ISSUE}/tree-holds`,
      `/api/companies/${COMPANY}/issues/${SECRET_ISSUE}/review-timeline`,
    ];

    function expectNonexistent(res: request.Response, label: string) {
      expect(res.status, label).toBe(404);
      const body = JSON.stringify(res.body);
      expect(body, label).not.toContain("Secret");
      expect(body, label).not.toContain(SECRET_PROJECT);
    }

    it("reads: 404 on every sub-route for an off-list member and an off-list agent", async () => {
      for (const [who, actor] of offListActors()) {
        const app = appAs(actor);
        for (const path of secretReadRoutes()) {
          expectNonexistent(await request(app).get(path), `${who} GET ${path}`);
        }
      }
    });

    it("reads: the creator, the listed agent and an admin still get the content", async () => {
      const paths = [
        `/api/issues/${SECRET_ISSUE}/comments`,
        `/api/issues/${SECRET_ISSUE}/comments/${SECRET_COMMENT}`,
        `/api/issues/${SECRET_ISSUE}/documents`,
        `/api/issues/${SECRET_ISSUE}/documents/plan`,
        `/api/issues/${SECRET_ISSUE}/heartbeat-context`,
        `/api/issues/${SECRET_IDENTIFIER}/heartbeat-context`,
        `/api/issues/${SECRET_ISSUE}/work-products`,
        `/api/issues/${SECRET_ISSUE}/activity`,
        `/api/issues/${SECRET_ISSUE}/live-runs`,
      ];
      for (const [who, actor] of [...onListActors(), ["an admin", asUser("admin-user", "admin")] as const]) {
        const app = appAs(actor);
        for (const path of paths) {
          const res = await request(app).get(path);
          expect(res.status, `${who} GET ${path}`).toBe(200);
        }
        const comments = await request(app).get(`/api/issues/${SECRET_ISSUE}/comments`);
        expect(JSON.stringify(comments.body), who).toContain("Secret comment body");
        const doc = await request(app).get(`/api/issues/${SECRET_ISSUE}/documents/plan`);
        expect(doc.body.body, who).toBe("Secret document body");
        const context = await request(app).get(`/api/issues/${SECRET_ISSUE}/heartbeat-context`);
        expect(context.body.issue.title, who).toBe("Secret issue");
      }
    });

    it("writes: comment, document, PATCH and child create are 404 and change nothing", async () => {
      for (const [who, actor] of offListActors()) {
        const app = appAs(actor);
        expectNonexistent(
          await request(app).post(`/api/issues/${SECRET_ISSUE}/comments`).send({ body: `leak from ${who}` }),
          `${who} POST comment`,
        );
        expectNonexistent(
          await request(app)
            .delete(`/api/issues/${SECRET_ISSUE}/comments/${SECRET_COMMENT}`),
          `${who} DELETE comment`,
        );
        expectNonexistent(
          await request(app)
            .put(`/api/issues/${SECRET_ISSUE}/documents/plan`)
            .send({ format: "markdown", body: `overwritten by ${who}` }),
          `${who} PUT document`,
        );
        expectNonexistent(
          await request(app).patch(`/api/issues/${SECRET_ISSUE}`).send({ title: `hijacked by ${who}` }),
          `${who} PATCH issue`,
        );
        expectNonexistent(
          await request(app).patch(`/api/issues/${SECRET_IDENTIFIER}`).send({ priority: "urgent" }),
          `${who} PATCH issue by identifier`,
        );
        expectNonexistent(
          await request(app).post(`/api/issues/${SECRET_ISSUE}/children`).send({ title: `child from ${who}` }),
          `${who} POST child`,
        );
        expectNonexistent(
          await request(app).patch(`/api/work-products/${SECRET_WORK_PRODUCT}`).send({ title: "renamed" }),
          `${who} PATCH work product`,
        );
        expectNonexistent(
          await request(app)
            .post(`/api/companies/${COMPANY}/issues/${SECRET_ISSUE}/attachments`)
            .attach("file", Buffer.from("leak"), "leak.txt"),
          `${who} POST attachment`,
        );
        expectNonexistent(await request(app).post(`/api/issues/${SECRET_ISSUE}/read`), `${who} POST read`);
        expectNonexistent(
          await request(app).post(`/api/issues/${SECRET_ISSUE}/inbox-archive`),
          `${who} POST inbox-archive`,
        );
      }

      const [issue] = await db.select().from(issues).where(eq(issues.id, SECRET_ISSUE));
      expect(issue.title).toBe("Secret issue");
      expect(issue.priority).not.toBe("urgent");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, SECRET_ISSUE));
      expect(comments.map((c) => c.body)).toEqual(["Secret comment body"]);
      const [doc] = await db.select().from(documents).where(eq(documents.id, SECRET_DOCUMENT));
      expect(doc.latestBody).toBe("Secret document body");
      const [product] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, SECRET_WORK_PRODUCT));
      expect(product.title).toBe("Secret work product");
      const children = await db.select().from(issues).where(eq(issues.parentId, SECRET_ISSUE));
      expect(children).toHaveLength(0);
    });

    it("create and move: 404 when the target project or parent is invisible, nothing written", async () => {
      for (const [who, actor] of offListActors()) {
        const app = appAs(actor);
        expectNonexistent(
          await request(app)
            .post(`/api/companies/${COMPANY}/issues`)
            .send({ title: `planted by ${who}`, projectId: SECRET_PROJECT }),
          `${who} create into restricted project`,
        );
        expectNonexistent(
          await request(app)
            .post(`/api/companies/${COMPANY}/issues`)
            .send({ title: `orphan by ${who}`, parentId: SECRET_ISSUE }),
          `${who} create under restricted parent`,
        );
        const res = await request(app).patch(`/api/issues/${OPEN_ISSUE}`).send({ projectId: SECRET_PROJECT });
        expect(res.status, `${who} move into restricted project`).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain("Secret");
      }

      const [open] = await db.select().from(issues).where(eq(issues.id, OPEN_ISSUE));
      expect(open.projectId).toBe(OPEN_PROJECT);
      const inSecret = await db.select().from(issues).where(eq(issues.projectId, SECRET_PROJECT));
      expect(inSecret.map((i) => i.id)).toEqual([SECRET_ISSUE]);
    });

    it("on-list actors can still comment, write documents, PATCH, create into and move into the project", async () => {
      for (const [who, actor] of onListActors()) {
        const app = appAs(actor);
        const comment = await request(app)
          .post(`/api/issues/${SECRET_ISSUE}/comments`)
          .send({ body: `note from ${who}` });
        expect(comment.status, `${who} POST comment`).toBe(201);

        const doc = await request(app)
          .put(`/api/issues/${SECRET_ISSUE}/documents/notes-${who.replace(/\W+/g, "-")}`)
          .send({ format: "markdown", body: `notes from ${who}` });
        expect([200, 201], `${who} PUT document`).toContain(doc.status);

        const patched = await request(app).patch(`/api/issues/${SECRET_ISSUE}`).send({ priority: "high" });
        expect(patched.status, `${who} PATCH issue`).toBe(200);

        const created = await request(app)
          .post(`/api/companies/${COMPANY}/issues`)
          .send({ title: `filed by ${who}`, projectId: SECRET_PROJECT });
        expect(created.status, `${who} create into project`).toBe(201);
        expect(created.body.projectId).toBe(SECRET_PROJECT);

        const loose = await request(app)
          .post(`/api/companies/${COMPANY}/issues`)
          .send({ title: `to move by ${who}`, projectId: OPEN_PROJECT });
        expect(loose.status).toBe(201);
        const moved = await request(app).patch(`/api/issues/${loose.body.id}`).send({ projectId: SECRET_PROJECT });
        expect(moved.status, `${who} move into project`).toBe(200);
        expect(moved.body.projectId).toBe(SECRET_PROJECT);
      }
    });
  });

  /**
   * GH #830 review (PR 8, changes requested): (1) the guard must fail closed
   * on id forms Postgres casts but the guard does not recognise, and (2) the
   * sibling routes that reach the same content without an /issues/:id path.
   */
  describe("GH #830 review: non-canonical ids and sibling surfaces", () => {
    const SECRET_RUN = randomUUID();
    const OPEN_RUN = randomUUID();
    const SECRET_PROJECT_WORKSPACE = randomUUID();
    const SECRET_EXEC_WORKSPACE = randomUUID();
    const OPEN_EXEC_WORKSPACE = randomUUID();
    const OPEN_PROJECT_WORKSPACE = randomUUID();
    const offList = () =>
      [
        ["an off-list board member", asUser("member-user", "member")],
        ["an off-list agent", asAgent(OUTSIDE_AGENT)],
      ] as const;
    const onList = () =>
      [
        ["the creator", asUser("sam", "member")],
        ["the listed lead agent", asAgent(LEAD_AGENT)],
      ] as const;
    const hyphenless = (id: string) => id.replaceAll("-", "");
    const braced = (id: string) => `%7B${id}%7D`;

    beforeAll(async () => {
      await db.insert(heartbeatRuns).values([
        {
          id: SECRET_RUN,
          companyId: COMPANY,
          agentId: LEAD_AGENT,
          status: "queued",
          contextSnapshot: { issueId: SECRET_ISSUE },
        },
        {
          id: OPEN_RUN,
          companyId: COMPANY,
          agentId: LEAD_AGENT,
          status: "queued",
          contextSnapshot: { issueId: OPEN_ISSUE },
        },
      ]);
      await db.insert(projectWorkspaces).values([
        { id: SECRET_PROJECT_WORKSPACE, companyId: COMPANY, projectId: SECRET_PROJECT, name: "Secret checkout" },
        { id: OPEN_PROJECT_WORKSPACE, companyId: COMPANY, projectId: OPEN_PROJECT, name: "Open checkout" },
      ]);
      await db.insert(executionWorkspaces).values([
        {
          id: SECRET_EXEC_WORKSPACE,
          companyId: COMPANY,
          projectId: SECRET_PROJECT,
          projectWorkspaceId: SECRET_PROJECT_WORKSPACE,
          sourceIssueId: SECRET_ISSUE,
          mode: "shared_workspace",
          strategyType: "project_primary",
          name: "Secret exec workspace",
        },
        {
          id: OPEN_EXEC_WORKSPACE,
          companyId: COMPANY,
          projectId: OPEN_PROJECT,
          sourceIssueId: OPEN_ISSUE,
          mode: "shared_workspace",
          strategyType: "project_primary",
          name: "Open exec workspace",
        },
      ]);
      for (const [entityType, entityId, label] of [
        ["issue", SECRET_ISSUE, "Secret issue activity"],
        ["project", SECRET_PROJECT, "Secret project activity"],
        ["issue", OPEN_ISSUE, "Open issue activity"],
      ] as const) {
        await logActivity(db, {
          companyId: COMPANY,
          actorType: "user",
          actorId: "sam",
          action: entityType === "issue" ? "issue.updated" : "project.updated",
          entityType,
          entityId,
          details: { label },
        });
      }
    });

    it("(1) hyphenless and braced ids are 404, including on routes that query the raw id", async () => {
      for (const [who, actor] of offList()) {
        const app = appAs(actor);
        for (const form of [hyphenless(SECRET_ISSUE), braced(SECRET_ISSUE)]) {
          for (const path of [
            `/api/companies/${COMPANY}/issues/${form}/review-timeline`,
            `/api/issues/${form}/comments`,
            `/api/issues/${form}/heartbeat-context`,
            `/api/issues/${form}/activity`,
            `/api/issues/${form}/tree-control/state`,
            `/api/issues/${form}/live-runs`,
          ]) {
            const res = await request(app).get(path);
            expect(res.status, `${who} GET ${path}`).toBe(404);
          }
          const dod = await request(app)
            .put(`/api/companies/${COMPANY}/issues/${form}/dod`)
            .send({ summary: "leak", criteria: [] });
          expect(dod.status, `${who} PUT dod ${form}`).toBe(404);
          const run = await request(app).get(`/api/heartbeat-runs/${hyphenless(SECRET_RUN)}`);
          expect(run.status, `${who} GET hyphenless run`).toBe(404);
        }
      }
      // Fail closed means closed for everyone: the canonical form is the API.
      const sam = await request(appAs(asUser("sam", "member"))).get(
        `/api/companies/${COMPANY}/issues/${hyphenless(SECRET_ISSUE)}/review-timeline`,
      );
      expect(sam.status).toBe(404);
      const samCanonical = await request(appAs(asUser("sam", "member"))).get(
        `/api/companies/${COMPANY}/issues/${SECRET_ISSUE}/review-timeline`,
      );
      expect(samCanonical.status).toBe(200);
    });

    it("(2a) company activity feed: rows about a restricted issue or project are absent off-list", async () => {
      const feed = (actor: Record<string, unknown>, query = "") =>
        request(appAs(actor)).get(`/api/companies/${COMPANY}/activity${query}`);
      for (const [who, actor] of offList()) {
        const filtered = await feed(actor, `?entityType=issue&entityId=${SECRET_ISSUE}`);
        expect(filtered.status, who).toBe(200);
        expect(filtered.body, who).toEqual([]);
        const all = await feed(actor);
        const body = JSON.stringify(all.body);
        expect(body, who).toContain("Open issue activity");
        expect(body, who).not.toContain(SECRET_ISSUE);
        expect(body, who).not.toContain(SECRET_PROJECT);
        expect(body, who).not.toContain("Secret");
      }
      for (const [who, actor] of [...onList(), ["an admin", asUser("admin-user", "admin")] as const]) {
        const body = JSON.stringify((await feed(actor)).body);
        expect(body, who).toContain("Secret issue activity");
        const filtered = await feed(actor, `?entityType=issue&entityId=${SECRET_ISSUE}`);
        expect(JSON.stringify(filtered.body), who).toContain("Secret issue activity");
      }
      // The creator made the project, so she sees its own rows too.
      expect(JSON.stringify((await feed(asUser("sam", "member"))).body)).toContain("Secret project activity");
    });

    it("(2b) runs: list, live list, detail, events, log, workspace ops and run issues are closed off-list", async () => {
      for (const [who, actor] of offList()) {
        const app = appAs(actor);
        const list = await request(app).get(`/api/companies/${COMPANY}/heartbeat-runs`);
        expect(list.status, who).toBe(200);
        const ids = list.body.map((run: { id: string }) => run.id);
        expect(ids, who).toContain(OPEN_RUN);
        expect(ids, who).not.toContain(SECRET_RUN);
        const live = await request(app).get(`/api/companies/${COMPANY}/live-runs`);
        expect(live.status, who).toBe(200);
        const liveIds = live.body.map((run: { id: string }) => run.id);
        expect(liveIds, who).toContain(OPEN_RUN);
        expect(liveIds, who).not.toContain(SECRET_RUN);
        for (const suffix of ["", "/events", "/log", "/workspace-operations", "/issues"]) {
          const res = await request(app).get(`/api/heartbeat-runs/${SECRET_RUN}${suffix}`);
          expect(res.status, `${who} GET run${suffix}`).toBe(404);
          expect(JSON.stringify(res.body)).not.toContain("Secret");
        }
        expect((await request(app).get(`/api/heartbeat-runs/${OPEN_RUN}`)).status, who).toBe(200);
      }
      for (const [who, actor] of onList()) {
        const app = appAs(actor);
        const list = await request(app).get(`/api/companies/${COMPANY}/heartbeat-runs`);
        expect(list.body.map((run: { id: string }) => run.id), who).toContain(SECRET_RUN);
        expect((await request(app).get(`/api/heartbeat-runs/${SECRET_RUN}`)).status, who).toBe(200);
        expect((await request(app).get(`/api/heartbeat-runs/${SECRET_RUN}/events`)).status, who).toBe(200);
        const runIssues = await request(app).get(`/api/heartbeat-runs/${SECRET_RUN}/issues`);
        expect(runIssues.body.map((i: { title: string }) => i.title), who).toContain("Secret issue");
      }
    });

    it("(2c) approvals: an off-list actor cannot link a restricted issue, nor read it through an approval", async () => {
      for (const [who, actor] of offList()) {
        const res = await request(appAs(actor))
          .post(`/api/companies/${COMPANY}/approvals`)
          .send({ type: "request_board_approval", payload: { title: `link by ${who}` }, issueIds: [SECRET_ISSUE] });
        expect(res.status, `${who} create approval linked to secret issue`).toBe(404);
      }
      // Every member may create agents, so the hire path reaches the guard
      // for the member (an agent without agents:create is refused 403 earlier).
      const hire = await request(appAs(asUser("member-user", "member")))
        .post(`/api/companies/${COMPANY}/agent-hires`)
        .send({
          name: "Hire by member-user",
          role: "general",
          adapterType: "codex_local",
          adapterConfig: {},
          sourceIssueIds: [SECRET_ISSUE],
        });
      expect(hire.status, "off-list member hire sourced from secret issue").toBe(404);
      const leaked = await db.select().from(approvals).where(eq(approvals.companyId, COMPANY));
      expect(leaked.filter((a) => String((a.payload as { title?: string }).title ?? "").startsWith("link by"))).toHaveLength(0);
      const hired = await db.select().from(agents).where(eq(agents.companyId, COMPANY));
      expect(hired.filter((a) => a.name.startsWith("Hire by"))).toHaveLength(0);

      const created = await request(appAs(asUser("sam", "member")))
        .post(`/api/companies/${COMPANY}/approvals`)
        .send({ type: "request_board_approval", payload: { title: "Sam's approval" }, issueIds: [SECRET_ISSUE, OPEN_ISSUE] });
      expect(created.status).toBe(201);
      const links = await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, created.body.id));
      expect(links).toHaveLength(2);

      const titlesFor = async (actor: Record<string, unknown>) => {
        const res = await request(appAs(actor)).get(`/api/approvals/${created.body.id}/issues`);
        expect(res.status).toBe(200);
        return res.body.map((i: { title: string }) => i.title);
      };
      expect(await titlesFor(asUser("member-user", "member"))).toEqual(["Open issue"]);
      expect((await titlesFor(asUser("sam", "member"))).sort()).toEqual(["Open issue", "Secret issue"]);
      expect((await titlesFor(asAgent(LEAD_AGENT))).sort()).toEqual(["Open issue", "Secret issue"]);
    });

    it("(2d) execution workspaces: filters naming restricted rows are 404; restricted rows are absent", async () => {
      for (const [who, actor] of offList()) {
        const app = appAs(actor);
        for (const query of [
          `issueId=${SECRET_ISSUE}`,
          `projectId=${SECRET_PROJECT}`,
          `projectWorkspaceId=${SECRET_PROJECT_WORKSPACE}`,
        ]) {
          const res = await request(app).get(`/api/companies/${COMPANY}/execution-workspaces?${query}`);
          expect(res.status, `${who} ?${query}`).toBe(404);
        }
        for (const summary of ["", "?summary=true"]) {
          const all = await request(app).get(`/api/companies/${COMPANY}/execution-workspaces${summary}`);
          expect(all.status, who).toBe(200);
          const ids = all.body.map((w: { id: string }) => w.id);
          expect(ids, who).toContain(OPEN_EXEC_WORKSPACE);
          expect(ids, who).not.toContain(SECRET_EXEC_WORKSPACE);
        }
        expect((await request(app).get(`/api/execution-workspaces/${SECRET_EXEC_WORKSPACE}`)).status, who).toBe(404);
        expect(
          (await request(app).get(`/api/execution-workspaces/${SECRET_EXEC_WORKSPACE}/workspace-operations`)).status,
          who,
        ).toBe(404);
      }
      for (const [who, actor] of onList()) {
        const app = appAs(actor);
        const filtered = await request(app).get(`/api/companies/${COMPANY}/execution-workspaces?issueId=${SECRET_ISSUE}`);
        expect(filtered.status, who).toBe(200);
        expect(filtered.body.map((w: { id: string }) => w.id), who).toEqual([SECRET_EXEC_WORKSPACE]);
        expect((await request(app).get(`/api/execution-workspaces/${SECRET_EXEC_WORKSPACE}`)).status, who).toBe(200);
      }
    });

    it("(2e) create and PATCH with only a restricted project's workspace id are 404", async () => {
      for (const [who, actor] of offList()) {
        const app = appAs(actor);
        for (const body of [
          { projectWorkspaceId: SECRET_PROJECT_WORKSPACE },
          { executionWorkspaceId: SECRET_EXEC_WORKSPACE },
        ]) {
          const created = await request(app)
            .post(`/api/companies/${COMPANY}/issues`)
            .send({ title: `workspace plant by ${who}`, ...body });
          expect(created.status, `${who} create ${JSON.stringify(body)}`).toBe(404);
          expect(JSON.stringify(created.body)).not.toContain("Secret");
          const patched = await request(app).patch(`/api/issues/${OPEN_ISSUE}`).send(body);
          expect(patched.status, `${who} PATCH ${JSON.stringify(body)}`).toBe(404);
        }
      }
      const planted = await db.select().from(issues).where(eq(issues.companyId, COMPANY));
      expect(planted.filter((i) => i.title.startsWith("workspace plant"))).toHaveLength(0);
      const [open] = await db.select().from(issues).where(eq(issues.id, OPEN_ISSUE));
      expect(open.projectWorkspaceId).toBeNull();
      expect(open.executionWorkspaceId).toBeNull();

      // An on-list actor may name the workspace with its project.
      const ok = await request(appAs(asUser("sam", "member")))
        .post(`/api/companies/${COMPANY}/issues`)
        .send({ title: "in the secret checkout", projectId: SECRET_PROJECT, projectWorkspaceId: SECRET_PROJECT_WORKSPACE });
      expect(ok.status).toBe(201);
      expect(ok.body.projectWorkspaceId).toBe(SECRET_PROJECT_WORKSPACE);
    });
  });

  describe("A6: name collision", () => {
    it("refuses a near-miss of a VISIBLE name, overridable with confirmSimilarName", async () => {
      const app = appAs(asUser("member-user", "member"));
      const res = await request(app)
        .post(`/api/companies/${COMPANY}/projects`)
        .send({ name: "OPEN   project!" }); // squashes to the same letters
      expect(res.status).toBe(409);
      expect(String(res.body.error)).toContain("Open project");

      const confirmed = await request(app)
        .post(`/api/companies/${COMPANY}/projects`)
        .send({ name: "Open project two", confirmSimilarName: true });
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.createdByUserId).toBe("member-user");
    });

    it("does not leak a RESTRICTED project's name through the near-miss message", async () => {
      // The member cannot see Sam's restricted project, so its name must not
      // appear in any refusal she receives. The deliberate consequence: her
      // near-duplicate of an invisible name is allowed. The hard unique
      // index still refuses an EXACT case-insensitive duplicate — as a
      // constraint violation, not a message carrying the hidden name.
      const res = await request(appAs(asUser("member-user", "member")))
        .post(`/api/companies/${COMPANY}/projects`)
        .send({ name: "Sams restricted project" }); // near-miss, not exact
      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain("Sam's restricted project");
    });

    it("a confirmed exact duplicate is auto-renamed, never stored verbatim", async () => {
      /**
       * Correction found while writing this test: the review claimed nothing
       * prevented duplicate names. In fact the creation path has ALWAYS
       * deduplicated — resolveProjectNameForUniqueShortname renames a
       * collision before insert. So the full A6 contract is: a near miss
       * warns first (new tonight); a CONFIRMED duplicate is renamed, not
       * refused (pre-existing); and the unique index backstops any write
       * path that skips the service.
       */
      const idx = (await db.execute(
        `select indexname from pg_indexes where tablename = 'projects'`,
      )) as unknown as Array<{ indexname: string }> & { rows?: Array<{ indexname: string }> };
      const names = (Array.isArray(idx) ? idx : (idx.rows ?? [])).map((r) => r.indexname);
      expect(names).toContain("projects_company_name_unique_idx");

      const res = await request(appAs(asUser("admin-user", "admin")))
        .post(`/api/companies/${COMPANY}/projects`)
        .send({ name: "OPEN PROJECT", confirmSimilarName: true });
      expect(res.status).toBe(201);
      expect(res.body.name.toLowerCase()).not.toBe("open project");

      const rows = await db.select().from(projects).where(eq(projects.companyId, COMPANY));
      expect(rows.filter((p) => p.name.toLowerCase() === "open project")).toHaveLength(1);

      // The index itself, exercised where the service dedupe cannot help:
      // a direct write of the exact lowercase-equal name must be refused.
      // drizzle wraps the violation, so assert on effect: the write rejects
      // and no second row exists.
      await expect(
        db.insert(projects).values({ companyId: COMPANY, name: "open PROJECT" }),
      ).rejects.toThrow();
      const after = await db.select().from(projects).where(eq(projects.companyId, COMPANY));
      expect(after.filter((p) => p.name.toLowerCase() === "open project")).toHaveLength(1);
    });
  });
});
