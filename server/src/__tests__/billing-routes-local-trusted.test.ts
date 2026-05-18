import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyStore = vi.hoisted(() => ({
  byId: new Map<string, any>(),
}));

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => companyStore.byId.get(id) ?? null),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const existing = companyStore.byId.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      companyStore.byId.set(id, updated);
      return updated;
    }),
    findByStripeCustomerId: vi.fn(async () => null),
    findByStripeSubscriptionId: vi.fn(async () => null),
  }),
}));

vi.mock("../services/conversations.js", () => ({
  conversationService: () => ({
    findByCompany: vi.fn(async () => null),
    postMessage: vi.fn(async () => null),
  }),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    list: vi.fn(async () => []),
  }),
}));

vi.mock("../services/entitlement-sync.js", () => ({
  entitlementSync: () => ({
    dispatch: vi.fn(async () => undefined),
  }),
}));

vi.mock("../services/stripe-webhook-ledger.js", () => ({
  stripeWebhookLedger: () => ({}),
}));

vi.mock("../auth/email.js", () => ({
  sendEmail: vi.fn(async () => undefined),
}));

function stripeStub() {
  return {
    customers: {
      create: vi.fn(async () => ({ id: "cus_new" })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://checkout.example.test/session" })),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://billing.example.test/session" })),
      },
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ billingRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/billing.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api/billing",
    billingRoutes({} as any, {
      stripe: stripeStub(),
      webhookSecret: "",
      proPriceId: "",
      trialDays: 14,
      publicBaseUrl: "",
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("billing route company access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    companyStore.byId.clear();
    companyStore.byId.set("company-1", {
      id: "company-1",
      name: "AgentDash Workspace",
      planTier: "free",
      planSeatsPaid: 0,
      planPeriodEnd: null,
      stripeCustomerId: null,
    });
  });

  it("allows local trusted implicit board access without a companyIds list", async () => {
    const app = await createApp({
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .get("/api/billing/status")
      .query({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tier: "free",
      seatsPaid: 0,
      periodEnd: null,
    });
  });

  it("still rejects session board access without company membership", async () => {
    const app = await createApp({
      type: "board",
      source: "session",
      userId: "user-1",
      companyIds: [],
    });

    const res = await request(app)
      .get("/api/billing/status")
      .query({ companyId: "company-1" });

    expect(res.status).toBe(403);
  });
});
