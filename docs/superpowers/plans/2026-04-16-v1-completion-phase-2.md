# V1 Completion — Phase 2: Three-Tier Entitlements

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a three-tier entitlement system (Free / Pro / Enterprise) that gates features, caps usage, and surfaces limits in the UI — without touching Stripe yet.

**Architecture:** A single `plans` + `company_plan` pair of tables plus a pure `entitlements.ts` policy module mapping `tier → { featureFlags, limits }`. Server exposes a `requireTier()` middleware and a `/api/companies/:id/entitlements` read endpoint; UI reads from a `useEntitlements()` hook and gates premium affordances inline. Stripe hooks are stubbed behind a `BillingProvider` interface so Phase 3 plugs in without touching callers.

**Tech Stack:** Drizzle (Postgres), Express middleware, React/TanStack Query, Zod validators.

**Scope non-goals (deferred to Phase 3):** Real Stripe API calls, checkout sessions, invoice sync, webhook handlers. Phase 2 ships the shape; Phase 3 fills the billing provider.

---

## File Structure

**Create:**
- `packages/db/src/schema/plans.ts` — `plans` + `company_plan` tables
- `packages/shared/src/entitlements.ts` — tier → entitlements map, types
- `server/src/services/entitlements.ts` — read/write company tier + compute entitlements
- `server/src/services/__tests__/entitlements.test.ts`
- `server/src/middleware/require-tier.ts` — express middleware gating routes
- `server/src/routes/entitlements.ts` — GET current entitlements
- `server/src/routes/__tests__/entitlements-routes.test.ts`
- `ui/src/api/entitlements.ts`
- `ui/src/hooks/useEntitlements.ts`
- `ui/src/components/TierBadge.tsx` — small badge + upgrade CTA
- `ui/src/components/UpgradeDialog.tsx` — shared upgrade prompt
- `ui/src/pages/Billing.tsx` — current tier + limits + (stub) upgrade button
- `ui/src/pages/__tests__/Billing.test.tsx`
- `packages/billing/src/index.ts` — `BillingProvider` interface + `StubBillingProvider`
- `packages/billing/src/__tests__/provider.test.ts`
- `tests/e2e/cuj-e-entitlements.spec.ts`

**Modify:**
- `packages/db/src/schema/index.ts` — re-export plans tables
- `packages/shared/src/constants.ts` — `TIERS = ["free","pro","enterprise"]`
- `server/src/app.ts` — wire entitlements routes
- `server/src/routes/agents.ts` + `server/src/routes/action-proposals.ts` — apply `requireTier` for premium bits
- `ui/src/App.tsx` + `ui/src/components/Sidebar.tsx` — Billing nav item
- `ui/src/pages/Settings.tsx` — surface current tier

**Migration:** `pnpm db:generate` produces a single `00XX_plans.sql` migration after the schema file lands.

---

## Task 1: Shared tier constants + entitlements map

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/entitlements.ts`
- Create: `packages/shared/src/__tests__/entitlements.test.ts`

- [ ] **Step 1: Add tier constants**

In `packages/shared/src/constants.ts`:
```ts
export const TIERS = ["free", "pro", "enterprise"] as const;
export type Tier = (typeof TIERS)[number];
```

- [ ] **Step 2: Write failing test for entitlements map**

`packages/shared/src/__tests__/entitlements.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { entitlementsForTier, TIERS } from "../entitlements";

describe("entitlementsForTier", () => {
  it("returns limits and features for every tier", () => {
    for (const t of TIERS) {
      const e = entitlementsForTier(t);
      expect(e.limits.agents).toBeGreaterThan(0);
      expect(typeof e.features.hubspotSync).toBe("boolean");
    }
  });

  it("Pro has more agents than Free", () => {
    expect(entitlementsForTier("pro").limits.agents).toBeGreaterThan(
      entitlementsForTier("free").limits.agents,
    );
  });

  it("Enterprise unlocks hubspotSync", () => {
    expect(entitlementsForTier("enterprise").features.hubspotSync).toBe(true);
  });
});
```

Run: `pnpm -C packages/shared exec vitest run src/__tests__/entitlements.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement entitlements map**

`packages/shared/src/entitlements.ts`:
```ts
import type { Tier } from "./constants";
export { TIERS } from "./constants";

export type Entitlements = {
  tier: Tier;
  limits: {
    agents: number;
    monthlyActions: number;
    pipelines: number;
  };
  features: {
    hubspotSync: boolean;
    autoResearch: boolean;
    assessMode: boolean;
    prioritySupport: boolean;
  };
};

const TABLE: Record<Tier, Omit<Entitlements, "tier">> = {
  free: {
    limits: { agents: 2, monthlyActions: 500, pipelines: 1 },
    features: {
      hubspotSync: false,
      autoResearch: false,
      assessMode: false,
      prioritySupport: false,
    },
  },
  pro: {
    limits: { agents: 25, monthlyActions: 50_000, pipelines: 10 },
    features: {
      hubspotSync: true,
      autoResearch: true,
      assessMode: true,
      prioritySupport: false,
    },
  },
  enterprise: {
    limits: { agents: 1_000, monthlyActions: 5_000_000, pipelines: 1_000 },
    features: {
      hubspotSync: true,
      autoResearch: true,
      assessMode: true,
      prioritySupport: true,
    },
  },
};

export function entitlementsForTier(tier: Tier): Entitlements {
  return { tier, ...TABLE[tier] };
}
```

- [ ] **Step 4: Run tests to confirm green**

`pnpm -C packages/shared exec vitest run src/__tests__/entitlements.test.ts` → PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/shared/src/constants.ts packages/shared/src/entitlements.ts packages/shared/src/__tests__/entitlements.test.ts
git commit -m "feat(entitlements): define three-tier matrix"
```

---

## Task 2: DB schema for plans + company_plan

**Files:**
- Create: `packages/db/src/schema/plans.ts`
- Modify: `packages/db/src/schema/index.ts`
- Migration: `packages/db/drizzle/00XX_plans.sql` (generated)

- [ ] **Step 1: Write schema**

`packages/db/src/schema/plans.ts`:
```ts
import { pgTable, text, uuid, timestamp, index, uniqueIndex, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies";

export const plans = pgTable("plans", {
  id: text("id").primaryKey(), // "free" | "pro" | "enterprise"
  displayName: text("display_name").notNull(),
  monthlyPriceCents: integer("monthly_price_cents").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const companyPlan = pgTable(
  "company_plan",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull().references(() => plans.id),
    activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow().notNull(),
    // Phase 3 will populate these — kept nullable for now.
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
  },
  (t) => [index("company_plan_plan_idx").on(t.planId)],
);
```

- [ ] **Step 2: Re-export**

Add to `packages/db/src/schema/index.ts`:
```ts
export * from "./plans";
```

- [ ] **Step 3: Generate migration**

```sh
pnpm db:generate
pnpm -r typecheck
```

- [ ] **Step 4: Commit**

```sh
git add packages/db/src/schema/plans.ts packages/db/src/schema/index.ts packages/db/drizzle/
git commit -m "feat(db): add plans + company_plan tables"
```

---

## Task 3: Entitlements service

**Files:**
- Create: `server/src/services/entitlements.ts`
- Create: `server/src/services/__tests__/entitlements.test.ts`

- [ ] **Step 1: Write failing service tests**

`server/src/services/__tests__/entitlements.test.ts`: test `getTier("c1")` returns `"free"` when no row; returns stored tier when row present; `setTier` upserts; `getEntitlements("c1")` returns merged limits+features.

- [ ] **Step 2: Implement service**

```ts
import type { Db } from "@agentdash/db";
import { companyPlan } from "@agentdash/db";
import { eq } from "drizzle-orm";
import { entitlementsForTier, type Tier, type Entitlements } from "@agentdash/shared";

export function entitlementsService(db: Db) {
  return {
    async getTier(companyId: string): Promise<Tier> {
      const rows = await db
        .select()
        .from(companyPlan)
        .where(eq(companyPlan.companyId, companyId))
        .limit(1);
      return (rows[0]?.planId as Tier) ?? "free";
    },
    async setTier(companyId: string, tier: Tier): Promise<void> {
      await db
        .insert(companyPlan)
        .values({ companyId, planId: tier })
        .onConflictDoUpdate({
          target: companyPlan.companyId,
          set: { planId: tier, activatedAt: new Date() },
        });
    },
    async getEntitlements(companyId: string): Promise<Entitlements> {
      const tier = await this.getTier(companyId);
      return entitlementsForTier(tier);
    },
  };
}
```

- [ ] **Step 3: Tests green, commit**

```sh
git add server/src/services/entitlements.ts server/src/services/__tests__/entitlements.test.ts
git commit -m "feat(entitlements): add service over company_plan table"
```

---

## Task 4: `requireTier` middleware + tier gates

**Files:**
- Create: `server/src/middleware/require-tier.ts`
- Create: `server/src/middleware/__tests__/require-tier.test.ts`
- Modify: `server/src/routes/agents.ts` (apply to spawn endpoint when over free-tier limit)
- Modify: `server/src/routes/action-proposals.ts` (apply to proposals-by-agent filter when feature gated)

- [ ] **Step 1: Write middleware**

```ts
import type { RequestHandler } from "express";
import type { Tier } from "@agentdash/shared";
import { entitlementsService } from "../services/entitlements";
import type { Db } from "@agentdash/db";

const TIER_ORDER: Record<Tier, number> = { free: 0, pro: 1, enterprise: 2 };

export function requireTier(db: Db, min: Tier): RequestHandler {
  const svc = entitlementsService(db);
  return async (req, res, next) => {
    const companyId = (req.params as { companyId?: string }).companyId;
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    const tier = await svc.getTier(companyId);
    if (TIER_ORDER[tier] < TIER_ORDER[min]) {
      return res.status(402).json({
        error: "tier_insufficient",
        currentTier: tier,
        requiredTier: min,
      });
    }
    next();
  };
}
```

- [ ] **Step 2: Write tests (free blocked, pro allowed, enterprise allowed)**

- [ ] **Step 3: Apply gates to 2 premium surfaces**

Gate HubSpot sync endpoint with `requireTier(db, "pro")`.
Gate AutoResearch cycle creation with `requireTier(db, "pro")`.

- [ ] **Step 4: Tests + commit**

```sh
git commit -m "feat(entitlements): add requireTier middleware + apply to premium routes"
```

---

## Task 5: Entitlements route

**Files:**
- Create: `server/src/routes/entitlements.ts`
- Create: `server/src/routes/__tests__/entitlements-routes.test.ts`
- Modify: `server/src/app.ts` + `server/src/routes/index.ts`

- [ ] Expose `GET /api/companies/:companyId/entitlements` → returns `Entitlements` JSON.
- [ ] Expose `PATCH /api/companies/:companyId/entitlements` admin-only → sets tier (hidden behind `X-AgentDash-Admin` header for now; Phase 3 replaces with Stripe webhook).
- [ ] Route test + wire + commit.

---

## Task 6: UI client + hook

**Files:**
- Create: `ui/src/api/entitlements.ts`
- Create: `ui/src/hooks/useEntitlements.ts`
- Create: `ui/src/hooks/__tests__/useEntitlements.test.tsx`

- [ ] Implement `entitlementsApi.get(companyId)` and `useEntitlements()` that reads from `useCompany().selectedCompanyId`.
- [ ] Test hook with react-query mocks; commit.

---

## Task 7: TierBadge + UpgradeDialog components

**Files:**
- Create: `ui/src/components/TierBadge.tsx`
- Create: `ui/src/components/UpgradeDialog.tsx`
- Tests for both

- [ ] Badge shows current tier pill. Dialog explains tier diff and has a stub CTA ("Contact sales" in Phase 2; replaced with Stripe checkout in Phase 3).
- [ ] Tests + commit.

---

## Task 8: Billing page

**Files:**
- Create: `ui/src/pages/Billing.tsx`
- Create: `ui/src/pages/__tests__/Billing.test.tsx`
- Modify: `ui/src/App.tsx` (route), `ui/src/components/Sidebar.tsx` (nav), `ui/src/pages/Settings.tsx` (link)

- [ ] Page shows: current tier, limits vs usage (read from existing `capacity` endpoint), feature list with check/cross, tier ladder table, upgrade CTA.
- [ ] Tests + commit.

---

## Task 9: Gate UI affordances inline

**Files:** various pages that surface premium features.

- [ ] HubSpot Settings page: if `!features.hubspotSync`, show UpgradeDialog trigger instead of config form.
- [ ] AutoResearch page: same pattern.
- [ ] Dashboard Needs-Attention list: hide premium items when tier lacks them.
- [ ] Commit per surface.

---

## Task 10: Billing provider seam (stub only)

**Files:**
- Create: `packages/billing/package.json`
- Create: `packages/billing/src/index.ts`
- Create: `packages/billing/src/__tests__/provider.test.ts`

- [ ] Define `BillingProvider` interface: `createCheckoutSession`, `cancelSubscription`, `syncEntitlement`. `StubBillingProvider` just logs.
- [ ] Add to `pnpm-workspace.yaml` (already covered by `packages/*`).
- [ ] Tests + commit.

---

## Task 11: CUJ-E E2E test

**Files:**
- Create: `tests/e2e/cuj-e-entitlements.spec.ts`

- [ ] Navigate to `/billing`, assert current tier badge renders.
- [ ] Assert feature rows render with correct availability for seeded company (default tier = free).
- [ ] Attempt to access a gated page (e.g., HubSpot Settings) → upgrade dialog appears.
- [ ] Commit.

---

## Task 12: Phase 2 gate

- [ ] Run `pnpm -r typecheck`
- [ ] Run `pnpm test:run`
- [ ] Run `pnpm build`
- [ ] Run `bash scripts/test-cujs.sh`
- [ ] Update `doc/CUJ-STATUS.md` with CUJ-E row and phase 2 status
- [ ] Commit docs

---

## Self-Review Checklist

- [ ] Every tier-gated surface has an inline upgrade path (no dead 402s from the UI)
- [ ] Entitlements computed server-side; UI never trusts client state for gates
- [ ] `BillingProvider` interface stable enough that Phase 3 can drop in Stripe without touching consumers
- [ ] Seed data sets first company to `free` so gates are exercised locally
- [ ] No Stripe references in Phase 2 (stays out until Phase 3)

---

## Phase 3 Preview (for reference, not implemented here)

Phase 3 will swap `StubBillingProvider` for a Stripe-backed implementation, add `/api/billing/webhook` with signature verification, implement checkout session creation on the UpgradeDialog CTA, and keep entitlements in sync via webhook → `entitlementsService.setTier()`.
