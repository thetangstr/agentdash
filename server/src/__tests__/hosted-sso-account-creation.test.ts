// AgentDash (#726): on a hosted box, Google/Microsoft sign-in must not create
// accounts. Neither sign-up gate sees SSO (the invite-code guard runs only on
// /api/auth/sign-up/*, PAPERCLIP_AUTH_DISABLE_SIGN_UP only covers email), and
// with self-serve bootstrap the first stranger to create a company becomes
// instance admin.
//
// This drives a REAL Better Auth instance (createBetterAuthInstance) against
// embedded Postgres through the Google id-token sign-in path — the path that
// ignores a provider's `disableSignUp` in Better Auth 1.6.x — with the token
// verification stubbed so no network call is made.
//
// AgentDash (#731): the only exception is a pending company invite, carried
// through sign-in in the `agentdash_invite_token` cookie that GET
// /api/invites/:token sets. The user-create hook is now the single uniform
// gate — the provider-level disableSignUp flag was removed because the OAuth
// callback honours it before the hook could read the invite claim.

import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authUsers, companies, createDb, invites } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { INVITE_TOKEN_COOKIE_NAME } from "../lib/signup-gate.js";
import { inviteService } from "../services/invites.js";

vi.mock("../auth/social-providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/social-providers.js")>();
  return {
    ...actual,
    // The real provider config (including hosted `disableSignUp`), plus a
    // stubbed id-token check: the token string is the email to sign in as.
    buildSocialProviders: (env?: Record<string, string | undefined>) => {
      const providers = actual.buildSocialProviders(env);
      if (providers.google) {
        providers.google = {
          ...(providers.google as object),
          verifyIdToken: async () => true,
          getUserInfo: async (token: { idToken?: string }) => ({
            user: {
              id: `google-${token.idToken}`,
              email: token.idToken,
              name: "SSO Person",
              emailVerified: true,
            },
            data: {},
          }),
        };
      }
      return providers;
    },
  };
});

import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  refuseUngatedUserCreation,
} from "../auth/better-auth.js";
import { buildSocialProviders } from "../auth/social-providers.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const ENV_KEYS = [
  "AGENTDASH_DEPLOYMENT_KIND",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "PAPERCLIP_PUBLIC_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv() {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.BETTER_AUTH_SECRET = "hosted-sso-test-secret-0123456789abcdef";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  delete process.env.PAPERCLIP_PUBLIC_URL;
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function setHosted(on: boolean) {
  if (on) process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
  else delete process.env.AGENTDASH_DEPLOYMENT_KIND;
}

describe("hosted SSO account-creation policy (#726)", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("leaves provider-level disableSignUp unset — the user-create hook is the uniform gate", () => {
    // #731: a provider-level flag fires before the hook could read the
    // company-invite cookie, so it is deliberately absent on hosted boxes too.
    const env = {
      AGENTDASH_DEPLOYMENT_KIND: "hosted",
      GOOGLE_CLIENT_ID: "g",
      GOOGLE_CLIENT_SECRET: "gs",
      MICROSOFT_CLIENT_ID: "m",
      MICROSOFT_CLIENT_SECRET: "ms",
    };
    const providers = buildSocialProviders(env) as Record<string, { disableSignUp?: boolean }>;
    expect(providers.google?.disableSignUp).toBeUndefined();
    expect(providers.microsoft?.disableSignUp).toBeUndefined();
  });

  it("refuses user creation from the OAuth callback and social sign-in on a hosted box", async () => {
    setHosted(true);
    await expect(refuseUngatedUserCreation({ path: "/callback/:id" })).rejects.toThrow(/single sign-on is disabled/);
    await expect(refuseUngatedUserCreation({ path: "/sign-in/social" })).rejects.toThrow(/single sign-on is disabled/);
    await expect(refuseUngatedUserCreation({ path: "/sign-up/email" })).resolves.toBeUndefined();
    await expect(refuseUngatedUserCreation(null)).resolves.toBeUndefined();
  });

  it("changes nothing off hosted boxes", async () => {
    setHosted(false);
    await expect(refuseUngatedUserCreation({ path: "/callback/:id" })).resolves.toBeUndefined();
  });
});

describeEmbeddedPostgres("hosted SSO account creation against a real Better Auth (#726)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hosted-sso-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  let companyId = "";

  beforeEach(async () => {
    saveEnv();
    companyId = crypto.randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Invite Co",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
  });

  afterEach(async () => {
    restoreEnv();
    await truncateWithRetry(db, sql`${invites}, ${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function buildApp() {
    const auth = createBetterAuthInstance(
      db,
      {
        authBaseUrlMode: "explicit",
        authPublicBaseUrl: "http://127.0.0.1:3100",
        authDisableSignUp: false,
      } as Parameters<typeof createBetterAuthInstance>[1],
      ["http://127.0.0.1:3100"],
    );
    const app = express();
    app.use(express.json());
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    return app;
  }

  function googleSignIn(app: express.Express, email: string, inviteToken?: string) {
    const req = request(app)
      .post("/api/auth/sign-in/social")
      .set("Origin", "http://127.0.0.1:3100");
    if (inviteToken) req.set("Cookie", `${INVITE_TOKEN_COOKIE_NAME}=${inviteToken}`);
    return req.send({ provider: "google", idToken: { token: email } });
  }

  async function createInvite(opts: { email?: string } = {}) {
    return inviteService(db).createCompanyInvite({
      companyId,
      invitedByUserId: "admin-user",
      ...opts,
    });
  }

  async function userCount(email: string) {
    return db.select().from(authUsers).where(eq(authUsers.email, email)).then((rows) => rows.length);
  }

  it("refuses to create an account through Google sign-in on a hosted box", async () => {
    setHosted(true);
    const res = await googleSignIn(buildApp(), "stranger@example.com");

    expect(res.status, JSON.stringify(res.body)).not.toBe(200);
    expect(await userCount("stranger@example.com")).toBe(0);
  });

  it("still lets an existing SSO user sign in on a hosted box", async () => {
    setHosted(false);
    const first = await googleSignIn(buildApp(), "member@example.com");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await userCount("member@example.com")).toBe(1);

    setHosted(true);
    const again = await googleSignIn(buildApp(), "member@example.com");
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.user?.email).toBe("member@example.com");
    expect(await userCount("member@example.com")).toBe(1);
  });

  it("still creates accounts through Google sign-in off hosted boxes", async () => {
    setHosted(false);
    const res = await googleSignIn(buildApp(), "self-hoster@example.com");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await userCount("self-hoster@example.com")).toBe(1);
  });

  it("still allows gated email sign-up on a hosted box", async () => {
    setHosted(true);
    const res = await request(buildApp())
      .post("/api/auth/sign-up/email")
      .set("Origin", "http://127.0.0.1:3100")
      .send({ email: "invited@example.com", password: "a-long-enough-password-1", name: "Invited" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await userCount("invited@example.com")).toBe(1);
  });

  it("creates an SSO account on a hosted box when the invite cookie is present (#731)", async () => {
    setHosted(true);
    const { token } = await createInvite();
    const res = await googleSignIn(buildApp(), "invited@example.com", token);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await userCount("invited@example.com")).toBe(1);
  });

  it("claims the invite single-use — a second SSO email is refused", async () => {
    setHosted(true);
    const { token } = await createInvite();
    const app = buildApp();

    const first = await googleSignIn(app, "first@example.com", token);
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const second = await googleSignIn(app, "second@example.com", token);
    expect(second.status, JSON.stringify(second.body)).not.toBe(200);
    expect(await userCount("second@example.com")).toBe(0);
  });

  it("enforces the invite's email binding over SSO too", async () => {
    setHosted(true);
    const { token } = await createInvite({ email: "bound@example.com" });
    const res = await googleSignIn(buildApp(), "other@example.com", token);

    expect(res.status, JSON.stringify(res.body)).not.toBe(200);
    expect(await userCount("other@example.com")).toBe(0);
  });

  it("still refuses a stranger with no invite cookie on a hosted box", async () => {
    setHosted(true);
    await createInvite(); // a pending invite exists — just not in this request
    const res = await googleSignIn(buildApp(), "stranger@example.com");

    expect(res.status, JSON.stringify(res.body)).not.toBe(200);
    expect(await userCount("stranger@example.com")).toBe(0);
  });
});
