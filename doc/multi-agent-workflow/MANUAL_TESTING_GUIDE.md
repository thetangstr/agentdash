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

### Suite 1: Multi-Human Onboarding (P0)

**Priority:** P0 - Critical (sign-up gates revenue + every other flow depends on having authenticated humans)
**Linked epic:** epic:onboarding (AGE-56)
**Prerequisites:** Fresh browser session, dev server running, both `AUTH_PROVIDER=better-auth` (Free) and `AUTH_PROVIDER=workos` (Pro with WorkOS sandbox) deployments available.

#### Test 1.1: Self-hosted Free first sign-up — `#onboarding-free-signup`
1. Boot server with `AUTH_PROVIDER=better-auth`, no companies seeded.
2. Navigate to `/auth`, switch to **Sign Up** tab.
3. Sign up with `alice@anywhere.com` (any email).
4. Complete the company-bootstrap onboarding wizard.

**Expected Results:**
- [ ] Lands on dashboard as company admin
- [ ] No console errors
- [ ] `companies.email_domain` populated (free-mail → full email; corp → bare domain)

#### Test 1.2: Free single-seat cap — `#onboarding-free-seat-cap`
1. With Test 1.1 complete, sign out.
2. Navigate to `/auth`, switch to **Sign Up**, try `bob@anywhere.com`.

**Expected Results:**
- [ ] Sign-up rejected with HTTP 403 + code `free_tier_seat_cap`
- [ ] UI shows clear "Self-hosted Free supports one human user" message with upgrade CTA

#### Test 1.3: Pro corp-domain sign-up — `#onboarding-pro-signup`
1. Boot server with `AUTH_PROVIDER=workos` and WorkOS sandbox env configured.
2. Navigate to `/auth`, sign up with `alice@acme.com`.
3. WorkOS hosted AuthKit page completes.

**Expected Results:**
- [ ] WorkOS Organization created for `acme.com`
- [ ] User mirrored to local `authUsers` via `user.created` webhook
- [ ] Admin lands on company-bootstrap wizard
- [ ] DNS verification handoff URL surfaced for the admin to complete domain ownership proof

#### Test 1.4: Pro free-mail block — `#onboarding-free-mail-block`
1. Same Pro deployment. Navigate to `/auth`, sign up with `you@gmail.com`.

**Expected Results:**
- [ ] Sign-up rejected with HTTP 400 + code `pro_requires_corp_email`
- [ ] UI shows inline error "Pro accounts require a company email" under email field

#### Test 1.5: Request-to-join with admin approval — `#onboarding-request-to-join`, `#onboarding-admin-approve`
1. With Test 1.3 complete (Acme org exists, admin signed in), open a 2nd browser profile.
2. Navigate to `/auth`, sign up with `bob@acme.com`.

**Expected Results:**
- [ ] Bob lands on a "Request submitted, awaiting approval" screen (no membership created yet)
- [ ] Admin (alice) receives notification email at `alice@acme.com` (or copy-link banner if SMTP unavailable)
- [ ] Admin opens `/admin/join-requests`, sees Bob's pending request
- [ ] Admin clicks **Approve** → Bob's `companyMemberships` row created → activity log entry written
- [ ] Bob's next sign-in lands on `/welcome` page (Test 1.7)

#### Test 1.6: JIT toggle — `#onboarding-jit-toggle`, `#onboarding-jit`
1. Admin (alice) opens **Settings → Org**, flips `Allow JIT auto-approve` to ON.
2. Admin signs out. Open a 3rd browser profile, sign up with `carol@acme.com`.

**Expected Results:**
- [ ] Carol auto-added to Acme org (no admin gating)
- [ ] Activity log shows `jit_toggled_on` followed by `joined_via_jit` entries
- [ ] Carol lands on `/welcome` page

#### Test 1.7: Per-human welcome — `#onboarding-welcome`, `#onboarding-welcome-skip`
1. As a newly-joined user (Bob from 1.5 or Carol from 1.6) on first sign-in.
2. Fill avatar/name + notification preferences, click "Get started".

**Expected Results:**
- [ ] `/welcome` shows once per user-per-company
- [ ] Profile saved; notification prefs persisted
- [ ] Refreshing `/welcome` after completion redirects to `/dashboard`

#### Test 1.8: People directory — `#onboarding-people-directory`, `#onboarding-people-search`
1. Admin (alice) navigates to `/people`.

**Expected Results:**
- [ ] Lists alice (admin), bob (member), carol (member) + all agents in the org
- [ ] Search by name filters list; "Admins" pill filters to alice
- [ ] Per-row actions: Invite/Revoke (humans), Grant agent access (humans)
- [ ] Member view: Bob navigating to `/people` sees the directory but no admin actions

#### Test 1.9: Agent access grant — `#onboarding-agent-acl`
1. Admin (alice) opens an agent profile → "Access" section.
2. Set Bob to `use`, save.

**Expected Results:**
- [ ] Grant persisted; activity log entry `agent_access_granted` with `details: { humanUserId: bob, agentId: X, level: use }`
- [ ] Bob's view of the agent reflects he has `use` (UI affordance for running tasks; identity edit hidden)

#### Test 1.10: Email fallback — `#onboarding-email-fallback`
1. Self-hosted Free deployment. Set `EMAIL_RELAY_URL=http://localhost:9999/dead` (unreachable).
2. As admin, send an invite from `/people`.

**Expected Results:**
- [ ] Invite created in `invites` table with valid `tokenHash`
- [ ] UI shows "Couldn't send email — copy link" banner with the working invite URL
- [ ] Activity log records `email_relay_failed`

---

### Suite 2: [Core Authentication — pre-existing] (P0)

**Priority:** P0 - Critical
**Prerequisites:** Fresh browser session, test user credentials

#### Test 2.1: Login Flow
1. Navigate to `/auth`
2. Enter test credentials
3. Click "Sign In"

**Expected Results:**
- [ ] User is redirected to dashboard
- [ ] Session persists on page refresh
- [ ] No console errors

#### Test 2.2: Logout Flow
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
| Standard | TODO_SET_TEST_USER_EMAIL | TODO_SET_TEST_USER_PASSWORD | Default |

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
