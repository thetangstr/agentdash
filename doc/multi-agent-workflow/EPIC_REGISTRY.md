# Epic & CUJ Registry Template

> Customize this for your project. Add your epics and CUJs below.

**Owner:** PM Agent
**Version:** 1.0

---

## Hierarchy Overview

```
Epic (labeled in Linear)
  +-- CUJ (referenced in issue title/description with #cuj-name)
        +-- Tests (tagged with @epic and @cuj in test files)
```

**Rules:**
- Every Linear issue belongs to exactly ONE epic
- CUJs are referenced inline with `#cuj-name` notation
- No feature should span multiple epics (if it does, scope is too big)
- Tests are tagged for selective execution by epic or CUJ

---

## Epics

| Epic Label | Description | Example CUJs |
|-----------|-------------|--------------|
| `epic:onboarding` | Human onboarding, auth providers, sign-up flows, request-to-join, ACL, people directory | #onboarding-pro-signup, #onboarding-request-to-join, #onboarding-jit-toggle, #onboarding-welcome, #onboarding-people-directory |
| `epic:auth` | Pre-existing auth flows (better-auth path) — being subsumed by `epic:onboarding` | #auth-login, #auth-signup, #auth-session |
| `epic:agents` | Agent factory, lifecycle, identity, runtimes | TBD |
| `epic:goals` | Business Goals, Chief-of-Staff, KPIs | TBD |
| `epic:crm` | CRM, HubSpot integration, contacts, opportunities | TBD |
| `epic:billing` | Plan tiers, Stripe, agent-count slider | TBD (gated on pricing decision) |
| `epic:admin` | Admin/CEO tools, audit log, instance settings | #admin-join-requests, #admin-agent-grants |

---

## CUJ Naming Convention

```
#<epic-prefix>-<action>[-<variant>]

Examples:
- #auth-login         (auth epic, login action)
- #auth-oauth         (auth epic, OAuth variant)
- #core-create        (core epic, create action)
- #pay-checkout       (billing epic, checkout action)
- #pay-subscribe      (billing epic, subscribe action)
```

---

## Epic Detail: ONBOARDING

Multi-human × multi-agent onboarding. Two deployment shapes (self-hosted Free / cloud Pro) behind a single `IAuthProvider` adapter. Owns: auth provider abstraction, sign-up flows, invitations, request-to-join + admin approval, per-user welcome, agent-access grants, people directory.

**Linear epic:** AGE-56. **Children:** AGE-57 → AGE-63.

| CUJ ID | CUJ Name | Description | User Type |
|--------|----------|-------------|-----------|
| `#onboarding-auth-adapter` | Auth provider adapter | Backend code routes through `IAuthProvider`; provider selected by `AUTH_PROVIDER` env | Internal |
| `#onboarding-workos-auth` | WorkOS sign-in/sign-up | Cloud Pro sign-in/sign-up backed by WorkOS AuthKit (free tier) | Cloud admin/member |
| `#onboarding-org-claim` | Domain claim (DNS) | WorkOS DNS-verified corp domain claim creates/joins org | Cloud admin |
| `#onboarding-jit` | JIT auto-join | Verified-domain user auto-added to org when JIT toggle is on | Cloud member |
| `#onboarding-jit-toggle` | JIT toggle | Admin flips per-org `allowJitProvisioning`; subsequent sign-ups skip request flow | Cloud admin |
| `#onboarding-user-mirror` | WorkOS user mirror | WorkOS users mirrored to local `authUsers` via webhooks | Internal |
| `#onboarding-pro-signup` | Pro corp-domain sign-up | First human at corp domain becomes admin/CEO | Cloud admin |
| `#onboarding-free-signup` | Free single-user sign-up | Solo user signs up on self-hosted Free | Self-hosted admin |
| `#onboarding-free-mail-block` | Free-mail block on Pro | Pro sign-up at gmail/yahoo/etc → 400 with clear error | Cloud visitor |
| `#onboarding-free-seat-cap` | Free single-seat hard cap | 2nd sign-up on self-hosted Free → blocked with upgrade CTA | Self-hosted visitor |
| `#onboarding-request-to-join` | Request to join | 2nd human at corp domain submits request, lands in admin inbox | Cloud member |
| `#onboarding-admin-approve` | Admin approves request | Admin one-click approves; member joins; activity logged | Cloud admin |
| `#onboarding-admin-deny` | Admin denies request | Admin denies with optional reason | Cloud admin |
| `#onboarding-email-invite` | Invite email delivered | Invite email reaches recipient (WorkOS or Resend relay) | All |
| `#onboarding-email-notify` | Admin notification email | Admin gets email on join requests | Cloud admin |
| `#onboarding-email-fallback` | Copy-link fallback | Self-hosted offline → invite UI shows copy-link banner | Self-hosted admin |
| `#onboarding-welcome` | Per-human welcome | New human's first visit; basic profile + tour | All members |
| `#onboarding-welcome-skip` | Welcome skip | Returning user with completed welcome → straight to dashboard | All members |
| `#onboarding-agent-acl` | Agent access grants | Admin grants/revokes per-agent access (read/use/edit) | Cloud admin |
| `#onboarding-people-directory` | People directory | All humans + agents in `/people` | All members |
| `#onboarding-people-search` | People filter | Search/filter by role / by agent | All members |

**Test Files (planned):**
- `server/src/__tests__/auth-provider-contract.test.ts` -> @onboarding #onboarding-auth-adapter
- `server/src/__tests__/workos-provider.test.ts` -> @onboarding #onboarding-workos-auth #onboarding-jit
- `server/src/__tests__/workos-webhook-route.test.ts` -> @onboarding #onboarding-user-mirror
- `server/src/__tests__/email-service.test.ts` -> @onboarding #onboarding-email-invite #onboarding-email-fallback
- `server/src/__tests__/signup-pro-free-mail-block.test.ts` -> @onboarding #onboarding-free-mail-block
- `server/src/__tests__/signup-free-seat-cap.test.ts` -> @onboarding #onboarding-free-seat-cap
- `server/src/__tests__/companies-email-domain-route.test.ts` -> @onboarding #onboarding-pro-signup (already exists, AGE-55)
- `server/src/__tests__/join-requests-routes.test.ts` -> @onboarding #onboarding-request-to-join #onboarding-admin-approve #onboarding-admin-deny
- `server/src/__tests__/jit-toggle-route.test.ts` -> @onboarding #onboarding-jit-toggle
- `server/src/__tests__/welcome-state-route.test.ts` -> @onboarding #onboarding-welcome
- `ui/src/pages/__tests__/WelcomePage.test.tsx` -> @onboarding #onboarding-welcome
- `server/src/__tests__/agent-access-grants-routes.test.ts` -> @onboarding #onboarding-agent-acl
- `ui/src/pages/__tests__/PeoplePage.test.tsx` -> @onboarding #onboarding-people-directory #onboarding-people-search
- `tests/e2e/onboarding/multi-human.spec.ts` (planned, epic-closure) -> @onboarding (full flow)

**Spec:** `.omc/specs/deep-interview-human-onboarding-2026-04-25.md` (gitignored — interview output)
**Memories:** `project_deployment_dual_path.md`, `project_auth_provider_direction.md`, `project_fre_account_model.md`

---

## Size-to-Test-Scope Rules

| Size | Test Scope |
|------|-----------|
| XS | Smoke tests only |
| S | Smoke tests |
| M | Epic-scoped tests |
| L | Epic-scoped tests (all affected) |
| XL | Full test suite |

---

## Issue Sizing

| Size | Effort | Test Scope | Example |
|------|--------|------------|---------|
| **XS** | < 1 day | Smoke only | Copy change, config tweak |
| **S** | 1-2 days | CUJ tests | Single bug fix, minor feature |
| **M** | 3-5 days | Epic tests | Feature enhancement, multiple CUJs |
| **L** | 1-2 weeks | Multi-epic tests | New feature spanning areas |
| **XL** | > 2 weeks | Full regression | Major refactor, new epic |

---

## Test Triggering Rules

### By Issue Size

| Issue Size | Test Scope | Command |
|------------|------------|---------|
| XS | Smoke tests | `pnpm test:e2e` |
| S | CUJ tests | `npx playwright test --grep "#<cuj>"` |
| M | Epic tests | `npx playwright test --grep "@<epic>"` |
| L | Multi-epic tests | `npx playwright test --grep "@<epic1>\|@<epic2>"` |
| XL | Full E2E suite | `pnpm test:e2e && pnpm test:release-smoke` |

---

## Linear Label Structure

### Epic Labels (create in Linear)
```
epic:auth
epic:billing
epic:core
epic:admin
```

### Size Labels
```
XS, S, M, L, XL
```

### Workflow Labels
```
PR-Ready, Testing, Tests-Passed, Tests-Failed, Locally-Tested, Staging-Tested, Human-Verified, In-Production
```

---

## Test File Tagging Convention

Add tags to test file descriptions for selective execution:

```typescript
// tests/e2e/auth/login.spec.ts
import { test, expect } from '@playwright/test';

test.describe('@auth #auth-login Login Flow', () => {
  test('user can log in with credentials', async ({ page }) => {
    // ...
  });
});
```

This allows running tests by epic or CUJ:
```bash
# Run all auth tests
npx playwright test --grep "@auth"

# Run specific CUJ tests
npx playwright test --grep "#auth-login"

# Run multiple CUJs
npx playwright test --grep "#auth-login|#auth-signup"
```

---

## PM Agent Responsibilities

The PM Agent is responsible for:

1. **Maintaining this document** - Keep epics and CUJs up to date
2. **Tagging Linear issues** - Apply epic labels and CUJ references
3. **Sizing issues** - Assign XS/S/M/L/XL based on scope
4. **Creating test plans** - Include exact test commands
5. **Triggering appropriate tests** - Ensure correct test scope runs
