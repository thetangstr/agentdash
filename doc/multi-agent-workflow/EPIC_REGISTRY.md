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
| `epic:auth` | Authentication, sessions, login | #auth-login, #auth-signup, #auth-logout |
| `epic:billing` | Payments, subscriptions, invoicing | #pay-checkout, #pay-subscribe |
| `epic:core` | Core product features | #core-create, #core-edit, #core-delete |
| `epic:admin` | Admin tools, analytics | #admin-dashboard, #admin-users |

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

## Example Epic Detail: AUTH

Authentication and session management.

| CUJ ID | CUJ Name | Description | User Type |
|--------|----------|-------------|-----------|
| `#auth-login` | Login | User signs in with credentials | All |
| `#auth-signup` | Signup | User creates new account | Visitor |
| `#auth-logout` | Logout | User signs out, session cleared | All |
| `#auth-session` | Session | Session persistence and refresh | All |

**Test Files:**
- `tests/e2e/auth/login.spec.ts` -> @auth #auth-login
- `tests/e2e/auth/signup.spec.ts` -> @auth #auth-signup

---

## Example Epic Detail: BILLING

Payments, subscriptions, and invoicing.

| CUJ ID | CUJ Name | Description | User Type |
|--------|----------|-------------|-----------|
| `#pay-checkout` | Checkout | User completes purchase | Customer |
| `#pay-subscribe` | Subscribe | User subscribes to plan | Customer |
| `#pay-cancel` | Cancel | User cancels subscription | Customer |
| `#pay-billing` | Billing History | User views payment history | Customer |

**Test Files:**
- `tests/e2e/billing/checkout.spec.ts` -> @billing #pay-checkout
- `tests/e2e/billing/subscription.spec.ts` -> @billing #pay-subscribe

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
