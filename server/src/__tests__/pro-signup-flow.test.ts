// AgentDash (AGE-104 follow-up): real end-to-end Pro signup integration test.
//
// This test spins up an embedded PostgreSQL, mounts the FULL middleware
// chain in the same order app.ts does, and uses a real Better Auth
// instance — not a stub. It exercises the journey that user-reported
// regressions kept slipping through:
//
//   1. Pro signup with a free-mail address must be blocked at the
//      /api/auth/sign-up/email endpoint with pro_requires_corp_email,
//      AND no row in auth_users may be created.
//   2. Pro signup with a corp email must succeed and the user must end
//      up able to create their first company.
//   3. The new company creator must be promoted to "owner" (FRE Plan B).
//
// If any of these fails, the regression that triggered PR #65 + PR #66
// is back. Reverting either fix turns this test red.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { Router, type Request as ExpressRequest } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@agentdash/db";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  resolveBetterAuthSession,
  type BetterAuthSessionResult,
} from "../auth/better-auth.js";
import type { Config } from "../config.js";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { corpEmailSignupGuard } from "../middleware/corp-email-signup-guard.js";
import { freeSeatCapMiddleware } from "../middleware/free-seat-cap.js";
import { errorHandler } from "../middleware/error-handler.js";
import { companyRoutes } from "../routes/companies.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const TEST_ORIGIN = "http://127.0.0.1:3100";
const TEST_HOST = "127.0.0.1:3100";

const support = await getEmbeddedPostgresTestSupport();
const describeIt = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping Pro signup flow integration test on this host: ${support.reason ?? "unsupported environment"}`,
  );
}

describeIt("Pro signup → first company end-to-end (AGE-104)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let originalSecret: string | undefined;

  beforeAll(async () => {
    originalSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-32-chars-min-foobar";

    tempDb = await startEmbeddedPostgresTestDatabase("agentdash-pro-signup-flow-");
    db = createDb(tempDb.connectionString);

    const config = {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "derive_from_request",
      authPublicBaseUrl: undefined,
      authDisableSignUp: false,
      allowedHostnames: ["127.0.0.1", "localhost"],
    } as unknown as Config;

    const auth = createBetterAuthInstance(db as never, config, [
      "http://127.0.0.1:3100",
      "http://localhost:3100",
    ]);
    const betterAuthHandler = createBetterAuthHandler(auth);
    const resolveSession = (req: ExpressRequest) =>
      resolveBetterAuthSession(auth, req) as Promise<BetterAuthSessionResult | null>;

    app = express();
    app.use(express.json());
    app.use(
      actorMiddleware(db as never, {
        deploymentMode: "authenticated",
        resolveSession,
      }),
    );
    // Same order as production app.ts:
    app.use(freeSeatCapMiddleware(db as never, { enabled: false }));
    app.use(corpEmailSignupGuard({ enabled: true }));
    app.all("/api/auth/*authPath", betterAuthHandler);

    const api = Router();
    api.use(boardMutationGuard());
    api.use(
      "/companies",
      companyRoutes(db as never, undefined, {
        allowMultiTenantPerDomain: false,
        requireCorpEmail: true,
      }),
    );
    app.use("/api", api);
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (originalSecret === undefined) {
      delete process.env.BETTER_AUTH_SECRET;
    } else {
      process.env.BETTER_AUTH_SECRET = originalSecret;
    }
  });

  it("blocks gmail signup with pro_requires_corp_email and creates no auth_users row", async () => {
    const before = await db.select().from(authUsers);
    const beforeCount = before.length;

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Origin", TEST_ORIGIN)
      .set("Host", TEST_HOST)
      .send({ name: "Jane", email: "jane@gmail.com", password: "hunter2hunter2" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: "pro_requires_corp_email",
      error:
        "Pro accounts require a company email. Please sign up with your work email or use the Free self-hosted plan.",
    });

    const after = await db.select().from(authUsers);
    expect(after.length).toBe(beforeCount);
  });

  it("blocks yahoo signup case-insensitively (defense against domain casing tricks)", async () => {
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Origin", TEST_ORIGIN)
      .set("Host", TEST_HOST)
      .send({ name: "Jane", email: "Jane@YAHOO.com", password: "hunter2hunter2" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("pro_requires_corp_email");
  });

  it("corp signup creates a real auth_users row and lets the new user create their first company as owner", async () => {
    // 1. Sign up with a corp email — must succeed end-to-end (real Better Auth).
    const signupRes = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Origin", TEST_ORIGIN)
      .set("Host", TEST_HOST)
      .send({
        name: "Alice Acme",
        email: "alice@acme.example",
        password: "hunter2hunter2",
      });

    expect(signupRes.status).toBe(200);
    const setCookieHeader = signupRes.headers["set-cookie"];
    expect(setCookieHeader).toBeTruthy();
    const cookieJar = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];

    const userRows = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.email, "alice@acme.example"));
    expect(userRows).toHaveLength(1);
    const userId = userRows[0]!.id;

    // 2. Create a company with the resulting session — proves PR #65 + #66 work
    //    together: no admin gate, no late-firing free-mail block, owner promo.
    const createRes = await request(app)
      .post("/api/companies")
      .set("Origin", TEST_ORIGIN)
      .set("Host", TEST_HOST)
      .set("Cookie", cookieJar)
      .send({ name: "Acme Inc" });

    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({
      name: "Acme Inc",
      emailDomain: "acme.example",
    });

    // 3. The creator must be the company owner.
    const memberships = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.principalId, userId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      principalType: "user",
      membershipRole: "owner",
      status: "active",
    });

    // Sanity: the company actually exists.
    const companyRows = await db
      .select()
      .from(companies)
      .where(eq(companies.id, createRes.body.id));
    expect(companyRows).toHaveLength(1);
  });
});
