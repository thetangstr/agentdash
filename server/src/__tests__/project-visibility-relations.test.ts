import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  feedbackExports,
  feedbackVotes,
  issueRelations,
  issues,
  projectAccess,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * GH #830 part A follow-up: A5 beyond the `/issues/:id/*` guard. A VISIBLE
 * issue can point at a restricted one — as its parent, as a blocker, as an
 * issue it blocks, or through a feedback trace — and each of those surfaces
 * used to echo the restricted issue's identifier, title and status.
 *
 * Falsification: remove `truncateAncestorsAtInvisible` /
 * `filterVisibleIssueRelations` from the heartbeat-context and detail routes,
 * the `assertIssueIdsVisibleInCompany` call from
 * `assertIssueWriteTargetsVisible`, or `feedbackTraceVisibilityCondition` /
 * `assertFeedbackTraceVisible` from the trace routes — the named case fails.
 */
describeEmbeddedPostgres("restricted project visibility: relations, ancestors, blocker ids, feedback traces", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OPEN_PROJECT = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const LEAD_AGENT = randomUUID();
  const OUTSIDE_AGENT = randomUUID();

  const SECRET_PARENT = randomUUID();
  const SECRET_BLOCKER = randomUUID();
  const SECRET_DEPENDENT = randomUUID();
  const OPEN_CHILD = randomUUID();
  const OPEN_BLOCKER = randomUUID();
  const OPEN_TARGET = randomUUID();
  const OPEN_SHARED = randomUUID();

  const SECRET_VOTE = randomUUID();
  const OPEN_VOTE = randomUUID();
  const SECRET_TRACE = randomUUID();
  const OPEN_TRACE = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-visibility-relations-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Relations Co", issuePrefix: "RELV" });
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
      { id: SECRET_PARENT, companyId: COMPANY, projectId: SECRET_PROJECT, title: "Secret parent", status: "todo" },
      { id: SECRET_BLOCKER, companyId: COMPANY, projectId: SECRET_PROJECT, title: "Secret blocker", status: "todo" },
      {
        id: SECRET_DEPENDENT,
        companyId: COMPANY,
        projectId: SECRET_PROJECT,
        title: "Secret dependent",
        status: "todo",
      },
      {
        id: OPEN_CHILD,
        companyId: COMPANY,
        projectId: OPEN_PROJECT,
        parentId: SECRET_PARENT,
        title: "Open child",
        status: "todo",
      },
      { id: OPEN_BLOCKER, companyId: COMPANY, projectId: OPEN_PROJECT, title: "Open blocker", status: "todo" },
      { id: OPEN_TARGET, companyId: COMPANY, projectId: OPEN_PROJECT, title: "Open target", status: "todo" },
      { id: OPEN_SHARED, companyId: COMPANY, projectId: OPEN_PROJECT, title: "Open shared", status: "todo" },
    ]);
    // SECRET_BLOCKER and OPEN_BLOCKER block OPEN_CHILD; OPEN_CHILD blocks SECRET_DEPENDENT.
    await db.insert(issueRelations).values([
      { companyId: COMPANY, issueId: SECRET_BLOCKER, relatedIssueId: OPEN_CHILD, type: "blocks" },
      { companyId: COMPANY, issueId: OPEN_BLOCKER, relatedIssueId: OPEN_CHILD, type: "blocks" },
      { companyId: COMPANY, issueId: OPEN_CHILD, relatedIssueId: SECRET_DEPENDENT, type: "blocks" },
    ]);

    await db.insert(feedbackVotes).values([
      {
        id: SECRET_VOTE,
        companyId: COMPANY,
        issueId: SECRET_BLOCKER,
        targetType: "issue_comment",
        targetId: randomUUID(),
        authorUserId: "sam",
        vote: "up",
      },
      {
        id: OPEN_VOTE,
        companyId: COMPANY,
        issueId: OPEN_BLOCKER,
        targetType: "issue_comment",
        targetId: randomUUID(),
        authorUserId: "member-user",
        vote: "up",
      },
    ]);
    await db.insert(feedbackExports).values([
      {
        id: SECRET_TRACE,
        companyId: COMPANY,
        feedbackVoteId: SECRET_VOTE,
        issueId: SECRET_BLOCKER,
        projectId: SECRET_PROJECT,
        authorUserId: "sam",
        targetType: "issue_comment",
        targetId: randomUUID(),
        vote: "up",
        payloadSnapshot: { note: "Secret payload" },
        targetSummary: { label: "Secret comment" },
      },
      {
        id: OPEN_TRACE,
        companyId: COMPANY,
        feedbackVoteId: OPEN_VOTE,
        issueId: OPEN_BLOCKER,
        projectId: OPEN_PROJECT,
        authorUserId: "member-user",
        targetType: "issue_comment",
        targetId: randomUUID(),
        vote: "up",
        targetSummary: { label: "Open comment" },
      },
    ]);
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
    app.use("/api", issueRoutes(db));
    app.use("/api/companies", companyRoutes(db));
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
  const offListActors = () =>
    [
      ["an off-list board member", asUser("member-user", "member")],
      ["an off-list agent", asAgent(OUTSIDE_AGENT)],
    ] as const;
  const onListActors = () =>
    [
      ["the creator", asUser("sam", "member")],
      ["the listed lead agent", asAgent(LEAD_AGENT)],
      ["an admin", asUser("admin-user", "admin")],
    ] as const;

  const titles = (rows: Array<{ title: string }> | undefined) => (rows ?? []).map((row) => row.title).sort();
  const SECRET_TITLES = ["Secret parent", "Secret blocker", "Secret dependent"];
  const expectNoSecretTitles = (body: unknown, label: string) => {
    const text = JSON.stringify(body);
    for (const title of SECRET_TITLES) expect(text, label).not.toContain(title);
  };

  it("heartbeat-context: an off-list actor sees no restricted ancestor, blocker or dependent", async () => {
    for (const [who, actor] of offListActors()) {
      const res = await request(appAs(actor)).get(`/api/issues/${OPEN_CHILD}/heartbeat-context`);
      expect(res.status, who).toBe(200);
      expect(res.body.ancestors, who).toEqual([]);
      expect(titles(res.body.issue.blockedBy), who).toEqual(["Open blocker"]);
      expect(res.body.issue.blocks, who).toEqual([]);
      expectNoSecretTitles(res.body, who);
    }
  });

  it("heartbeat-context: on-list actors still see the whole picture", async () => {
    for (const [who, actor] of onListActors()) {
      const res = await request(appAs(actor)).get(`/api/issues/${OPEN_CHILD}/heartbeat-context`);
      expect(res.status, who).toBe(200);
      expect(res.body.ancestors.map((a: { title: string }) => a.title), who).toEqual(["Secret parent"]);
      expect(titles(res.body.issue.blockedBy), who).toEqual(["Open blocker", "Secret blocker"]);
      expect(titles(res.body.issue.blocks), who).toEqual(["Secret dependent"]);
    }
  });

  it("issue detail and list (includeBlockedBy): restricted relations and ancestors are omitted off-list", async () => {
    for (const [who, actor] of offListActors()) {
      const app = appAs(actor);
      const detail = await request(app).get(`/api/issues/${OPEN_CHILD}`);
      expect(detail.status, who).toBe(200);
      expect(detail.body.ancestors, who).toEqual([]);
      expect(titles(detail.body.blockedBy), who).toEqual(["Open blocker"]);
      expect(detail.body.blocks, who).toEqual([]);
      expectNoSecretTitles(detail.body, who);

      const list = await request(app).get(`/api/companies/${COMPANY}/issues?includeBlockedBy=true`);
      expect(list.status, who).toBe(200);
      const rows = Array.isArray(list.body) ? list.body : list.body.issues;
      const child = rows.find((row: { id: string }) => row.id === OPEN_CHILD);
      expect(titles(child.blockedBy), who).toEqual(["Open blocker"]);
      expectNoSecretTitles(rows, who);
    }
    const sam = await request(appAs(asUser("sam", "member"))).get(`/api/issues/${OPEN_CHILD}`);
    expect(sam.body.ancestors.map((a: { title: string }) => a.title)).toEqual(["Secret parent"]);
    expect(titles(sam.body.blockedBy)).toEqual(["Open blocker", "Secret blocker"]);
    expect(titles(sam.body.blocks)).toEqual(["Secret dependent"]);
  });

  it("blocker ids: a restricted blocker is 404 on create, child create and PATCH — same as a made-up id", async () => {
    for (const [who, actor] of offListActors()) {
      const app = appAs(actor);
      for (const blockerId of [SECRET_BLOCKER, randomUUID()]) {
        const label = `${who} with ${blockerId === SECRET_BLOCKER ? "the restricted" : "an unknown"} blocker`;
        const patch = await request(app).patch(`/api/issues/${OPEN_TARGET}`).send({ blockedByIssueIds: [blockerId] });
        expect(patch.status, `${label}: PATCH`).toBe(404);
        expect(patch.body, `${label}: PATCH`).toEqual({ error: "Blocker issue not found" });
        const create = await request(app)
          .post(`/api/companies/${COMPANY}/issues`)
          .send({ title: "New", projectId: OPEN_PROJECT, blockedByIssueIds: [blockerId] });
        expect(create.status, `${label}: create`).toBe(404);
        expect(create.body, `${label}: create`).toEqual({ error: "Blocker issue not found" });
        const child = await request(app)
          .post(`/api/issues/${OPEN_TARGET}/children`)
          .send({ title: "Child", blockedByIssueIds: [blockerId] });
        expect(child.status, `${label}: child create`).toBe(404);
        expect(child.body, `${label}: child create`).toEqual({ error: "Blocker issue not found" });
      }
    }
    const links = await db
      .select({ id: issueRelations.id })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, OPEN_TARGET));
    expect(links).toEqual([]);
  });

  it("blocker ids: on-list actors can link a restricted blocker; an off-list edit keeps it without seeing it", async () => {
    const sam = await request(appAs(asUser("sam", "member")))
      .patch(`/api/issues/${OPEN_SHARED}`)
      .send({ blockedByIssueIds: [SECRET_BLOCKER] });
    expect(sam.status).toBe(200);
    expect(titles(sam.body.blockedBy)).toEqual(["Secret blocker"]);

    const member = await request(appAs(asUser("member-user", "member")))
      .patch(`/api/issues/${OPEN_SHARED}`)
      .send({ blockedByIssueIds: [OPEN_BLOCKER] });
    expect(member.status).toBe(200);
    expect(titles(member.body.blockedBy)).toEqual(["Open blocker"]);
    expectNoSecretTitles(member.body, "member PATCH response");

    const stored = await db
      .select({ blockerId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.relatedIssueId, OPEN_SHARED), eq(issueRelations.type, "blocks")));
    expect(stored.map((row) => row.blockerId).sort()).toEqual([OPEN_BLOCKER, SECRET_BLOCKER].sort());
  });

  it("feedback traces: the company list omits restricted traces off-list and 404s a restricted filter", async () => {
    const member = appAs(asUser("member-user", "member"));
    const list = await request(member).get(`/api/companies/${COMPANY}/feedback-traces?includePayload=true`);
    expect(list.status).toBe(200);
    expect(list.body.map((trace: { id: string }) => trace.id)).toEqual([OPEN_TRACE]);
    expect(JSON.stringify(list.body)).not.toContain("Secret");

    expect(
      (await request(member).get(`/api/companies/${COMPANY}/feedback-traces?projectId=${SECRET_PROJECT}`)).status,
    ).toBe(404);
    expect(
      (await request(member).get(`/api/companies/${COMPANY}/feedback-traces?issueId=${SECRET_BLOCKER}`)).status,
    ).toBe(404);

    for (const actor of [asUser("sam", "member"), asUser("admin-user", "admin")]) {
      const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/feedback-traces`);
      expect(res.status).toBe(200);
      expect(res.body.map((trace: { id: string }) => trace.id).sort()).toEqual([OPEN_TRACE, SECRET_TRACE].sort());
    }
  });

  it("feedback traces: a restricted trace and its bundle are 404 off-list, readable on-list", async () => {
    const member = appAs(asUser("member-user", "member"));
    for (const path of [`/api/feedback-traces/${SECRET_TRACE}`, `/api/feedback-traces/${SECRET_TRACE}/bundle`]) {
      const res = await request(member).get(path);
      expect(res.status, path).toBe(404);
      expect(JSON.stringify(res.body), path).not.toContain("Secret");
    }
    expect((await request(member).get(`/api/feedback-traces/${OPEN_TRACE}`)).status).toBe(200);

    const sam = appAs(asUser("sam", "member"));
    const trace = await request(sam).get(`/api/feedback-traces/${SECRET_TRACE}`);
    expect(trace.status).toBe(200);
    expect(trace.body.issueTitle).toBe("Secret blocker");
    expect((await request(sam).get(`/api/feedback-traces/${SECRET_TRACE}/bundle`)).status).toBe(200);
  });
});
