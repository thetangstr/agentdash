// AgentDash: Billing service unit tests
// Tests webhook idempotency, event routing, and stripe ID persistence.
// Uses mocked db chains and a stub entitlements service — no real Stripe calls.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { billingService } from "../billing.js";
import type { BillingServiceDeps } from "../billing.js";
import type { Db } from "@agentdash/db";
import type { EntitlementsService } from "../entitlements.js";
import type { BillingProvider } from "@agentdash/billing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert chain that supports both the idempotency-gate insert (with
 *  onConflictDoNothing + returning) and ordinary fire-and-forget inserts. */
function makeInsertChain(insertedRows: Array<{ id: string }> = [{ id: "evt-row-1" }]) {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn().mockReturnValue(chain);
  chain.onConflictDoNothing = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockResolvedValue(insertedRows);
  // Allow `await db.insert(...).values(...)` to resolve when no conflict-chain is used.
  // We set `then` so the chain itself acts as a thenable for plain inserts.
  chain.then = (onResolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(onResolve);
  return chain;
}

/** Update chain: `db.update(...).set(...).where(...)` resolves to undefined. */
function makeUpdateChain() {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(undefined);
  return chain;
}

interface DbOptions {
  /** Whether the idempotency-gate insert returns a row (first time) or empty (duplicate). */
  idempotencyInserted?: boolean;
}

/** Build a mock db that supports the select chain and returns given rows. */
function makeSelectDb(rows: Record<string, unknown>[], options: DbOptions = {}): Db {
  const inserted = options.idempotencyInserted === false ? [] : [{ id: "evt-row-1" }];
  return {
    select: vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockImplementation(() => Promise.resolve(rows));
      return chain;
    }),
    insert: vi.fn().mockImplementation(() => makeInsertChain(inserted)),
    update: vi.fn().mockImplementation(() => makeUpdateChain()),
  } as unknown as Db;
}

/** Build a db where selects return different row sets by call order. */
function makeMultiSelectDb(rowSets: Array<Record<string, unknown>[]>, options: DbOptions = {}): Db {
  let callCount = 0;
  const inserted = options.idempotencyInserted === false ? [] : [{ id: "evt-row-1" }];
  return {
    select: vi.fn().mockImplementation(() => {
      const currentSet = rowSets[callCount] ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(currentSet);
      });
      return chain;
    }),
    insert: vi.fn().mockImplementation(() => makeInsertChain(inserted)),
    update: vi.fn().mockImplementation(() => makeUpdateChain()),
  } as unknown as Db;
}

function makeEntitlements(): EntitlementsService {
  return {
    getTier: vi.fn().mockResolvedValue("free"),
    setTier: vi.fn().mockResolvedValue(undefined),
    getEntitlements: vi.fn().mockResolvedValue({ tier: "free", features: {}, limits: {} }),
    setStripeIds: vi.fn().mockResolvedValue(undefined),
    setSubscriptionStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makeProvider(): BillingProvider {
  return {
    createCheckoutSession: vi.fn().mockResolvedValue({ status: "stubbed", reason: "no stripe key" }),
    cancelSubscription: vi.fn().mockResolvedValue({ status: "stubbed", reason: "no stripe key" }),
    syncEntitlement: vi.fn().mockResolvedValue(undefined),
  };
}

/** Build a raw-body buffer from a Stripe-shaped event object. */
function makeRawBody(event: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(event));
}

function baseDeps(overrides: Partial<BillingServiceDeps> = {}): BillingServiceDeps {
  return {
    entitlements: makeEntitlements(),
    provider: makeProvider(),
    priceMap: { price_pro: "pro", price_enterprise: "enterprise" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: idempotency
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — idempotency", () => {
  it("returns { received: true, skipped: true } when stripeEventId already exists", async () => {
    // Insert with onConflictDoNothing returns [] when the unique stripe_event_id
    // index rejects the row → handler must short-circuit before any processing.
    const db = makeSelectDb([], { idempotencyInserted: false });
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = { id: "evt_001", type: "invoice.paid", data: { object: { customer: "cus_abc" } } };
    const result = await svc.handleWebhookEvent(makeRawBody(event), "");

    expect(result).toEqual({ received: true, skipped: true });
    // Entitlements must NOT be touched on skip
    expect(deps.entitlements.setTier).not.toHaveBeenCalled();
    expect(deps.entitlements.setSubscriptionStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: customer.subscription.created
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — customer.subscription.created", () => {
  it("upgrades tier, saves stripe IDs and subscription status", async () => {
    // Idempotency is now insert-first; SELECTs only cover lookupCompanyByStripeCustomer.
    const db = makeMultiSelectDb([
      [{ companyId: "company-123" }],               // lookupCompanyByStripeCustomer
    ]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_sub_created",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_abc",
          customer: "cus_xyz",
          status: "active",
          current_period_end: 1900000000,
          items: { data: [{ price: { id: "price_pro" } }] },
        },
      },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    expect(deps.entitlements.setStripeIds).toHaveBeenCalledWith("company-123", null, "sub_abc");
    expect(deps.entitlements.setSubscriptionStatus).toHaveBeenCalledWith(
      "company-123",
      "active",
      new Date(1900000000 * 1000),
    );
    expect(deps.entitlements.setTier).toHaveBeenCalledWith("company-123", "pro");
  });

  it("reads current_period_end from items.data[0] (Stripe API 2025-10-28.basil shape)", async () => {
    const db = makeMultiSelectDb([
      [{ companyId: "company-basil" }],             // lookupCompanyByStripeCustomer
    ]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const periodEnd = 1950000000;
    const event = {
      id: "evt_sub_basil",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_basil",
          customer: "cus_basil",
          status: "active",
          // No root-level current_period_end — only on the item
          items: { data: [{ price: { id: "price_pro" }, current_period_end: periodEnd }] },
        },
      },
    };

    await svc.handleWebhookEvent(makeRawBody(event), "");

    expect(deps.entitlements.setSubscriptionStatus).toHaveBeenCalledWith(
      "company-basil",
      "active",
      new Date(periodEnd * 1000),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: customer.subscription.deleted
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — customer.subscription.deleted", () => {
  it("sets status=canceled and tier=free", async () => {
    const db = makeMultiSelectDb([
      [{ companyId: "company-999" }],  // lookupCompanyByStripeCustomer
    ]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_sub_deleted",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_abc", customer: "cus_xyz", status: "canceled" } },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    expect(deps.entitlements.setSubscriptionStatus).toHaveBeenCalledWith("company-999", "canceled", null);
    expect(deps.entitlements.setTier).toHaveBeenCalledWith("company-999", "free");
  });
});

// ---------------------------------------------------------------------------
// Tests: checkout.session.completed
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — checkout.session.completed", () => {
  it("persists stripeCustomerId for the company in client_reference_id", async () => {
    // checkout.session.completed uses client_reference_id directly — no db SELECT needed
    const db = makeMultiSelectDb([]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: "company-abc",
          customer: "cus_new",
          mode: "subscription",
        },
      },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    expect(deps.entitlements.setStripeIds).toHaveBeenCalledWith("company-abc", "cus_new", null);
  });
});

// ---------------------------------------------------------------------------
// Tests: invoice.payment_failed
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — invoice.payment_failed", () => {
  it("sets subscriptionStatus=past_due", async () => {
    const db = makeMultiSelectDb([
      [{ companyId: "company-456" }],  // lookupCompanyByStripeCustomer
    ]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_inv_fail",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_xyz", status: "open" } },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    expect(deps.entitlements.setSubscriptionStatus).toHaveBeenCalledWith("company-456", "past_due", null);
  });
});

// ---------------------------------------------------------------------------
// Tests: invoice.paid after past_due
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — invoice.paid", () => {
  it("sets subscriptionStatus=active when previously past_due", async () => {
    // Selects: lookupCompanyByStripeCustomer, then status check inside invoice.paid
    const db = makeMultiSelectDb([
      [{ companyId: "company-789" }],                      // lookupCompanyByStripeCustomer
      [{ subscriptionStatus: "past_due" }],                // status check inside invoice.paid
    ]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_inv_paid",
      type: "invoice.paid",
      data: { object: { customer: "cus_xyz", status: "paid" } },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    expect(deps.entitlements.setSubscriptionStatus).toHaveBeenCalledWith("company-789", "active", null);
  });

  it("does NOT update status when not past_due", async () => {
    const db = makeMultiSelectDb([
      [{ companyId: "company-789" }],
      [{ subscriptionStatus: "active" }],  // already active
    ]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_inv_paid_2",
      type: "invoice.paid",
      data: { object: { customer: "cus_xyz", status: "paid" } },
    };

    await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(deps.entitlements.setSubscriptionStatus).not.toHaveBeenCalled();
  });
});
