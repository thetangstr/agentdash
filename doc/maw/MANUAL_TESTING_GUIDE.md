# Manual Testing Guide Template

> Customize this template for your project's browser-based verification procedures.

## Overview

This guide defines Chrome browser verification procedures for features that require visual or interactive testing beyond automated E2E tests.

**Purpose:** Business-priority manual testing checklist for agent-driven testing or QA validation.

---

## Testing Strategy & Priorities

### Business-Driven Test Prioritization

Tests are organized by **business impact** rather than feature areas.

**Priority Levels:**
- **P0 - Critical** - Revenue, authentication, core product
- **P1 - High** - Key user flows, settings
- **P2 - Medium** - Secondary features
- **P3 - Low** - Edge cases, polish

**Testing Philosophy:**
1. **ALWAYS test P0 features first** - These directly impact revenue
2. **P1 features before deployment** - High business value
3. **P2 features for major releases** - Important user experience
4. **P3 features when time permits** - Already covered by automated E2E tests

---

## Test Suites

Organize tests by business priority:

### Suite 1: [Core Authentication] (P0)

**Priority:** P0 - Critical
**Prerequisites:** Fresh browser session, test user credentials

#### Test 1.1: Login Flow
1. Navigate to `/login`
2. Enter test credentials
3. Click "Sign In"

**Expected Results:**
- [ ] User is redirected to dashboard
- [ ] Session persists on page refresh
- [ ] No console errors

#### Test 1.2: Logout Flow
1. Click user avatar/menu
2. Click "Logout"

**Expected Results:**
- [ ] Session cleared
- [ ] Redirected to home/login page

---

### Suite 2: [Core Product Feature] (P0)

**Priority:** P0 - Critical
**Prerequisites:** User is logged in

#### Test 2.1: [Primary Feature Action]
1. Navigate to [page]
2. [Action]
3. [Action]

**Expected Results:**
- [ ] [Expected outcome 1]
- [ ] [Expected outcome 2]

---

### Suite 3: [Payment/Billing] (P1)

**Priority:** P1 - High
**Prerequisites:** User is logged in, test payment method available

#### Test 3.1: [Purchase Flow]
1. Navigate to pricing page
2. Select plan/product
3. Complete checkout

**Expected Results:**
- [ ] Checkout completes
- [ ] Transaction visible in payment dashboard

---

## Test User Setup

| Role | Email | Password | When to Use |
|------|-------|----------|-------------|
| Standard | {{TEST_USER_EMAIL}} | {{TEST_USER_PASSWORD}} | Default |

---

## Recommended Test Execution Order

**Quick Validation (30 minutes):**
- Suite 1: Core Authentication (P0)
- Suite 2: Core Product Feature (P0)

**Full Pre-Deployment (2 hours):**
- All P0 tests
- All P1 tests
- Critical P2 tests

**Comprehensive QA (4+ hours):**
- All P0, P1, P2 tests
- Selected P3 tests

---

## How to Use This Guide

This guide is used by:
1. **Tester Agent** - Chrome CUJ verification using `mcp__claude-in-chrome__*` tools
2. **QA Engineers** - Manual validation before production deployment
3. **Product Managers** - Feature acceptance testing

For cross-cutting flows (navigation, account, settings), the Tester agent walks the relevant suite from this guide during Chrome CUJ verification.
