// AgentDash: Entitlements route — billing fields extension tests
// The GET /companies/:companyId/entitlements endpoint returns billing state
// (stripeCustomerId, subscriptionStatus, currentPeriodEnd) merged into the
// same response. The route delegates to entitlementsService.getEntitlements,
// which is the single source of truth for both entitlements and billing fields.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { entitlementsRoutes } from "../routes/entitlements.js";
import { errorHandler } from "../middleware/index.js";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const mockGetEntitlements = vi.fn();

vi.mock("../services/entitlements.js", () => ({
  entitlementsService: () => ({
    getTier: vi.fn(async () => "pro"),
    setTier: vi.fn(async () => undefined),
    getEntitlements: mockGetEntitlements,
  }),
}));

const baseEntitlements = {
  tier: "pro" as const,
  limits: { agents: 25, monthlyActions: 50_000, pipelines: 10 },
  features: { hubspotSync: true, autoResearch: true, assessMode: true, prioritySupport: false },
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", entitlementsRoutes({} as unknown as import("@agentdash/db").Db));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /companies/:companyId/entitlements — billing fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes stripeCustomerId, subscriptionStatus, currentPeriodEnd when plan row exists", async () => {
    const periodEnd = new Date("2026-06-30T00:00:00.000Z");
    mockGetEntitlements.mockResolvedValue({
      ...baseEntitlements,
      stripeCustomerId: "cus_test_abc",
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd.toISOString(),
    });

    const res = await request(createApp()).get("/api/companies/company-1/entitlements");

    expect(res.status).toBe(200);
    expect(res.body.stripeCustomerId).toBe("cus_test_abc");
    expect(res.body.subscriptionStatus).toBe("active");
    expect(res.body.currentPeriodEnd).toBe(periodEnd.toISOString());
  });

  it("returns null billing fields when no plan row exists", async () => {
    mockGetEntitlements.mockResolvedValue({
      ...baseEntitlements,
      tier: "free",
      stripeCustomerId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
    });

    const res = await request(createApp()).get("/api/companies/company-1/entitlements");

    expect(res.status).toBe(200);
    expect(res.body.stripeCustomerId).toBeNull();
    expect(res.body.subscriptionStatus).toBeNull();
    expect(res.body.currentPeriodEnd).toBeNull();
  });

  it("returns null billing fields when stripeCustomerId is null in plan row", async () => {
    mockGetEntitlements.mockResolvedValue({
      ...baseEntitlements,
      stripeCustomerId: null,
      subscriptionStatus: "canceled",
      currentPeriodEnd: null,
    });

    const res = await request(createApp()).get("/api/companies/company-1/entitlements");

    expect(res.status).toBe(200);
    expect(res.body.stripeCustomerId).toBeNull();
    expect(res.body.subscriptionStatus).toBe("canceled");
    expect(res.body.currentPeriodEnd).toBeNull();
  });

  it("returns past_due status when plan is in dunning", async () => {
    mockGetEntitlements.mockResolvedValue({
      ...baseEntitlements,
      stripeCustomerId: "cus_pastdue",
      subscriptionStatus: "past_due",
      currentPeriodEnd: null,
    });

    const res = await request(createApp()).get("/api/companies/company-1/entitlements");

    expect(res.status).toBe(200);
    expect(res.body.stripeCustomerId).toBe("cus_pastdue");
    expect(res.body.subscriptionStatus).toBe("past_due");
  });

  it("merges billing fields into the same response object as entitlements", async () => {
    mockGetEntitlements.mockResolvedValue({
      ...baseEntitlements,
      stripeCustomerId: "cus_merge",
      subscriptionStatus: "active",
      currentPeriodEnd: null,
    });

    const res = await request(createApp()).get("/api/companies/company-1/entitlements");

    expect(res.body).toMatchObject({
      tier: "pro",
      features: expect.objectContaining({ hubspotSync: true }),
      limits: expect.objectContaining({ agents: 25 }),
      stripeCustomerId: "cus_merge",
      subscriptionStatus: "active",
    });
  });
});
