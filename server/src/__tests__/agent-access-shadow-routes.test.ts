import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agentGovernancePolicies,
  agents,
  approvals,
  authUsers,
  companies,
  companySkills,
  createDb,
  issues,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { addAgent, addCompany, addUser, agentRequestActor, boardActor, seedProfileCompany, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { activityRows, setAccessMode, setAccessPolicy, wouldRefuseRows } from "./helpers/agent-access-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { agentGovernanceRoutes } from "../routes/agent-governance.js";
import { assertIssueIdVisible, assertProjectIdVisible, filterVisibleByProject } from "../routes/visibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Router = express.Router;
const noRunRuntime = { heartbeat: { enabled: false, wakeOnDemand: false } };

/**
 * AgentDash: APM gate 2 (P2.3) — the route-level access LLD §4 matrix rows in
 * shadow mode. For each row: in `shadow` a would-be refusal is logged as
 * `access.would_refuse` { dimension, rule, target, site } and the route
 * answers exactly as it does in `off`; in `off` nothing is logged. Plus the
 * governance editors: V1 projection out, V1-shaped writes merged in, and
 * `access.policy_changed` with its source.
 */
describeEmbeddedPostgres("V2 access shadow checks at route-level matrix rows (APM gate 2, P2.3)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-access-shadow-routes-");
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
    const company = await addCompany(db, "Shadow", "default");
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
    // The issue-mutation authority re-reads an agent key, so the acting agent has a real one.
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

  // -------------------------------------------------------------------------
  // visibility.project_read
  // -------------------------------------------------------------------------

  describe("visibility.project_read (API reads)", () => {
    async function seedRead() {
      const s = await seedCompany();
      const issue = await db
        .insert(issues)
        .values({ companyId: s.company.id, projectId: s.project.id, title: "In the secret project", status: "todo" })
        .returning()
        .then((rows) => rows[0]!);
      await setAccessPolicy(db, s.company.id, s.actor.id, { request: { see: { projects: { mode: "listed", ids: [] } } } });
      const agentReq = () => ({ actor: agentRequestActor(s.actor) }) as any;
      return { ...s, issue, agentReq };
    }

    async function readAll(s: Awaited<ReturnType<typeof seedRead>>) {
      await assertIssueIdVisible(db, s.agentReq(), s.issue.id);
      await assertProjectIdVisible(db, s.agentReq(), s.company.id, s.project.id);
      return filterVisibleByProject(db, s.agentReq(), [{ id: s.issue.id, projectId: s.project.id }, { id: "loose", projectId: null }]);
    }

    it("off: the agent's reads resolve and nothing is logged", async () => {
      const s = await seedRead();
      const rows = await readAll(s);
      expect(rows.map((row) => row.id)).toEqual([s.issue.id, "loose"]);
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });

    it("shadow: the same reads resolve with the same rows, and each logs a would-be refusal", async () => {
      const s = await seedRead();
      await setAccessMode(db, s.company.id, "shadow");
      const rows = await readAll(s);
      expect(rows.map((row) => row.id)).toEqual([s.issue.id, "loose"]);
      const logged = await wouldRefuseRows(db, s.company.id, "visibility.project_read");
      expect(logged).toHaveLength(3);
      for (const row of logged) {
        expect(details(row)).toMatchObject({
          dimension: "see.projects",
          rule: "see.projects:not_listed",
          reason: "not_listed",
          target: { projectId: s.project.id },
          site: "visibility.project_read",
          policyMode: "shadow",
        });
        expect(row.agentId).toBe(s.actor.id);
        expect(row.actorType).toBe("agent");
      }
    });

    it("shadow: one request that reads the same project twice logs once", async () => {
      const s = await seedRead();
      await setAccessMode(db, s.company.id, "shadow");
      const req = s.agentReq();
      await assertIssueIdVisible(db, req, s.issue.id);
      await assertIssueIdVisible(db, req, s.issue.id);
      expect(await wouldRefuseRows(db, s.company.id, "visibility.project_read")).toHaveLength(1);
    });

    it("shadow: a board reader is not an agent and is never checked", async () => {
      const s = await seedRead();
      await setAccessMode(db, s.company.id, "shadow");
      const boardReq = { actor: boardActor(s.company.id, s.ownerUserId, "owner") } as any;
      await assertIssueIdVisible(db, boardReq, s.issue.id);
      await filterVisibleByProject(db, boardReq, [{ projectId: s.project.id }]);
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // issues.assign
  // -------------------------------------------------------------------------

  describe("issues.assign (create and reassign)", () => {
    const routers = () => [issueRoutes(db, {} as never)];

    async function assignFlow(mode: "off" | "shadow") {
      const s = await seedCompany();
      await setAccessPolicy(db, s.company.id, s.actor.id, {
        request: { talk: { agents: { mode: "listed", agentIds: [], via: ["assign"] } } },
      });
      await setAccessMode(db, s.company.id, mode);
      const actor = s.actorPrincipal;
      const created = await send(routers(), actor, "post", `/api/companies/${s.company.id}/issues`, {
        title: "Write the brief",
        status: "todo",
        assigneeAgentId: s.worker.id,
      });
      const own = await send(routers(), actor, "post", `/api/companies/${s.company.id}/issues`, {
        title: "My own work",
        status: "todo",
        assigneeAgentId: s.actor.id,
      });
      const reassigned = await send(routers(), actor, "patch", `/api/issues/${own.body.id}`, { assigneeAgentId: s.helper.id });
      return { s, created, own, reassigned };
    }

    function shape(res: { status: number; body: Record<string, unknown> }) {
      return { status: res.status, title: res.body.title, status_: res.body.status, assigneeAgentId: res.body.assigneeAgentId };
    }

    it("off: assignments go through and nothing is logged", async () => {
      const { s, created, own, reassigned } = await assignFlow("off");
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.assigneeAgentId).toBe(s.worker.id);
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
      expect(reassigned.body.assigneeAgentId).toBe(s.helper.id);
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });

    it("shadow: the same assignments go through identically and each logs talk.agents (assign)", async () => {
      const off = await assignFlow("off");
      const shadow = await assignFlow("shadow");
      expect(shape(shadow.created)).toEqual({ ...shape(off.created), assigneeAgentId: shadow.s.worker.id });
      expect(shape(shadow.own)).toEqual({ ...shape(off.own), assigneeAgentId: shadow.s.actor.id });
      expect(shape(shadow.reassigned)).toEqual({ ...shape(off.reassigned), assigneeAgentId: shadow.s.helper.id });

      const logged = await wouldRefuseRows(db, shadow.s.company.id, "issues.assign");
      // Create to Worker and reassign to Helper; assigning itself is not contact.
      expect(logged.map((row) => (details(row).target as { agentId: string }).agentId)).toEqual([shadow.s.worker.id, shadow.s.helper.id]);
      for (const row of logged) {
        expect(details(row)).toMatchObject({
          dimension: "talk.agents",
          rule: "talk.agents:not_listed",
          reason: "not_listed",
          via: "assign",
          site: "issues.assign",
        });
        expect(row.agentId).toBe(shadow.s.actor.id);
      }
      expect(await wouldRefuseRows(db, off.s.company.id)).toHaveLength(0);
    });

    it("shadow: a board user's assignment is not an agent's contact and is not checked here", async () => {
      const s = await seedCompany();
      await setAccessPolicy(db, s.company.id, s.actor.id, {
        request: { talk: { agents: { mode: "listed", agentIds: [], via: ["assign"] } } },
      });
      await setAccessMode(db, s.company.id, "shadow");
      const res = await send([issueRoutes(db, {} as never)], boardActor(s.company.id, s.ownerUserId, "owner"), "post", `/api/companies/${s.company.id}/issues`, {
        title: "From a person",
        status: "todo",
        assigneeAgentId: s.worker.id,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await wouldRefuseRows(db, s.company.id, "issues.assign")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // agents.skill_sync and agents.hire_skills
  // -------------------------------------------------------------------------

  describe("agents.skill_sync and agents.hire_skills (do.skills writers)", () => {
    async function seedSkills(mode: "off" | "shadow") {
      const s = await seedCompany();
      await db.insert(companySkills).values({
        companyId: s.company.id,
        key: "acme/weekly-report",
        slug: "weekly-report",
        name: "Weekly report",
        markdown: "# Weekly report\n",
        // Not a local path: the inventory refresh prunes local skills missing on disk.
        sourceType: "url",
        sourceLocator: "https://example.test/skills/weekly-report/SKILL.md",
      });
      await setAccessPolicy(db, s.company.id, s.actor.id, { request: { do: { skills: { mode: "listed", ids: [] } } } });
      await setAccessMode(db, s.company.id, mode);
      return s;
    }

    async function syncSelf(s: Awaited<ReturnType<typeof seedSkills>>) {
      return send([agentRoutes(db)], agentRequestActor(s.actor), "post", `/api/agents/${s.actor.id}/skills/sync`, {
        desiredSkills: ["acme/weekly-report"],
      });
    }

    it("skill sync: shadow answers exactly as off and logs the unlisted skill; off logs nothing", async () => {
      const off = await seedSkills("off");
      const offRes = await syncSelf(off);
      expect(offRes.status, JSON.stringify(offRes.body)).toBe(200);
      expect(await wouldRefuseRows(db, off.company.id)).toHaveLength(0);

      const shadow = await seedSkills("shadow");
      const shadowRes = await syncSelf(shadow);
      expect(shadowRes.status, JSON.stringify(shadowRes.body)).toBe(200);
      expect(JSON.stringify(shadowRes.body).replaceAll(shadow.actor.id, "AGENT").replaceAll(shadow.company.id, "CO")).toEqual(
        JSON.stringify(offRes.body).replaceAll(off.actor.id, "AGENT").replaceAll(off.company.id, "CO"),
      );
      const stored = await db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.id, shadow.actor.id)).then((rows) => rows[0]!);
      expect(JSON.stringify(stored.adapterConfig)).toContain("acme/weekly-report");

      const logged = await wouldRefuseRows(db, shadow.company.id, "agents.skill_sync");
      expect(logged).toHaveLength(1);
      expect(details(logged[0]!)).toMatchObject({
        dimension: "do.skills",
        rule: "do.skills:not_listed",
        reason: "not_listed",
        target: { skillKey: "acme/weekly-report" },
        site: "agents.skill_sync",
      });
    });

    async function hire(s: Awaited<ReturnType<typeof seedSkills>>) {
      return send([agentRoutes(db)], agentRequestActor(s.actor), "post", `/api/companies/${s.company.id}/agent-hires`, {
        name: "Report helper",
        role: "engineer",
        // No host command: an agent may not set one (instance-admin only).
        adapterType: "claude_local",
        adapterConfig: {},
        desiredSkills: ["acme/weekly-report"],
      });
    }

    it("hire: an agent's hire with skills outside its scope is answered as in off and logged in shadow", async () => {
      const off = await seedSkills("off");
      const offRes = await hire(off);
      expect([200, 201, 202], JSON.stringify(offRes.body)).toContain(offRes.status);
      expect(await wouldRefuseRows(db, off.company.id)).toHaveLength(0);

      const shadow = await seedSkills("shadow");
      const shadowRes = await hire(shadow);
      expect(shadowRes.status, JSON.stringify(shadowRes.body)).toBe(offRes.status);
      expect(shadowRes.body.agent?.name ?? shadowRes.body.name).toBe(offRes.body.agent?.name ?? offRes.body.name);
      expect(shadowRes.body.agent?.status ?? shadowRes.body.status).toBe(offRes.body.agent?.status ?? offRes.body.status);

      const logged = await wouldRefuseRows(db, shadow.company.id, "agents.hire_skills");
      expect(logged).toHaveLength(1);
      expect(details(logged[0]!)).toMatchObject({
        dimension: "do.skills",
        target: { skillKey: "acme/weekly-report" },
        site: "agents.hire_skills",
      });
      expect(logged[0]!.agentId).toBe(shadow.actor.id);
    });
  });

  // -------------------------------------------------------------------------
  // approval_routing
  // -------------------------------------------------------------------------

  describe("approval_routing (talk.people, approval)", () => {
    async function fileApproval(mode: "off" | "shadow", approver: "member" | "owner" = "member") {
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

    it("off: the approval is filed and nothing is logged", async () => {
      const { s, res } = await fileApproval("off");
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });

    it("shadow: filed exactly as in off, and the named approver outside its people scope is logged", async () => {
      const off = await fileApproval("off");
      const shadow = await fileApproval("shadow");
      expect(shadow.res.status).toBe(off.res.status);
      expect({ type: shadow.res.body.type, status: shadow.res.body.status, requestedByAgentId: shadow.res.body.requestedByAgentId }).toEqual({
        type: off.res.body.type,
        status: off.res.body.status,
        requestedByAgentId: shadow.s.actor.id,
      });
      const stored = await db.select().from(approvals).where(eq(approvals.companyId, shadow.s.company.id));
      expect(stored).toHaveLength(1);
      expect(stored[0]!.status).toBe("pending");

      const logged = await wouldRefuseRows(db, shadow.s.company.id, "approval_routing");
      expect(logged).toHaveLength(1);
      expect(details(logged[0]!)).toMatchObject({
        dimension: "talk.people",
        rule: "talk.people:not_listed",
        reason: "not_listed",
        target: { userId: shadow.approverUserId, purpose: "approval" },
        site: "approval_routing",
      });
    });

    it("shadow: an approval routed to a company admin is always reachable and logs nothing", async () => {
      const { s, res } = await fileApproval("shadow", "owner");
      expect(res.status).toBe(201);
      expect(await wouldRefuseRows(db, s.company.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Governance editors: V1 projection, merge, access.policy_changed
  // -------------------------------------------------------------------------

  describe("governance editors (V1 projection, merge, access.policy_changed)", () => {
    const V2_KEYS = ["policyVersion", "see", "do", "talk"];

    async function seedGovernance() {
      const s = await seedProfileCompany(db, "agentdash_mk");
      await setAccessPolicy(db, s.company.id, s.analyst.id, {
        ceiling: { see: { projects: { mode: "all", ids: [] } } },
        request: { do: { skills: { mode: "listed", ids: [] } } },
      });
      const path = `/api/companies/${s.company.id}/agents/${s.analyst.id}/governance`;
      return {
        ...s,
        path,
        owner: boardActor(s.company.id, s.ownerUserId, "owner"),
        steward: boardActor(s.company.id, s.stewardUserId),
      };
    }

    async function storedRow(companyId: string, agentId: string) {
      return db
        .select()
        .from(agentGovernancePolicies)
        .where(and(eq(agentGovernancePolicies.companyId, companyId), eq(agentGovernancePolicies.agentId, agentId)))
        .then((rows) => rows[0]!);
    }

    it("GET returns both sides without their V2 dimensions", async () => {
      const s = await seedGovernance();
      const res = await send([agentGovernanceRoutes(db)], s.owner, "get", s.path);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      for (const side of [res.body.policy.ownerCeiling, res.body.policy.stewardRequest]) {
        for (const key of V2_KEYS) expect(side).not.toHaveProperty(key);
        expect(side).toHaveProperty("permissions");
      }
      const stored = await storedRow(s.company.id, s.analyst.id);
      expect(stored.ownerCeiling).toHaveProperty("see");
      expect(stored.stewardRequest).toHaveProperty("do");
    });

    it("a V1-shaped ceiling save round-trips, keeps the V2 dimensions and logs an admin ceiling edit", async () => {
      const s = await seedGovernance();
      const read = await send([agentGovernanceRoutes(db)], s.owner, "get", s.path);
      const ceiling = { ...read.body.policy.ownerCeiling, monthlyBudgetCents: 50_000 };
      const saved = await send([agentGovernanceRoutes(db)], s.owner, "put", `${s.path}/ceiling`, { policy: ceiling, revision: read.body.policy.revision });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      for (const key of V2_KEYS) {
        expect(saved.body.policy.ownerCeiling).not.toHaveProperty(key);
        expect(saved.body.policy.stewardRequest).not.toHaveProperty(key);
      }
      expect(saved.body.policy.ownerCeiling.monthlyBudgetCents).toBe(50_000);

      const stored = await storedRow(s.company.id, s.analyst.id);
      expect((stored.ownerCeiling as Record<string, unknown>).see).toEqual({ projects: { mode: "all", ids: [] } });
      expect((stored.ownerCeiling as Record<string, unknown>).monthlyBudgetCents).toBe(50_000);
      expect((stored.stewardRequest as Record<string, unknown>).do).toEqual({ skills: { mode: "listed", ids: [] } });

      const changes = await activityRows(db, s.company.id, "access.policy_changed");
      expect(changes).toHaveLength(1);
      expect(details(changes[0]!)).toMatchObject({
        source: "admin_ceiling_edit",
        target: "owner_ceiling",
        changed: ["monthlyBudgetCents"],
        v2Dimensions: ["see.projects"],
      });
      expect(changes[0]!.agentId).toBe(s.analyst.id);
    });

    it("a V1-shaped request save keeps the request's V2 dimensions and logs a steward request edit", async () => {
      const s = await seedGovernance();
      const read = await send([agentGovernanceRoutes(db)], s.steward, "get", s.path);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      const requestSide = { ...read.body.policy.stewardRequest, destructiveActions: "blocked" };
      const saved = await send([agentGovernanceRoutes(db)], s.steward, "put", `${s.path}/request`, { policy: requestSide, revision: read.body.policy.revision });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      for (const key of V2_KEYS) expect(saved.body.policy.stewardRequest).not.toHaveProperty(key);

      const stored = await storedRow(s.company.id, s.analyst.id);
      expect((stored.stewardRequest as Record<string, unknown>).do).toEqual({ skills: { mode: "listed", ids: [] } });
      expect((stored.stewardRequest as Record<string, unknown>).destructiveActions).toBe("blocked");

      const changes = await activityRows(db, s.company.id, "access.policy_changed");
      expect(changes).toHaveLength(1);
      expect(details(changes[0]!)).toMatchObject({
        source: "steward_request_edit",
        target: "steward_request",
        changed: ["destructiveActions"],
        v2Dimensions: ["do.skills"],
      });
    });

    it("a harness push logs a harness narrowing and keeps the request's V2 dimensions", async () => {
      const s = await seedGovernance();
      const read = await send([agentGovernanceRoutes(db)], s.steward, "get", s.path);
      const pushed = await send([agentGovernanceRoutes(db)], s.steward, "put", `${s.path}/harness-request`, {
        policy: { ...read.body.policy.stewardRequest, providers: ["hubspot"] },
      });
      expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
      for (const key of V2_KEYS) expect(pushed.body.policy.stewardRequest).not.toHaveProperty(key);
      const stored = await storedRow(s.company.id, s.analyst.id);
      expect((stored.stewardRequest as Record<string, unknown>).do).toEqual({ skills: { mode: "listed", ids: [] } });
      const changes = await activityRows(db, s.company.id, "access.policy_changed");
      expect(changes).toHaveLength(1);
      expect(details(changes[0]!)).toMatchObject({ source: "harness_narrowing", target: "steward_request", changed: ["providers"] });
    });

    it("a save that changes nothing logs no access.policy_changed", async () => {
      const s = await seedGovernance();
      const read = await send([agentGovernanceRoutes(db)], s.owner, "get", s.path);
      const saved = await send([agentGovernanceRoutes(db)], s.owner, "put", `${s.path}/ceiling`, {
        policy: read.body.policy.ownerCeiling,
        revision: read.body.policy.revision,
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(await activityRows(db, s.company.id, "access.policy_changed")).toHaveLength(0);
      // The ordinary governance audit still records the write.
      expect(await activityRows(db, s.company.id, "agent.governance_ceiling_updated")).toHaveLength(1);
    });

    it("a V1-only row round-trips byte-identically", async () => {
      const s = await seedProfileCompany(db, "agentdash_mk");
      const owner = boardActor(s.company.id, s.ownerUserId, "owner");
      const path = `/api/companies/${s.company.id}/agents/${s.chief.id}/governance`;
      // First write materializes the V1 row.
      const first = await send([agentGovernanceRoutes(db)], owner, "get", path);
      const saved = await send([agentGovernanceRoutes(db)], owner, "put", `${path}/ceiling`, {
        policy: { ...first.body.policy.ownerCeiling, monthlyBudgetCents: 90_000 },
        revision: first.body.policy.revision,
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const before = await storedRow(s.company.id, s.chief.id);
      for (const key of V2_KEYS) expect(before.ownerCeiling).not.toHaveProperty(key);

      const read = await send([agentGovernanceRoutes(db)], owner, "get", path);
      expect(read.body.policy.ownerCeiling).toEqual(before.ownerCeiling);
      expect(read.body.policy.stewardRequest).toEqual(before.stewardRequest);
      expect(JSON.stringify(read.body.policy.ownerCeiling)).toBe(JSON.stringify(before.ownerCeiling));

      const again = await send([agentGovernanceRoutes(db)], owner, "put", `${path}/ceiling`, {
        policy: read.body.policy.ownerCeiling,
        revision: read.body.policy.revision,
      });
      expect(again.status).toBe(200);
      const after = await storedRow(s.company.id, s.chief.id);
      expect(JSON.stringify(after.ownerCeiling)).toBe(JSON.stringify(before.ownerCeiling));
      expect(JSON.stringify(after.stewardRequest)).toBe(JSON.stringify(before.stewardRequest));
    });
  });
});
