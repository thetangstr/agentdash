// AgentDash: Billing service — gap coverage
// Covers event types and paths missing from the existing billing.test.ts:
//   - customer.subscription.updated (tier re-map on price change)
//   - unknown event type logged but not crashed
//   - checkout.session.completed with no client_reference_id (no-op)
//   - customer.subscription.created with no matching price ID (tier stays unchanged)
//   - handleWebhookEvent when rawBody is invalid JSON raises error

import { describe, it, expect, vi, beforeEach } from "vitest";
import { billingService } from "../billing.js";
import type { BillingServiceDeps } from "../billing.js";
import type { Db } from "@agentdash/db";
import type { EntitlementsService } from "../entitlements.js";
import type { BillingProvider } from "@agentdash/billing";

// ---------------------------------------------------------------------------
// Helpers (mirror the pattern from billing.test.ts)
// ---------------------------------------------------------------------------

function makeInsertChain(insertedRows: Array<{ id: string }> = [{ id: "evt-row-1" }]) {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn().mockReturnValue(chain);
  chain.onConflictDoNothing = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockResolvedValue(insertedRows);
  chain.then = (onResolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(onResolve);
  return chain;
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(undefined);
  return chain;
}

interface DbOptions {
  idempotencyInserted?: boolean;
}

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
    createCheckoutSession: vi.fn().mockResolvedValue({ status: "stubbed", reason: "no key" }),
    cancelSubscription: vi.fn().mockResolvedValue({ status: "stubbed", reason: "no key" }),
    syncEntitlement: vi.fn().mockResolvedValue(undefined),
  };
}

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
// customer.subscription.updated
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — customer.subscription.updated", () => {
  it("updates subscription status, stripe IDs, and re-maps tier when price changed", async () => {
    const db = makeMultiSelectDb([
      [{ companyId: "company-upd" }],  // lookupCompanyByStripeCustomer
    ]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_sub_updated",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_upd_001",
          customer: "cus_xyz",
          status: "active",
          current_period_end: 1980000000,
          items: { data: [{ price: { id: "price_enterprise" } }] },
        },
      },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    expect(deps.entitlements.setStripeIds).toHaveBeenCalledWith("company-upd", null, "sub_upd_001");
    expect(deps.entitlements.setSubscriptionStatus).toHaveBeenCalledWith(
      "company-upd",
      "active",
      new Date(1980000000 * 1000),
    );
    expect(deps.entitlements.setTier).toHaveBeenCalledWith("company-upd", "enterprise");
  });

  it("updates status without changing tier when price ID has no mapping", async () => {
    const db = makeMultiSelectDb([
      [{ companyId: "company-noprice" }],
    ]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_sub_updated_noprice",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_noprice",
          customer: "cus_noprice",
          status: "active",
          current_period_end: 1980000000,
          items: { data: [{ price: { id: "price_unmapped" } }] },
        },
      },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    // Status must be updated
    expect(deps.entitlements.setSubscriptionStatus).toHaveBeenCalledWith(
      "company-noprice",
      "active",
      new Date(1980000000 * 1000),
    );
    // But setTier must NOT be called when price ID doesn't map to any tier
    expect(deps.entitlements.setTier).not.toHaveBeenCalled();
  });

  it("does not call entitlements when companyId cannot be resolved", async () => {
    const db = makeMultiSelectDb([
      [],    // lookupCompanyByStripeCustomer: company not found
    ]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_sub_updated_nocompany",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_orphan",
          customer: "cus_orphan",
          status: "active",
          current_period_end: 1980000000,
          items: { data: [{ price: { id: "price_pro" } }] },
        },
      },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    expect(deps.entitlements.setStripeIds).not.toHaveBeenCalled();
    expect(deps.entitlements.setSubscriptionStatus).not.toHaveBeenCalled();
    expect(deps.entitlements.setTier).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unknown event type
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — unknown event type", () => {
  it("returns { received: true } without crashing or touching entitlements", async () => {
    const db = makeSelectDb([]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_customer_created",
      type: "customer.created",
      data: { object: { id: "cus_newbie" } },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    expect(deps.entitlements.setTier).not.toHaveBeenCalled();
    expect(deps.entitlements.setStripeIds).not.toHaveBeenCalled();
    expect(deps.entitlements.setSubscriptionStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkout.session.completed — no client_reference_id
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — checkout.session.completed edge cases", () => {
  it("is a no-op when client_reference_id is missing", async () => {
    const db = makeSelectDb([]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_checkout_no_ref",
      type: "checkout.session.completed",
      data: {
        object: {
          // No client_reference_id
          customer: "cus_orphan",
          mode: "subscription",
        },
      },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    expect(deps.entitlements.setStripeIds).not.toHaveBeenCalled();
  });

  it("is a no-op when customer field is missing from checkout session", async () => {
    const db = makeSelectDb([]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_checkout_no_customer",
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: "company-xyz",
          // No customer field
          mode: "subscription",
        },
      },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });
    // setStripeIds needs both clientRef AND customer — should not be called
    expect(deps.entitlements.setStripeIds).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// customer.subscription.created — unmapped price ID
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — customer.subscription.created with unmapped price", () => {
  it("saves stripe IDs and status but does NOT change tier when price is unmapped", async () => {
    const db = makeMultiSelectDb([
      [{ companyId: "company-unmapped" }],
    ]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const event = {
      id: "evt_sub_unmapped_price",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_unmapped",
          customer: "cus_unmapped",
          status: "trialing",
          current_period_end: 1900000000,
          items: { data: [{ price: { id: "price_unknown_xyz" } }] },
        },
      },
    };

    const result = await svc.handleWebhookEvent(makeRawBody(event), "");
    expect(result).toEqual({ received: true });

    expect(deps.entitlements.setStripeIds).toHaveBeenCalledWith("company-unmapped", null, "sub_unmapped");
    expect(deps.entitlements.setSubscriptionStatus).toHaveBeenCalledWith(
      "company-unmapped",
      "trialing",
      new Date(1900000000 * 1000),
    );
    // Price unknown → tier unchanged
    expect(deps.entitlements.setTier).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Invalid JSON payload
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — invalid payload", () => {
  it("throws when rawBody is not valid JSON (no webhookSecret)", async () => {
    const db = makeSelectDb([]);
    const deps = baseDeps();
    const svc = billingService(db, deps);

    const badBody = Buffer.from("this is not json {{{}}}");

    await expect(svc.handleWebhookEvent(badBody, "")).rejects.toThrow(/cannot parse JSON/i);
  });
});

// ---------------------------------------------------------------------------
// billing_events audit row is always written (even on processing error)
// ---------------------------------------------------------------------------

describe("billingService.handleWebhookEvent — audit log on error", () => {
  it("still records the audit row + error when downstream entitlements throws", async () => {
    const db = makeMultiSelectDb([
      [{ companyId: "company-err" }],  // lookupCompanyByStripeCustomer
    ]);
    const entitlements = makeEntitlements();
    (entitlements.setSubscriptionStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db write failed"),
    );
    const deps = baseDeps({ entitlements });
    const svc = billingService(db, deps);

    const event = {
      id: "evt_error_test",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_xyz", status: "open" } },
    };

    // The handler inserts the audit row first, processes, then re-throws.
    await expect(svc.handleWebhookEvent(makeRawBody(event), "")).rejects.toThrow(/webhook processing error/i);

    // Insert (audit row) AND update (patching error column) must have been called.
    expect((db.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((db.update as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
