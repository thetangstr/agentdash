import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireTierFor } from "../middleware/require-tier.js";

// requireTierFor bypasses all checks when STRIPE_SECRET_KEY is unset (so dev/test
// envs aren't forced into Pro-or-pay). Set it for these tests so the caps actually fire.
const originalKey = process.env.STRIPE_SECRET_KEY;
beforeAll(() => { process.env.STRIPE_SECRET_KEY = "sk_test_for_require_tier_tests"; });
afterAll(() => {
  if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalKey;
});

function makeDeps(planTier: string, humanCount: number, agentCount: number) {
  return {
    getCompany: vi.fn(async (_id: string) => ({ planTier })),
    counts: {
      humans: vi.fn(async (_id: string) => humanCount),
      agents: vi.fn(async (_id: string) => agentCount),
    },
  };
}

function makeReqRes(companyId: string) {
  const req = {
    params: { companyId },
    body: {},
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe("requireTierFor billing-disabled bypass", () => {
  it("bypasses all caps when STRIPE_SECRET_KEY is unset", async () => {
    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const deps = makeDeps("free", 99, 99);
      const { req, res, next } = makeReqRes("company-1");
      await requireTierFor("invite", deps)(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(deps.getCompany).not.toHaveBeenCalled();
    } finally {
      process.env.STRIPE_SECRET_KEY = saved;
    }
  });

  it("bypasses all caps when AGENTDASH_BILLING_DISABLED=true (even with Stripe key set)", async () => {
    process.env.AGENTDASH_BILLING_DISABLED = "true";
    try {
      const deps = makeDeps("free", 99, 99);
      const { req, res, next } = makeReqRes("company-1");
      await requireTierFor("hire", deps)(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    } finally {
      delete process.env.AGENTDASH_BILLING_DISABLED;
    }
  });
});

describe("requireTierFor invite", () => {
  it("allows invite when free workspace has 0 humans", async () => {
    const deps = makeDeps("free", 0, 0);
    const { req, res, next } = makeReqRes("company-1");
    await requireTierFor("invite", deps)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks invite when free workspace already has 1 human", async () => {
    const deps = makeDeps("free", 1, 0);
    const { req, res, next } = makeReqRes("company-1");
    await requireTierFor("invite", deps)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "seat_cap_exceeded" }));
  });

  it("allows invite on pro_trial regardless of human count", async () => {
    const deps = makeDeps("pro_trial", 5, 0);
    const { req, res, next } = makeReqRes("company-1");
    await requireTierFor("invite", deps)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows invite on pro_active regardless of human count", async () => {
    const deps = makeDeps("pro_active", 10, 0);
    const { req, res, next } = makeReqRes("company-1");
    await requireTierFor("invite", deps)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks invite on pro_canceled (treated as free) when humans >= 1", async () => {
    const deps = makeDeps("pro_canceled", 1, 0);
    const { req, res, next } = makeReqRes("company-1");
    await requireTierFor("invite", deps)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
  });

  it("skips check when no companyId present", async () => {
    const deps = makeDeps("free", 99, 99);
    const req = { params: {}, body: {} } as any;
    const res = { status: vi.fn(), json: vi.fn() } as any;
    const next = vi.fn();
    await requireTierFor("invite", deps)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("requireTierFor hire", () => {
  it("allows hire when free workspace has 0 agents", async () => {
    const deps = makeDeps("free", 0, 0);
    const { req, res, next } = makeReqRes("company-1");
    await requireTierFor("hire", deps)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks hire when free workspace already has 1 agent", async () => {
    const deps = makeDeps("free", 0, 1);
    const { req, res, next } = makeReqRes("company-1");
    await requireTierFor("hire", deps)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "agent_cap_exceeded" }));
  });

  it("allows hire on pro_trial regardless of agent count", async () => {
    const deps = makeDeps("pro_trial", 0, 5);
    const { req, res, next } = makeReqRes("company-1");
    await requireTierFor("hire", deps)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows hire on pro_active regardless of agent count", async () => {
    const deps = makeDeps("pro_active", 0, 10);
    const { req, res, next } = makeReqRes("company-1");
    await requireTierFor("hire", deps)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks hire on pro_canceled (treated as free) when agents >= 1", async () => {
    const deps = makeDeps("pro_canceled", 0, 1);
    const { req, res, next } = makeReqRes("company-1");
    await requireTierFor("hire", deps)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
  });
});
