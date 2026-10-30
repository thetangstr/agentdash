import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  approvals,
  authUsers,
  companies,
  companySkills,
  createDb,
  featureFlags,
  issues,
  projects,
} from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { addAgent, addCompany, addUser, agentRequestActor, boardActor, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { activityRows, setAccessMode, setAccessPolicy, wouldRefuseRows } from "./helpers/agent-access-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { projectRoutes } from "../routes/projects.js";
import {
  agentAccessScopeMiddleware,
  assertIssueIdVisible,
  assertProjectIdVisible,
  filterVisibleByProject,
} from "../routes/visibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Router = express.Router;
type Mode = "off" | "shadow" | "enforce";
const noRunRuntime = { heartbeat: { enabled: false, wakeOnDemand: false } };

/**
 * AgentDash: APM gate 3 (P3.4) — the route-level access LLD §4 matrix rows in
 * `enforce`. Request paths answer `403 ACCESS_POLICY_REFUSED` with
 * `{ dimension, rule, requested, allowedSummary, howToRequest }` and log
 * `authz.refused` { dimension, policyMode }; project reads are filtered from
 * lists and 404 on direct read. Board actors with authority are unaffected,
 * and off/shadow answer exactly as gate 2. Plus the fixed `capabilities` rule
 * (422 for self and peer agents in every mode).
 */
describeEmbeddedPostgres("V2 access enforce at route-level matrix rows (APM gate 3, P3.4)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-access-enforce-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function send(
    routers: Router[],
    actor: Record<string, unknown>,
    method: "get" | "post" | "patch" | "put",
    path: string,
    body?: unknown,
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    // As app.ts mounts it: the agent's enforced project scope is resolved per request.
    app.use("/api", agentAccessScopeMiddleware(db));
    for (const router of routers) app.use("/api", router);
    app.use(errorHandler);
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const call = request(`http://127.0.0.1:${address.port}`)[method](path);
      return await (body === undefined ? call : call.send(body as object));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }

  /** A default-profile company: an owner, a plain member, an acting agent (legacy tasks:assign via canCreateAgents) and two peers. */
  async function seedCompany() {
    const company = await addCompany(db, "Enforce", "default");
    const ownerUserId = await addUser(db, company.id, "owner");
    const memberUserId = await addUser(db, company.id, "member");
    const actor = await addAgent(db, company.id, { name: "Planner", permissions: { canCreateAgents: true }, runtimeConfig: noRunRuntime });
    const worker = await addAgent(db, company.id, { name: "Worker", runtimeConfig: noRunRuntime });
    const helper = await addAgent(db, company.id, { name: "Helper", runtimeConfig: noRunRuntime });
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Secret launch" })
      .returning()
      .then((rows) => rows[0]!);
    const key = await db
      .insert(agentApiKeys)
      .values({ agentId: actor.id, companyId: company.id, name: "test", keyHash: `unused-${actor.id}` })
      .returning()
      .then((rows) => rows[0]!);
    const actorPrincipal = agentRequestActor(actor, { keyId: key.id });
    return { company, ownerUserId, memberUserId, actor, actorPrincipal, worker, helper, project };
  }

  function details(row: { details: unknown }) {
    return row.details as Record<string, unknown>;
  }

  async function refusedRows(companyId: string, site?: string) {
    const rows = await activityRows(db, companyId, "authz.refused");
    return site ? rows.filter((row) => details(row).site === site) : rows;
  }

  /** The 403 body every enforced request-path refusal answers. */
  function expectRefusalBody(body: Record<string, unknown>, expected: { dimension: string; rule: string; requested: Record<string, unknown> }) {
    expect(body).toMatchObject({
      code: "ACCESS_POLICY_REFUSED",
      dimension: expected.dimension,
      rule: expected.rule,
      requested: expected.requested,
    });
    expect(typeof body.error).toBe("string");
    expect(typeof body.allowedSummary).toBe("string");
    expect(String(body.howToRequest)).toContain("GET /api/agents/me/access");
  }

  function expectEnforcedLog(row: { details: unknown; actorType: string; agentId: string | null }, expected: { dimension: string; site: string }) {
    expect(details(row)).toMatchObject({
      reasonCode: "ACCESS_POLICY_REFUSED",
      dimension: expected.dimension,
      policyMode: "enforce",
      site: expected.site,
    });
  }

  // -------------------------------------------------------------------------
  // visibility.project_read — filtered from lists; 404 on direct read
  // -------------------------------------------------------------------------

  describe("visibility.project_read (API reads)", () => {
    async function seedRead(mode: Mode) {
      const s = await seedCompany();
      const open = await db.insert(projects).values({ companyId: s.company.id, name: "Open roadmap" }).returning().then((rows) => rows[0]!);
      const secret = await db
        .insert(issues)
        .values({ companyId: s.company.id, projectId: s.project.id, title: "In the secret project", status: "todo" })
        .returning()
        .then((rows) => rows[0]!);
      const visible = await db
        .insert(issues)
        .values({ companyId: s.company.id, projectId: open.id, title: "On the open roadmap", status: "todo" })
        .returning()
        .then((rows) => rows[0]!);
      const loose = await db
        .insert(issues)
        .values({ companyId: s.company.id, projectId: null, title: "No project at all", status: "todo" })
        .returning()
        .then((rows) => rows[0]!);
      await setAccessPolicy(db, s.company.id, s.actor.id, { request: { see: { projects: { mode: "listed", ids: [open.id] } } } });
      await setAccessMode(db, s.company.id, mode);
      const agentReq = () => ({ actor: agentRequestActor(s.actor) }) as any;
      return { ...s, open, secret, visible, loose, agentReq };
    }

    it("enforce: direct reads of an out-of-scope project are 404 and logged as authz.refused; lists drop it silently", async () => {
      const s = await seedRead("enforce");
      await expect(assertIssueIdVisible(db, s.agentReq(), s.secret.id)).rejects.toMatchObject({ status: 404 });
      await expect(assertProjectIdVisible(db, s.agentReq(), s.company.id, s.project.id)).rejects.toMatchObject({ status: 404 });
      // In-scope and project-less reads still resolve.
      await assertIssueIdVisible(db, s.agentReq(), s.visible.id);
      await assertIssueIdVisible(db, s.agentReq(), s.loose.id);
      const kept = await filterVisibleByProject(db, s.agentReq(), [
        { id: "secret", projectId: s.project.id },
        { id: "open", projectId: s.open.id },
        { id: "loose", projectId: null },
      ]);
      expect(kept.map((row) => row.id)).toEqual(["open", "loose"]);

      const refused = await refusedRows(s.company.id, "visibility.project_read");
      expect(refused).toHaveLength(2); // the two direct reads; list filtering is not an attempt
      for (const row of refused) {
        expectEnforcedLog(row, { dimension: "see.projects", site: "visibility.project_read" });
        expect(details(row).target).toEqual({ projectId: s.project.id });
        expect(row.agentId).toBe(s.actor.id);
      }
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });

    it("enforce: the issue and project list routes filter the out-of-scope project; a board reader still sees it", async () => {
      const s = await seedRead("enforce");
      const issueList = await send([issueRoutes(db, {} as never)], s.actorPrincipal, "get", `/api/companies/${s.company.id}/issues`);
      expect(issueList.status, JSON.stringify(issueList.body)).toBe(200);
      const titles = (issueList.body as Array<{ title: string }>).map((row) => row.title).sort();
      expect(titles).toEqual(["No project at all", "On the open roadmap"]);
      const projectList = await send([projectRoutes(db)], s.actorPrincipal, "get", `/api/companies/${s.company.id}/projects`);
      expect(projectList.status, JSON.stringify(projectList.body)).toBe(200);
      expect((projectList.body as Array<{ id: string }>).map((row) => row.id)).toEqual([s.open.id]);
      const direct = await send([issueRoutes(db, {} as never)], s.actorPrincipal, "get", `/api/issues/${s.secret.id}`);
      expect(direct.status).toBe(404);

      const board = boardActor(s.company.id, s.ownerUserId, "owner");
      const boardList = await send([issueRoutes(db, {} as never)], board, "get", `/api/companies/${s.company.id}/issues`);
      expect((boardList.body as Array<{ title: string }>).map((row) => row.title)).toContain("In the secret project");
    });

    it("off and shadow: reads and lists are exactly as gate 2 (shadow logs would-be refusals only)", async () => {
      for (const mode of ["off", "shadow"] as const) {
        const s = await seedRead(mode);
        await assertIssueIdVisible(db, s.agentReq(), s.secret.id);
        const list = await send([issueRoutes(db, {} as never)], s.actorPrincipal, "get", `/api/companies/${s.company.id}/issues`);
        expect((list.body as Array<{ title: string }>).map((row) => row.title)).toContain("In the secret project");
        expect(await refusedRows(s.company.id)).toHaveLength(0);
        expect((await wouldRefuseRows(db, s.company.id)).length > 0, mode).toBe(mode === "shadow");
      }
    });
  });

  // -------------------------------------------------------------------------
  // issues.assign (+ hand-offs): 403, V2 overrides the CEO fallback
  // -------------------------------------------------------------------------

  describe("issues.assign and handoffs (talk.agents)", () => {
    const routers = () => [issueRoutes(db, {} as never)];

    async function seedAssign(mode: Mode, policy: { agentIds?: string[]; mode?: "listed" | "any"; via?: Array<"assign" | "handoff" | "comment_wake" | "mention"> } = {}) {
      const s = await seedCompany();
      await setAccessPolicy(db, s.company.id, s.actor.id, {
        request: { talk: { agents: { mode: policy.mode ?? "listed", agentIds: policy.agentIds ?? [], via: policy.via ?? ["assign", "handoff"] } } },
      });
      await setAccessMode(db, s.company.id, mode);
      return s;
    }

    it("enforce: an agent's create, child create and reassignment to an out-of-scope agent answer 403 and write nothing, although its legacy CEO-style authority allows them", async () => {
      const s = await seedAssign("enforce");
      const created = await send(routers(), s.actorPrincipal, "post", `/api/companies/${s.company.id}/issues`, {
        title: "Write the brief",
        status: "todo",
        assigneeAgentId: s.worker.id,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(403);
      expectRefusalBody(created.body, {
        dimension: "talk.agents",
        rule: "talk.agents.not_listed",
        requested: { agentId: s.worker.id, via: "assign" },
      });
      expect(await db.select().from(issues).where(and(eq(issues.companyId, s.company.id), eq(issues.title, "Write the brief")))).toHaveLength(0);

      const own = await send(routers(), s.actorPrincipal, "post", `/api/companies/${s.company.id}/issues`, {
        title: "My own work",
        status: "todo",
        assigneeAgentId: s.actor.id,
      });
      expect(own.status, JSON.stringify(own.body)).toBe(201);

      const child = await send(routers(), s.actorPrincipal, "post", `/api/issues/${own.body.id}/children`, {
        title: "A part for the worker",
        status: "todo",
        assigneeAgentId: s.worker.id,
      });
      expect(child.status, JSON.stringify(child.body)).toBe(403);
      expect(child.body.code).toBe("ACCESS_POLICY_REFUSED");

      const reassigned = await send(routers(), s.actorPrincipal, "patch", `/api/issues/${own.body.id}`, { assigneeAgentId: s.helper.id });
      expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(403);
      expectRefusalBody(reassigned.body, {
        dimension: "talk.agents",
        rule: "talk.agents.not_listed",
        requested: { agentId: s.helper.id, via: "assign" },
      });
      const after = await db.select().from(issues).where(eq(issues.id, own.body.id)).then((rows) => rows[0]!);
      expect(after.assigneeAgentId).toBe(s.actor.id);

      const refused = await refusedRows(s.company.id, "issues.assign");
      // One per request: the create and the child create (Worker), the reassignment (Helper).
      expect(refused.map((row) => (details(row).target as { agentId: string }).agentId).sort()).toEqual([s.helper.id, s.worker.id, s.worker.id].sort());
      for (const row of refused) {
        expectEnforcedLog(row, { dimension: "talk.agents", site: "issues.assign" });
        expect(row.actorType).toBe("agent");
        expect(row.actorId).toBe(s.actor.id);
      }
    });

    it("enforce: a listed agent is still assignable, and a board user's assignment is never checked", async () => {
      const s = await seedAssign("enforce");
      await setAccessPolicy(db, s.company.id, s.actor.id, {
        request: { talk: { agents: { mode: "listed", agentIds: [s.worker.id], via: ["assign"] } } },
      });
      const allowed = await send(routers(), s.actorPrincipal, "post", `/api/companies/${s.company.id}/issues`, {
        title: "Listed worker",
        status: "todo",
        assigneeAgentId: s.worker.id,
      });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
      const board = await send(routers(), boardActor(s.company.id, s.ownerUserId, "owner"), "post", `/api/companies/${s.company.id}/issues`, {
        title: "From a person",
        status: "todo",
        assigneeAgentId: s.helper.id,
      });
      expect(board.status, JSON.stringify(board.body)).toBe(201);
      expect(await refusedRows(s.company.id)).toHaveLength(0);
    });

    it("enforce: with hand-offs on, a reassignment the policy allows as `assign` but not as `handoff` is 403 on the hand-off channel", async () => {
      const s = await seedAssign("enforce", { mode: "any", via: ["assign"] });
      await db.insert(featureFlags).values({ companyId: s.company.id, flagKey: FEATURE_FLAG_KEYS.COWORKER_BRIDGE, enabled: true });
      const own = await send(routers(), s.actorPrincipal, "post", `/api/companies/${s.company.id}/issues`, {
        title: "Mine first",
        status: "todo",
        assigneeAgentId: s.actor.id,
      });
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      const handOff = await send(routers(), s.actorPrincipal, "patch", `/api/issues/${own.body.id}`, { assigneeAgentId: s.helper.id });
      expect(handOff.status, JSON.stringify(handOff.body)).toBe(403);
      expectRefusalBody(handOff.body, {
        dimension: "talk.agents",
        rule: "talk.agents.via_not_allowed",
        requested: { agentId: s.helper.id, via: "handoff" },
      });
      const refused = await refusedRows(s.company.id, "handoffs");
      expect(refused).toHaveLength(1);
      expectEnforcedLog(refused[0]!, { dimension: "talk.agents", site: "handoffs" });
      expect((await db.select().from(issues).where(eq(issues.id, own.body.id)).then((rows) => rows[0]!)).assigneeAgentId).toBe(s.actor.id);
    });

    it("off and shadow: the same assignments go through exactly as gate 2", async () => {
      for (const mode of ["off", "shadow"] as const) {
        const s = await seedAssign(mode);
        const created = await send(routers(), s.actorPrincipal, "post", `/api/companies/${s.company.id}/issues`, {
          title: "Write the brief",
          status: "todo",
          assigneeAgentId: s.worker.id,
        });
        expect(created.status, `${mode} ${JSON.stringify(created.body)}`).toBe(201);
        expect(created.body.assigneeAgentId).toBe(s.worker.id);
        expect(await refusedRows(s.company.id)).toHaveLength(0);
        expect((await wouldRefuseRows(db, s.company.id, "issues.assign")).length, mode).toBe(mode === "shadow" ? 1 : 0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // agents.skill_sync and agents.hire_skills (do.skills writers): 403
  // -------------------------------------------------------------------------

  describe("agents.skill_sync and agents.hire_skills (do.skills writers)", () => {
    async function seedSkills(mode: Mode) {
      const s = await seedCompany();
      for (const [key, slug] of [["acme/weekly-report", "weekly-report"], ["acme/standup", "standup"]] as const) {
        await db.insert(companySkills).values({
          companyId: s.company.id,
          key,
          slug,
          name: slug,
          markdown: `# ${slug}\n`,
          sourceType: "url",
          sourceLocator: `https://example.test/skills/${slug}/SKILL.md`,
        });
      }
      await setAccessPolicy(db, s.company.id, s.actor.id, { request: { do: { skills: { mode: "listed", ids: ["acme/standup"] } } } });
      await setAccessMode(db, s.company.id, mode);
      return s;
    }

    async function storedSkills(agentId: string) {
      const row = await db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
      return JSON.stringify(row.adapterConfig);
    }

    it("enforce: a sync that adds an unlisted skill is 403 and writes nothing; a listed skill syncs", async () => {
      const s = await seedSkills("enforce");
      const refused = await send([agentRoutes(db)], agentRequestActor(s.actor), "post", `/api/agents/${s.actor.id}/skills/sync`, {
        desiredSkills: ["acme/weekly-report"],
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expectRefusalBody(refused.body, { dimension: "do.skills", rule: "do.skills.not_listed", requested: { skillKey: "acme/weekly-report" } });
      expect(await storedSkills(s.actor.id)).not.toContain("acme/weekly-report");
      const rows = await refusedRows(s.company.id, "agents.skill_sync");
      expect(rows).toHaveLength(1);
      expectEnforcedLog(rows[0]!, { dimension: "do.skills", site: "agents.skill_sync" });

      const allowed = await send([agentRoutes(db)], agentRequestActor(s.actor), "post", `/api/agents/${s.actor.id}/skills/sync`, {
        desiredSkills: ["acme/standup"],
      });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect(await storedSkills(s.actor.id)).toContain("acme/standup");
    });

    it("enforce: a sync that keeps or removes an out-of-scope skill the agent already holds is never refused (V2 only narrows)", async () => {
      const s = await seedSkills("enforce");
      await db
        .update(agents)
        .set({ adapterConfig: { command: "echo", paperclipSkillSync: { desiredSkills: ["acme/weekly-report"] } } })
        .where(eq(agents.id, s.actor.id));
      const keep = await send([agentRoutes(db)], agentRequestActor(s.actor), "post", `/api/agents/${s.actor.id}/skills/sync`, {
        desiredSkills: ["acme/weekly-report", "acme/standup"],
      });
      expect(keep.status, JSON.stringify(keep.body)).toBe(200);
      const remove = await send([agentRoutes(db)], agentRequestActor(s.actor), "post", `/api/agents/${s.actor.id}/skills/sync`, {
        desiredSkills: ["acme/standup"],
      });
      expect(remove.status, JSON.stringify(remove.body)).toBe(200);
      expect(await storedSkills(s.actor.id)).not.toContain("acme/weekly-report");
      expect(await refusedRows(s.company.id)).toHaveLength(0);
    });

    it("enforce: an agent's hire with a skill outside its scope is 403 and creates no agent", async () => {
      const s = await seedSkills("enforce");
      const before = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, s.company.id));
      const res = await send([agentRoutes(db)], agentRequestActor(s.actor), "post", `/api/companies/${s.company.id}/agent-hires`, {
        name: "Report helper",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        desiredSkills: ["acme/weekly-report"],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expectRefusalBody(res.body, { dimension: "do.skills", rule: "do.skills.not_listed", requested: { skillKey: "acme/weekly-report" } });
      expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, s.company.id))).toHaveLength(before.length);
      expectEnforcedLog((await refusedRows(s.company.id, "agents.hire_skills"))[0]!, { dimension: "do.skills", site: "agents.hire_skills" });
    });

    it("off and shadow: the unlisted sync succeeds exactly as gate 2", async () => {
      for (const mode of ["off", "shadow"] as const) {
        const s = await seedSkills(mode);
        const res = await send([agentRoutes(db)], agentRequestActor(s.actor), "post", `/api/agents/${s.actor.id}/skills/sync`, {
          desiredSkills: ["acme/weekly-report"],
        });
        expect(res.status, mode).toBe(200);
        expect(await refusedRows(s.company.id)).toHaveLength(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // approval_routing (talk.people, approval): 403 before the approval exists
  // -------------------------------------------------------------------------

  describe("approval_routing (talk.people, approval)", () => {
    async function fileApproval(mode: Mode, approver: "member" | "owner") {
      const s = await seedCompany();
      await setAccessPolicy(db, s.company.id, s.actor.id, { request: { talk: { people: { mode: "listed", userIds: [] } } } });
      await setAccessMode(db, s.company.id, mode);
      const approverUserId = approver === "member" ? s.memberUserId : s.ownerUserId;
      const res = await send([approvalRoutes(db, { autoDispatchQueuedRuns: false })], agentRequestActor(s.actor), "post", `/api/companies/${s.company.id}/approvals`, {
        type: "request_board_approval",
        payload: { summary: "Sign off the launch", approverUserId },
      });
      return { s, res, approverUserId };
    }

    it("enforce: an approval naming a person outside its people scope is 403 and is never filed", async () => {
      const { s, res, approverUserId } = await fileApproval("enforce", "member");
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expectRefusalBody(res.body, {
        dimension: "talk.people",
        rule: "talk.people.not_listed",
        requested: { userId: approverUserId, purpose: "approval" },
      });
      expect(String(res.body.allowedSummary)).toContain("always reachable");
      expect(await db.select().from(approvals).where(eq(approvals.companyId, s.company.id))).toHaveLength(0);
      expectEnforcedLog((await refusedRows(s.company.id, "approval_routing"))[0]!, { dimension: "talk.people", site: "approval_routing" });
    });

    it("enforce: the escalation path stays open — an approval routed to a company admin is filed", async () => {
      const { s, res } = await fileApproval("enforce", "owner");
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await db.select().from(approvals).where(eq(approvals.companyId, s.company.id))).toHaveLength(1);
      expect(await refusedRows(s.company.id)).toHaveLength(0);
    });

    it("off and shadow: the outsider approval is filed exactly as gate 2", async () => {
      for (const mode of ["off", "shadow"] as const) {
        const { s, res } = await fileApproval(mode, "member");
        expect(res.status, mode).toBe(201);
        expect(await refusedRows(s.company.id)).toHaveLength(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Fixed rule (every mode): `capabilities` is profile-managed
  // -------------------------------------------------------------------------

  describe("capabilities is profile-managed (access LLD §3.1, §5) in every mode", () => {
    it.each(["off", "shadow", "enforce"] as const)("%s: self and peer agents get 422; a board admin may still change it", async (mode) => {
      const s = await seedCompany();
      await setAccessMode(db, s.company.id, mode);
      const self = await send([agentRoutes(db)], agentRequestActor(s.actor), "patch", `/api/agents/${s.actor.id}`, { capabilities: "Everything" });
      expect(self.status, JSON.stringify(self.body)).toBe(422);
      expect(self.body.error).toContain("operating profile");
      expect(self.body.details).toMatchObject({ code: "AGENT_FIELD_PROFILE_MANAGED", fields: ["capabilities"] });

      // The acting agent can modify peers (canCreateAgents), but not their capabilities.
      const peer = await send([agentRoutes(db)], agentRequestActor(s.actor), "patch", `/api/agents/${s.worker.id}`, { capabilities: "Anything" });
      expect(peer.status, JSON.stringify(peer.body)).toBe(422);
      expect(peer.body.details).toMatchObject({ code: "AGENT_FIELD_PROFILE_MANAGED" });

      // Presentation fields stay self-editable.
      const rename = await send([agentRoutes(db)], agentRequestActor(s.actor), "patch", `/api/agents/${s.actor.id}`, { title: "Planner of record" });
      expect(rename.status, JSON.stringify(rename.body)).toBe(200);

      const board = await send([agentRoutes(db)], boardActor(s.company.id, s.ownerUserId, "owner"), "patch", `/api/agents/${s.worker.id}`, { capabilities: "Ships server routes" });
      expect(board.status, JSON.stringify(board.body)).toBe(200);
      const stored = await db.select().from(agents).where(eq(agents.id, s.worker.id)).then((rows) => rows[0]!);
      expect(stored.capabilities).toBe("Ships server routes");
      const actorRow = await db.select().from(agents).where(eq(agents.id, s.actor.id)).then((rows) => rows[0]!);
      expect(actorRow.capabilities).not.toBe("Everything");
    });
  });
});
