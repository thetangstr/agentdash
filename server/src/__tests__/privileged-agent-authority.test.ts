// Company-wide agent authority is a company administrator's decision.
//
// A CEO or Chief of Staff agent, or an agent holding `canCreateAgents`, carries
// company-wide authority (a CEO agent's key runs the CEO-only company routes).
// Members keep creating ordinary agents; only an owner or admin may create or
// promote a privileged one, grant `canCreateAgents`, or file and approve a
// privileged hire. A member holding a delegated `agents:create` grant is still
// not an administrator. Real database, real routes.
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentConfigRevisions,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";

const PRIVILEGED_REFUSAL =
  "Only owners and admins can create a CEO or Chief of Staff agent, give an agent one of those roles, or let an agent create agents.";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("privileged agent authority", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let home: string;
  const companyId = randomUUID();
  const memberId = randomUUID();
  const delegateId = randomUUID();
  const adminId = randomUUID();

  beforeAll(async () => {
    home = await mkdtemp(join(process.env.TMPDIR ?? process.cwd(), "privileged-agent-authority-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
    vi.stubEnv("XDG_DATA_HOME", join(home, "data"));
    vi.stubEnv("AGENTDASH_BILLING_DISABLED", "true");
    database = await startEmbeddedPostgresTestDatabase("privileged-agent-authority-db-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Privilege test", issuePrefix: "PRIV", requireBoardApprovalForNewAgents: false });
    for (const [id, role] of [[memberId, "member"], [delegateId, "member"], [adminId, "admin"]] as const) {
      await db.insert(authUsers).values({ id, name: role, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, membershipRole: role, status: "active" });
    }
    // A member someone delegated agent administration to: configuration
    // authority, but not a company administrator.
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: delegateId, permissionKey: "agents:create", grantedByUserId: adminId,
    });
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  function appAs(userId: string, role: "member" | "admin") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", userId, source: "session", isInstanceAdmin: false,
        companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }],
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use("/api", approvalRoutes(db, { autoDispatchQueuedRuns: false }));
    app.use(errorHandler);
    return app;
  }
  const member = () => appAs(memberId, "member");
  const delegate = () => appAs(delegateId, "member");
  const admin = () => appAs(adminId, "admin");

  async function seedAgent(role = "engineer", permissions: Record<string, unknown> = {}) {
    const [row] = await db.insert(agents).values({ companyId, name: `Agent ${randomUUID()}`, role, permissions }).returning();
    return row!;
  }

  describe("creating an agent", () => {
    const privileged = [
      { role: "ceo" },
      { role: "chief_of_staff" },
      { role: "engineer", permissions: { canCreateAgents: true } },
    ];
    for (const route of ["agents", "agent-hires"] as const) {
      it.each(privileged)(`${route}: a member is refused %j and nothing is created`, async (authority) => {
        const name = `Member privileged ${randomUUID()}`;
        const res = await request(member()).post(`/api/companies/${companyId}/${route}`).send({ name, adapterType: "hermes_local", ...authority });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error).toBe(PRIVILEGED_REFUSAL);
        expect(await db.select().from(agents).where(eq(agents.name, name))).toEqual([]);
      });

      it(`${route}: a member holding agents:create is refused a CEO too`, async () => {
        const res = await request(delegate()).post(`/api/companies/${companyId}/${route}`).send({ name: `Delegate CEO ${randomUUID()}`, adapterType: "hermes_local", role: "ceo" });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
      });

      it(`${route}: an admin may create a CEO`, async () => {
        const res = await request(admin()).post(`/api/companies/${companyId}/${route}`).send({ name: `Admin CEO ${randomUUID()}`, adapterType: "hermes_local", role: "ceo" });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
      });
    }

    it("still lets a member create an ordinary agent and receive its key", async () => {
      const res = await request(member()).post(`/api/companies/${companyId}/agents`).send({ name: `Ordinary ${randomUUID()}`, role: "engineer", adapterType: "hermes_local" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.role).toBe("engineer");
      expect(res.body.apiKey.token).toEqual(expect.any(String));
    });
  });

  describe("changing an existing agent", () => {
    it("refuses a member with agents:create promoting an agent to CEO or Chief of Staff", async () => {
      const agent = await seedAgent();
      for (const role of ["ceo", "chief_of_staff"]) {
        const res = await request(delegate()).patch(`/api/agents/${agent.id}`).send({ role });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error).toBe(PRIVILEGED_REFUSAL);
      }
      const [stored] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(stored!.role).toBe("engineer");
    });

    it("refuses the same member demoting a CEO, but lets them make ordinary edits", async () => {
      const ceo = await seedAgent("ceo");
      expect((await request(delegate()).patch(`/api/agents/${ceo.id}`).send({ role: "engineer" })).status).toBe(403);
      const ordinary = await seedAgent();
      const res = await request(delegate()).patch(`/api/agents/${ordinary.id}`).send({ role: "researcher", title: "Analyst" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it("lets an admin promote an agent to CEO", async () => {
      const agent = await seedAgent();
      const res = await request(admin()).patch(`/api/agents/${agent.id}`).send({ role: "ceo" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.role).toBe("ceo");
    });

    it("refuses a member with agents:create granting canCreateAgents; an admin may", async () => {
      const agent = await seedAgent();
      const refused = await request(delegate()).patch(`/api/agents/${agent.id}/permissions`).send({ canCreateAgents: true, canAssignTasks: false });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.error).toBe(PRIVILEGED_REFUSAL);
      const granted = await request(admin()).patch(`/api/agents/${agent.id}/permissions`).send({ canCreateAgents: true, canAssignTasks: false });
      expect(granted.status, JSON.stringify(granted.body)).toBe(200);
      // Revoking narrows authority and stays open to the delegate.
      const revoked = await request(delegate()).patch(`/api/agents/${agent.id}/permissions`).send({ canCreateAgents: false, canAssignTasks: false });
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    });
  });

  describe("configuration rollback", () => {
    // A rollback restores `role` wholesale, so it meets the PATCH role rule.
    async function revisionWithRole(agentId: string, role: string) {
      const rows = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));
      const match = rows.find((row) => (row.afterConfig as { role?: string }).role === role);
      expect(match, `a revision with role ${role}`).toBeTruthy();
      return match!.id;
    }

    it("refuses a member with agents:create rolling an agent back into the CEO role; an admin may", async () => {
      const agent = await seedAgent();
      expect((await request(admin()).patch(`/api/agents/${agent.id}`).send({ role: "ceo" })).status).toBe(200);
      expect((await request(admin()).patch(`/api/agents/${agent.id}`).send({ role: "engineer" })).status).toBe(200);
      const ceoRevision = await revisionWithRole(agent.id, "ceo");

      const refused = await request(delegate()).post(`/api/agents/${agent.id}/config-revisions/${ceoRevision}/rollback`).send({});
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.error).toBe(PRIVILEGED_REFUSAL);
      expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]!.role).toBe("engineer");

      const allowed = await request(admin()).post(`/api/agents/${agent.id}/config-revisions/${ceoRevision}/rollback`).send({});
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]!.role).toBe("ceo");
    });

    it("refuses the same member rolling a CEO back out of the role", async () => {
      const agent = await seedAgent();
      expect((await request(admin()).patch(`/api/agents/${agent.id}`).send({ title: "Before" })).status).toBe(200);
      const engineerRevision = await revisionWithRole(agent.id, "engineer");
      expect((await request(admin()).patch(`/api/agents/${agent.id}`).send({ role: "ceo" })).status).toBe(200);
      const res = await request(delegate()).post(`/api/agents/${agent.id}/config-revisions/${engineerRevision}/rollback`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });
  });

  describe("keys, connect codes and stewardship of a CEO or agent creator", () => {
    const HAND_OUT_REFUSAL =
      "Only owners and admins can give someone a key, a connect code or stewardship for a CEO agent or an agent that can create agents.";

    for (const [label, role, permissions] of [
      ["CEO", "ceo", {}],
      ["agent creator", "engineer", { canCreateAgents: true }],
    ] as const) {
      it(`refuses a member with agents:create a key or connect code for a ${label}; an admin may`, async () => {
        const agent = await seedAgent(role, permissions);
        const key = await request(delegate()).post(`/api/agents/${agent.id}/keys`).send({ name: "mine" });
        expect(key.status, JSON.stringify(key.body)).toBe(403);
        expect(key.body.error).toBe(HAND_OUT_REFUSAL);
        const code = await request(delegate()).post(`/api/agents/${agent.id}/connect-codes`).send({});
        expect(code.status, JSON.stringify(code.body)).toBe(403);
        expect(code.body.error).toBe(HAND_OUT_REFUSAL);

        expect((await request(admin()).post(`/api/agents/${agent.id}/keys`).send({ name: "admin" })).status).toBe(201);
        expect((await request(admin()).post(`/api/agents/${agent.id}/connect-codes`).send({})).status).toBe(201);
      });
    }

    it("still lets a member with agents:create key an ordinary agent", async () => {
      const agent = await seedAgent();
      const res = await request(delegate()).post(`/api/agents/${agent.id}/keys`).send({ name: "ordinary" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
  });

  describe("hire approvals", () => {
    const ceoHire = () => ({ type: "hire_agent", payload: { name: `Hire CEO ${randomUUID()}`, role: "ceo", adapterType: "process" } });

    it("refuses a member filing a CEO hire directly", async () => {
      const before = await db.select().from(approvals);
      const res = await request(member()).post(`/api/companies/${companyId}/approvals`).send(ceoHire());
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe(PRIVILEGED_REFUSAL);
      expect(await db.select().from(approvals)).toHaveLength(before.length);
    });

    it("refuses a member with agents:create approving an admin's CEO hire; the admin may", async () => {
      const filed = await request(admin()).post(`/api/companies/${companyId}/approvals`).send(ceoHire());
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      const refused = await request(delegate()).post(`/api/approvals/${filed.body.id}/approve`).send({});
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      // Checked once, in approvalService.approve, where every channel meets.
      expect(refused.body.error).toBe("Only owners and admins can approve this hire.");
      const [stillPending] = await db.select().from(approvals).where(eq(approvals.id, filed.body.id));
      expect(stillPending!.status).toBe("pending");
      const approved = await request(admin()).post(`/api/approvals/${filed.body.id}/approve`).send({});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const created = await db.select().from(agents).where(eq(agents.name, filed.body.payload.name));
      expect(created.map((row) => row.role)).toEqual(["ceo"]);
    });

    it("lets an agent propose a CEO hire; deciding it still needs an admin", async () => {
      const cos = await seedAgent("chief_of_staff");
      const agentApp = express();
      agentApp.use(express.json());
      agentApp.use((req, _res, next) => {
        req.actor = { type: "agent", agentId: cos.id, companyId, source: "agent_key" };
        next();
      });
      agentApp.use("/api", approvalRoutes(db, { autoDispatchQueuedRuns: false }));
      agentApp.use(errorHandler);
      const filed = await request(agentApp).post(`/api/companies/${companyId}/approvals`).send(ceoHire());
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      const refused = await request(delegate()).post(`/api/approvals/${filed.body.id}/approve`).send({});
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe("Only owners and admins can approve this hire.");
      expect((await request(admin()).post(`/api/approvals/${filed.body.id}/approve`).send({})).status).toBe(200);
    });

    it("still lets a member file an ordinary hire", async () => {
      const res = await request(member()).post(`/api/companies/${companyId}/approvals`).send({
        type: "hire_agent", payload: { name: `Hire engineer ${randomUUID()}`, role: "engineer", adapterType: "process" },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
  });
});
