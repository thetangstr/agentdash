# V1 Completion Spec — Close UI Stubs + Tiered Entitlements + Stripe Billing

**Date:** 2026-04-16
**Status:** Approved (design)
**Goal:** Close out every "coming soon" surface in the UI, introduce a three-tier entitlement model (Free / Pro / Enterprise) enforced server-side, and integrate Stripe Checkout + Customer Portal + webhook-driven subscription sync so customers can self-serve upgrades.

---

## 1. Motivation

The product has 12+ stub pages, 4 gated adapters, and a commented-out skills view. Sales conversations require a coherent demo that walks CRM and agent-governance flows end-to-end. Revenue infrastructure is absent: premium capabilities (CRM, HubSpot, unlimited agents) must be gated behind a paid tier with self-serve billing.

## 2. Scope

Three phases executed sequentially. Each phase has its own sub-plan and verification gate. On green gate, the next phase begins automatically.

### Phase 1 — Close UI Stubs + CUJ Integration
All "coming soon" surfaces become functional. Stubs are closed **grouped by Critical User Journey**, not alphabetically, so each journey is end-to-end testable.

### Phase 2 — Entitlements & Tier Limits
Server-side enforcement of a three-tier model. No client-side trust. Admin override table for sales deals.

### Phase 3 — Stripe Integration
Self-serve Checkout + Customer Portal + webhook-driven tier sync. No admin toggles except the Phase 2 override escape hatch.

### Out of Scope
- Usage-based metering / overage billing (schema ready, billing shipped in 3.5)
- Seat-based billing beyond fixed inclusions (Pro = 5 seats, Enterprise = unlimited)
- Multi-currency / tax (Stripe Tax handles US sales tax only)
- Annual contract wet-signature flow (Enterprise tier manual-invoice handoff)

---

## 3. Critical User Journey (CUJ) Mapping

Stubs are grouped into 4 CUJs. Each CUJ ships with an end-to-end integration test that walks the full flow.

### CUJ-A: Lead → Close (Sales Pipeline)
`CrmLeads` (capture/qualify) → convert action → `CrmDealDetail` (single deal view) → `CrmKanban` (pipeline board) → `CrmPipeline` (fix WIP `@ts-nocheck` page) → `HubSpotSettings` (bidirectional sync config)

- **Shared contract:** deal/lead/contact schema round-trips through HubSpot
- **Gating:** HubSpot sync is Pro-tier; CRM entities exist on Free for preview/upsell
- **Gate test:** seed a lead → convert → deal advances through kanban → synced to HubSpot (mocked) → deal detail shows sync status

### CUJ-B: Agent Governance Loop
Agent proposes action → `ActionProposals` (approve/reject queue) → approved action emits event to `Feed` (audit trail) → affects linked `issues`/`budget`

- **Shared contract:** `action_proposals` link to `issues` and emit `feed_events`
- **Gate test:** seed agent proposing action → appears in ActionProposals → approve → Feed shows event → linked issue updated

### CUJ-C: Personal Productivity Surface
`Feed` aggregates my agent heartbeats + issue updates + goal progress + action proposals needing me → `UserProfile` manages API keys those agents use → loop back to agent config

- **Shared contract:** Feed event types cover every user-visible activity; UserProfile API keys referenced by `AgentConfigForm`
- **Gate test:** seed agent activity + issue update + goal edit → Feed shows all 3 chronologically → UserProfile edit API key → agent config reflects new key

### CUJ-D: Adapter Onboarding
`InviteLanding` (4 gated adapters) → adapter picked → `AgentConfigForm` dropdown (1 gated) → `adapter-display-registry` (3 gated) → `AgentDetail` skills view (currently commented out)

- **Shared contract:** "coming soon" → "available" flip is atomic across all 4 surfaces
- **Gate test:** flip 4 gated adapters available → InviteLanding + AgentConfigForm + registry + AgentDetail all show unlocked atomically

### CUJ Execution Order (Phase 1)
1. **CUJ-D** — unlocks adapters, prerequisite for real agent testing
2. **CUJ-B** — ActionProposals + Feed wired to existing agent/issue data
3. **CUJ-A** — CRM chain + HubSpot settings
4. **CUJ-C** — UserProfile + Feed personalization

---

## 4. Three-Tier Model

### 4.1 Tier Matrix

| Capability | Free | Pro | Enterprise |
|---|---|---|---|
| Active agents | **2** | 25 | unlimited |
| Tool calls per heartbeat | **5** | 50 | unlimited |
| Min heartbeat interval | **10 min** | 1 min | 1 min |
| Manual wake-up | yes | yes | yes |
| CRM module | — | ✓ | ✓ |
| HubSpot sync | — | ✓ | ✓ |
| Action Proposals | ✓ | ✓ | ✓ |
| Custom adapters | — | — | ✓ |
| SSO / SAML | — | — | ✓ |
| Audit log export | — | — | ✓ |
| Seats included | 1 | 5 | unlimited |

### 4.2 Tier Transitions
- **Free → Pro:** self-serve Stripe Checkout, instant unlock
- **Pro → Enterprise:** "Contact Sales" link → manual invoice flow → admin sets override
- **Pro → Free (downgrade):** retain tier until `current_period_end`; on downgrade, agents beyond cap are paused (not deleted), heartbeat intervals clamped, CRM data read-only
- **Past-due:** 7-day grace at current tier before downgrade

---

## 5. Architecture

### 5.1 Database Schema (Migration 0060)

```ts
// packages/db/src/schema/billing.ts

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id).unique(),
  tier: text("tier").$type<"free" | "pro" | "enterprise">().notNull().default("free"),
  status: text("status").$type<
    "active" | "past_due" | "canceled" | "trialing" | "incomplete"
  >().notNull().default("active"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("subscriptions_company_idx").on(t.companyId),
  index("subscriptions_stripe_customer_idx").on(t.stripeCustomerId),
]);

export const entitlementOverrides = pgTable("entitlement_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  key: text("key").notNull(),
  valueJson: jsonb("value_json").notNull(),
  reason: text("reason").notNull(),
  expiresAt: timestamp("expires_at"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("entitlement_overrides_company_idx").on(t.companyId),
]);
```

### 5.2 New Package: `packages/entitlements`

```
packages/entitlements/src/
├── tiers.ts          # Tier → limits mapping (single source of truth)
├── resolve.ts        # resolveEntitlements(db, companyId) → Entitlements
├── gates.ts          # assertCanCreateAgent, assertToolBudget, assertHeartbeatInterval, assertCapability
├── errors.ts         # EntitlementError with 402 response shape
└── index.ts
```

**Tier definition:**
```ts
export const TIERS = {
  free: {
    maxAgents: 2,
    maxToolCallsPerHeartbeat: 5,
    minHeartbeatIntervalMs: 600_000,
    capabilities: ["action_proposals"] as const,
    includedSeats: 1,
  },
  pro: {
    maxAgents: 25,
    maxToolCallsPerHeartbeat: 50,
    minHeartbeatIntervalMs: 60_000,
    capabilities: ["action_proposals", "crm", "hubspot"] as const,
    includedSeats: 5,
  },
  enterprise: {
    maxAgents: Infinity,
    maxToolCallsPerHeartbeat: Infinity,
    minHeartbeatIntervalMs: 60_000,
    capabilities: ["action_proposals", "crm", "hubspot", "custom_adapters", "sso", "audit_export"] as const,
    includedSeats: Infinity,
  },
} as const;
```

**402 response shape:**
```ts
{
  error: "entitlement_required",
  tier_required: "pro",
  current_tier: "free",
  limit_hit: "agents" | "tool_calls" | "heartbeat_interval" | "capability",
  upgrade_url: "/billing/upgrade",
}
```

### 5.3 Enforcement Points

| Location | Gate |
|---|---|
| `POST /agents` | `assertCanCreateAgent(companyId)` — count active, reject at limit |
| Agent tool-execution loop (`server/src/services/assistant.ts`, agent runner) | `assertToolBudget(heartbeatId)` — increment counter, stop at limit |
| `PATCH /agents/:id/heartbeat-interval` | `clampHeartbeatInterval(companyId, requestedMs)` |
| `/api/crm/**` routes | `assertCapability(companyId, "crm")` |
| `/api/hubspot/**` routes | `assertCapability(companyId, "hubspot")` |
| Middleware | `req.entitlements` populated per-request |

### 5.4 Stripe Integration

**Products/Prices** (created via idempotent script `scripts/stripe-bootstrap.ts`):
- `product_agentdash_pro` + monthly/annual prices
- `product_agentdash_enterprise` (manual invoice; no self-serve price)

**Webhook:** `POST /api/billing/webhook` (raw body, signature verified)

**Events handled:**
- `checkout.session.completed` → upsert subscription, set tier
- `customer.subscription.updated` → sync tier, period end, cancel flag
- `customer.subscription.deleted` → downgrade to Free at period end
- `invoice.payment_failed` → mark past_due, start grace period
- `invoice.payment_succeeded` → clear past_due

**Routes** (`server/src/routes/billing.ts`):
- `POST /api/billing/checkout` — returns Checkout URL
- `POST /api/billing/portal` — returns Customer Portal URL
- `GET /api/billing/subscription` — current tier + status
- `POST /api/billing/webhook` — signature-verified

**Env vars:**
```
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRO_PRICE_MONTHLY_ID
STRIPE_PRO_PRICE_ANNUAL_ID
STRIPE_PORTAL_CONFIGURATION_ID
```

If missing in dev, billing routes return 503 and UI hides billing surfaces.

### 5.5 Frontend

- `useEntitlements()` hook — loads once, exposes `can(key)`, `limit(key)`, `usage(key)`
- `<Gated capability="crm">` wrapper — lock state + upgrade CTA when blocked
- `ui/src/pages/Billing.tsx` — tier card, upgrade button, portal button
- Every 402 → upgrade modal with CTA to `/billing/upgrade`

---

## 6. Rollout

1. **Phase 1 ships first** — stubs closed, no gating yet
2. **Phase 2 ships behind `ENTITLEMENTS_ENABLED=false`** — all existing companies backfilled to Enterprise override (grandfathered)
3. **Phase 2 flip** — new signups default to Free, flag set to true
4. **Phase 3 ships behind `BILLING_ENABLED=false`** — Stripe integration hidden
5. **Phase 3 flip** — Stripe test mode in staging, then live in prod after QA

Each flag flips independently; rollback does not lose data.

---

## 7. Security

- Webhook signature verification mandatory; unsigned → 400
- `STRIPE_SECRET_KEY` never logged, never to client
- Customer Portal URLs single-use, short-lived (Stripe default 5 min)
- No raw card data touches our server
- Entitlements enforced server-side only; UI gates are UX, never trusted
- Override table requires `instance_admin`; all writes logged
- 402 responses don't leak tier-gate logic internals
- HubSpot OAuth tokens encrypted at rest

---

## 8. Observability

- Metrics: `entitlement_gate_hits{tier,capability}`, `stripe_webhook_events{type,status}`, `tier_distribution{tier}`
- Log every 402 with `{company_id, user_id, gate_key}` → upgrade-funnel analysis
- Alert on webhook failure rate > 1% or signature verification failures > 0

---

## 9. Verification Gates

Each phase must pass before the next begins:

```sh
pnpm -r typecheck              # 0 errors
pnpm test:run                  # 100% pass
pnpm build                     # exit 0
bash scripts/test-cujs.sh      # all CUJs green (Phase 1+)
```

**Phase-specific gates:**
- **Phase 1 gate:** all 4 CUJ integration tests green
- **Phase 2 gate:** Free-tier integration tests show 402 at each limit; Enterprise override passes all
- **Phase 3 gate:** Stripe test-mode E2E (Checkout + Portal + cancel-and-downgrade) passes; webhook signature verification 100%

Test coverage floor: 80% line coverage for new code; 100% for entitlement gates + webhook handlers.

---

## 10. PRD & Docs Updates

- Add **CUJ-16 (Assess)** and **CUJ-17 (Assistant Chatbot)** to `doc/PRD.md`
- Add **tier matrix** to `doc/PRD.md` (single source of truth)
- Update `doc/CUJ-STATUS.md` for Phase 1 closures
- Reconcile pricing in `doc/BUSINESS-PLAN.md` with tier matrix
- `ARCHITECTURE.md` gains entitlements + billing sections
- `.env.example` adds Stripe vars
- New: `doc/BILLING-RUNBOOK.md` — webhook debugging, support ops

---

## 11. Non-Goals & Explicit Trade-offs

- **Not building in-app seat management** this phase (Pro gets 5 fixed seats; Enterprise unlimited — no assignment UI)
- **Not building proration UI** — Stripe handles proration server-side; user sees final amount in Checkout
- **Not building tax UI** — Stripe Tax handles US sales tax only; international handled manually
- **Not building usage dashboards** — usage metrics logged for Phase 3.5 metered billing

---

## 12. Sub-Plans

- `docs/superpowers/plans/2026-04-16-v1-completion-phase-1.md` — Close UI stubs by CUJ
- `docs/superpowers/plans/2026-04-16-v1-completion-phase-2.md` — Entitlements + limits
- `docs/superpowers/plans/2026-04-16-v1-completion-phase-3.md` — Stripe integration

Each sub-plan is self-contained and executable. Auto-chaining: on Phase N gate green, Phase N+1 plan begins.
