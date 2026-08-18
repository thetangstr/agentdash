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
  app.post("/", (_req, res) => res.json({ ok: true }));
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

  it("auth limiter enforces tighter cap on auth mutations", async () => {
    delete process.env.NODE_ENV;
    process.env.AGENTDASH_RATE_LIMIT_DISABLED = "false";
    process.env.AGENTDASH_RATE_LIMIT_AUTH_MAX = "3";
    const { createAuthRateLimiter } = await loadFactories();
    const app = buildApp(createAuthRateLimiter());

    for (let i = 0; i < 3; i++) {
      const ok = await request(app).post("/").set("X-Forwarded-For", "10.0.0.1");
      expect(ok.status).toBe(200);
    }
    const blocked = await request(app).post("/").set("X-Forwarded-For", "10.0.0.1");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "Rate limited" });
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("auth safe reads do not consume the sign-in limiter", async () => {
    delete process.env.NODE_ENV;
    process.env.AGENTDASH_RATE_LIMIT_DISABLED = "false";
    process.env.AGENTDASH_RATE_LIMIT_AUTH_MAX = "1";
    const { createAuthRateLimiter } = await loadFactories();
    const app = buildApp(createAuthRateLimiter());

    for (let i = 0; i < 5; i++) {
      const read = await request(app).get("/").set("X-Forwarded-For", "10.0.0.5");
      expect(read.status).toBe(200);
    }

    const ok = await request(app).post("/").set("X-Forwarded-For", "10.0.0.5");
    expect(ok.status).toBe(200);
    const blocked = await request(app).post("/").set("X-Forwarded-For", "10.0.0.5");
    expect(blocked.status).toBe(429);
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

  it("local_trusted deployment bypasses rate limits for developer UAT", async () => {
    delete process.env.NODE_ENV;
    process.env.AGENTDASH_RATE_LIMIT_DISABLED = "false";
    process.env.AGENTDASH_RATE_LIMIT_API_MAX = "1";
    const { createDefaultApiRateLimiter } = await loadFactories();
    const app = buildApp(createDefaultApiRateLimiter({ deploymentMode: "local_trusted" }));

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/").set("X-Forwarded-For", "10.0.0.20");
      expect(res.status).toBe(200);
    }
  });

  it("authenticated deployment keeps rate limits enabled for mutations", async () => {
    delete process.env.NODE_ENV;
    process.env.AGENTDASH_RATE_LIMIT_DISABLED = "false";
    process.env.AGENTDASH_RATE_LIMIT_API_MAX = "1";
    const { createDefaultApiRateLimiter } = await loadFactories();
    const app = buildApp(createDefaultApiRateLimiter({ deploymentMode: "authenticated" }));

    const ok = await request(app).post("/").set("X-Forwarded-For", "10.0.0.21");
    expect(ok.status).toBe(200);
    const blocked = await request(app).post("/").set("X-Forwarded-For", "10.0.0.21");
    expect(blocked.status).toBe(429);
  });

  it.each(["board", "agent"] as const)(
    "authenticated %s safe reads bypass the default mutation limiter",
    async (actorType) => {
      delete process.env.NODE_ENV;
      process.env.AGENTDASH_RATE_LIMIT_DISABLED = "false";
      process.env.AGENTDASH_RATE_LIMIT_API_MAX = "1";
      const { createDefaultApiRateLimiter } = await loadFactories();

      const app = express();
      app.set("trust proxy", true);
      app.use((req, _res, next) => {
        (req as any).actor =
          actorType === "board"
            ? { type: "board", userId: "alice" }
            : { type: "agent", agentId: "agent-123", companyId: "company-123" };
        next();
      });
      app.use(createDefaultApiRateLimiter({ deploymentMode: "authenticated" }));
      app.get("/", (_req, res) => res.json({ ok: true }));

      for (let i = 0; i < 5; i++) {
        const res = await request(app).get("/").set("X-Forwarded-For", "10.0.0.22");
        expect(res.status).toBe(200);
      }
    },
  );

  it("unauthenticated safe reads still count against the default limiter", async () => {
    delete process.env.NODE_ENV;
    process.env.AGENTDASH_RATE_LIMIT_DISABLED = "false";
    process.env.AGENTDASH_RATE_LIMIT_API_MAX = "1";
    const { createDefaultApiRateLimiter } = await loadFactories();
    const app = buildApp(createDefaultApiRateLimiter({ deploymentMode: "authenticated" }));

    const ok = await request(app).get("/").set("X-Forwarded-For", "10.0.0.24");
    expect(ok.status).toBe(200);
    const blocked = await request(app).get("/").set("X-Forwarded-For", "10.0.0.24");
    expect(blocked.status).toBe(429);
  });

  it("health checks bypass the default limiter", async () => {
    delete process.env.NODE_ENV;
    process.env.AGENTDASH_RATE_LIMIT_DISABLED = "false";
    process.env.AGENTDASH_RATE_LIMIT_API_MAX = "1";
    const { createDefaultApiRateLimiter } = await loadFactories();

    const app = express();
    app.set("trust proxy", true);
    app.use(createDefaultApiRateLimiter({ deploymentMode: "authenticated" }));
    app.get("/health", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/health").set("X-Forwarded-For", "10.0.0.23");
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

/**
 * The bridge poll must not consume the mutation budget.
 *
 * The worker polls every 5 seconds. Over a 15-minute window that is 180
 * requests against a 200-request ceiling shared with everything else the same
 * actor does — so a laptop merely being connected spent 90% of its own quota,
 * and any real work tipped it into 429s. The reported symptom was "the
 * connection bumps all the time": the poll gets rate limited, the worker looks
 * disconnected, and nothing in the product explains why.
 *
 * The numbers below are deliberate rather than round. If someone later "fixes"
 * a rate-limit complaint by raising the ceiling, these still fail at whatever
 * the new poll cadence implies, which is the honest signal.
 */
describe("bridge poll is exempt from the mutation limiter", () => {
  const POLLS_PER_WINDOW = 180; // 15 min / 5 s

  /**
   * The actor auth.ts actually builds for a bridge credential.
   *
   * `type: "none"` is deliberate there — a bridge token must not satisfy any
   * ordinary guard — and this test previously stubbed `{ type: "agent" }`
   * instead, a shape production never produces for this route. The exemption
   * was keyed on type, so the test passed against an actor that could not
   * exist while every real laptop still collected 429s. Use the real shape.
   */
  const BRIDGE_ACTOR = {
    type: "none",
    companyId: "c1",
    bridgeEndpointId: "endpoint-1",
    source: "bridge_endpoint",
  };

  function buildBridgeApp(mw: express.RequestHandler, actor: unknown = BRIDGE_ACTOR): Express {
    const app = express();
    app.set("trust proxy", true);
    // The real stack resolves the actor before the limiter.
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use(mw);
    app.post("/bridge/poll", (_req, res) => res.json({ ok: true }));
    app.post("/bridge/result", (_req, res) => res.json({ ok: true }));
    app.post("/companies/c1/issues", (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("keeps polling past a ceiling that would otherwise stop it", async () => {
    // Ceiling deliberately BELOW the poll count. At the real 200 this assertion
    // could not fail — 180 polls never reach 200 — so the test would pass with
    // or without the exemption and prove nothing.
    process.env.NODE_ENV = "production";
    delete process.env.AGENTDASH_RATE_LIMIT_DISABLED;
    process.env.AGENTDASH_RATE_LIMIT_API_MAX = "50";
    const { createDefaultApiRateLimiter } = await loadFactories();
    const app = buildBridgeApp(createDefaultApiRateLimiter());

    for (let i = 0; i < POLLS_PER_WINDOW; i += 1) {
      const res = await request(app).post("/bridge/poll");
      expect(res.status, `poll ${i + 1} of ${POLLS_PER_WINDOW} was rate limited`).toBe(200);
    }
  });

  it("leaves the real mutation budget intact after a window of polling", async () => {
    // Scaled down deliberately. Proving this with 180 polls plus 30 mutations
    // meant 210 sequential HTTP calls, which turned out to be flaky under full
    // parallel-suite load ("socket hang up") — a volume problem, not a logic
    // one. The property is a ratio: polls must not consume the budget that real
    // work needs. A ceiling of 10 with 20 polls exercises the same relationship
    // (polls exceed the ceiling on their own) at a tenth of the cost.
    process.env.NODE_ENV = "production";
    delete process.env.AGENTDASH_RATE_LIMIT_DISABLED;
    process.env.AGENTDASH_RATE_LIMIT_API_MAX = "10";
    const { createDefaultApiRateLimiter } = await loadFactories();
    const app = buildBridgeApp(createDefaultApiRateLimiter());

    for (let i = 0; i < 20; i += 1) {
      await request(app).post("/bridge/poll");
    }
    // If polling counted, the budget of 10 is long gone and these all 429.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await request(app).post("/companies/c1/issues")).status);
    }
    expect(
      statuses.filter((code) => code === 429).length,
      "polling ate the mutation budget",
    ).toBe(0);
  });

  /**
   * The regression that made this whole block worthless: an actor with an
   * ordinary type must NOT be exempt on the poll path. Only an enrolled bridge
   * endpoint is, and the route rejects everyone else anyway.
   */
  it("does not exempt a non-endpoint actor on the poll path", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.AGENTDASH_RATE_LIMIT_DISABLED;
    process.env.AGENTDASH_RATE_LIMIT_API_MAX = "20";
    const { createDefaultApiRateLimiter } = await loadFactories();
    const app = buildBridgeApp(createDefaultApiRateLimiter(), { type: "agent", agentId: "agent-1" });

    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      statuses.push((await request(app).post("/bridge/poll")).status);
    }
    expect(
      statuses.filter((s) => s === 429).length,
      "an agent-typed actor should not inherit the endpoint exemption",
    ).toBeGreaterThan(0);
  });

  it("still limits the bridge calls that actually write", async () => {
    // /bridge/result and /bridge/decline change state. The exemption is for the
    // poll only — this is what stops it becoming a hole.
    process.env.NODE_ENV = "production";
    delete process.env.AGENTDASH_RATE_LIMIT_DISABLED;
    process.env.AGENTDASH_RATE_LIMIT_API_MAX = "5";
    const { createDefaultApiRateLimiter } = await loadFactories();
    const app = buildBridgeApp(createDefaultApiRateLimiter());

    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await request(app).post("/bridge/result")).status);
    }
    expect(statuses.filter((s) => s === 429).length, "bridge/result was not limited").toBeGreaterThan(0);
  });
});
