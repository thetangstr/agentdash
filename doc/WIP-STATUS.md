# WIP Status — 2026-04-20

Snapshot of in-flight work across Conductor workspaces, mapped to Linear gaps.
Regenerate by re-running the audit prompt; do not edit by hand.

## Conductor workspaces (8 total under `townhall/`)

| Workspace | Branch | Last commit | Dirty files | Status |
|---|---|---|---|---|
| `agentdash` | `feat/v1-completion-phase-1` | 3h ago | 112 | **active (duplicate of san-francisco-v1)** |
| `san-francisco-v1` | `feat/v1-completion-phase-1` | 3h ago | 112 | **active (primary)** |
| `dakar` | `kailortang-prog/agent-context-cleanup` | 2 weeks ago | 1 | stale |
| `dakar-v1` | `kailortang-prog/agent-gmail-access` | 3 weeks ago | 3 | stale |
| `hangzhou` | `kailortang-prog/hangzhou` | 3 weeks ago | 0 | stale |
| `miami-v1` | `kailortang-prog/gstack-office-hours` | 3 weeks ago | 0 | stale |
| `santiago` | `kailortang-prog/review-status` | 3 weeks ago | 0 | stale |
| `review-status` | `kailortang-prog/review-status` | 3 weeks ago | 0 | stale |

Only one unit of active work (Phase 1 completion). The other workspaces are abandoned branches — candidates for cleanup.

## Linear vs reality gap

Linear AGE has 28 issues: 7 Done (UI Sprint), 16 Backlog (v1 Launch), 0 in-progress, 5 noise.
**The 112-file diff on `feat/v1-completion-phase-1` has zero Linear issue backing.**

## In-flight themes (no Linear issue)

Themes inferred from `git log` + `git status`. Each = a candidate Linear issue.

### P0 — Billing / Stripe / Entitlements (largest thread)
- `stripe-provider.ts`, `stripe-types.ts`, `stripe-provider.test.ts` (new)
- `billing_events` schema + migration 0073/0074
- `BillingProvider` seam, `useEntitlements` hook, `TierBadge`, `UpgradeDialog`, Billing page
- Inline premium-UI gating, plan rows seeded
- CUJ-E entitlements e2e spec
- **Proposed:** `AGE-29 Wire Stripe billing provider end-to-end` (L)

### P0 — Goal-driven agent workflow
- `agent_goals` + `agent_plans` schema (new tables)
- `server/src/services/agent-plans.ts` (new)
- `packages/shared/src/validators/agent-plan.ts` (new)
- Plan doc: `doc/plans/2026-04-20-goal-driven-workflow-plan.md`
- **Proposed:** `AGE-30 Implement goal-driven workflow (agent goals + plans)` (XL)

### P1 — E2E test coverage expansion
- 6+ new specs: `agent-factory`, `budget`, `comments`, `crm-customer360`, `crm-pipeline`, `dashboard`, `full-journey`
- Phase-1 CUJ orchestrator (commit `ccfbc14e`)
- **Proposed:** `AGE-31 Phase-1 CUJ test coverage suite` (M)

### P1 — Luxury control-plane UI redesign
- LuxePageHeader rolled out to Feed/Billing/Costs/Pipelines (commit `2ceca73e`)
- Sidebar + BreadcrumbBar reskinned (`0a808798`)
- shadcn token migration (`250c998c`)
- Dashboard redesign (`a7cf04db`)
- WelcomePage + CrmLeads modifications (dirty)
- **Proposed:** `AGE-32 Luxury control-plane UI rollout` (L)

### P1 — Security hardening (already shipped)
- Commit `bf49a2aa` closed company-boundary holes + XSS in assess pages
- **Proposed:** `AGE-33 Security: company-boundary + XSS in assess pages` (S, mark Done immediately — backfill issue for audit trail)

### P2 — GTM / sales narrative
- `doc/plans/2026-04-09-agentdash-gtm-plan.md`
- `doc/plans/2026-04-09-agentdash-gtm-positioning.md`
- `doc/plans/2026-04-09-agentdash-sales-deck-outline.md`
- `doc/plans/2026-04-09-agentdash-sales-narrative.md`
- **Proposed:** `AGE-34 GTM/sales narrative + positioning v1` (M)

### P2 — Smart model routing
- Design doc `docs/superpowers/specs/2026-04-12-smart-model-routing-design.md`
- Plan doc `docs/superpowers/plans/2026-04-12-smart-model-routing.md`
- **Proposed:** `AGE-35 Smart model routing implementation` (L)

### P2 — Conversational mode (P2 chat)
- Design doc `docs/superpowers/specs/2026-04-12-conversational-mode-design.md`
- Memory: dual-mode dashboard + chat
- **Proposed:** `AGE-36 Conversational mode (P2 chat surface)` (XL)

### P2 — Maxiaoer client deploy
- `scripts/deploy-maxiaoer.sh` (new)
- **Proposed:** `AGE-37 Maxiaoer first-client deploy` (M)

### P2 — Integration test quality assessment
- Plan doc `docs/superpowers/plans/2026-04-15-assess-integration-test-quality.md`
- Spec `docs/superpowers/specs/2026-04-15-assess-integration-test-quality-design.md`
- **Proposed:** `AGE-38 Assess + improve integration test quality` (M)

### Gaps surfaced (no work but should exist)
- **HubSpot integration is P0 per memory** — first client uses HubSpot. No Linear issue, no dirty code on this branch.
  - **Proposed:** `AGE-39 HubSpot integration for first client` (XL, **flag as next**)

## Critical path (recommended)

1. **Commit & ship** the 112-file diff on `feat/v1-completion-phase-1` first (split into 3-4 PRs by theme: billing, goal-driven, tests, UI). Don't start anything new while this is open.
2. **AGE-39 HubSpot** — P0, blocks first client.
3. **AGE-30 Goal-driven workflow** — already in-flight, finish it.
4. **AGE-37 Maxiaoer deploy** — first client gate.
5. Backlog grooming: AGE-6 through AGE-23 (UI features) — defer until post-client.

## Cleanup candidates
- Delete stale workspaces: `dakar`, `dakar-v1`, `hangzhou`, `miami-v1`, `santiago`, `review-status` (all 3 weeks idle, branches landed or abandoned)
- Delete `agentdash` workspace (duplicate of `san-francisco-v1`)
