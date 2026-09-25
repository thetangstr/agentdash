// AgentDash (#731): a company invite must open the hosted signup gate.
//
// The invite link's whole promise is "click this to join the company" — on a
// gated box it dead-ended at the signup gate, which only knew the shared
// instance codes. A pending company_join invite is itself an invitation to
// create an account, so the gate now accepts the invite token too — delivered
// in the sign-up body's `inviteToken` field, or in the first-party cookie the
// invite-summary endpoint sets (the cookie is what lets the SSO round trip
// carry the claim).
//
// Single-use is claimed, not just checked: the first sign-up binds the token
// to that email in defaultsPayload.signupClaimedEmail via a CAS update, so a
// second sign-up with a different email against the same link is refused.

import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authUsers,
  boardApiKeys,
  companies,
  createDb,
  instanceUserRoles,
  invites,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { inviteCodeSignupGuard } from "../middleware/invite-code-signup-guard.js";
import { INVITE_TOKEN_COOKIE_NAME } from "../lib/signup-gate.js";
import { hashToken } from "../lib/invite-tokens.js";
import { inviteService } from "../services/invites.js";
import { onboardingMcpSignupRoutes } from "../routes/onboarding-mcp-signup.js";
import { errorHandler } from "../middleware/error-handler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const ENV_KEYS = [
  "AGENTDASH_INVITE_CODES",
  "AGENTDASH_MK_INVITE_CODES",
  "AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE",
  "AGENTDASH_SELF_SERVE_BOOTSTRAP",
  "AGENTDASH_INVITE_VALIDATION",
] as const;
const savedEnv: Record<string, string | undefined> = {};

describeEmbeddedPostgres("company-invite signup gate bypass (#731)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invite-signup-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.AGENTDASH_INVITE_CODES = "GENERAL-CODE";
    companyId = crypto.randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Invite Co",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.restoreAllMocks();
    await truncateWithRetry(db, sql`${invites}, ${companies}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Mounts the guard exactly where app.ts does: in front of the auth router. */
  function buildApp(withDb = true) {
    const seen: Array<Record<string, unknown>> = [];
    const app = express();
    app.use(express.json());
    app.use("/api/auth", inviteCodeSignupGuard({ enabled: true, ...(withDb ? { db } : {}) }));
    app.use("/api/auth", (req, res) => {
      // Stands in for Better Auth: records what actually reached it.
      seen.push({ ...(req.body as Record<string, unknown>) });
      res.status(200).json({ ok: true });
    });
    return { app, seen };
  }

  function createInvite(opts: Parameters<ReturnType<typeof inviteService>["createCompanyInvite"]>[0] = {}) {
    return inviteService(db).createCompanyInvite({
      companyId,
      invitedByUserId: "admin-user",
      ...opts,
    });
  }

  async function inviteRow(token: string) {
    return db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
  }

  it("accepts a pending company invite token in the sign-up body", async () => {
    const { token } = await createInvite();
    const { app, seen } = buildApp();

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "teammate@example.com", name: "T", password: "x", inviteToken: token });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("accepts the invite token delivered by the invite-landing cookie", async () => {
    // This is the transport that survives the OAuth round trip; the email
    // path uses it too when the body field is absent.
    const { token } = await createInvite();
    const { app, seen } = buildApp();

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Cookie", `${INVITE_TOKEN_COOKIE_NAME}=${token}`)
      .send({ email: "teammate@example.com", name: "T", password: "x" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("strips inviteToken from the body before the auth layer sees it", async () => {
    // Same contract as inviteCode: Better Auth does not model the field, and
    // the token is a credential that must not reach their handlers.
    const { token } = await createInvite();
    const { app, seen } = buildApp();

    await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "teammate@example.com", name: "T", password: "x", inviteToken: token });

    expect(seen[0]?.inviteToken).toBeUndefined();
    expect(seen[0]?.email).toBe("teammate@example.com");
  });

  it("claims the token to the signing-up email — a second email is refused", async () => {
    const { token } = await createInvite();
    const { app, seen } = buildApp();

    const first = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "first@example.com", name: "F", password: "x", inviteToken: token });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "second@example.com", name: "S", password: "x", inviteToken: token });

    expect(second.status).toBe(403);
    expect(seen).toHaveLength(1);

    const row = await inviteRow(token);
    expect(
      (row?.defaultsPayload as Record<string, unknown> | null)?.signupClaimedEmail,
    ).toBe("first@example.com");
  });

  it("lets the same email retry a failed sign-up against its own claim", async () => {
    const { token } = await createInvite();
    const { app } = buildApp();

    await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "teammate@example.com", name: "T", password: "x", inviteToken: token });
    const retry = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "Teammate@Example.com", name: "T", password: "x", inviteToken: token });

    expect(retry.status).toBe(200);
  });

  it("enforces the invite's own email binding when one is set", async () => {
    const { token } = await createInvite({ email: "bound@example.com" });
    const { app, seen } = buildApp();

    const wrong = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "other@example.com", name: "O", password: "x", inviteToken: token });
    expect(wrong.status).toBe(403);

    const right = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "Bound@Example.com", name: "B", password: "x", inviteToken: token });
    expect(right.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("refuses expired, revoked, already-accepted and agent-only invites", async () => {
    const { app, seen } = buildApp();
    const { token: expiredToken } = await createInvite();
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.tokenHash, hashToken(expiredToken)));

    const { token: revokedToken } = await createInvite();
    await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.tokenHash, hashToken(revokedToken)));

    const { token: acceptedToken } = await createInvite();
    await db
      .update(invites)
      .set({ acceptedAt: new Date() })
      .where(eq(invites.tokenHash, hashToken(acceptedToken)));

    const { token: agentToken } = await createInvite({ allowedJoinTypes: "agent" });

    for (const token of [expiredToken, revokedToken, acceptedToken, agentToken]) {
      const res = await request(app)
        .post("/api/auth/sign-up/email")
        .send({ email: "teammate@example.com", name: "T", password: "x", inviteToken: token });
      expect(res.status, `token ${token}`).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses an unknown or malformed token", async () => {
    const { app, seen } = buildApp();

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x", inviteToken: "pcp_invite_wrong" });

    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("still gives a missing token and a bad token the same refusal", async () => {
    const { app } = buildApp();

    const missing = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x" });
    const wrong = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x", inviteToken: "pcp_invite_wrong" });

    expect(missing.body).toEqual(wrong.body);
  });

  it("keeps sign-IN untouched when the token path is wired", async () => {
    const { token } = await createInvite();
    const { app, seen } = buildApp();

    const res = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "a@b.com", password: "x", inviteToken: token });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("fails closed when no db handle is wired (legacy callers)", async () => {
    const { token } = await createInvite();
    const { app, seen } = buildApp(false);

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x", inviteToken: token });

    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  // AgentDash (#731): the MCP self-serve sign-up reads the same local gate —
  // a pending company-invite token is an alternative credential to the shared
  // instance codes, and it is NOT forwarded to the remote funnel validator.
  describe("MCP signup gate", () => {
    beforeEach(() => {
      process.env.AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE = "true";
      process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
      // Remote funnel validation would otherwise try to phone home; the token
      // path must not need it at all.
      process.env.AGENTDASH_INVITE_VALIDATION = "off";
    });

    afterEach(async () => {
      await truncateWithRetry(db, sql`${boardApiKeys}, ${instanceUserRoles}, ${authUsers}`);
    });

    function buildMcpApp() {
      const app = express();
      app.use(express.json());
      app.use(
        "/api/onboarding",
        onboardingMcpSignupRoutes(db, {
          deploymentMode: "authenticated",
          createUser: async ({ name, email }) => {
            const id = crypto.randomUUID();
            await db.insert(authUsers).values({
              id,
              name,
              email,
              emailVerified: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            return { userId: id };
          },
        }),
      );
      app.use(errorHandler);
      return app;
    }

    it("accepts a pending company invite token and creates the founding user", async () => {
      const { token } = await createInvite();
      const res = await request(buildMcpApp())
        .post("/api/onboarding/mcp-signup")
        .send({ email: "founder@example.com", name: "Founder", inviteToken: token });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.email).toBe("founder@example.com");
      expect(res.body.apiKey).toBeTruthy();
    });

    it("refuses a second sign-up claiming the same token to another email", async () => {
      const { token } = await createInvite();
      const app = buildMcpApp();

      const first = await request(app)
        .post("/api/onboarding/mcp-signup")
        .send({ email: "first@example.com", name: "First", inviteToken: token });
      expect(first.status, JSON.stringify(first.body)).toBe(201);

      const second = await request(app)
        .post("/api/onboarding/mcp-signup")
        .send({ email: "second@example.com", name: "Second", inviteToken: token });
      // The token is claimed to first@, so the gate refuses before the
      // founding-only 409 even gets a say.
      expect(second.status).toBe(403);
      expect(second.body.code).toBe("invite_code_required");
    });

    it("still refuses sign-up with neither code nor token", async () => {
      const res = await request(buildMcpApp())
        .post("/api/onboarding/mcp-signup")
        .send({ email: "founder@example.com", name: "Founder" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("invite_code_required");
    });
  });
});
