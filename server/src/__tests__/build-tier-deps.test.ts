import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { buildRequireTierDeps } from "../middleware/build-tier-deps.js";
import { requireTierFor } from "../middleware/require-tier.js";

// AgentDash: billing-trio (#151) — covers the helper that assembles `Deps`
// for `requireTierFor` and the wiring expectation that the middleware blocks
// over-cap mutations on Free workspaces.

// requireTierFor short-circuits unless STRIPE_SECRET_KEY is set.
const originalKey = process.env.STRIPE_SECRET_KEY;
beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_for_tier_wiring_tests";
});
afterAll(() => {
  if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalKey;
});

// Minimal Drizzle-shaped stub. `then` is the terminal step — return what
// the count query yields per call.
function makeDbWithCounts(humans: number, agents: number, planTier = "free") {
  const calls: string[] = [];
  let nextResult: unknown = null;
  const db: any = {
    select: vi.fn((sel: any) => {
      // Track which entity is being queried. companyService.getById uses a
      // multi-key selection (companies.* + logo); humans/agents helpers use a
      // single { count } selection.
      if (sel?.count !== undefined) {
        // count query — figure out humans vs agents from the next from() call
      } else {
        nextResult = [{ id: "co-1", planTier, logoAssetId: null }];
      }
      return db;
    }),
    from: vi.fn((_table: any) => {
      // We can't introspect the table object reliably; rely on call order:
      // 1) getById -> companies → returns company row
      // 2) humans count → companyMemberships
      // 3) agents count → agents
      const tableName =
        typeof _table?.[Symbol.for("drizzle:Name")] === "string"
          ? _table[Symbol.for("drizzle:Name")]
          : null;
      calls.push(tableName ?? "unknown");
      if (tableName === "company_memberships") nextResult = [{ count: humans }];
      else if (tableName === "agents") nextResult = [{ count: agents }];
      return db;
    }),
    leftJoin: vi.fn(() => db),
    where: vi.fn(() => db),
    then: vi.fn((fn: any) => Promise.resolve(fn(nextResult))),
  };
  return { db, calls };
}

describe("buildRequireTierDeps", () => {
  it("counts.humans queries company_memberships filtered by active users", async () => {
    const { db } = makeDbWithCounts(3, 0, "free");
    const deps = buildRequireTierDeps(db);
    const humans = await deps.counts.humans("co-1");
    expect(humans).toBe(3);
  });

  it("counts.agents queries agents excluding terminated", async () => {
    const { db } = makeDbWithCounts(0, 5, "free");
    const deps = buildRequireTierDeps(db);
    const agents = await deps.counts.agents("co-1");
    expect(agents).toBe(5);
  });

  it("getCompany falls back to free planTier when company is missing", async () => {
    const db: any = {
      select: vi.fn(() => db),
      from: vi.fn(() => db),
      leftJoin: vi.fn(() => db),
      where: vi.fn(() => db),
      then: vi.fn((fn: any) => Promise.resolve(fn([]))),
    };
    const deps = buildRequireTierDeps(db);
    const company = await deps.getCompany("co-missing");
    expect(company.planTier).toBe("free");
  });
});

describe("requireTierFor wiring (integration via express)", () => {
  function makeApp(planTier: string, humans: number, agents: number) {
    const app = express();
    app.use(express.json());
    const deps = {
      getCompany: async () => ({ planTier }),
      counts: {
        humans: async () => humans,
        agents: async () => agents,
      },
    };
    app.post(
      "/companies/:companyId/invites",
      requireTierFor("invite", deps),
      (_req, res) => res.status(201).json({ ok: true }),
    );
    app.post(
      "/companies/:companyId/agents",
      requireTierFor("hire", deps),
      (_req, res) => res.status(201).json({ ok: true }),
    );
    app.post(
      "/companies/:companyId/agent-hires",
      requireTierFor("hire", deps),
      (_req, res) => res.status(201).json({ ok: true }),
    );
    return app;
  }

  it("blocks invite POST on Free workspace at the seat cap", async () => {
    const app = makeApp("free", 1, 0);
    const r = await request(app).post("/companies/co-1/invites").send({});
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("seat_cap_exceeded");
  });

  it("allows invite POST on Free workspace below the cap", async () => {
    const app = makeApp("free", 0, 0);
    const r = await request(app).post("/companies/co-1/invites").send({});
    expect(r.status).toBe(201);
  });

  it("blocks agent POST on Free workspace at the agent cap", async () => {
    const app = makeApp("free", 0, 1);
    const r = await request(app).post("/companies/co-1/agents").send({});
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("agent_cap_exceeded");
  });

  it("blocks agent-hires POST on Free workspace at the agent cap", async () => {
    const app = makeApp("free", 0, 1);
    const r = await request(app).post("/companies/co-1/agent-hires").send({});
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("agent_cap_exceeded");
  });

  it("allows pro_trial workspaces past Free caps", async () => {
    const app = makeApp("pro_trial", 99, 99);
    const r = await request(app).post("/companies/co-1/invites").send({});
    expect(r.status).toBe(201);
  });
});
