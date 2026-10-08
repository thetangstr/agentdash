import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, activityLog, authUsers, companyMemberships, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("agent creation authority", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let home: string;
  const companyId = randomUUID();
  const creatorId = randomUUID();
  const ceoId = randomUUID();
  const memberId = randomUUID();
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "agent-create-authority-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
    vi.stubEnv("XDG_DATA_HOME", join(home, "data"));
    vi.stubEnv("AGENTDASH_BILLING_DISABLED", "true");
    database = await startEmbeddedPostgresTestDatabase("agent-create-authority-db-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Authority test", issuePrefix: "AUTH", requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: memberId, name: "Member", email: `${memberId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: memberId, membershipRole: "member", status: "active" });
    await db.insert(agents).values([
      { id: creatorId, companyId, name: "Creator", role: "engineer", permissions: { canCreateAgents: true } },
      { id: ceoId, companyId, name: "CEO", role: "ceo" },
    ]);
  });
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });
  function appAs(agentId?: string, member = false) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = member
        ? { type: "board", userId: memberId, source: "session", isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, membershipRole: "member", status: "active" }] }
        : agentId
        ? { type: "agent", agentId, companyId, source: "agent_key" }
        : { type: "board", userId: "test-board", source: "local_implicit", isInstanceAdmin: true, companyIds: [companyId] };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }
  const privileged = [
    { role: "ceo" },
    { role: "ceo", permissions: { canCreateAgents: false } },
    { role: "chief_of_staff" },
    { role: "engineer", permissions: { canCreateAgents: true } },
    { role: "chief_of_staff", permissions: { canCreateAgents: true } },
  ];
  for (const route of ["agents", "agent-hires"]) {
    it(`${route}: ordinary member creation hides monthly figures in every envelope`, async () => {
      await db.update(companies).set({ requireBoardApprovalForNewAgents: route === "agent-hires" }).where(eq(companies.id, companyId));
      const response = await request(appAs(undefined, true)).post(`/api/companies/${companyId}/${route}`).send({
        name: `Member ${route}`, role: "engineer", adapterType: "hermes_local", budgetMonthlyCents: 876543,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const agent = route === "agent-hires" ? response.body.agent : response.body;
      expect(agent.budgetMonthlyCents).toBeNull();
      expect(agent.spentMonthlyCents).toBeNull();
      const [stored] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(stored!.budgetMonthlyCents).toBe(876543);
      if (route === "agent-hires") {
        expect(response.body.approval.type).toBe("hire_agent");
        expect(response.body.approval.payload.budgetMonthlyCents).toBeNull();
      } else {
        expect(response.body.apiKey.token).toEqual(expect.any(String));
        expect(response.body.apiKey.autoCreated).toBe(true);
      }
    });
    for (const caller of [creatorId, ceoId]) {
      it.each(privileged)(`${route}: agent ${caller} cannot grant %j`, async (authority) => {
        await db.update(companies).set({ requireBoardApprovalForNewAgents: route === "agent-hires" }).where(eq(companies.id, companyId));
        const name = `Escalation ${randomUUID()}`;
        const beforeApprovals = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
        const beforeActivity = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
        const response = await request(appAs(caller)).post(`/api/companies/${companyId}/${route}`).send({
          name, adapterType: "hermes_local", adapterConfig: {}, ...authority,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(403);
        expect(await db.select().from(agents).where(eq(agents.name, name))).toEqual([]);
        expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).toEqual(beforeApprovals);
        expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toEqual(beforeActivity);
      });
    }
    it(`${route}: a creator can create an ordinary agent`, async () => {
      const response = await request(appAs(creatorId)).post(`/api/companies/${companyId}/${route}`).send({ name: `Ordinary ${route}`, role: "engineer", adapterType: "hermes_local", budgetMonthlyCents: 876543 });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const agent = route === "agent-hires" ? response.body.agent : response.body;
      expect(agent.budgetMonthlyCents).toBe(876543);
      expect(agent.spentMonthlyCents).toBe(0);
    });
    it.each(privileged)(`${route}: the board may grant %j`, async (authority) => {
      const response = await request(appAs()).post(`/api/companies/${companyId}/${route}`).send({ name: `Board ${randomUUID()}`, adapterType: "hermes_local", ...authority });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    });
  }
});
