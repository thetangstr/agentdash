// AgentDash (security, GH #977): POST /api/onboarding/bootstrap with no
// companyId used to reuse the user's FIRST active membership — arbitrary for
// a user who belongs to more than one workspace. The Ask page exercised this
// and got a CoS provisioned in the wrong company. The route now answers 409
// `ambiguous_company` with the candidate list; a single active membership is
// still inferred, and an explicit companyId is honoured when the caller is an
// active member of it.
//
// Runs the real route and real services on embedded Postgres.
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import { onboardingV2Routes } from "../routes/onboarding-v2.js";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("POST /api/onboarding/bootstrap (multi-company actor, GH #977)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bootstrap-ambiguous-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [],
        memberships: [],
      };
      next();
    });
    app.use("/api/onboarding", onboardingV2Routes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedUser(email: string) {
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      email,
      name: "Multi Company User",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return userId;
  }

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedMembership(
    companyId: string,
    userId: string,
    opts: { status?: string; membershipRole?: string } = {},
  ) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: opts.status ?? "active",
      membershipRole: opts.membershipRole ?? "admin",
    });
  }

  it("returns 409 ambiguous_company with the workspace list when no companyId is given", async () => {
    const userId = await seedUser("multi@example.com");
    const companyA = await seedCompany("Alpha Co");
    const companyB = await seedCompany("Beta Co");
    await seedMembership(companyA, userId);
    await seedMembership(companyB, userId);
    const app = createApp(userId);

    const res = await request(app).post("/api/onboarding/bootstrap").send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ambiguous_company");
    expect(res.body.companies).toHaveLength(2);
    expect(res.body.companies).toEqual(
      expect.arrayContaining([
        { id: companyA, name: "Alpha Co" },
        { id: companyB, name: "Beta Co" },
      ]),
    );
  });

  it("honours an explicit companyId the user is an active member of", async () => {
    const userId = await seedUser("multi@example.com");
    const companyA = await seedCompany("Alpha Co");
    const companyB = await seedCompany("Beta Co");
    await seedMembership(companyA, userId, { membershipRole: "admin" });
    // A plain member may not bootstrap a CoS — a 403 here proves the named
    // company (B), not the ambiguous-company refusal, handled the request.
    await seedMembership(companyB, userId, { membershipRole: "member" });
    const app = createApp(userId);

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send({ companyId: companyB });

    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe("ambiguous_company");
  });

  it("infers the company when exactly one membership is active", async () => {
    const userId = await seedUser("multi@example.com");
    const active = await seedCompany("Alpha Co");
    const archived = await seedCompany("Beta Co");
    await seedMembership(active, userId, { membershipRole: "member" });
    await seedMembership(archived, userId, { status: "archived" });
    const app = createApp(userId);

    // One active membership is unambiguous: the request proceeds to the
    // workspace's own rules — here the member-role refusal, not the 409.
    const res = await request(app).post("/api/onboarding/bootstrap").send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner or admin/i);

    const memberships = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      );
    expect(memberships).toHaveLength(2);
  });
});
