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
// GH #743 review/re-review: the gate RESERVES, it does not claim — an
// atomic CAS writes signupReservedEmail + a 2-minute TTL before any user
// exists, so N parallel sign-ups on one token can no longer all land. The
// token is bound to the email only once the account actually exists —
// the user.create.after hook writes defaultsPayload.signupClaimedEmail
// via a CAS update — and the reservation is released when the sign-up
// fails, so a failed attempt cannot burn or park the invite.

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
import {
  claimInviteSignupAfterCreate,
  createBetterAuthHandler,
  createBetterAuthInstance,
} from "../auth/better-auth.js";
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
  "BETTER_AUTH_SECRET",
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

  /**
   * Mounts the guard exactly where app.ts does: in front of the auth router.
   * The stub stands in for Better Auth and emulates what the real endpoint
   * does on a successful user create — the GH #743 claim-after-create step
   * (claimInviteSignupAfterCreate) — so the single-use claim is exercised
   * through the same code path production uses. `failSignupFor` makes the
   * stub refuse that email before "creating" it, proving a failed sign-up
   * cannot burn the token.
   */
  function buildApp(opts: {
    withDb?: boolean;
    inviteOnly?: boolean;
    failSignupFor?: string;
  } = {}) {
    const seen: Array<Record<string, unknown>> = [];
    const clearingCookies: string[][] = [];
    const app = express();
    app.use(express.json());
    app.use("/api/auth", inviteCodeSignupGuard({
      enabled: true,
      inviteOnly: opts.inviteOnly ?? false,
      ...(opts.withDb === false ? {} : { db }),
    }));
    app.use("/api/auth", async (req, res) => {
      // Stands in for Better Auth: records what actually reached it.
      seen.push({ ...(req.body as Record<string, unknown>) });
      if (opts.failSignupFor && (req.body as { email?: string }).email === opts.failSignupFor) {
        res.status(400).json({ error: "sign-up failed before user create" });
        return;
      }
      const responseHeaders = new Headers();
      await claimInviteSignupAfterCreate(
        { headers: req.headers, responseHeaders },
        { db, email: (req.body as { email?: string }).email },
      );
      const cookies = responseHeaders.getSetCookie();
      clearingCookies.push(cookies);
      for (const cookie of cookies) res.append("Set-Cookie", cookie);
      res.status(200).json({ ok: true });
    });
    return { app, seen, clearingCookies };
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

  /** Poll until `check` holds — the reservation release is intentionally
   * fire-and-forget off the response lifecycle, so tests must wait for the
   * write rather than assume it landed. */
  async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await check()).toBe(true);
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

  it("a sign-up that fails before user create does not burn the token", async () => {
    // GH #743 review/re-review: claiming happens in user.create.after and
    // the reservation releases on a failed response, so a token that
    // passed the gate but never produced an account stays spendable — by a
    // DIFFERENT email, even (the claim belongs to whoever lands the account).
    const { token } = await createInvite();
    const { app, seen } = buildApp({ failSignupFor: "burned@example.com" });

    const failed = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "burned@example.com", name: "B", password: "x", inviteToken: token });
    expect(failed.status).toBe(400);
    expect(seen).toHaveLength(1); // reached the auth layer; no user created

    // The failed response released the reservation — wait for the
    // fire-and-forget write rather than racing it.
    await waitFor(async () => {
      const payload =
        ((await inviteRow(token))?.defaultsPayload as Record<string, unknown> | null) ?? {};
      return !("signupClaimedEmail" in payload) && !("signupReservedEmail" in payload);
    });

    const retry = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "teammate@example.com", name: "T", password: "x", inviteToken: token });
    expect(retry.status).toBe(200);
    expect(
      ((await inviteRow(token))?.defaultsPayload as Record<string, unknown>)
        ?.signupClaimedEmail,
    ).toBe("teammate@example.com");
  });

  it("admits only one of several parallel sign-ups on the same token", async () => {
    // GH #743 re-review blocker: the read-only check let every concurrent
    // sign-up through. The reservation CAS is serialized by the row lock —
    // exactly one request holds the token; the rest get the same refusal
    // as a bad credential.
    const { token } = await createInvite();
    const { app, seen } = buildApp();

    const results = await Promise.all(
      ["one", "two", "three", "four"].map((name) =>
        request(app)
          .post("/api/auth/sign-up/email")
          .send({
            email: `${name}@example.com`,
            name,
            password: "x",
            inviteToken: token,
          }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 403, 403, 403]);
    expect(seen).toHaveLength(1);
    const payload =
      ((await inviteRow(token))?.defaultsPayload as Record<string, unknown>) ?? {};
    expect(payload.signupClaimedEmail).toBe(
      (seen[0] as { email?: string }).email,
    );
  });

  it("lets a different email take over once an abandoned reservation expires", async () => {
    // A browser that closed mid-sign-up holds the token for nobody — the
    // TTL, not a manual reset, frees it.
    const { token } = await createInvite();
    await db
      .update(invites)
      .set({
        defaultsPayload: {
          signupReservedEmail: "gone@example.com",
          signupReservedUntil: new Date(Date.now() - 60_000).toISOString(),
        },
      })
      .where(eq(invites.tokenHash, hashToken(token)));

    const { app } = buildApp();
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "teammate@example.com", name: "T", password: "x", inviteToken: token });

    expect(res.status).toBe(200);
  });

  it("blocks a different email while a live reservation is held", async () => {
    const { token } = await createInvite();
    await db
      .update(invites)
      .set({
        defaultsPayload: {
          signupReservedEmail: "inflight@example.com",
          signupReservedUntil: new Date(Date.now() + 60_000).toISOString(),
        },
      })
      .where(eq(invites.tokenHash, hashToken(token)));

    const { app, seen } = buildApp();
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "other@example.com", name: "O", password: "x", inviteToken: token });

    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("expires the invite cookie on the successful sign-up response", async () => {
    const { token } = await createInvite();
    const { app, clearingCookies } = buildApp();

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Cookie", `${INVITE_TOKEN_COOKIE_NAME}=${token}`)
      .send({ email: "teammate@example.com", name: "T", password: "x" });

    expect(res.status).toBe(200);
    expect(clearingCookies.flat().join(";")).toContain(`${INVITE_TOKEN_COOKIE_NAME}=`);
    expect(clearingCookies.flat().join(";")).toContain("Max-Age=0");
    const setCookies = res.headers["set-cookie"] as unknown as string[] | string;
    expect([setCookies].flat().join(";")).toContain(`${INVITE_TOKEN_COOKIE_NAME}=`);
  });

  it("fails closed when no db handle is wired (legacy callers)", async () => {
    const { token } = await createInvite();
    const { app, seen } = buildApp({ withDb: false });

    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ email: "a@b.com", name: "A", password: "x", inviteToken: token });

    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  // GH #743 review (HIGH-1): PAPERCLIP_AUTH_DISABLE_SIGN_UP means CLOSED —
  // the box runs inviteOnly, where only a pending company invite opens
  // sign-up and the shared instance codes deliberately do not.
  describe("inviteOnly mode (signup-disabled box)", () => {
    it("admits a pending invite token but refuses the shared code", async () => {
      const { token } = await createInvite();
      const { app, seen } = buildApp({ inviteOnly: true });

      const code = await request(app)
        .post("/api/auth/sign-up/email")
        .send({ email: "a@b.com", name: "A", password: "x", inviteCode: "GENERAL-CODE" });
      expect(code.status).toBe(403);

      const invited = await request(app)
        .post("/api/auth/sign-up/email")
        .send({ email: "a@b.com", name: "A", password: "x", inviteToken: token });
      expect(invited.status).toBe(200);
      expect(seen).toHaveLength(1);
    });

    it("admits the cookie-delivered token and refuses bare strangers", async () => {
      const { token } = await createInvite();
      const { app } = buildApp({ inviteOnly: true });

      const bare = await request(app)
        .post("/api/auth/sign-up/email")
        .send({ email: "a@b.com", name: "A", password: "x" });
      expect(bare.status).toBe(403);

      const invited = await request(app)
        .post("/api/auth/sign-up/email")
        .set("Cookie", `${INVITE_TOKEN_COOKIE_NAME}=${token}`)
        .send({ email: "a@b.com", name: "A", password: "x" });
      expect(invited.status).toBe(200);
    });
  });

  // GH #743 review (HIGH-1): the same closed box against a REAL Better Auth
  // instance — the endpoint must still exist (disableSignUp stays off) so an
  // invited teammate can create the account their invite promises.
  describe("closed box against real Better Auth (#743)", () => {
    beforeEach(() => {
      process.env.BETTER_AUTH_SECRET = "invite-gate-test-secret-0123456789abcdef";
    });

    afterEach(async () => {
      await truncateWithRetry(db, sql`${authUsers}`);
    });

    function buildClosedApp() {
      const auth = createBetterAuthInstance(
        db,
        {
          authBaseUrlMode: "explicit",
          authPublicBaseUrl: "http://127.0.0.1:3100",
          // The production flag — wired through so the config shape mirrors
          // the hosted box even though BA's internal flag stays off.
          authDisableSignUp: true,
        } as Parameters<typeof createBetterAuthInstance>[1],
        ["http://127.0.0.1:3100"],
      );
      const app = express();
      app.use(express.json());
      app.use("/api/auth", inviteCodeSignupGuard({
        enabled: false,
        inviteOnly: true,
        db,
      }));
      app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
      return app;
    }

    it("admits email sign-up carrying a valid invite while sign-up is disabled", async () => {
      const { token } = await createInvite();
      const res = await request(buildClosedApp())
        .post("/api/auth/sign-up/email")
        .set("Origin", "http://127.0.0.1:3100")
        .send({
          email: "invited@example.com",
          name: "Invited",
          password: "a-long-enough-password-1",
          inviteToken: token,
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const rows = await db.select().from(authUsers).where(eq(authUsers.email, "invited@example.com"));
      expect(rows).toHaveLength(1);
      // The create.after hook claimed the token to the created email…
      expect(
        ((await inviteRow(token))?.defaultsPayload as Record<string, unknown>)
          ?.signupClaimedEmail,
      ).toBe("invited@example.com");
      // …and expired the invite cookie on the response.
      const setCookies = res.headers["set-cookie"] as unknown as string[] | string;
      expect([setCookies].flat().join(";")).toContain(`${INVITE_TOKEN_COOKIE_NAME}=`);
    });

    it("refuses sign-up with no credential while sign-up is disabled", async () => {
      const res = await request(buildClosedApp())
        .post("/api/auth/sign-up/email")
        .set("Origin", "http://127.0.0.1:3100")
        .send({
          email: "stranger@example.com",
          name: "Stranger",
          password: "a-long-enough-password-1",
        });

      expect(res.status).toBe(403);
      expect(
        await db.select().from(authUsers).where(eq(authUsers.email, "stranger@example.com")),
      ).toHaveLength(0);
    });

    it("a failed sign-up does not burn the invite token", async () => {
      const { token } = await createInvite();
      const app = buildClosedApp();

      // Better Auth rejects the short password BEFORE creating the user —
      // the token must survive that attempt unclaimed, and the failed
      // response releases the gate's reservation.
      const failed = await request(app)
        .post("/api/auth/sign-up/email")
        .set("Origin", "http://127.0.0.1:3100")
        .send({
          email: "burned@example.com",
          name: "Burned",
          password: "x",
          inviteToken: token,
        });
      expect(failed.status).not.toBe(200);
      await waitFor(async () => {
        const payload =
          ((await inviteRow(token))?.defaultsPayload as Record<string, unknown> | null) ?? {};
        return !("signupClaimedEmail" in payload) && !("signupReservedEmail" in payload);
      });

      const retry = await request(app)
        .post("/api/auth/sign-up/email")
        .set("Origin", "http://127.0.0.1:3100")
        .send({
          email: "teammate@example.com",
          name: "Teammate",
          password: "a-long-enough-password-1",
          inviteToken: token,
        });
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(
        ((await inviteRow(token))?.defaultsPayload as Record<string, unknown>)
          ?.signupClaimedEmail,
      ).toBe("teammate@example.com");
    });

    it("admits exactly one of several parallel sign-ups on one invite", async () => {
      // GH #743 re-review blocker — the reviewer's probe: four concurrent
      // email sign-ups on one token produced four users. The reservation
      // CAS (row-lock serialized) now lets exactly one through the gate.
      const { token } = await createInvite();
      const app = buildClosedApp();

      const results = await Promise.all(
        ["one", "two", "three", "four"].map((name) =>
          request(app)
            .post("/api/auth/sign-up/email")
            .set("Origin", "http://127.0.0.1:3100")
            .send({
              email: `${name}@example.com`,
              name,
              password: "a-long-enough-password-1",
              inviteToken: token,
            }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 200);
      expect(
        results.map((r) => r.status).sort(),
        results.map((r) => `${r.status}: ${JSON.stringify(r.body)}`).join("\n"),
      ).toEqual([200, 403, 403, 403]);
      const created = await db.select().from(authUsers);
      expect(created).toHaveLength(1);
      expect(created[0]?.email).toBe(
        (succeeded[0]?.body as { user?: { email?: string } })?.user?.email ??
          created[0]?.email,
      );
      expect(
        ((await inviteRow(token))?.defaultsPayload as Record<string, unknown>)
          ?.signupClaimedEmail,
      ).toBe(created[0]?.email);
    });
  });

  // GH #743 review (HIGH-2): MCP self-serve sign-up mints the founding
  // instance_admin — a company invite must NEVER open it. Only the shared
  // instance codes may pass the local gate.
  describe("MCP signup gate", () => {
    beforeEach(() => {
      process.env.AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE = "true";
      process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
      // Remote funnel validation would otherwise try to phone home.
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

    it("refuses a company invite token — it cannot mint the founding admin", async () => {
      const { token } = await createInvite();
      const res = await request(buildMcpApp())
        .post("/api/onboarding/mcp-signup")
        .send({ email: "founder@example.com", name: "Founder", inviteToken: token });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invite_token_not_allowed");
      expect(
        await db.select().from(authUsers).where(eq(authUsers.email, "founder@example.com")),
      ).toHaveLength(0);
    });

    it("still accepts the shared invite code and creates the founding user", async () => {
      const res = await request(buildMcpApp())
        .post("/api/onboarding/mcp-signup")
        .send({ email: "founder@example.com", name: "Founder", inviteCode: "GENERAL-CODE" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.email).toBe("founder@example.com");
      expect(res.body.apiKey).toBeTruthy();
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
