import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// These fixtures inject req.actor without running the auth middleware, so no
// verified credential exists (same arrangement as agent-visibility-routes.test.ts).
vi.mock("../services/issue-current-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-current-authority.js")>()),
  issueCurrentAuthority: () => undefined,
}));

import {
  agentStewardships,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessRoutes } from "../routes/access.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { userProfileRoutes } from "../routes/user-profiles.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (GH #505): member email addresses, walked through the REAL routers
 * against a REAL database -- so `canUser` is the production permission path,
 * company id included, not a mock that answers the same for every company.
 *
 * The rule: agents never get member emails; board users get other members'
 * addresses only where they manage members (`users:manage_permissions`) in
 * THAT company; everyone gets their own.
 */
describeEmbeddedPostgres("member email visibility routes (GH #505)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY_A = randomUUID();
  const COMPANY_B = randomUUID();
  const ADMIN_A = `admin-${randomUUID()}`; // admin of A, plain member of B
  const MEMBER = `member-${randomUUID()}`; // plain member of A
  const STEWARD = `steward-${randomUUID()}`; // member of A, stewards CASPER
  const NAMELESS = `nameless-${randomUUID()}`; // member of A with no display name
  const BOB = `bob-${randomUUID()}`; // member of B only
  const CASPER = randomUUID();
  const ISSUE = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-email-visibility-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values([
      { id: COMPANY_A, name: "Company A", issuePrefix: "MEA", agentVisibilityDefault: "company" },
      { id: COMPANY_B, name: "Company B", issuePrefix: "MEB", agentVisibilityDefault: "company" },
    ]);
    const now = new Date();
    await db.insert(authUsers).values([
      { id: ADMIN_A, name: "Ada Admin", email: "ada@a.test", createdAt: now, updatedAt: now },
      { id: MEMBER, name: "Mo Member", email: "mo@a.test", createdAt: now, updatedAt: now },
      { id: STEWARD, name: "Stu Steward", email: "stu@a.test", createdAt: now, updatedAt: now },
      { id: NAMELESS, name: "", email: "quiet.person@a.test", createdAt: now, updatedAt: now },
      { id: BOB, name: "Bob", email: "bob@b.test", createdAt: now, updatedAt: now },
    ]);
    for (const [companyId, userId, role] of [
      [COMPANY_A, ADMIN_A, "admin"],
      [COMPANY_A, MEMBER, "member"],
      [COMPANY_A, STEWARD, "member"],
      [COMPANY_A, NAMELESS, "member"],
      [COMPANY_B, ADMIN_A, "member"],
      [COMPANY_B, BOB, "admin"],
    ] as const) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: role,
      });
    }
    await db.insert(agents).values({
      id: CASPER,
      companyId: COMPANY_A,
      name: "Casper",
      role: "chief_of_staff",
      createdByUserId: ADMIN_A,
      visibility: "company",
    });
    await db.insert(agentStewardships).values({ companyId: COMPANY_A, agentId: CASPER, userId: STEWARD });
    await db.insert(issues).values({
      id: ISSUE,
      companyId: COMPANY_A,
      title: "Casper's task",
      status: "todo",
      assigneeAgentId: CASPER,
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
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use("/api", agentRoutes(db));
    app.use("/api", (issueRoutes as any)(db));
    app.use("/api", userProfileRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const asUser = (userId: string, memberships: Array<[string, string]>) =>
    appAs({
      type: "board",
      source: "session",
      userId,
      isInstanceAdmin: false,
      companyIds: memberships.map(([companyId]) => companyId),
      memberships: memberships.map(([companyId, membershipRole]) => ({
        companyId,
        membershipRole,
        status: "active",
      })),
    });
  const adminA = () => asUser(ADMIN_A, [[COMPANY_A, "admin"], [COMPANY_B, "member"]]);
  const member = () => asUser(MEMBER, [[COMPANY_A, "member"]]);
  const nameless = () => asUser(NAMELESS, [[COMPANY_A, "member"]]);
  const agent = () =>
    appAs({ type: "agent", agentId: CASPER, companyId: COMPANY_A, source: "agent_key", companyIds: [COMPANY_A] });

  const emailsIn = (body: unknown) =>
    [...JSON.stringify(body).matchAll(/[a-z0-9.]+@[ab]\.test/g)].map((m) => m[0]).sort();

  describe("cross-company", () => {
    it("an admin of company A sees A's emails but only their own in company B", async () => {
      const inA = await request(adminA()).get(`/api/companies/${COMPANY_A}/user-directory`);
      expect(inA.status).toBe(200);
      expect(emailsIn(inA.body)).toEqual(["ada@a.test", "mo@a.test", "quiet.person@a.test", "stu@a.test"]);

      const inB = await request(adminA()).get(`/api/companies/${COMPANY_B}/user-directory`);
      expect(inB.status).toBe(200);
      expect(emailsIn(inB.body)).toEqual(["ada@a.test"]);
      const bob = inB.body.users.find((u: { principalId: string }) => u.principalId === BOB);
      expect(bob.user).toMatchObject({ name: "Bob", email: null });

      const peopleB = await request(adminA()).get(`/api/companies/${COMPANY_B}/people`);
      expect(peopleB.status).toBe(200);
      expect(emailsIn(peopleB.body)).toEqual(["ada@a.test"]);
    });
  });

  describe("a non-admin member", () => {
    it("gets steward names without emails on the agent list and detail", async () => {
      const list = await request(member()).get(`/api/companies/${COMPANY_A}/agents`);
      expect(list.status).toBe(200);
      const casper = list.body.find((row: { id: string }) => row.id === CASPER);
      expect(casper.steward).toMatchObject({ userId: STEWARD, name: "Stu Steward", email: null });
      expect(emailsIn(list.body)).toEqual([]);

      const detail = await request(member()).get(`/api/agents/${CASPER}`);
      expect(detail.status).toBe(200);
      expect(detail.body.steward).toMatchObject({ userId: STEWARD, name: "Stu Steward", email: null });
      expect(emailsIn(detail.body)).toEqual([]);
    });

    it("gets the issue-list steward chip without the email; an admin keeps it", async () => {
      const asMember = await request(member()).get(`/api/companies/${COMPANY_A}/issues`);
      expect(asMember.status).toBe(200);
      const row = asMember.body.find((issue: { id: string }) => issue.id === ISSUE);
      expect(row.assigneeSteward).toMatchObject({ userId: STEWARD, name: "Stu Steward", email: null });
      expect(emailsIn(asMember.body)).toEqual([]);

      const asAdmin = await request(adminA()).get(`/api/companies/${COMPANY_A}/issues`);
      const adminRow = asAdmin.body.find((issue: { id: string }) => issue.id === ISSUE);
      expect(adminRow.assigneeSteward).toMatchObject({ userId: STEWARD, email: "stu@a.test" });
    });

    it("gets a colleague's profile without the email", async () => {
      const res = await request(member()).get(`/api/companies/${COMPANY_A}/users/stu-steward/profile`);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: STEWARD, name: "Stu Steward", email: null });
    });
  });

  describe("an agent", () => {
    it("gets no email on the issue list, the agent reads or the directory", async () => {
      for (const path of [
        `/api/companies/${COMPANY_A}/issues`,
        `/api/companies/${COMPANY_A}/agents`,
        `/api/agents/me`,
        `/api/companies/${COMPANY_A}/user-directory`,
        `/api/companies/${COMPANY_A}/people`,
      ]) {
        const res = await request(agent()).get(path);
        expect(res.status, path).toBe(200);
        expect(emailsIn(res.body), path).toEqual([]);
      }
    });
  });

  describe("profile slugs and lookup", () => {
    it("never derives a nameless member's slug from their email for a non-admin", async () => {
      const res = await request(member()).get(`/api/companies/${COMPANY_A}/users/${NAMELESS}/profile`);
      expect(res.status).toBe(200);
      expect(res.body.user.slug).not.toMatch(/quiet/);
      expect(res.body.user.email).toBeNull();
      // The returned slug resolves again, so links built from it work.
      const again = await request(member()).get(
        `/api/companies/${COMPANY_A}/users/${encodeURIComponent(res.body.user.slug)}/profile`,
      );
      expect(again.status).toBe(200);
      expect(again.body.user.id).toBe(NAMELESS);
    });

    it("answers an email or email-local-part lookup exactly like not-found", async () => {
      const missing = await request(member()).get(`/api/companies/${COMPANY_A}/users/no-such-person/profile`);
      expect(missing.status).toBe(404);
      for (const probe of ["quiet.person@a.test", "quiet-person", "stu", "stu@a.test"]) {
        const res = await request(member()).get(
          `/api/companies/${COMPANY_A}/users/${encodeURIComponent(probe)}/profile`,
        );
        expect(res.status, probe).toBe(404);
        expect(res.body, probe).toEqual(missing.body);
      }
      const asAgent = await request(agent()).get(`/api/companies/${COMPANY_A}/users/quiet-person/profile`);
      expect(asAgent.status).toBe(404);
    });

    it("keeps email-based slugs and lookup for a member manager, and for the member themself", async () => {
      const admin = await request(adminA()).get(`/api/companies/${COMPANY_A}/users/quiet-person/profile`);
      expect(admin.status).toBe(200);
      expect(admin.body.user).toMatchObject({ id: NAMELESS, slug: "quiet-person", email: "quiet.person@a.test" });
      const byLocalPart = await request(adminA()).get(`/api/companies/${COMPANY_A}/users/stu/profile`);
      expect(byLocalPart.status).toBe(200);

      const self = await request(nameless()).get(`/api/companies/${COMPANY_A}/users/quiet-person/profile`);
      expect(self.status).toBe(200);
      expect(self.body.user).toMatchObject({ id: NAMELESS, email: "quiet.person@a.test" });
    });
  });
});
