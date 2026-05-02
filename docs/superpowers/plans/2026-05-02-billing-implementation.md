# Subscription + billing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement [docs/superpowers/specs/2026-05-02-billing-design.md](../specs/2026-05-02-billing-design.md) — Free + Pro tiers, per-seat Pro pricing, 14-day no-card trial, Stripe checkout + portal + webhooks, lenient downgrade, caps enforced at write paths.

**Architecture:** `companies.plan_tier` is the single source of truth, written only by webhook handlers (idempotent via `event_id` ledger). UI gates at write paths (invite, hire) call `requireTier`. Stripe owns the customer + subscription + payment surface. Application owns the company ↔ customer mapping and the seat-quantity-syncer that updates Stripe `quantity` on membership changes.

**Tech Stack:** TypeScript, Node 20, Express, Drizzle ORM, PostgreSQL, Stripe Node SDK (`stripe` v17+), React 19, Vitest, Playwright, Stripe CLI for local webhook testing.

---

## Prerequisites

- [ ] v2 base migration plan complete.
- [ ] Multi-human + CoS chat substrate plan complete (the upgrade-prompt cards live in chat).
- [ ] Onboarding plan complete (the activation flow includes invite, which is the cap'd write path).
- [ ] Stripe account in dashboard with:
  - A `Price` record for Pro per-seat (`recurring.interval=month`, `recurring.usage_type=licensed`, set `STRIPE_PRO_PRICE_ID`).
  - `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` set in env.
- [ ] Stripe CLI installed locally for webhook testing (`stripe listen --forward-to localhost:3100/api/billing/webhook`).

---

## File structure

**Created:**
| File | Responsibility |
|---|---|
| `packages/db/src/schema/billing.ts` | Adds plan_tier columns to companies + stripe_webhook_events table |
| `packages/db/src/migrations/0073_billing.sql` | Migration |
| `server/src/services/billing.ts` | createCheckoutSession, createPortalSession, getStatus |
| `server/src/services/entitlement-sync.ts` | Per-event handlers writing companies.plan_tier |
| `server/src/services/seat-quantity-syncer.ts` | Membership-change → Stripe.subscriptions.update(quantity) |
| `server/src/middleware/require-tier.ts` | Express middleware for cap enforcement |
| `server/src/routes/billing.ts` | All billing routes |
| `server/src/realtime/billing-events.ts` | Optional WS event for "tier changed" — minor convenience |
| `ui/src/pages/BillingPage.tsx` | Settings → Billing |
| `ui/src/components/UpgradePromptCard.tsx` | Inline upgrade prompt rendered in chat on 402 |
| `ui/src/components/TrialBanner.tsx` | "Pro trial — 14 days left" |
| `ui/src/api/billing.ts` | Frontend client |
| `server/src/__tests__/billing-routes.test.ts` | Route tests |
| `server/src/__tests__/entitlement-sync.test.ts` | Webhook handler tests with canned Stripe payloads |
| `server/src/__tests__/seat-quantity-syncer.test.ts` | Membership-change → Stripe call tests |
| `server/src/__tests__/require-tier.test.ts` | Middleware tests |
| `tests/e2e/billing.spec.ts` | E2E with Stripe CLI triggers |

**Modified:**
| File | Change |
|---|---|
| `packages/db/src/schema/companies.ts` | Add plan columns |
| `server/src/app.ts` | Mount billing routes |
| `server/src/routes/onboarding-v2.ts` | Wire `requireTier("pro")` on invites and `agent/confirm` |
| `server/src/services/access.ts` | Fire seat-quantity-syncer on `ensureMembership`/`removeMembership` |

---

## Phase 1 — Schema

### Task 1.1 — Plan columns + webhook events table

**Files:**
- Modify: `packages/db/src/schema/companies.ts`
- Create: `packages/db/src/schema/billing.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Failing test**

```typescript
// packages/db/src/__tests__/billing-schema.test.ts
import { describe, it, expect } from "vitest";
import { companies } from "../schema/companies.js";
import { stripeWebhookEvents } from "../schema/billing.js";

describe("billing schema", () => {
  it("companies has plan columns", () => {
    const cols = Object.keys(companies);
    for (const c of ["planTier", "planSeatsPaid", "planPeriodEnd", "stripeCustomerId", "stripeSubscriptionId"]) {
      expect(cols).toContain(c);
    }
  });
  it("stripe_webhook_events has the required columns", () => {
    const cols = Object.keys(stripeWebhookEvents);
    for (const c of ["id", "eventId", "eventType", "payload", "processedAt"]) {
      expect(cols).toContain(c);
    }
  });
});
```

- [ ] **Step 2: Run, expect failure**

```sh
pnpm test:run -- billing-schema
```

- [ ] **Step 3: Add plan columns to `companies`**

```typescript
// packages/db/src/schema/companies.ts (additions)
planTier: varchar("plan_tier", { length: 32 }).notNull().default("free"),
planSeatsPaid: integer("plan_seats_paid").notNull().default(0),
planPeriodEnd: timestamp("plan_period_end", { withTimezone: true }),
stripeCustomerId: varchar("stripe_customer_id", { length: 64 }),
stripeSubscriptionId: varchar("stripe_subscription_id", { length: 64 }),
```

Plus an index:
```typescript
index("companies_plan_tier_idx").on(table.planTier),
```

- [ ] **Step 4: Create `stripe_webhook_events`**

```typescript
// packages/db/src/schema/billing.ts
import { pgTable, uuid, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";

export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: varchar("event_id", { length: 128 }).notNull().unique(),
  eventType: varchar("event_type", { length: 128 }).notNull(),
  payload: jsonb("payload").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 5: Re-export, generate migration, apply**

```sh
echo 'export * from "./billing.js";' >> packages/db/src/schema/index.ts
pnpm db:generate
pnpm db:migrate
pnpm test:run -- billing-schema
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/db/src/schema/billing.ts packages/db/src/schema/companies.ts \
  packages/db/src/schema/index.ts packages/db/src/migrations/ \
  packages/db/src/__tests__/billing-schema.test.ts
git commit -m "feat(db): billing schema (plan columns + webhook events ledger)"
```

---

## Phase 2 — `requireTier` middleware

### Task 2.1 — Middleware with caps

**Files:**
- Create: `server/src/middleware/require-tier.ts`
- Create: `server/src/__tests__/require-tier.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import express from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { requireTierFor } from "../middleware/require-tier.js";

const mockGetCompany = vi.fn();
const mockCount = { humans: vi.fn(), agents: vi.fn() };

function buildApp(tier: string, humanCount = 0, agentCount = 0) {
  mockGetCompany.mockResolvedValue({ planTier: tier });
  mockCount.humans.mockResolvedValue(humanCount);
  mockCount.agents.mockResolvedValue(agentCount);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.companyId = "c1"; next(); });
  app.post("/invite",
    requireTierFor("invite", { getCompany: mockGetCompany, counts: mockCount } as any),
    (_req, res) => res.json({ ok: true }));
  app.post("/hire",
    requireTierFor("hire", { getCompany: mockGetCompany, counts: mockCount } as any),
    (_req, res) => res.json({ ok: true }));
  return app;
}

describe("requireTierFor", () => {
  it("blocks invite on free tier when humans >= 1", async () => {
    const res = await request(buildApp("free", 1)).post("/invite");
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("seat_cap_exceeded");
  });
  it("blocks hire on free tier when agents >= 1", async () => {
    const res = await request(buildApp("free", 1, 1)).post("/hire");
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("agent_cap_exceeded");
  });
  it("allows invite/hire on pro_trial", async () => {
    const res1 = await request(buildApp("pro_trial", 5)).post("/invite");
    expect(res1.status).toBe(200);
    const res2 = await request(buildApp("pro_trial", 5, 5)).post("/hire");
    expect(res2.status).toBe(200);
  });
  it("blocks invite/hire on pro_canceled like free (lenient downgrade)", async () => {
    const res = await request(buildApp("pro_canceled", 1)).post("/invite");
    expect(res.status).toBe(402);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// server/src/middleware/require-tier.ts
import type { RequestHandler } from "express";

interface Deps {
  getCompany: (id: string) => Promise<{ planTier: string }>;
  counts: { humans: (companyId: string) => Promise<number>; agents: (companyId: string) => Promise<number> };
}

const PRO_LIVE = new Set(["pro_trial", "pro_active"]);

export function requireTierFor(action: "invite" | "hire", deps: Deps): RequestHandler {
  return async (req, res, next) => {
    const companyId = (req as any).companyId ?? req.params.companyId;
    if (!companyId) return next(); // upstream auth should set this
    const company = await deps.getCompany(companyId);
    if (PRO_LIVE.has(company.planTier)) return next();
    // Free or pro_canceled: enforce caps.
    if (action === "invite") {
      const humans = await deps.counts.humans(companyId);
      if (humans >= 1) return res.status(402).json({ code: "seat_cap_exceeded", message: "Free workspaces are limited to 1 user. Upgrade to Pro to invite teammates." });
    }
    if (action === "hire") {
      const agents = await deps.counts.agents(companyId);
      if (agents >= 1) return res.status(402).json({ code: "agent_cap_exceeded", message: "Free workspaces include only the Chief of Staff. Upgrade to Pro to hire more agents." });
    }
    next();
  };
}
```

- [ ] **Step 3: Run + commit**

```sh
pnpm test:run -- require-tier
git add server/src/middleware/require-tier.ts server/src/__tests__/require-tier.test.ts
git commit -m "feat(server): requireTierFor middleware (free caps)"
```

### Task 2.2 — Wire `requireTierFor` into onboarding routes

**Files:**
- Modify: `server/src/routes/onboarding-v2.ts`

- [ ] **Step 1: Add the middleware to the relevant routes**

```typescript
// onboarding-v2.ts:
import { requireTierFor } from "../middleware/require-tier.js";

// On the agent/confirm handler:
router.post("/agent/confirm", requireTierFor("hire", deps), async (req, res) => { /* existing */ });

// On the invites handler:
router.post("/invites", requireTierFor("invite", deps), async (req, res) => { /* existing */ });
```

(Note: the `companyId` in these requests comes from the body, not the URL. Adapt the middleware to read from body if needed, or set `req.companyId` in a small upstream handler before the middleware.)

- [ ] **Step 2: Existing onboarding tests should still pass on `pro_trial`-equivalent default; add a free-tier rejection test**

```typescript
// In onboarding-v2-routes.test.ts:
it("returns 402 when a Free user tries to invite teammates", async () => {
  // Arrange: company in plan_tier='free' with 1 human already
  // ...
  const res = await request(app).post("/api/onboarding/invites").send({ companyId: "c1", emails: ["bob@x.com"] });
  expect(res.status).toBe(402);
  expect(res.body.code).toBe("seat_cap_exceeded");
});
```

- [ ] **Step 3: Commit**

```sh
git add server/src/routes/onboarding-v2.ts server/src/__tests__/onboarding-v2-routes.test.ts
git commit -m "feat(server): enforce Free caps on onboarding write paths"
```

---

## Phase 3 — Billing service: checkout + portal + status

### Task 3.1 — `createCheckoutSession`

**Files:**
- Create: `server/src/services/billing.ts`
- Create: `server/src/__tests__/billing-service.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { billingService } from "../services/billing.js";

const mockStripe = {
  checkout: { sessions: { create: vi.fn() } },
  customers: { create: vi.fn(), retrieve: vi.fn() },
  billingPortal: { sessions: { create: vi.fn() } },
  subscriptions: { retrieve: vi.fn() },
};
const mockCompanies = { getById: vi.fn(), update: vi.fn() };

describe("billingService.createCheckoutSession", () => {
  it("creates a Stripe customer (if absent), then a checkout session with trial_period_days=14", async () => {
    mockCompanies.getById.mockResolvedValue({ id: "c1", name: "Acme", stripeCustomerId: null });
    mockStripe.customers.create.mockResolvedValue({ id: "cus_123" });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.com/abc" });
    mockCompanies.update.mockResolvedValue({});

    const result = await billingService({
      stripe: mockStripe, companies: mockCompanies,
      config: { proPriceId: "price_pro", trialDays: 14, publicBaseUrl: "https://app.example.com" },
    } as any).createCheckoutSession("c1");

    expect(mockStripe.customers.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Acme" }));
    expect(mockCompanies.update).toHaveBeenCalledWith("c1", { stripeCustomerId: "cus_123" });
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription",
      customer: "cus_123",
      line_items: [{ price: "price_pro", quantity: expect.any(Number) }],
      subscription_data: expect.objectContaining({
        trial_period_days: 14,
        trial_settings: expect.objectContaining({ end_behavior: { missing_payment_method: "cancel" } }),
      }),
    }));
    expect(result.url).toBe("https://checkout.stripe.com/abc");
  });

  it("reuses existing stripeCustomerId when present", async () => {
    mockCompanies.getById.mockResolvedValue({ id: "c1", name: "Acme", stripeCustomerId: "cus_existing" });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.com/x" });
    await billingService({ stripe: mockStripe, companies: mockCompanies, config: { proPriceId: "p", trialDays: 14, publicBaseUrl: "u" } } as any).createCheckoutSession("c1");
    expect(mockStripe.customers.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// server/src/services/billing.ts
interface Deps {
  stripe: any; // typed Stripe SDK
  companies: any;
  config: { proPriceId: string; trialDays: number; publicBaseUrl: string };
}

export function billingService(deps: Deps) {
  return {
    createCheckoutSession: async (companyId: string) => {
      const company = await deps.companies.getById(companyId);
      let customerId = company.stripeCustomerId;
      if (!customerId) {
        const customer = await deps.stripe.customers.create({
          name: company.name,
          metadata: { companyId },
        });
        customerId = customer.id;
        await deps.companies.update(companyId, { stripeCustomerId: customerId });
      }
      const session = await deps.stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: deps.config.proPriceId, quantity: 1 }],
        subscription_data: {
          trial_period_days: deps.config.trialDays,
          trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
          metadata: { companyId },
        },
        success_url: `${deps.config.publicBaseUrl}/billing?session=success`,
        cancel_url: `${deps.config.publicBaseUrl}/billing?session=cancel`,
      });
      return { url: session.url };
    },

    createPortalSession: async (companyId: string) => {
      const company = await deps.companies.getById(companyId);
      if (!company.stripeCustomerId) throw new Error("No Stripe customer for this company");
      const session = await deps.stripe.billingPortal.sessions.create({
        customer: company.stripeCustomerId,
        return_url: `${deps.config.publicBaseUrl}/billing`,
      });
      return { url: session.url };
    },

    getStatus: async (companyId: string) => {
      const c = await deps.companies.getById(companyId);
      return {
        tier: c.planTier,
        seatsPaid: c.planSeatsPaid,
        periodEnd: c.planPeriodEnd,
      };
    },
  };
}
```

- [ ] **Step 3: Run + commit**

```sh
pnpm test:run -- billing-service
git add server/src/services/billing.ts server/src/__tests__/billing-service.test.ts
git commit -m "feat(server): billingService (checkout, portal, status)"
```

---

## Phase 4 — Webhook handler + entitlement sync

### Task 4.1 — Webhook handler with idempotency

**Files:**
- Create: `server/src/services/entitlement-sync.ts`
- Create: `server/src/__tests__/entitlement-sync.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { entitlementSync } from "../services/entitlement-sync.js";

const mockCompanies = { findByStripeCustomerId: vi.fn(), findByStripeSubscriptionId: vi.fn(), update: vi.fn() };
const mockLedger = { record: vi.fn() };

describe("entitlementSync handlers", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("onSubscriptionCreated sets plan_tier=pro_trial and stores subscriptionId", async () => {
    mockCompanies.findByStripeCustomerId.mockResolvedValue({ id: "c1" });
    await entitlementSync({ companies: mockCompanies, ledger: mockLedger } as any).onSubscriptionCreated({
      id: "sub_1",
      customer: "cus_1",
      status: "trialing",
      items: { data: [{ quantity: 1 }] },
      current_period_end: 1735689600,
    });
    expect(mockCompanies.update).toHaveBeenCalledWith("c1", expect.objectContaining({
      planTier: "pro_trial",
      planSeatsPaid: 1,
      stripeSubscriptionId: "sub_1",
      planPeriodEnd: expect.any(Date),
    }));
  });

  it("onSubscriptionUpdated transitions trialing → active to pro_active", async () => {
    mockCompanies.findByStripeSubscriptionId.mockResolvedValue({ id: "c1" });
    await entitlementSync({ companies: mockCompanies, ledger: mockLedger } as any).onSubscriptionUpdated({
      id: "sub_1", customer: "cus_1", status: "active", items: { data: [{ quantity: 3 }] }, current_period_end: 1735689600,
    });
    expect(mockCompanies.update).toHaveBeenCalledWith("c1", expect.objectContaining({ planTier: "pro_active", planSeatsPaid: 3 }));
  });

  it("onSubscriptionDeleted sets pro_canceled and preserves history", async () => {
    mockCompanies.findByStripeSubscriptionId.mockResolvedValue({ id: "c1" });
    await entitlementSync({ companies: mockCompanies, ledger: mockLedger } as any).onSubscriptionDeleted({
      id: "sub_1", customer: "cus_1", status: "canceled", items: { data: [{ quantity: 3 }] }, current_period_end: 1735689600,
    });
    expect(mockCompanies.update).toHaveBeenCalledWith("c1", expect.objectContaining({ planTier: "pro_canceled" }));
  });

  it("idempotent: same event_id processed twice is a no-op the second time", async () => {
    mockLedger.record.mockResolvedValueOnce({ inserted: true });
    mockLedger.record.mockResolvedValueOnce({ inserted: false }); // duplicate
    mockCompanies.findByStripeCustomerId.mockResolvedValue({ id: "c1" });
    const sync = entitlementSync({ companies: mockCompanies, ledger: mockLedger } as any);
    const ev = { id: "evt_1", type: "customer.subscription.created", data: { object: { id: "s", customer: "c", status: "trialing", items: { data: [{ quantity: 1 }] }, current_period_end: 1 } } };
    await sync.dispatch(ev);
    await sync.dispatch(ev);
    expect(mockCompanies.update).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// server/src/services/entitlement-sync.ts
interface Deps {
  companies: any;
  ledger: { record: (eventId: string, eventType: string, payload: any) => Promise<{ inserted: boolean }> };
}

const STATUS_TO_TIER: Record<string, string> = {
  trialing: "pro_trial",
  active: "pro_active",
  past_due: "pro_active", // still grant access during grace; let Stripe finalize
  unpaid: "pro_canceled",
  canceled: "pro_canceled",
  incomplete: "free", // checkout never completed
  incomplete_expired: "free",
};

export function entitlementSync(deps: Deps) {
  async function applyFromSubscription(sub: any) {
    const company = await (
      deps.companies.findByStripeSubscriptionId(sub.id)
        ?? deps.companies.findByStripeCustomerId(sub.customer)
    );
    if (!company) throw new Error(`No company for subscription ${sub.id} / customer ${sub.customer}`);
    const planTier = STATUS_TO_TIER[sub.status] ?? "free";
    const planSeatsPaid = sub.items?.data?.[0]?.quantity ?? 0;
    const planPeriodEnd = new Date(sub.current_period_end * 1000);
    await deps.companies.update(company.id, {
      planTier,
      planSeatsPaid,
      planPeriodEnd,
      stripeSubscriptionId: sub.id,
      stripeCustomerId: sub.customer,
    });
  }

  return {
    onSubscriptionCreated: applyFromSubscription,
    onSubscriptionUpdated: applyFromSubscription,
    onSubscriptionDeleted: applyFromSubscription,
    onInvoicePaid: async (inv: any) => {
      const company = await deps.companies.findByStripeSubscriptionId(inv.subscription);
      if (!company) return;
      // If we were past_due and just collected, the subscription.updated will follow.
      // No-op here beyond logging.
    },
    onTrialWillEnd: async (sub: any) => {
      // Trigger reminder email + in-app banner. Implementation in send-trial-reminder service.
      // (Wired in a later task.)
    },

    dispatch: async (event: any) => {
      const recorded = await deps.ledger.record(event.id, event.type, event);
      if (!recorded.inserted) return; // duplicate
      switch (event.type) {
        case "customer.subscription.created":
          return applyFromSubscription(event.data.object);
        case "customer.subscription.updated":
          return applyFromSubscription(event.data.object);
        case "customer.subscription.deleted":
          return applyFromSubscription(event.data.object);
        case "invoice.paid":
          // No state change beyond what subscription.updated will deliver.
          return;
        case "invoice.payment_failed":
          return;
        case "customer.subscription.trial_will_end":
          // Send reminder.
          return;
        default:
          return; // unknown event types are stored but no-op
      }
    },
  };
}
```

- [ ] **Step 3: Implement the ledger**

```typescript
// server/src/services/stripe-webhook-ledger.ts
export function stripeWebhookLedger(db: any) {
  return {
    record: async (eventId: string, eventType: string, payload: any) => {
      try {
        await db.insert(stripeWebhookEvents).values({ eventId, eventType, payload });
        return { inserted: true };
      } catch (err: any) {
        // unique constraint violation = duplicate
        if (err?.code === "23505") return { inserted: false };
        throw err;
      }
    },
  };
}
```

- [ ] **Step 4: Run + commit**

```sh
pnpm test:run -- entitlement-sync
git add server/src/services/entitlement-sync.ts server/src/services/stripe-webhook-ledger.ts \
  server/src/__tests__/entitlement-sync.test.ts
git commit -m "feat(server): entitlement-sync handlers + idempotent ledger"
```

---

## Phase 5 — Routes

### Task 5.1 — Billing routes

**Files:**
- Create: `server/src/routes/billing.ts`
- Create: `server/src/__tests__/billing-routes.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { billingRoutes } from "../routes/billing.js";

const mockSvc = {
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  getStatus: vi.fn(),
};
const mockSync = { dispatch: vi.fn() };
const mockStripe = { webhooks: { constructEvent: vi.fn() } };

vi.mock("../services/index.js", () => ({
  billingService: () => mockSvc,
  entitlementSync: () => mockSync,
}));

function buildApp(actor: any) {
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf } }));
  app.use((req: any, _res, next) => { req.actor = actor; next(); });
  app.use("/api/billing", billingRoutes({} as any, { stripe: mockStripe, webhookSecret: "whsec_x" }));
  return app;
}

describe("billing routes", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("POST /checkout-session returns the URL", async () => {
    mockSvc.createCheckoutSession.mockResolvedValue({ url: "https://checkout.stripe.com/abc" });
    const res = await request(buildApp({ type: "board", userId: "u1", companyIds: ["c1"], source: "session" }))
      .post("/api/billing/checkout-session").send({ companyId: "c1" });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.stripe.com/abc");
  });

  it("POST /webhook with valid signature dispatches the event", async () => {
    const event = { id: "evt_1", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } };
    mockStripe.webhooks.constructEvent.mockReturnValue(event);
    const res = await request(buildApp({ type: "none", source: "none" }))
      .post("/api/billing/webhook")
      .set("stripe-signature", "t=1,v1=valid")
      .send({});
    expect(res.status).toBe(200);
    expect(mockSync.dispatch).toHaveBeenCalledWith(event);
  });

  it("POST /webhook with invalid signature returns 400", async () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => { throw new Error("invalid"); });
    const res = await request(buildApp({ type: "none", source: "none" }))
      .post("/api/billing/webhook")
      .set("stripe-signature", "bogus")
      .send({});
    expect(res.status).toBe(400);
    expect(mockSync.dispatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// server/src/routes/billing.ts
import { Router } from "express";
import type { Db } from "@agentdash/db";
import { billingService, entitlementSync } from "../services/index.js";
import { unauthorized, forbidden } from "../errors.js";

interface RoutesConfig {
  stripe: any;
  webhookSecret: string;
}

export function billingRoutes(db: Db, cfg: RoutesConfig) {
  const router = Router();
  const svc = billingService(/* deps */);
  const sync = entitlementSync(/* deps */);

  router.post("/checkout-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Sign-in required");
    const { companyId } = req.body as { companyId: string };
    if (!req.actor.companyIds?.includes(companyId)) throw forbidden("Not a member of this company");
    const r = await svc.createCheckoutSession(companyId);
    res.json(r);
  });

  router.post("/portal-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Sign-in required");
    const { companyId } = req.body as { companyId: string };
    if (!req.actor.companyIds?.includes(companyId)) throw forbidden("Not a member of this company");
    const r = await svc.createPortalSession(companyId);
    res.json(r);
  });

  router.get("/status", async (req, res) => {
    const companyId = String(req.query.companyId);
    if (req.actor.type !== "board" || !req.actor.companyIds?.includes(companyId)) throw forbidden("Not a member of this company");
    const r = await svc.getStatus(companyId);
    res.json(r);
  });

  // Webhook: raw body is captured by express.json verify above.
  router.post("/webhook", async (req, res) => {
    const sig = req.header("stripe-signature");
    let event;
    try {
      event = cfg.stripe.webhooks.constructEvent((req as any).rawBody, sig, cfg.webhookSecret);
    } catch (err) {
      return res.status(400).json({ error: "invalid signature" });
    }
    await sync.dispatch(event);
    res.status(200).json({ received: true });
  });

  return router;
}
```

- [ ] **Step 3: Run + commit**

```sh
pnpm test:run -- billing-routes
git add server/src/routes/billing.ts server/src/__tests__/billing-routes.test.ts
git commit -m "feat(server): billing routes (checkout, portal, status, webhook)"
```

### Task 5.2 — Wire into app

**Files:**
- Modify: `server/src/app.ts`

- [ ] **Step 1: Mount**

```typescript
import { billingRoutes } from "./routes/billing.js";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
app.use("/api/billing", billingRoutes(db, { stripe, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET! }));
```

- [ ] **Step 2: Commit**

```sh
git add server/src/app.ts
git commit -m "feat(server): mount billing routes"
```

---

## Phase 6 — Seat-quantity syncer

### Task 6.1 — Sync `quantity` on membership change

**Files:**
- Create: `server/src/services/seat-quantity-syncer.ts`
- Create: `server/src/__tests__/seat-quantity-syncer.test.ts`
- Modify: `server/src/services/access.ts`

- [ ] **Step 1: Failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { seatQuantitySyncer } from "../services/seat-quantity-syncer.js";

const mockStripe = { subscriptions: { update: vi.fn() } };
const mockCompanies = { getById: vi.fn() };
const mockCounts = { humans: vi.fn() };

describe("seatQuantitySyncer.onMembershipChanged", () => {
  it("calls stripe.subscriptions.update with the new human count when company has a Pro subscription", async () => {
    mockCompanies.getById.mockResolvedValue({ id: "c1", stripeSubscriptionId: "sub_1", planTier: "pro_active" });
    mockCounts.humans.mockResolvedValue(4);
    await seatQuantitySyncer({ stripe: mockStripe, companies: mockCompanies, counts: mockCounts } as any).onMembershipChanged("c1");
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith("sub_1", { quantity: 4, proration_behavior: "create_prorations" });
  });

  it("does nothing for free-tier companies", async () => {
    mockCompanies.getById.mockResolvedValue({ id: "c1", stripeSubscriptionId: null, planTier: "free" });
    await seatQuantitySyncer({ stripe: mockStripe, companies: mockCompanies, counts: mockCounts } as any).onMembershipChanged("c1");
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// server/src/services/seat-quantity-syncer.ts
interface Deps {
  stripe: any;
  companies: any;
  counts: { humans: (companyId: string) => Promise<number> };
}

const PRO_LIVE = new Set(["pro_trial", "pro_active"]);

export function seatQuantitySyncer(deps: Deps) {
  return {
    onMembershipChanged: async (companyId: string) => {
      const company = await deps.companies.getById(companyId);
      if (!company.stripeSubscriptionId || !PRO_LIVE.has(company.planTier)) return;
      const humans = await deps.counts.humans(companyId);
      // Find the subscription item (assumes one Price; real impl may need to find it by Price ID).
      await deps.stripe.subscriptions.update(company.stripeSubscriptionId, {
        quantity: humans,
        proration_behavior: "create_prorations",
      });
    },
  };
}
```

- [ ] **Step 3: Hook into access service**

In `server/src/services/access.ts`, after `ensureMembership` and `removeMembership`, fire the syncer:

```typescript
ensureMembership: async (...) => {
  const result = await /* existing impl */;
  if (principalType === "user") {
    await seatQuantitySyncer(/* deps */).onMembershipChanged(companyId).catch(err => logger.warn({ err }, "seat sync failed"));
  }
  return result;
},
```

(Wrap in try/catch so a Stripe error doesn't roll back the membership operation.)

- [ ] **Step 4: Run + commit**

```sh
pnpm test:run -- seat-quantity-syncer
git add server/src/services/seat-quantity-syncer.ts server/src/services/access.ts \
  server/src/__tests__/seat-quantity-syncer.test.ts
git commit -m "feat(server): seat quantity syncer on membership change"
```

---

## Phase 7 — UI

### Task 7.1 — `BillingPage` + API client

**Files:**
- Create: `ui/src/pages/BillingPage.tsx`
- Create: `ui/src/api/billing.ts`
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: API client**

```typescript
// ui/src/api/billing.ts
import { api } from "./client";

export interface BillingStatus { tier: string; seatsPaid: number; periodEnd: string | null }

export const billingApi = {
  status: (companyId: string) => api.get<BillingStatus>("/billing/status", { params: { companyId } }),
  startCheckout: (companyId: string) => api.post<{ url: string }>("/billing/checkout-session", { companyId }),
  openPortal: (companyId: string) => api.post<{ url: string }>("/billing/portal-session", { companyId }),
};
```

- [ ] **Step 2: BillingPage**

```tsx
// ui/src/pages/BillingPage.tsx
import { useEffect, useState } from "react";
import { billingApi, type BillingStatus } from "../api/billing";

export default function BillingPage({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  useEffect(() => { billingApi.status(companyId).then(setStatus); }, [companyId]);
  if (!status) return <div>Loading…</div>;

  const isPro = status.tier === "pro_trial" || status.tier === "pro_active";

  async function upgrade() {
    const r = await billingApi.startCheckout(companyId);
    window.location.href = r.url;
  }
  async function manage() {
    const r = await billingApi.openPortal(companyId);
    window.location.href = r.url;
  }

  return (
    <div className="billing-page">
      <h1>Billing</h1>
      <div>Plan: <strong>{status.tier}</strong></div>
      <div>Seats paid: {status.seatsPaid}</div>
      {status.periodEnd && <div>Renews / ends: {new Date(status.periodEnd).toLocaleDateString()}</div>}
      {!isPro ? (
        <button onClick={upgrade}>Start Pro trial (14 days, no card)</button>
      ) : (
        <button onClick={manage}>Manage subscription</button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Route in App.tsx**

```tsx
import BillingPage from "./pages/BillingPage";
<Route path="/billing" element={<BillingPage companyId={currentCompanyId} />} />
```

- [ ] **Step 4: Commit**

```sh
git add ui/src/pages/BillingPage.tsx ui/src/api/billing.ts ui/src/App.tsx
git commit -m "feat(ui): BillingPage + API client"
```

### Task 7.2 — `UpgradePromptCard` + `TrialBanner`

**Files:**
- Create: `ui/src/components/UpgradePromptCard.tsx`
- Create: `ui/src/components/TrialBanner.tsx`

- [ ] **Step 1: UpgradePromptCard**

```tsx
// ui/src/components/UpgradePromptCard.tsx
import { billingApi } from "../api/billing";

export function UpgradePromptCard({
  reason,
  companyId,
}: {
  reason: "seat_cap_exceeded" | "agent_cap_exceeded";
  companyId: string;
}) {
  const message = reason === "seat_cap_exceeded"
    ? "Free workspaces are limited to 1 user."
    : "Free workspaces include only the Chief of Staff.";
  async function go() {
    const r = await billingApi.startCheckout(companyId);
    window.location.href = r.url;
  }
  return (
    <div className="card card--upgrade">
      <div>{message}</div>
      <button onClick={go}>Start Pro trial →</button>
    </div>
  );
}
```

- [ ] **Step 2: TrialBanner**

```tsx
// ui/src/components/TrialBanner.tsx
import { useEffect, useState } from "react";
import { billingApi } from "../api/billing";

export function TrialBanner({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<{ tier: string; periodEnd: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { billingApi.status(companyId).then(setStatus); }, [companyId]);
  if (!status || status.tier !== "pro_trial" || !status.periodEnd || dismissed) return null;
  const daysLeft = Math.max(0, Math.round((new Date(status.periodEnd).getTime() - Date.now()) / 86400000));
  return (
    <div className="trial-banner">
      Pro trial — {daysLeft} day{daysLeft === 1 ? "" : "s"} left. <a href="/billing">Add payment method</a>
      <button onClick={() => setDismissed(true)}>×</button>
    </div>
  );
}
```

- [ ] **Step 3: Wire into ChatPanel** (mount `TrialBanner` at the top of the chat UI; render `UpgradePromptCard` when an `onSend` API call returns 402)

- [ ] **Step 4: Commit**

```sh
git add ui/src/components/UpgradePromptCard.tsx ui/src/components/TrialBanner.tsx \
  ui/src/pages/ChatPanel.tsx
git commit -m "feat(ui): UpgradePromptCard + TrialBanner"
```

---

## Phase 8 — Reconciliation cron (failure-path safety net)

### Task 8.1 — Daily reconciliation

**Files:**
- Create: `server/src/services/billing-reconcile.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { billingReconcile } from "../services/billing-reconcile.js";

const mockCompanies = { listExpiredTrials: vi.fn() };
const mockStripe = { subscriptions: { retrieve: vi.fn() } };
const mockSync = { onSubscriptionUpdated: vi.fn() };

describe("billingReconcile.run", () => {
  it("for any pro_trial past period_end, fetches the subscription and re-syncs", async () => {
    mockCompanies.listExpiredTrials.mockResolvedValue([{ id: "c1", stripeSubscriptionId: "sub_1" }]);
    mockStripe.subscriptions.retrieve.mockResolvedValue({ id: "sub_1", status: "canceled", customer: "cus_1", items: { data: [{ quantity: 1 }] }, current_period_end: 0 });
    await billingReconcile({ companies: mockCompanies, stripe: mockStripe, sync: mockSync } as any).run();
    expect(mockStripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
    expect(mockSync.onSubscriptionUpdated).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// server/src/services/billing-reconcile.ts
interface Deps {
  companies: { listExpiredTrials: () => Promise<any[]> };
  stripe: any;
  sync: { onSubscriptionUpdated: (sub: any) => Promise<void> };
}

export function billingReconcile(deps: Deps) {
  return {
    run: async () => {
      const expired = await deps.companies.listExpiredTrials();
      for (const c of expired) {
        if (!c.stripeSubscriptionId) continue;
        try {
          const sub = await deps.stripe.subscriptions.retrieve(c.stripeSubscriptionId);
          await deps.sync.onSubscriptionUpdated(sub);
        } catch (err) {
          // Log + continue; reconciliation is best-effort.
        }
      }
    },
  };
}
```

- [ ] **Step 3: Schedule daily**

In `server/src/index.ts`, register a daily cron at 03:00 UTC:

```typescript
setInterval(() => {
  const now = new Date();
  if (now.getUTCHours() === 3 && now.getUTCMinutes() < 5) {
    billingReconcile({ /* deps */ }).run().catch((err) => logger.error({ err }, "billing reconcile failed"));
  }
}, 60 * 60 * 1000);
```

- [ ] **Step 4: Run + commit**

```sh
pnpm test:run -- billing-reconcile
git add server/src/services/billing-reconcile.ts server/src/index.ts \
  server/src/__tests__/billing-reconcile.test.ts
git commit -m "feat(server): daily billing reconciliation cron"
```

---

## Phase 9 — E2E

### Task 9.1 — Stripe-CLI-driven webhook test

**Files:**
- Create: `tests/e2e/billing.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";

test("Free user upgrades, lands on pro_trial, can invite a teammate", async ({ page }) => {
  await page.goto("/");
  // Sign up + onboard via existing harness (or use test seed)
  // ...
  // Try to invite while still Free → 402 / upgrade card
  await expect(page.getByText(/start pro trial/i)).toBeVisible();
  await page.getByRole("button", { name: /start pro trial/i }).click();
  // Stripe redirects in real Playwright tests use the testmode hosted page; simulate by hitting CLI:
  execSync(`stripe trigger customer.subscription.created --override "data.object.metadata.companyId=<test-company-id>"`);
  await page.waitForTimeout(2000);
  await page.goto("/billing");
  await expect(page.getByText(/pro_trial/i)).toBeVisible();
});
```

- [ ] **Step 2: Run with Stripe CLI listening**

```sh
# Tab 1
pnpm dev
# Tab 2
stripe listen --forward-to localhost:3100/api/billing/webhook
# Tab 3
pnpm playwright test tests/e2e/billing.spec.ts
```

- [ ] **Step 3: Commit**

```sh
git add tests/e2e/billing.spec.ts
git commit -m "test(e2e): billing happy path with Stripe CLI"
```

---

## Phase 10 — Final verification

### Task 10.1 — Regression suite

- [ ] **Step 1: Typecheck + tests + build**

```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

Expected: PASS.

### Task 10.2 — Manual QA checklist

- Sign up. Plan = `free`. Try to invite teammate → 402 + UpgradePromptCard.
- Click Start Pro Trial → Stripe checkout. Use test card `4242 4242 4242 4242`. Return.
- Plan = `pro_trial`. Invite 3 teammates → succeeds. Hire 2 agents → succeeds.
- Open Settings → Billing. See period end ~14 days out.
- In Stripe dashboard, manually cancel the subscription. Webhook fires.
- Plan = `pro_canceled`. Try to invite a 4th teammate → 402. Existing 3 still active.
- CoS chat shows the "subscription ended" message.

### Task 10.3 — Open the PR

Title: `feat: subscription + billing (Free + Pro per-seat with 14-day trial)`

```sh
git push -u origin <branch>
gh pr create --base main --head <branch> --title "feat: subscription + billing" --body "$(cat << 'EOF'
Implements docs/superpowers/specs/2026-05-02-billing-design.md.

- Two tiers: Free (1 human, 1 agent) + Pro (unlimited)
- Per-seat monthly billing via Stripe
- 14-day no-card trial (Stripe-managed trial_period_days)
- Lenient downgrade: existing access preserved, future writes capped
- Webhook handler with idempotent ledger
- Seat quantity sync on membership change
- Daily reconciliation cron as safety net

Verification: typecheck ✓, tests ✓, build ✓, e2e ✓ (Stripe CLI).
EOF
)"
```

---

## Decisions baked in (cross-reference to spec § 15)

| Decision | Implementation |
|---|---|
| Free + Pro tiers | Phase 2 caps + Phase 7 UI |
| Pro = invites + agent cap lifted | Phase 2 `requireTierFor` enforces caps; Pro short-circuits |
| Per-seat pricing | Phase 6 syncer updates Stripe quantity on membership change |
| 14-day no-card trial | Phase 3 checkout creates with `trial_period_days=14`, `missing_payment_method=cancel` |
| Lenient downgrade | Phase 2 caps only block future writes; existing data untouched |
| Stripe webhook is sole writer of `plan_tier` | Phase 4 entitlement-sync; application code never writes plan_tier directly |
| Idempotent webhook ledger | Phase 4 `stripe-webhook-ledger` |
| Daily reconciliation safety net | Phase 8 cron |
