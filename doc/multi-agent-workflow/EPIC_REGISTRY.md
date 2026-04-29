# AgentDash Epic & CUJ Registry

**Owner:** PM Agent
**Version:** 2.0 (2026-04-29 — AGE-20)
**Authoritative product source:** [`doc/PRD.md`](../PRD.md)

---

## Hierarchy

```
Epic (Linear label)
  └── CUJ (referenced in issue body / commit footer with #<epic>-<action>)
        └── Tests (tagged in test files with @<epic> #<cuj>)
```

Rules:
- Every Linear issue belongs to exactly **one** epic
- CUJs are referenced inline with `#<epic>-<action>` notation (kebab-case)
- A feature spanning multiple epics is too big — break it down before sizing
- Tests carry `@<epic> #<cuj>` tags for selective execution

---

## Epics

| Epic Label | Track | Purpose | Primary CUJs |
|---|---|---|---|
| `epic:onboarding` | A + B | First-run experience, multi-human onboarding, auth providers, request-to-join, ACL, people directory | CUJ-1 |
| `epic:agents` | A + B | Agent factory, lifecycle, identity, runtimes, skill registry, smart routing, **Track B citizen apps** | CUJ-3, CUJ-10, CUJ-14, CUJ-16-20 |
| `epic:crm` | A | CRM, HubSpot integration, customer 360, pipeline, agent impact | CUJ-7, CUJ-12, CUJ-13 |
| `epic:governance` | A + B | Security policies, kill switch, audit trail, policy engine | CUJ-5, CUJ-9 |
| `epic:ux` | — | Dashboard, navigation, conversation, DAG visualization | CUJ-2, CUJ-4, CUJ-15 |
| `epic:integrations` | A | External system manifests + sync (HubSpot, Slack, GitHub, Linear) | CUJ-7 |
| `epic:idea-to-cash` | — | Founder-mode 4-stage staircase: idea → spec → app → company | New project (AGE-64..83) |
| `epic:pipelines` | A | Multi-stage workflows, HITL gates, fan-out/fan-in (folded under Goals UI) | CUJ-6 |
| `epic:billing` | — | Tier gating, plans table, Stripe, entitlements UI | CUJ-E |

---

## CUJ catalogue (PRD.md anchored)

### Track A — Agent workforce

| CUJ | Title | Persona | Epic | Status |
|---|---|---|---|---|
| **#core-onboarding** (CUJ-1) | First-time setup wizard | P1 | onboarding | Operational |
| **#core-dashboard** (CUJ-2) | Morning check-in (60-sec scan) | P1 | ux | Operational |
| **#core-spawn** (CUJ-3) | Agent factory — spawn from templates | P1/P2 | agents | Operational |
| **#core-deps** (CUJ-4) | Task dependencies (DAG) | P2 | ux | Backend ✅, viz UI ✅ (AGE-96) |
| **#core-kill-switch** (CUJ-5) | Emergency halt | P1 | governance | Operational |
| **#core-pipeline** (CUJ-6) | Multi-stage workflows | P1/P2 | pipelines | Operational |
| **#crm-pipeline** (CUJ-7) | CRM pipeline review | P1 | crm | Operational |
| **#agents-research** (CUJ-8) | AutoResearch hypothesis loops | P1/P2 | agents | Operational (Pro tier) |
| **#governance-policy** (CUJ-9) | Security policy configuration | P1/P5 | governance | Operational; Track B target = open |
| **#agents-skills** (CUJ-10) | Skill management | P2 | agents | Operational |
| **#governance-budget** (CUJ-11) | Budget monitoring + forecast | P1 | governance | Operational |
| **#crm-360** (CUJ-12) | CRM Customer 360 | P1 | crm | Operational |
| **#crm-impact** (CUJ-13) | Agent impact on customer | P1 | crm | Operational |
| **#agents-routing** (CUJ-14) | Smart model routing (small/large) | P1/P2 | agents | Operational |
| **#ux-conversation** (CUJ-15) | Agent–human chat via comments | P2 | ux | Operational |

### Track B — Citizen apps (vibecoding) — *not built yet*

| CUJ | Title | Persona | Epic | Status |
|---|---|---|---|---|
| **#app-vibecode** (CUJ-16) | `/apps/new` authoring flow | P4 | agents | AGE-87 (P0 MVP) |
| **#app-review** (CUJ-17) | IT governance gate | P5/P4 | agents | AGE-88 (P0 MVP) |
| **#app-run** (CUJ-18) | Run a sanctioned app | P4 | agents | AGE-89 (P0 MVP) |
| **#app-governance** (CUJ-19) | Governance dashboard | P5 | agents | AGE-90 (P1) |
| **#app-share** (CUJ-20) | Cross-team catalog | P2/P4 | agents | AGE-91 (P2) |

### Onboarding sub-CUJs (`epic:onboarding`)

| CUJ | Description | Status |
|---|---|---|
| `#onboarding-auth-adapter` | Auth provider adapter (`AUTH_PROVIDER`) | Done (AGE-57) |
| `#onboarding-workos-auth` | WorkOS AuthKit sign-in | Done (AGE-58) |
| `#onboarding-pro-signup` | Corp-domain sign-up → admin | Done (AGE-55) |
| `#onboarding-free-mail-block` | Free-mail blocked on Pro | AGE-60 |
| `#onboarding-free-seat-cap` | Single-seat cap on Free | AGE-60 |
| `#onboarding-request-to-join` | Request flow + admin approval | AGE-61 |
| `#onboarding-jit-toggle` | JIT toggle | AGE-61 |
| `#onboarding-welcome` | Per-human welcome page | AGE-62 |
| `#onboarding-agent-acl` | Agent access grants UI | AGE-63 |
| `#onboarding-people-directory` | `/people` listing | AGE-63 |
| `#onboarding-prefill` | Pre-seeded company profile (MKthink) | AGE-92 |

### Idea-to-Cash sub-CUJs (`epic:idea-to-cash`)

| Phase | Tracking issues |
|---|---|
| Phase 1 — Foundations | AGE-64 (Intake & Chief of Staff handoff) |
| Phase 2 — Validation & Spec | AGE-65 |
| Phase 3 — Build & Ship | AGE-66 (parent), AGE-72-76 (sub-issues) |
| Phase 4 — GTM & Launch | AGE-67 |
| Phase 5 — Graduation | AGE-68, AGE-83 |

### Billing entitlements (`epic:billing`)

| CUJ | Description | Status |
|---|---|---|
| `#pay-tier-free` | Free tier limits (3 agents, 500 actions, 1 pipeline) | Operational |
| `#pay-tier-pro` | Pro tier — HubSpot ✅, AutoResearch ✅, Track B team ✅ | Operational |
| `#pay-tier-enterprise` | Enterprise unlimited + cross-team Track B | Operational |
| `#pay-stripe-checkout` | Stripe checkout session | Stubbed (AGE-77 / AGE-80) |
| `#pay-stripe-webhook` | Stripe webhook tier mapping | Stubbed (AGE-69 fix) |

---

## CUJ naming convention

```
#<epic-prefix>-<action>[-<variant>]

Examples (current):
- #core-onboarding         (epic:onboarding, CUJ-1)
- #core-dashboard          (epic:ux, CUJ-2)
- #crm-pipeline            (epic:crm, CUJ-7)
- #agents-research         (epic:agents, CUJ-8)
- #governance-policy       (epic:governance, CUJ-9)
- #app-vibecode            (epic:agents Track B, CUJ-16)
- #pay-stripe-checkout     (epic:billing)
```

---

## Issue sizing

| Size | Points | Effort | Test scope | Example |
|------|--------|--------|------------|---------|
| **XS** | 1 | < 1 day | Smoke only | Copy change, config tweak, single-line bug fix |
| **S** | 2 | 1-2 days | CUJ tests | Bug fix touching 1-2 files, minor feature, doc updates |
| **M** | 3 | 3-5 days | Epic tests | Feature enhancement, multiple CUJs, schema additive |
| **L** | 5 | 1-2 weeks | Multi-epic tests | New feature spanning areas, schema migration |
| **XL** | 8 | > 2 weeks | Full regression | Major refactor, new epic, system-wide change |

---

## Test commands by scope

```bash
# Per-issue test scope (size-driven)
pnpm test:e2e                                    # XS smoke (full E2E, fast paths)
npx playwright test --grep "#<cuj>"              # S — single CUJ
npx playwright test --grep "@<epic>"             # M — full epic
npx playwright test --grep "@<epic1>|@<epic2>"   # L — multi-epic
pnpm test:e2e && pnpm test:release-smoke         # XL — full regression

# API CUJ suite (all 10 in PRD)
bash scripts/test-cujs.sh

# Vitest (all packages)
pnpm test:run

# Typecheck + build (always before push)
pnpm -r typecheck && pnpm build
```

### Test-tag convention

```typescript
// tests/e2e/dashboard.spec.ts
import { test, expect } from "@playwright/test";

test.describe("@ux #core-dashboard Daily Dashboard", () => {
  test("60-second morning scan shows all-clear", async ({ page }) => {
    // ...
  });
});
```

---

## Linear label structure

### Epic labels (already in Linear)
```
epic:onboarding   epic:agents       epic:crm
epic:governance   epic:ux           epic:integrations
epic:idea-to-cash epic:pipelines    epic:billing
```

### Size labels
```
size:XS  size:S  size:M  size:L  size:XL
```

### Workflow labels (MAW)
```
PR-Ready  Testing  Tests-Passed  Tests-Failed
Locally-Tested  Staging-Tested  Human-Verified  In-Production
```

### Type labels
```
Bug  Feature  Improvement  Spike
```

---

## PM Agent responsibilities

The PM Agent owns:

1. **Maintaining this registry** — every new CUJ goes here; epic decisions documented
2. **Tagging Linear issues** — apply `epic:*`, `size:*`, type label, plus inline `#cuj-name` references in the body
3. **Sizing** — XS/S/M/L/XL per the table above
4. **Test plans** — every M+ ticket includes the exact test command per the scope rules
5. **Decomposing oversized work** — XL tickets get broken into smaller children before they enter the sprint queue (see AGE-93 → AGE-99 split as the canonical example)

## Track B reuse map

For the citizen-apps work (CUJs 16-20), the implementation reuses Track A primitives. Document this in every Track B issue's "Out of scope" section so reviewers know nothing is being re-invented:

| Track B need | Track A primitive being reused |
|---|---|
| Spec lifecycle | `skill_versions` (draft → in_review → approved → published → deprecated) |
| Sandbox runtime | `packages/plugins/sdk` worker isolate |
| Review workflow | Existing approval system + `it_reviewer` board-user role |
| Policy enforcement | `security_policies.appId` (additive column on existing table) |
| Cost attribution | `resource_usage.appId` (additive column) |
| Audit | Existing activity feed + CRM activity tables |
| Kill switch | CUJ-5 mechanism applies identically |
| Tier gating | `requireFeature('trackBPublish')` (Pro+) |
