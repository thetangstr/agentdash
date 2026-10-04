// AgentDash (#767, SC-6): the one-time claim link of a hosted box, against a
// real Better Auth instance and embedded Postgres.
//   - the claim code works once, for the claim email only, while the box has
//     no users; a second use and a different email are refused;
//   - a company invite still admits a teammate after the claim;
//   - MCP sign-up is bound to the claim email the same way;
//   - /api/health reports `claimed`, false then true, on hosted boxes only;
//   - without AGENTDASH_CLAIM_EMAIL nothing changes.
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentdashBoxClaim, authUsers, boardApiKeys, companies, createDb, instanceUserRoles, invites } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { inviteCodeSignupGuard } from "../middleware/invite-code-signup-guard.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import { onboardingMcpSignupRoutes } from "../routes/onboarding-mcp-signup.js";
import { healthRoutes } from "../routes/health.js";
import { errorHandler } from "../middleware/error-handler.js";
import { inviteService } from "../services/invites.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { boxClaimed, boxClaimedCached, CLAIM_ATTEMPT_HEADER, checkClaimSignup, claimEmailMatches, resetClaimedCacheForTests, takeClaim } from "../lib/claim-code.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

const CLAIM_CODE = "AGD-0123456789ABCDEF0123456789";
const PASSWORD = "a-long-enough-password-1";
const ENV_KEYS = [
  "AGENTDASH_INVITE_CODES",
  "AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE",
  "AGENTDASH_CLAIM_EMAIL",
  "AGENTDASH_SELF_SERVE_BOOTSTRAP",
  "AGENTDASH_INVITE_VALIDATION",
  "AGENTDASH_DEPLOYMENT_KIND",
  "BETTER_AUTH_SECRET",
] as const;

describe("claim email matching", () => {
  it("is case-insensitive and trimmed, and never matches without a binding", () => {
    const env = { AGENTDASH_CLAIM_EMAIL: "  Founder@Example.COM " } as NodeJS.ProcessEnv;
    expect(claimEmailMatches("founder@example.com", env)).toBe(true);
    expect(claimEmailMatches(" FOUNDER@example.com", env)).toBe(true);
    expect(claimEmailMatches("other@example.com", env)).toBe(false);
    expect(claimEmailMatches("", env)).toBe(false);
    expect(claimEmailMatches("founder@example.com", {} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describeEmbedded("one-time claim link (#767)", () => {
  type TestDb = ReturnType<typeof createDb>;
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claim-link-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE = "true";
    process.env.AGENTDASH_INVITE_CODES = CLAIM_CODE;
    process.env.AGENTDASH_CLAIM_EMAIL = "Founder@Example.com";
    process.env.BETTER_AUTH_SECRET = "claim-link-test-secret-0123456789abcdef";
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await truncateWithRetry(db, sql`${boardApiKeys}, ${instanceUserRoles}, ${invites}, ${companies}, ${authUsers}, ${agentdashBoxClaim}`);
    resetClaimedCacheForTests();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function authApp() {
    const auth = createBetterAuthInstance(
      db,
      { authBaseUrlMode: "explicit", authPublicBaseUrl: "http://127.0.0.1:3100" } as Parameters<typeof createBetterAuthInstance>[1],
      ["http://127.0.0.1:3100"],
    );
    const app = express();
    app.use(express.json());
    app.use("/api/auth", inviteCodeSignupGuard({ enabled: true, db }));
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    return app;
  }

  const signUp = (app: express.Express, body: Record<string, unknown>) =>
    request(app).post("/api/auth/sign-up/email").set("Origin", "http://127.0.0.1:3100").send({ name: "N", password: PASSWORD, ...body });

  const users = () => db.select({ email: authUsers.email }).from(authUsers);

  it("works once, for the claim email only; a second use and a different email are refused", async () => {
    const app = authApp();
    const wrong = await signUp(app, { email: "intruder@example.com", inviteCode: CLAIM_CODE });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("claim_email_mismatch");
    expect(await users()).toHaveLength(0);

    const ok = await signUp(app, { email: " FOUNDER@example.com ".trim(), inviteCode: CLAIM_CODE });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await users()).map((u) => u.email.toLowerCase())).toEqual(["founder@example.com"]);

    const again = await signUp(app, { email: "founder2@example.com", inviteCode: CLAIM_CODE });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("claim_code_used");
    const sameEmail = await signUp(app, { email: "founder@example.com", inviteCode: CLAIM_CODE });
    expect(sameEmail.status).toBe(409);
    expect(await users()).toHaveLength(1);
  });

  it("a wrong code still gets the generic refusal (no hint about the binding)", async () => {
    const res = await signUp(authApp(), { email: "founder@example.com", inviteCode: "AGD-FFFFFFFFFFFFFFFFFFFFFFFFFF" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("invite_code_required");
  });

  it("a company invite still admits a teammate after the claim", async () => {
    const app = authApp();
    expect((await signUp(app, { email: "founder@example.com", inviteCode: CLAIM_CODE })).status).toBe(200);
    const companyId = crypto.randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Claim Co", issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    const { token } = await inviteService(db).createCompanyInvite({ companyId, invitedByUserId: "admin-user" });
    const teammate = await signUp(app, { email: "teammate@example.com", inviteToken: token });
    expect(teammate.status, JSON.stringify(teammate.body)).toBe(200);
    // Presenting the used claim code alongside a valid invite still lets the invite through.
    const { token: token2 } = await inviteService(db).createCompanyInvite({ companyId, invitedByUserId: "admin-user" });
    const both = await signUp(app, { email: "third@example.com", inviteCode: CLAIM_CODE, inviteToken: token2 });
    expect(both.status, JSON.stringify(both.body)).toBe(200);
    expect(await users()).toHaveLength(3);
  });

  it("without AGENTDASH_CLAIM_EMAIL, the instance code behaves exactly as before", async () => {
    delete process.env.AGENTDASH_CLAIM_EMAIL;
    const app = authApp();
    expect((await signUp(app, { email: "a@example.com", inviteCode: CLAIM_CODE })).status).toBe(200);
    expect((await signUp(app, { email: "b@example.com", inviteCode: CLAIM_CODE })).status).toBe(200);
    expect(await checkClaimSignup(db, "anyone@example.com")).toEqual({ ok: true });
  });

  // #767 review, HIGH: the zero-user check was not atomic with user creation.
  it("of 8 parallel claim sign-ups with the claim email, exactly one creates a user", async () => {
    const app = authApp();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => signUp(app, { email: "founder@example.com", inviteCode: CLAIM_CODE })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await users()).toHaveLength(1);
    expect(await db.select().from(agentdashBoxClaim)).toHaveLength(1);
  });

  it("the claim is persisted: with every user gone, the code still does not work", async () => {
    const app = authApp();
    expect((await signUp(app, { email: "founder@example.com", inviteCode: CLAIM_CODE })).status).toBe(200);
    await truncateWithRetry(db, sql`${authUsers}`);
    expect(await users()).toHaveLength(0);
    const again = await signUp(app, { email: "founder@example.com", inviteCode: CLAIM_CODE });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("claim_code_used");
    expect(await users()).toHaveLength(0);
  });

  it("a failed claim sign-up (weak password) does not lock the box", async () => {
    const app = authApp();
    const weak = await signUp(app, { email: "founder@example.com", inviteCode: CLAIM_CODE, password: "short" });
    expect(weak.status).toBeGreaterThanOrEqual(400);
    await new Promise((r) => setTimeout(r, 100)); // the release runs off the response
    expect(await db.select().from(agentdashBoxClaim)).toHaveLength(0);
    expect((await signUp(app, { email: "founder@example.com", inviteCode: CLAIM_CODE })).status).toBe(200);
  });

  it("a client cannot supply the claim attempt header", async () => {
    const app = authApp();
    const forged = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Origin", "http://127.0.0.1:3100")
      .set("x-agentdash-claim-attempt", "forged")
      .send({ name: "N", password: PASSWORD, email: "intruder@example.com", inviteCode: CLAIM_CODE });
    expect(forged.status).toBe(403);
    expect(await users()).toHaveLength(0);
  });

  // #812 / pre-release review: a claim row with no user behind it must never strand the claimant.
  describe("stuck claims (#812)", () => {
    const orphan = (ageMinutes: number) =>
      db.insert(agentdashBoxClaim).values({ email: "founder@example.com", attempt: "dead-attempt", claimedAt: new Date(Date.now() - ageMinutes * 60_000) });

    it("a crash between taking the claim and inserting the user: not claimed, and the claimant gets in once the row is stale", async () => {
      await orphan(10);
      expect(await boxClaimed(db)).toBe(false);
      expect((await checkClaimSignup(db, "founder@example.com")).ok).toBe(true);
      process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
      const health = express();
      health.use("/health", healthRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "public", authReady: true, companyDeletionEnabled: false }));
      expect((await request(health).get("/health")).body.claimed).toBe(false);
      const ok = await signUp(authApp(), { email: "founder@example.com", inviteCode: CLAIM_CODE });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(await users()).toHaveLength(1);
      const [row] = await db.select().from(agentdashBoxClaim);
      expect(row!.attempt).not.toBe("dead-attempt");
      expect(row!.completedAt).not.toBeNull();
    });

    it("a fresh row from an attempt still in flight keeps the race safe but is not reported as claimed", async () => {
      await orphan(0);
      expect(await boxClaimed(db)).toBe(false);
      expect(await boxClaimedCached(db)).toBe(false);
      const blocked = await signUp(authApp(), { email: "founder@example.com", inviteCode: CLAIM_CODE });
      expect(blocked.status).toBe(409);
      expect(await users()).toHaveLength(0);
      expect(await takeClaim(db, "founder@example.com", "other-attempt")).toBe(false);
      expect(await takeClaim(db, "founder@example.com", "other-attempt", 0)).toBe(true); // once stale
    });

    it("an aborted claim request gives the claim back", async () => {
      // Stands in for Better Auth: takes the claim for the guard's attempt, then never answers.
      const app = express();
      app.use(express.json());
      app.use("/api/auth", inviteCodeSignupGuard({ enabled: true, db }));
      app.use("/api/auth", async (req, _res) => {
        await takeClaim(db, "founder@example.com", String(req.headers[CLAIM_ATTEMPT_HEADER]));
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", () => r()));
      try {
        const port = (server.address() as AddressInfo).port;
        const body = JSON.stringify({ name: "N", email: "founder@example.com", password: PASSWORD, inviteCode: CLAIM_CODE });
        const req = http.request({ host: "127.0.0.1", port, path: "/api/auth/sign-up/email", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
        req.on("error", () => {});
        req.end(body);
        for (let i = 0; i < 50 && (await db.select().from(agentdashBoxClaim)).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
        expect(await db.select().from(agentdashBoxClaim)).toHaveLength(1);
        req.destroy(); // the client gives up
        for (let i = 0; i < 50 && (await db.select().from(agentdashBoxClaim)).length > 0; i++) await new Promise((r) => setTimeout(r, 20));
        expect(await db.select().from(agentdashBoxClaim)).toHaveLength(0);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it("health caches claimed=true for good only once a user exists", async () => {
      await orphan(0);
      expect(await boxClaimedCached(db)).toBe(false);
      resetClaimedCacheForTests();
      await db.update(agentdashBoxClaim).set({ completedAt: new Date() });
      expect(await boxClaimedCached(db)).toBe(true); // a completed claim, but no user: not cached for good
      await truncateWithRetry(db, sql`${agentdashBoxClaim}`);
      await new Promise((r) => setTimeout(r, 5));
      expect(await boxClaimedCached(db, 0)).toBe(false);
    });
  });

  describe("MCP sign-up", () => {
    beforeEach(() => {
      process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
      process.env.AGENTDASH_INVITE_VALIDATION = "off";
    });

    function mcpApp() {
      const app = express();
      app.use(express.json());
      app.use(
        "/api/onboarding",
        onboardingMcpSignupRoutes(db, {
          deploymentMode: "authenticated",
          createUser: async ({ name, email }) => {
            const id = crypto.randomUUID();
            await db.insert(authUsers).values({ id, name, email, emailVerified: false, createdAt: new Date(), updatedAt: new Date() });
            return { userId: id };
          },
        }),
      );
      app.use(errorHandler);
      return app;
    }

    it("is bound to the claim email and single-use", async () => {
      const app = mcpApp();
      const wrong = await request(app).post("/api/onboarding/mcp-signup").send({ email: "intruder@example.com", name: "X", inviteCode: CLAIM_CODE });
      expect(wrong.status).toBe(403);
      expect(wrong.body.code).toBe("claim_email_mismatch");
      const ok = await request(app).post("/api/onboarding/mcp-signup").send({ email: "founder@example.com", name: "F", inviteCode: CLAIM_CODE });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      const again = await request(app).post("/api/onboarding/mcp-signup").send({ email: "founder@example.com", name: "F", inviteCode: CLAIM_CODE });
      expect(again.status).toBe(409);
    });

    it("of 8 parallel MCP claims, exactly one creates a user", async () => {
      const app = mcpApp();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => request(app).post("/api/onboarding/mcp-signup").send({ email: "founder@example.com", name: "F", inviteCode: CLAIM_CODE })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await users()).toHaveLength(1);
    });
  });

  describe("health", () => {
    function healthApp() {
      const app = express();
      app.use("/health", healthRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "public", authReady: true, companyDeletionEnabled: false }));
      return app;
    }

    it("reports claimed false, then true after the first sign-up, on a hosted box", async () => {
      process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
      const before = await request(healthApp()).get("/health");
      expect(before.body).toMatchObject({ hostedBox: true, claimed: false, hasUsers: false });
      expect((await signUp(authApp(), { email: "founder@example.com", inviteCode: CLAIM_CODE })).status).toBe(200);
      // No resetClaimedCacheForTests: the user-create hook clears the stale
      // pre-signup snapshot, so this poll reads live state (PR #1017 follow-up).
      const after = await request(healthApp()).get("/health");
      expect(after.body).toMatchObject({ hostedBox: true, claimed: true, hasUsers: true });
      // Nothing about the user beyond the flag.
      expect(JSON.stringify(after.body)).not.toContain("founder@example.com");
    });

    it("flips hasUsers without a cache reset on a claim-less self-serve box too", async () => {
      // No AGENTDASH_CLAIM_EMAIL → completeClaim never runs; the
      // unconditional invalidation in the user-create hook is what must fire.
      delete process.env.AGENTDASH_CLAIM_EMAIL;
      process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
      const health = healthApp();
      expect((await request(health).get("/health")).body).toMatchObject({ hasUsers: false });
      expect((await signUp(authApp(), { email: "a@example.com", inviteCode: CLAIM_CODE })).status).toBe(200);
      expect((await request(health).get("/health")).body).toMatchObject({ hasUsers: true });
    });

    it("has no claimed field off a hosted box", async () => {
      delete process.env.AGENTDASH_DEPLOYMENT_KIND;
      const res = await request(healthApp()).get("/health");
      expect(res.body.hostedBox).toBe(false);
      expect(res.body).not.toHaveProperty("claimed");
    });
  });

  it("the claim sign-up created exactly the claim email's user", async () => {
    const app = authApp();
    await signUp(app, { email: "founder@example.com", inviteCode: CLAIM_CODE });
    const rows = await db.select().from(authUsers).where(eq(authUsers.email, "founder@example.com"));
    expect(rows).toHaveLength(1);
  });
});
