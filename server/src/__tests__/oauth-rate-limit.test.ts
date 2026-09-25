import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOAuthEndpointRateLimiter } from "../middleware/rate-limit.js";
import { errorHandler } from "../middleware/index.js";

/**
 * GH #688 M4: the OAuth AS endpoints' rate limiting is scoped and keyed
 * correctly.
 *
 *  - Scoped: the limiters hang off the oauth router's own routes, so an
 *    anonymous request to an UNRELATED path is never metered (the previous
 *    blanket router.use covered the whole app root — SPA pages included).
 *  - Keyed: /oauth/token limits by client_id + IP, because a shared-egress
 *    client population (Muse via Meta) must not share one IP bucket.
 *
 * The factories no-op under NODE_ENV=test, so this suite stubs it to
 * "production" and drives the real express-rate-limit handlers through
 * supertest. `trust proxy: "loopback"` lets X-Forwarded-For simulate
 * different source IPs from the loopback supertest client.
 */

function miniApp(limiter: ReturnType<typeof createOAuthEndpointRateLimiter>): Express {
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.post("/oauth/token", limiter, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe("OAuth endpoint rate limiting (GH #688)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("limits repeated hits past the configured max", async () => {
    vi.stubEnv("AGENTDASH_RATE_LIMIT_TEST_MAX", "2");
    const app = miniApp(
      createOAuthEndpointRateLimiter({
        deploymentMode: "authenticated",
        envKey: "AGENTDASH_RATE_LIMIT_TEST_MAX",
        defaultMax: 2,
      }),
    );
    expect((await request(app).post("/oauth/token").send({})).status).toBe(200);
    expect((await request(app).post("/oauth/token").send({})).status).toBe(200);
    const third = await request(app).post("/oauth/token").send({});
    expect(third.status).toBe(429);
  });

  it("is a no-op in local_trusted deployments and when disabled by env", async () => {
    const localTrusted = miniApp(
      createOAuthEndpointRateLimiter({
        deploymentMode: "local_trusted",
        envKey: "AGENTDASH_RATE_LIMIT_TEST_MAX",
        defaultMax: 1,
      }),
    );
    for (let i = 0; i < 5; i++) {
      expect((await request(localTrusted).post("/oauth/token").send({})).status).toBe(200);
    }
    vi.stubEnv("AGENTDASH_RATE_LIMIT_DISABLED", "true");
    const disabled = miniApp(
      createOAuthEndpointRateLimiter({
        deploymentMode: "authenticated",
        envKey: "AGENTDASH_RATE_LIMIT_TEST_MAX",
        defaultMax: 1,
      }),
    );
    for (let i = 0; i < 5; i++) {
      expect((await request(disabled).post("/oauth/token").send({})).status).toBe(200);
    }
  });

  it("keys /oauth/token buckets by client_id + IP — shared egress does not share a bucket", async () => {
    vi.stubEnv("AGENTDASH_RATE_LIMIT_TEST_MAX", "1");
    const app = miniApp(
      createOAuthEndpointRateLimiter({
        deploymentMode: "authenticated",
        envKey: "AGENTDASH_RATE_LIMIT_TEST_MAX",
        defaultMax: 1,
        keyByClientId: true,
      }),
    );
    // Same IP, two client_ids — the Muse-over-Meta-egress case: each client
    // gets its own bucket even though every request shares the source IP.
    expect(
      (await request(app).post("/oauth/token").send({ client_id: "muse" })).status,
    ).toBe(200);
    expect(
      (await request(app).post("/oauth/token").send({ client_id: "dcr_other" })).status,
    ).toBe(200);
    // Second hit for the same client_id+IP is the one that limits.
    expect(
      (await request(app).post("/oauth/token").send({ client_id: "muse" })).status,
    ).toBe(429);
    // And a different IP for the same client_id is a fresh bucket.
    expect(
      (
        await request(app)
          .post("/oauth/token")
          .set("X-Forwarded-For", "198.51.100.9")
          .send({ client_id: "muse" })
      ).status,
    ).toBe(200);
  });

  it("a missing client_id still gets a stable bucket", async () => {
    vi.stubEnv("AGENTDASH_RATE_LIMIT_TEST_MAX", "1");
    const app = miniApp(
      createOAuthEndpointRateLimiter({
        deploymentMode: "authenticated",
        envKey: "AGENTDASH_RATE_LIMIT_TEST_MAX",
        defaultMax: 1,
        keyByClientId: true,
      }),
    );
    expect((await request(app).post("/oauth/token").send({})).status).toBe(200);
    expect((await request(app).post("/oauth/token").send({})).status).toBe(429);
  });
});

/**
 * Route scoping is an app-shape property: hammering an unrelated path must
 * never produce a 429 even with the limiters live.
 */
describe("OAuth limiter route scope", () => {
  let app: Express;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENTDASH_RATE_LIMIT_OAUTH_META_MAX", "3");
    app = express();
    app.use(express.json());
    // Stand-in for the real router's mounting shape: limiters sit ON the
    // OAuth routes, not on a router.use() that would swallow the app root.
    app.get(
      "/.well-known/oauth-authorization-server",
      createOAuthEndpointRateLimiter({
        deploymentMode: "authenticated",
        envKey: "AGENTDASH_RATE_LIMIT_OAUTH_META_MAX",
        defaultMax: 200,
      }),
      (_req, res) => res.json({ ok: true }),
    );
    app.get("/other", (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("limits the metered OAuth path but never the unrelated one", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get("/.well-known/oauth-authorization-server")).status).toBe(200);
    }
    expect((await request(app).get("/.well-known/oauth-authorization-server")).status).toBe(429);
    // The unrelated anonymous route was never metered at all.
    for (let i = 0; i < 6; i++) {
      expect((await request(app).get("/other")).status).toBe(200);
    }
  });
});
