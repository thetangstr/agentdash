/**
 * AgentDash (#160): rate-limiter middleware tests.
 *
 * Note: NODE_ENV === "test" auto-disables limiters via isDisabled() in the
 * factory. We override that for these tests by setting AGENTDASH_RATE_LIMIT_*
 * env vars and re-importing the module via vi.resetModules. Each test sets
 * its own env state to keep cases isolated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const ORIG_ENV = { ...process.env };

afterEach(() => {
  // Restore env between tests
  process.env = { ...ORIG_ENV };
  vi.resetModules();
});

beforeEach(() => {
  vi.resetModules();
});

async function loadFactories() {
  return await import("../middleware/rate-limit.js");
}

function buildApp(mw: express.RequestHandler): Express {
  const app = express();
  app.set("trust proxy", true);
  app.use(mw);
  app.get("/", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("rate-limit middleware (#160)", () => {
  it("disabled in NODE_ENV=test by default — passes through unlimited", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.AGENTDASH_RATE_LIMIT_DISABLED;
    const { createDefaultApiRateLimiter } = await loadFactories();
    const app = buildApp(createDefaultApiRateLimiter());

    // Hit it 50 times — would blow any sane limit if active.
    for (let i = 0; i < 50; i++) {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
    }
  });

  it("auth limiter enforces tighter cap (configurable, set to 3 for test)", async () => {
    delete process.env.NODE_ENV;
    process.env.AGENTDASH_RATE_LIMIT_DISABLED = "false";
    process.env.AGENTDASH_RATE_LIMIT_AUTH_MAX = "3";
    const { createAuthRateLimiter } = await loadFactories();
    const app = buildApp(createAuthRateLimiter());

    for (let i = 0; i < 3; i++) {
      const ok = await request(app).get("/").set("X-Forwarded-For", "10.0.0.1");
      expect(ok.status).toBe(200);
    }
    const blocked = await request(app).get("/").set("X-Forwarded-For", "10.0.0.1");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "Rate limited" });
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("AGENTDASH_RATE_LIMIT_DISABLED=true bypasses entirely", async () => {
    delete process.env.NODE_ENV;
    process.env.AGENTDASH_RATE_LIMIT_DISABLED = "true";
    process.env.AGENTDASH_RATE_LIMIT_AUTH_MAX = "1";
    const { createAuthRateLimiter } = await loadFactories();
    const app = buildApp(createAuthRateLimiter());

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/").set("X-Forwarded-For", "10.0.0.2");
      expect(res.status).toBe(200);
    }
  });

  it("billing limiter enforces tighter cap (configurable, set to 2)", async () => {
    delete process.env.NODE_ENV;
    process.env.AGENTDASH_RATE_LIMIT_DISABLED = "false";
    process.env.AGENTDASH_RATE_LIMIT_BILLING_MAX = "2";
    const { createBillingRateLimiter } = await loadFactories();
    const app = buildApp(createBillingRateLimiter());

    for (let i = 0; i < 2; i++) {
      const ok = await request(app).get("/").set("X-Forwarded-For", "10.0.0.3");
      expect(ok.status).toBe(200);
    }
    const blocked = await request(app).get("/").set("X-Forwarded-For", "10.0.0.3");
    expect(blocked.status).toBe(429);
  });

  it("authenticated requests key on actor.userId, not IP", async () => {
    delete process.env.NODE_ENV;
    process.env.AGENTDASH_RATE_LIMIT_DISABLED = "false";
    process.env.AGENTDASH_RATE_LIMIT_API_MAX = "3";
    const { createDefaultApiRateLimiter } = await loadFactories();

    const app = express();
    app.set("trust proxy", true);
    // Stub actor middleware
    app.use((req, _res, next) => {
      const userHeader = req.header("x-test-user");
      if (userHeader) (req as any).actor = { userId: userHeader };
      next();
    });
    app.use(createDefaultApiRateLimiter());
    app.get("/", (_req, res) => res.json({ ok: true }));

    // Same IP, two different users — each gets their own quota
    for (let i = 0; i < 3; i++) {
      const a = await request(app).get("/").set("X-Forwarded-For", "10.0.0.4").set("X-Test-User", "alice");
      expect(a.status).toBe(200);
    }
    for (let i = 0; i < 3; i++) {
      const b = await request(app).get("/").set("X-Forwarded-For", "10.0.0.4").set("X-Test-User", "bob");
      expect(b.status).toBe(200);
    }
    // Alice's 4th request blocked
    const aliceBlocked = await request(app).get("/").set("X-Forwarded-For", "10.0.0.4").set("X-Test-User", "alice");
    expect(aliceBlocked.status).toBe(429);
  });
});
