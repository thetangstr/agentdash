import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Config } from "../config.js";
import {
  createSchemeAwareBetterAuth,
  createSchemeAwareBetterAuthHandler,
  requestSchemeFromHeaders,
  resolveAuthTrustedOrigins,
  tlsDoorServedAsHttp,
} from "../auth/better-auth.js";
import { resolveOriginSettings, type OriginEnv } from "../lib/declared-origins.js";

// AgentDash (#547): Secure cookies follow the door a request came through,
// not the canonical URL's scheme. Exercised end to end through Better Auth's
// real handler: `POST /sign-out` with no session touches no database and
// answers with the instance's own session-cookie names and attributes.

const ENV_KEYS = [
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_CANONICAL_ORIGIN",
  "PAPERCLIP_ORIGINS",
] as const;
const saved = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  process.env.BETTER_AUTH_SECRET = "declared-origins-cookie-test-secret-0123456789abcdef";
  process.env.PAPERCLIP_INSTANCE_ID = "cookie-test";
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function withEnv<T>(env: OriginEnv, fn: () => T): T {
  const before = new Map<string, string | undefined>();
  for (const key of ["PAPERCLIP_PUBLIC_URL", "PAPERCLIP_CANONICAL_ORIGIN", "PAPERCLIP_ORIGINS"]) {
    before.set(key, process.env[key]);
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function buildAuthApp(env: OriginEnv) {
  return withEnv(env, () => {
    const settings = resolveOriginSettings({ env });
    const config = {
      deploymentMode: "authenticated",
      port: 3102,
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: settings.authPublicBaseUrl,
      allowedHostnames: settings.allowedHostnames,
      ...(settings.declaredOrigins
        ? {
          canonicalOrigin: settings.canonicalOrigin,
          declaredOrigins: settings.declaredOrigins,
          trustedOriginPatterns: settings.trustedOriginPatterns,
        }
        : {}),
    } as Config;
    const trusted = resolveAuthTrustedOrigins(config, { listenPort: 3102, env });
    // Nothing on these paths reaches the database.
    const pair = createSchemeAwareBetterAuth({} as Db, config, trusted.origins);
    const app = express();
    // Same hop count app.ts sets in authenticated mode.
    app.set("trust proxy", 1);
    app.all("/api/auth/{*authPath}", createSchemeAwareBetterAuthHandler(pair));
    return { app, pair };
  });
}

function sessionCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = cookies.find((cookie) => /session_token=/.test(cookie));
  if (!match) throw new Error(`no session cookie in ${JSON.stringify(cookies)}`);
  return match;
}

describe("declared mode: secure cookies per door", () => {
  const env: OriginEnv = {
    PAPERCLIP_CANONICAL_ORIGIN: "http://agents.example.test:3102",
    PAPERCLIP_ORIGINS: "http://agents.example.test:3102,https://agents.example.test:3112",
  };

  it("sets Secure, __Secure- prefixed cookies on the TLS door even though the canonical is http", async () => {
    const { app } = buildAuthApp(env);

    const res = await request(app)
      .post("/api/auth/sign-out")
      .set("x-forwarded-proto", "https")
      .set("origin", "https://agents.example.test:3112")
      .send({});

    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/^__Secure-paperclip-cookie-test\.session_token=/);
    expect(cookie).toMatch(/;\s*Secure/i);
  });

  it("sets plain cookies without Secure on the plaintext door", async () => {
    const { app } = buildAuthApp(env);

    const res = await request(app)
      .post("/api/auth/sign-out")
      .set("origin", "http://agents.example.test:3102")
      .send({});

    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/^paperclip-cookie-test\.session_token=/);
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it("hands Better Auth the declared set as its trusted origins, on both instances", async () => {
    // Better Auth skips its Origin check under a test runner, so assert on
    // the list it enforces in production instead.
    const { pair } = buildAuthApp(env);
    for (const scheme of ["http", "https"] as const) {
      const ctx = await pair.forScheme(scheme).$context;
      expect(ctx.isTrustedOrigin("https://agents.example.test:3112")).toBe(true);
      expect(ctx.isTrustedOrigin("http://agents.example.test:3102")).toBe(true);
      // Not declared, so not trusted — the cross-product would have added it.
      expect(ctx.isTrustedOrigin("https://agents.example.test:3102")).toBe(false);
      expect(ctx.isTrustedOrigin("http://agents.example.test")).toBe(false);
    }
  });

  // GH #863 item 1 (verify SSO from an http door): the OAuth state cookie is
  // named per scheme like the session cookie, and the provider callback is
  // served by the canonical origin's instance. SSO started on a door of the
  // other scheme stores state under a name the callback never reads, so it
  // fails with Better Auth's state mismatch. Boot warns about this.
  it("names the OAuth state cookie per scheme, so SSO only completes from the canonical scheme", async () => {
    const { pair } = buildAuthApp(env);
    const secureCtx = await pair.forScheme("https").$context;
    const plainCtx = await pair.forScheme("http").$context;
    expect(secureCtx.createAuthCookie("state").name).toBe("__Secure-paperclip-cookie-test.state");
    expect(plainCtx.createAuthCookie("state").name).toBe("paperclip-cookie-test.state");
    // Callbacks land on the canonical (http here), whose instance reads the plain name.
    expect(pair.primary).toBe(pair.forScheme("http"));
  });

  it("an https canonical does not force Secure cookies onto the http door", async () => {
    const { app, pair } = buildAuthApp({
      PAPERCLIP_CANONICAL_ORIGIN: "https://agents.example.test",
      PAPERCLIP_ORIGINS: "https://agents.example.test,http://office.example.test:3102",
    });

    const res = await request(app)
      .post("/api/auth/sign-out")
      .set("origin", "http://office.example.test:3102")
      .send({});

    expect(res.status).toBe(200);
    expect(sessionCookie(res)).not.toMatch(/;\s*Secure/i);
    // Server-side calls use the canonical door's instance.
    expect(pair.primary).toBe(pair.forScheme("https"));
  });

  it("spots a TLS door the proxy reports as http", () => {
    const declared = ["https://agents.example.test", "https://agents.example.test:3112", "http://agents.example.test:3102"];
    const req = (host: string, protocol: string) => ({
      protocol,
      header: (name: string) => (name.toLowerCase() === "host" ? host : undefined),
    });

    expect(tlsDoorServedAsHttp(declared, req("agents.example.test:3112", "http"))).toBe("https://agents.example.test:3112");
    expect(tlsDoorServedAsHttp(declared, req("agents.example.test", "http"))).toBe("https://agents.example.test");
    // Correctly reported, or a declared plaintext door, or an unrelated host: nothing to say.
    expect(tlsDoorServedAsHttp(declared, req("agents.example.test:3112", "https"))).toBeNull();
    expect(tlsDoorServedAsHttp(declared, req("agents.example.test:3102", "http"))).toBeNull();
    expect(tlsDoorServedAsHttp(declared, req("other.example.test", "http"))).toBeNull();
  });

  it("reads the scheme of a header-only request (WebSocket upgrade) from X-Forwarded-Proto", () => {
    expect(requestSchemeFromHeaders(new Headers({ "x-forwarded-proto": "https, http" }))).toBe("https");
    expect(requestSchemeFromHeaders(new Headers({ "x-forwarded-proto": "http" }))).toBe("http");
    expect(requestSchemeFromHeaders(new Headers())).toBe("http");
  });
});

describe("legacy mode: one instance, cookie rule unchanged", () => {
  it("keeps Secure off on every door when PAPERCLIP_PUBLIC_URL is http://, as before", async () => {
    const env: OriginEnv = { PAPERCLIP_PUBLIC_URL: "http://agents.example.test:3102" };
    const { app, pair } = buildAuthApp(env);

    expect(pair.mode).toBe("legacy");
    expect(pair.forScheme("https")).toBe(pair.forScheme("http"));

    const res = await request(app)
      .post("/api/auth/sign-out")
      .set("x-forwarded-proto", "https")
      .set("origin", "https://agents.example.test:3102")
      .send({});

    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/^paperclip-cookie-test\.session_token=/);
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });
});
