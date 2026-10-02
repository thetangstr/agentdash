// AgentDash (scan 3, lane H): the founder stays owner through onboarding, the
// onboarding plan's hires keep their roles, and nobody is left "Needs a
// steward".
//
// The P0: setPrincipalPermission upserted the caller's membership as "member".
// /cos runs the onboarding bootstrap, which grants agents:create to the
// founder; for a founder who had created the company at /company-create (an
// existing `owner` row) that grant rewrote the row to `member`, and the owner
// re-assert after it was skipped because a membership existed. The CoS was
// then never paired (pairing requires `owner`), and the next /cos visit was
// refused as a non-admin.
//
// Real routes (POST /api/companies, POST /api/onboarding/bootstrap and
// /confirm-plan) on embedded Postgres. Only the instruction-bundle file write
// is stubbed: it touches the filesystem, not the identity rows under test.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
  assistantMessages,
  authUsers,
  boardApiKeys,
  companyMemberships,
  cosOnboardingStates,
  createDb,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { hashBearerToken } from "../services/board-auth.js";
import { agentAccountabilityService } from "../services/agent-accountability.js";

vi.mock("../services/agent-instructions.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  agentInstructionsService: () => ({
    materializeManagedBundle: async () => ({ adapterConfig: {} }),
  }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("onboarding: founder identity, hired roles and stewards", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let app!: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-founder-identity-");
    db = createDb(tempDb.connectionString);
    const { companyRoutes } = await import("../routes/companies.js");
    const { onboardingV2Routes } = await import("../routes/onboarding-v2.js");
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api/companies", companyRoutes(db, undefined, { allowMultiCompany: true }));
    app.use("/api/onboarding", onboardingV2Routes(db));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubEnv() {
    vi.stubEnv("AGENTDASH_ALLOW_MULTI_COMPANY", "true");
    vi.stubEnv("AGENTDASH_BILLING_DISABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("AGENTDASH_SELF_SERVE_BOOTSTRAP", "");
  }

  async function signedInUser(label = "founder") {
    const userId = `${label}-${randomUUID()}`;
    const token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      name: label,
      email: `${userId}@gmail.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(boardApiKeys).values({ userId, name: "Test", keyHash: hashBearerToken(token) });
    return { userId, token };
  }

  async function membershipRole(companyId: string, userId: string) {
    const [row] = await db
      .select({ role: companyMemberships.membershipRole, status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      );
    return row ?? null;
  }

  async function activeSteward(companyId: string, agentId: string) {
    const [row] = await db
      .select({ userId: agentStewardships.userId })
      .from(agentStewardships)
      .where(
        and(
          eq(agentStewardships.companyId, companyId),
          eq(agentStewardships.agentId, agentId),
          isNull(agentStewardships.endedAt),
        ),
      );
    return row?.userId ?? null;
  }

  async function createCompany(token: string, name = "Acme") {
    const res = await request(app).post("/api/companies").set("authorization", `Bearer ${token}`).send({ name });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  function bootstrap(token: string | null, companyId?: string) {
    const req = request(app).post("/api/onboarding/bootstrap");
    if (token) req.set("authorization", `Bearer ${token}`);
    return req.send(companyId ? { companyId } : {});
  }

  it("company create then /cos keeps the founder owner, on every visit, and pairs them with the CoS", async () => {
    stubEnv();
    const { userId, token } = await signedInUser();
    const companyId = await createCompany(token);
    expect(await membershipRole(companyId, userId)).toEqual({ role: "owner", status: "active" });

    const first = await bootstrap(token, companyId);
    expect(first.status).toBe(200);
    expect(first.body.companyId).toBe(companyId);
    expect(await membershipRole(companyId, userId)).toEqual({ role: "owner", status: "active" });

    // The second /cos visit used to be refused once the first had demoted them.
    const second = await bootstrap(token, companyId);
    expect(second.status).toBe(200);
    expect(second.body.cosAgentId).toBe(first.body.cosAgentId);
    expect(await membershipRole(companyId, userId)).toEqual({ role: "owner", status: "active" });

    expect(await activeSteward(companyId, first.body.cosAgentId)).toBe(userId);
  });

  it("local_trusted bootstrap keeps local-board owner across visits", async () => {
    stubEnv();
    // What server startup does for local_trusted (ensureLocalTrustedBoardPrincipal).
    await db
      .insert(authUsers)
      .values({ id: "local-board", name: "Board", email: "local@agentdash.local", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    const first = await bootstrap(null);
    expect(first.status).toBe(200);
    const companyId = first.body.companyId as string;
    expect(await membershipRole(companyId, "local-board")).toEqual({ role: "owner", status: "active" });

    const second = await bootstrap(null, companyId);
    expect(second.status).toBe(200);
    expect(await membershipRole(companyId, "local-board")).toEqual({ role: "owner", status: "active" });
    expect(await activeSteward(companyId, first.body.cosAgentId)).toBe("local-board");
  });

  it("a 4-agent plan persists mapped roles and humanized titles, and no agent needs a steward", async () => {
    stubEnv();
    const { userId, token } = await signedInUser();
    const companyId = await createCompany(token, "Planner Co");
    const boot = await bootstrap(token, companyId);
    expect(boot.status).toBe(200);
    const { conversationId, cosAgentId } = boot.body as { conversationId: string; cosAgentId: string };

    await db.insert(cosOnboardingStates).values({ conversationId, phase: "plan" }).onConflictDoNothing();
    const agent = (role: string, name: string) => ({
      role, name, adapterType: "claude_local", responsibilities: ["Do the work"], kpis: ["Work done"],
    });
    await db.insert(assistantMessages).values({
      conversationId,
      role: "assistant",
      content: "Plan",
      cardKind: "agent_plan_proposal_v1",
      cardPayload: {
        rationale: "Four hires",
        alignmentToShortTerm: "Short",
        alignmentToLongTerm: "Long",
        agents: [
          agent("research_analyst", "Scout"),
          agent("content_lead", "Quill"),
          agent("deployment_lead", "Rig"),
          agent("proposal_drafter", "Ivy"),
        ],
      },
    });

    const res = await request(app)
      .post("/api/onboarding/confirm-plan")
      .set("authorization", `Bearer ${token}`)
      .send({ conversationId });
    expect(res.status).toBe(201);
    expect(res.body.createdAgentIds).toHaveLength(4);

    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const hires = rows
      .filter((row) => row.id !== cosAgentId)
      .map((row) => ({ name: row.name, role: row.role, title: row.title }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(hires).toEqual([
      { name: "Ivy", role: "general", title: "Proposal Drafter" },
      { name: "Quill", role: "cmo", title: "Content Lead" },
      { name: "Rig", role: "devops", title: "Deployment Lead" },
      { name: "Scout", role: "researcher", title: "Research Analyst" },
    ]);

    // The founder still owns the company, stewards the CoS, and answers for
    // every hire: nothing on the board reads "Needs a steward".
    expect(await membershipRole(companyId, userId)).toEqual({ role: "owner", status: "active" });
    const accountability = await agentAccountabilityService(db).resolveForAgents(
      companyId,
      rows.map((row) => row.id),
    );
    for (const row of rows) {
      const entry = accountability.get(row.id);
      expect(entry?.via, `${row.name} accountability`).not.toBe("unpaired");
      expect(entry?.userId, `${row.name} accountable person`).toBe(userId);
    }
    expect(accountability.get(cosAgentId)?.via).toBe("steward");
  });

  describe("repair for founders the old grant demoted", () => {
    it("restores owner for the sole human creator and pairs them with the existing CoS", async () => {
      stubEnv();
      const { userId, token } = await signedInUser();
      const companyId = await createCompany(token, "Demoted Co");
      const boot = await bootstrap(token, companyId);
      expect(boot.status).toBe(200);
      // What the old code left behind: member, and no CoS pairing.
      await db
        .update(companyMemberships)
        .set({ membershipRole: "member" })
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
      await db.delete(agentStewardships).where(eq(agentStewardships.companyId, companyId));

      const repaired = await bootstrap(token, companyId);
      expect(repaired.status).toBe(200);
      expect(await membershipRole(companyId, userId)).toEqual({ role: "owner", status: "active" });
      expect(await activeSteward(companyId, boot.body.cosAgentId)).toBe(userId);
      const audit = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "company.owner_restored")));
      expect(audit).toHaveLength(1);

      // Idempotent: nothing more to repair on the next visit.
      expect((await bootstrap(token, companyId)).status).toBe(200);
      const auditAfter = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "company.owner_restored")));
      expect(auditAfter).toHaveLength(1);
    });

    it("does not promote a member when another human is in the company", async () => {
      stubEnv();
      const founder = await signedInUser();
      const companyId = await createCompany(founder.token, "Two Humans Co");
      const other = await signedInUser("teammate");
      await db.insert(companyMemberships).values({
        companyId, principalType: "user", principalId: other.userId, membershipRole: "member", status: "active",
      });
      await db
        .update(companyMemberships)
        .set({ membershipRole: "member" })
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, founder.userId)));

      const res = await bootstrap(founder.token, companyId);
      expect(res.status).toBe(403);
      expect(await membershipRole(companyId, founder.userId)).toEqual({ role: "member", status: "active" });
    });

    it("does not promote a member who never granted themselves agents:create", async () => {
      stubEnv();
      const founder = await signedInUser();
      const companyId = await createCompany(founder.token, "Invited Co");
      await db
        .update(companyMemberships)
        .set({ membershipRole: "member" })
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, founder.userId)));
      await db
        .update(principalPermissionGrants)
        .set({ grantedByUserId: "someone-else" })
        .where(eq(principalPermissionGrants.companyId, companyId));

      const res = await bootstrap(founder.token, companyId);
      expect(res.status).toBe(403);
      expect(await membershipRole(companyId, founder.userId)).toEqual({ role: "member", status: "active" });
    });
  });

  it("a permission grant never rewrites an existing membership role or status", async () => {
    stubEnv();
    const { accessService } = await import("../services/access.js");
    const { userId, token } = await signedInUser();
    const companyId = await createCompany(token, "Grant Co");
    const access = accessService(db);

    await access.setPrincipalPermission(companyId, "user", userId, "users:invite", true, userId);
    expect(await membershipRole(companyId, userId)).toEqual({ role: "owner", status: "active" });

    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
    await access.setPrincipalPermission(companyId, "user", userId, "tasks:assign", true, userId);
    expect(await membershipRole(companyId, userId)).toEqual({ role: "owner", status: "suspended" });

    // A principal with no membership still gets one, as member.
    const newcomer = `newcomer-${randomUUID()}`;
    await access.setPrincipalPermission(companyId, "user", newcomer, "tasks:assign", true, userId);
    expect(await membershipRole(companyId, newcomer)).toEqual({ role: "member", status: "active" });
  });
});
