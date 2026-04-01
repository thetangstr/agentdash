# Multi-Agent Workflow (MAW) - Standard Operating Procedure

**Version:** 5.0
**Last Updated:** 2026-03-10
**Owner:** Engineering Team

---

## Mandatory MAW Policy

> **ALL feature and bug development MUST use the MAW workflow.**
>
> **Exceptions:**
>
> - Production hotfixes (critical bugs requiring immediate deployment)
> - Infrastructure/DevOps changes (CI/CD, environment config)
>
> **No development should happen outside MAW.** This ensures:
>
> - Consistent quality gates (PM -> Builder -> Tester -> Human -> Production)
> - Proper test coverage for all changes
> - Audit trail via Linear labels
> - Predictable deployment pipeline
>
> **Critical Branching Rules:**
>
> - **Builder MUST rebase feature branch on `agentdash-main`** before creating any PR (resolves conflicts)
> - **TPM is the ONLY agent allowed to merge anything to `agentdash-main`**
> - **No bulk staging->agentdash-main merges** -- each feature gets its own PR to `agentdash-main`
> - **After production deploy, TPM rebases `staging` on `agentdash-main`** to keep it in sync (staging-required only)

---

## Workspace-Scoped Architecture

Each Conductor workspace is a **self-contained pipeline** for ONE Linear issue. All agents run within the same workspace. No cross-workspace awareness.

### Two-Phase Orchestration

| Phase | Owner | Trigger | Stops When |
|-------|-------|---------|------------|
| Intake -> Locally-Tested (or Staging-Tested) | `/workon` | Human runs `/workon PAP-XXX` | `Locally-Tested` or `Staging-Tested` label set |
| XS/S auto-ship | `/workon` | `Locally-Tested` set on XS/S issue | `/workon` auto-adds `Human-Verified`, hands off to TPM |
| Human-Verified -> Production (M+ only) | `/tpm sync` | Human adds `Human-Verified` label, runs `/tpm sync` | `In-Production` label set |

### Human Gates

The pipeline is **fully autonomous** for XS/S issues (1-2 pts). For **M+ issues (3+ pts)**, there is one human gate:

**Human Verification (M+ only):** After agents complete automated tests AND Chrome-based CUJ verification, the human verifies ONLY external-system items (third-party dashboards, email delivery, AI quality) on the test environment. Then adds `Human-Verified` label. TPM auto-ships from there.

**XS/S Auto-Ship:** For XS/S issues, `/workon` auto-adds `Human-Verified` after `Locally-Tested` -- no human gate needed. TPM auto-ships from there.

**What agents verify (human does NOT need to):**

- Pages load correctly, UI elements visible and interactive
- Forms submit, navigation flows work end-to-end
- No JavaScript console errors, no failed network requests
- Visual layout correct, responsive behavior works
- Auth gates work correctly

**What ONLY humans verify:**

- Third-party dashboard transactions (e.g., Stripe Dashboard)
- Email delivery (magic links, receipts, notifications)
- Third-party webhook processing
- AI-generated content quality/aesthetics
- OAuth popup completion

---

## Environments

| Environment | Frontend URL | Backend URL | Purpose |
|-------------|--------------|-------------|---------|
| **Local Dev** | `http://localhost:3100` | `TODO_SET_BACKEND_STAGING_URL` | **Default testing: E2E, Chrome CUJ, human verification** |
| **Staging** | `TODO_SET_STAGING_URL` | `TODO_SET_BACKEND_STAGING_URL` | **Staging-required only: XL issues modifying existing prod code** |
| **Production** | `TODO_SET_PRODUCTION_URL` | `TODO_SET_BACKEND_PROD_URL` | Live production |

---

## Quick Start: `/workon PAP-XXX`

The **single entry point** for all development in a workspace:

```bash
/workon PAP-123   # Drives issue from intake through Locally-Tested (or Staging-Tested)
```

**What `/workon` does:**

1. Fetches issue from Linear, checks size
2. Routes through PM -> Builder -> Deploy -> Tester (automated + Chrome)
3. Stops at `Locally-Tested` (default) or `Staging-Tested` (staging-required) -- human verifies external items, adds `Human-Verified`
4. Then `/tpm sync` auto-ships to production

**Deployment Path Routing:**

| Condition | PR Target | Testing Environment | Quality Gate |
|-----------|-----------|---------------------|--------------|
| All sizes, no `staging-required` label | `agentdash-main` | http://localhost:3100 + staging backend | `Locally-Tested` |
| XL + `staging-required` label | `staging` | TODO_SET_STAGING_URL | `Staging-Tested` |

**`staging-required` is set by PM** when an XL issue modifies 3+ existing user-facing files AND touches auth/payments/core features/shared UI.

---

## Overview

The Multi-Agent Workflow (MAW) is a CI/CD system using specialized AI agents that coordinate via Linear labels within workspace-scoped pipelines.

```
+-------------------------------------------------------------+
| /workon PAP-XXX (continuous, no human needed)    |
+-------------------------------------------------------------+
|                                                               |
|  1. PM -- elaborate requirements, size, test plan             |
|       |                                                       |
|       v                                                       |
|  2. BUILDER -- implement, rebase on agentdash-main, create PR           |
|       |       + E2E tests for S+ features                     |
|       |       Default: PR -> agentdash-main                             |
|       |       Staging-required: PR -> staging                 |
|       v                                                       |
|  3. DEPLOY -- wait for deploy, health check,                  |
|       |       then run deployment smoke test                  |
|       v                                                       |
|  4. TESTER (automated) -- E2E tests                           |
|       |                                                       |
|       v                                                       |
|  4.5 TESTER (code review) -- diff review with                 |
|       |       GetWorkspaceDiff + DiffComment                  |
|       |       auto-fix loop for CRITICAL/HIGH findings        |
|       v                                                       |
|  5. TESTER (chrome) -- walk CUJs with mcp__claude-in-chrome   |
|       |                record GIFs, verify visually            |
|       v                                                       |
|  XS/S: Locally-Tested -> auto-adds Human-Verified             |
|     /workon hands off to TPM (no human gate)                  |
|  M+: Locally-Tested -- /workon STOPS here                     |
|     Posts human verification checklist (external items only)   |
|  Staging-required: Staging-Tested -- /workon STOPS here       |
|     Posts human verification checklist (external items only)   |
|                                                               |
+-------------------------------------------------------------+

================================================================
 M+ ONLY: Human verifies external-system items, adds
          Human-Verified label in Linear
 XS/S: Auto-verified by /workon (no human gate)
================================================================

+-------------------------------------------------------------+
| /tpm sync (detects Human-Verified, auto-ships)               |
+-------------------------------------------------------------+
|                                                               |
|  6. (staging-required) TPM creates PR #2 -> agentdash-main             |
|       |                                                       |
|       v                                                       |
|  7. MERGE -- TPM merges PR to agentdash-main                            |
|       |     (ONLY agent allowed to merge to agentdash-main)             |
|       v                                                       |
|  8. PROD SMOKE -- production smoke test                       |
|       |                                                       |
|       v                                                       |
|  9. DONE -- In-Production label + issue state -> Done         |
|            (staging-required: rebase staging on agentdash-main)          |
|                                                               |
+-------------------------------------------------------------+
```

**Key Rules:**

1. Builder **rebases on `agentdash-main`** before creating any PR
2. **XS/S (1-2 pts):** Auto-ships after `Locally-Tested` -- no human verification gate
3. **M+ (3+ pts):** Requires human to add `Human-Verified` label before TPM ships
4. **Staging-required (XL + modifies existing):** PR #1 to `staging`, then PR #2 to `agentdash-main`
5. **TPM is the ONLY agent that merges to `agentdash-main`**
6. **Every deployment MUST include a smoke test** -- wait for deployment to finish, then run smoke tests
7. For staging-required only: TPM **rebases `staging` on `agentdash-main`** after production deploy

---

## Deployment Smoke Test Policy

> **Every deployment -- staging or production -- MUST include a smoke test.**
>
> No deployment is considered complete until smoke tests pass. This is a universal rule.

### Procedure

1. **Wait for deployment** to finish (build + deploy)
2. **Health check** the deployed environment:
   - Staging: `curl -s https://TODO_SET_BACKEND_STAGING_URL/health`
   - Production: `curl -s https://TODO_SET_BACKEND_PROD_URL/health` and `curl -s -o /dev/null -w "%{http_code}" https://TODO_SET_PRODUCTION_URL`
3. **Run smoke tests** against the deployed environment
4. **If smoke tests fail:** Investigate immediately. For production: revert the merge (`git revert HEAD && git push`).

### Who Runs Smoke Tests

| Deployment | Triggered By | Smoke Test Run By |
|------------|--------------|-------------------|
| Staging (PR merged to `staging`) | Builder/Tester | **Tester** (as part of `/workon` flow) |
| Production (PR merged to `agentdash-main`) | TPM | **TPM** (as part of `/tpm sync` flow) |
| Local dev (PR branch checked out) | On PR creation | **Tester** (E2E tests on http://localhost:3100) |

---

## Agents

### 1. PM Agent (`/pm`)

**Command:** `.claude/commands/pm.md`

**Responsibilities:**

- Elaborate raw requirements into comprehensive specs
- Determine epic (e.g., `epic:auth`, `epic:billing`, `epic:core`)
- Assign T-shirt size (XS/S/M/L/XL) with points
- Define CUJs (Critical User Journeys)
- Create/update Linear issues with epic, size, CUJs, test plan

**Commands:**

```bash
/pm                    # Interactive requirements session
/pm <description>      # Elaborate specific feature
```

---

### 2. Builder Agent (`/builder`)

**Command:** `.claude/commands/builder.md`

**Responsibilities:**

- Pick up Linear issues with specs from PM
- Research codebase and existing patterns
- Implement feature on feature branch
- **Rebase feature branch on `agentdash-main`** before creating any PR
- Write unit tests
- Write E2E tests for S+ features
- Create PR (default -> `agentdash-main`, staging-required -> `staging`)
- **NEVER merge to `agentdash-main`** -- only TPM merges to agentdash-main

**Commands:**

```bash
/builder         # Auto-pickup highest priority issue
/builder PAP-5   # Work on specific issue
```

---

### 3. Tester Agent (`/tester`)

**Command:** `.claude/commands/tester.md`

**Responsibilities:**

- Pick up issues with `PR-Ready` label
- Run scoped E2E tests
- **Chrome CUJ Verification:** Walk through each CUJ visually using `mcp__claude-in-chrome__*` tools
- **Code Review:** Review PR diff using `GetWorkspaceDiff` and `DiffComment`
  - CRITICAL/HIGH findings block merge and trigger Builder auto-fix loop
  - MEDIUM/LOW findings are noted as inline comments (non-blocking)
- Mark `Locally-Tested` (default) or `Staging-Tested` (staging-required) only after automated tests, code review, AND Chrome CUJ verification pass
- Create Human Verification Checklist with ONLY agent-impossible items
- Auto-spawn Builder to fix failures (max 2 attempts)

**Test Scope by Size:**

| Size | Tier | Test Command | Regression |
|------|------|-------------|------------|
| XS | Critical | `pnpm test:e2e` | Optional |
| S | Critical | `pnpm test:e2e` | Optional |
| M | Epic | `pnpm test:e2e` | Required |
| L | Epic | `pnpm test:e2e` (all affected) | Required |
| XL | Full | `pnpm test:e2e && pnpm test:release-smoke` | Required |

**Commands:**

```bash
/tester PAP-5        # Test specific issue
```

---

### 4. Admin Agent (`/admin`) -- Ops Only

**Command:** `.claude/commands/admin.md`

**Responsibilities:**

- Monitor deployment health
- Run database queries
- Check service status
- **Ops-only** -- does NOT merge to agentdash-main (TPM handles all merges)

**Commands:**

```bash
/admin health           # Check service health
/admin status           # Show deployment status
```

---

### 5. TPM Agent (`/tpm`) -- Merge Authority & Project Planner

**Command:** `.claude/commands/tpm.md`

**Responsibilities:**

- **ONLY agent allowed to merge PRs to `agentdash-main`** -- hard rule
- Project planning: break projects into issues, plan waves
- **Global `/tpm sync`:** scans ALL Human-Verified issues in Linear, auto-ships each sequentially
  - For staging-required: creates PR #2 to agentdash-main if needed
  - Merges PR to agentdash-main
  - Runs production smoke tests
  - On failure: reverts, adds Tests-Failed, continues to next issue
  - For staging-required: rebases staging on agentdash-main

**Commands:**

```bash
/tpm <project>          # Break project into issues, plan waves
/tpm sync               # Global: scan ALL Human-Verified issues, auto-ship sequentially
/tpm wave               # Show current wave details
/tpm status             # Quick read-only summary
```

---

## Linear Label State Machine

### Label Definitions

| Label | Set By | Meaning |
|-------|--------|---------|
| `PR-Ready` | Builder | PR created, ready for testing |
| `Testing` | Tester | Tester actively testing |
| `Tests-Passed` | Tester | Automated E2E tests passed |
| `Tests-Failed` | Tester | Failures found, back to Builder |
| `Locally-Tested` | Tester | Automated tests + Chrome CUJ verification both passed (default path) |
| `Staging-Tested` | Tester | Automated tests + Chrome CUJ verification both passed (staging-required path) |
| `PM-Validated` | PM | PM validated as real user (optional enrichment) |
| `Human-Verified` | Human | Human approved external-system items |
| `Prod-Smoke-Passed` | TPM | Production smoke tests passed |
| `In-Production` | TPM | Live in production, issue state set to **Done** |

### Default Flow -- XS/S (1-2 pts, no `staging-required`)

```
PR-Ready -> Testing -> Tests-Passed -> Locally-Tested -> Human-Verified (auto) -> In-Production
(PR->agentdash-main)                              |                  |                          |
                                  chrome CUJ pass     /workon auto-adds       TPM merges PR to agentdash-main
              |                                                               TPM runs prod smoke test
         Tests-Failed (back to Builder)                                       TPM sets issue state -> Done
```

### Default Flow -- M+ (3+ pts, no `staging-required`)

```
PR-Ready -> Testing -> Tests-Passed -> Locally-Tested -> Human-Verified -> In-Production
(PR->agentdash-main)                              |                  |                    |
                                  chrome CUJ pass     human adds label    TPM merges PR to agentdash-main
              |                                                           TPM runs prod smoke test
         Tests-Failed (back to Builder)                                   TPM sets issue state -> Done
```

### Staging-Required Flow (XL + `staging-required` label)

```
PR-Ready -> Testing -> Tests-Passed -> Staging-Tested -> Human-Verified
(PR #1         |         (staging)    (staging)          (staging)
->staging)     |
          Tests-Failed                                       |
          (back to Builder)                                  v
                                                   TPM creates PR #2 -> agentdash-main
                                                             |
                                                             v
                                                   TPM merges PR #2 to agentdash-main
                                                             |
                                                             v
                                                   TPM runs prod smoke test
                                                             |
                                                             v
                                                   In-Production
                                                             |
                                                             v
                                                   TPM rebases staging on agentdash-main
```

---

## Workflow Scenarios

### Happy Path - Default XS/S (1-2 pts, no `staging-required`)

| Step | Agent | Action | Environment |
|------|-------|--------|-------------|
| 1 | **PM** | Creates issue with epic, size, CUJs, test plan | - |
| 2 | **Builder** | Implements + E2E tests (S+), **rebases on agentdash-main**, creates PR -> `agentdash-main` | localhost |
| 3 | Deploy | Start local dev server, verify health | http://localhost:3100 |
| 4 | **Tester** | Runs smoke test against localhost | http://localhost:3100 |
| 5 | **Tester** | Runs automated E2E tests | http://localhost:3100 |
| 5.5 | **Tester** | Code review via `GetWorkspaceDiff` + `DiffComment` | - |
| 6 | **Tester** | Walks CUJs in Chrome, verifies visually | http://localhost:3100 |
| 7 | **Tester** | Passes -> adds `Locally-Tested`, posts human checklist | - |
| 8 | **/workon** | Auto-adds `Human-Verified` (XS/S -- no human gate) | - |
| 9 | **TPM** | Auto-merges PR to agentdash-main (on `/tpm sync`) | Production |
| 10 | **TPM** | Waits for deploy, runs production smoke test | Production |
| 11 | **TPM** | Adds `In-Production`, marks Done | - |

### Happy Path - Default M+ (3+ pts, no `staging-required`)

| Step | Agent | Action | Environment |
|------|-------|--------|-------------|
| 1 | **PM** | Creates issue with epic, size, CUJs, test plan | - |
| 2 | **Builder** | Implements + E2E tests, **rebases on agentdash-main**, creates PR -> `agentdash-main` | localhost |
| 3 | Deploy | Start local dev server, verify health | http://localhost:3100 |
| 4 | **Tester** | Runs smoke test against localhost | http://localhost:3100 |
| 5 | **Tester** | Runs automated E2E tests | http://localhost:3100 |
| 5.5 | **Tester** | Code review via `GetWorkspaceDiff` + `DiffComment` | - |
| 6 | **Tester** | Walks CUJs in Chrome, verifies visually | http://localhost:3100 |
| 7 | **Tester** | Passes -> adds `Locally-Tested`, posts human checklist | - |
| 8 | **Human** | Verifies external-system items, adds `Human-Verified` | http://localhost:3100 |
| 9 | **TPM** | Auto-merges PR to agentdash-main (on `/tpm sync`) | Production |
| 10 | **TPM** | Waits for deploy, runs production smoke test | Production |
| 11 | **TPM** | Adds `In-Production`, marks Done | - |

### Happy Path - Staging-Required (XL + `staging-required`)

| Step | Agent | Action | Environment |
|------|-------|--------|-------------|
| 1 | **PM** | Creates issue with epic, size, CUJs, test plan, adds `staging-required` label | - |
| 2 | **Builder** | Implements + E2E tests, **rebases on agentdash-main**, creates PR #1 -> `staging` | localhost |
| 3 | Deploy | Wait for staging deploy, health check | TODO_SET_STAGING_URL |
| 4 | **Tester** | Runs deployment smoke test against staging | TODO_SET_STAGING_URL |
| 5 | **Tester** | Runs automated E2E tests | TODO_SET_STAGING_URL |
| 5.5 | **Tester** | Code review via `GetWorkspaceDiff` + `DiffComment` | - |
| 6 | **Tester** | Walks CUJs in Chrome, verifies visually, records GIFs | TODO_SET_STAGING_URL |
| 7 | **Tester** | Passes -> adds `Staging-Tested`, posts human checklist | - |
| 8 | **Human** | Verifies external-system items on staging, adds `Human-Verified` | TODO_SET_STAGING_URL |
| 9 | **TPM** | Creates PR #2 -> agentdash-main, merges (on `/tpm sync`) | Production |
| 10 | **TPM** | Waits for deploy, runs production smoke test | Production |
| 11 | **TPM** | Adds `In-Production`, rebases staging on agentdash-main | - |

### Test Failure / Code Review Failure (Auto-Fix Loop)

```
Tester -> FAIL (tests or CRITICAL/HIGH code review findings)
           -> Auto-spawn Builder -> Fix -> Push -> Orchestrator re-invokes Tester -> PASS
                                                                                  -> FAIL (attempt 2) -> repeat
                                                                                                      -> FAIL (attempt 3) -> Escalate to human
```

### Production Smoke Test Failure

| Step | Action |
|------|--------|
| 1 | **TPM** merges PR to agentdash-main, runs smoke tests |
| 2 | Smoke tests fail |
| 3 | **TPM** reverts merge (`git revert HEAD && git push`) |
| 4 | **Builder** investigates and fixes on feature branch |
| 5 | Workflow restarts from testing |

---

## Verification Responsibilities

### What the Tester Agent Verifies (Chrome MCP)

**After automated E2E tests pass**, the Tester agent uses `mcp__claude-in-chrome__*` to verify UI state, console errors, network health, and visual rendering. These items do NOT require human eyes.

| Category | Agent Verifies via Chrome MCP |
|----------|------------------------------|
| UI Rendering | Pages load, elements visible, layout correct |
| Forms | Submit correctly, validation works |
| Navigation | Routing works, no broken links |
| Console | No JavaScript errors |
| Network | No failed API requests |
| Responsive | Mobile/tablet/desktop layouts |
| Auth | Login/logout gates work correctly |

### Human Verification Checklist

**After `Locally-Tested` or `Staging-Tested` is set**, the Tester posts a minimal checklist containing ONLY items the agent cannot verify -- external systems, subjective quality, or third-party auth.

| Category | Human-Only Items | Why Human-Only |
|----------|-----------------|----------------|
| Payments | Dashboard transactions visible | External authenticated site |
| Email | Emails arrive in inbox | Mailbox access required |
| Webhooks | Third-party processing completes | External system verification |
| AI Quality | Generated content quality acceptable | Subjective judgment |
| OAuth | Popup completes successfully | Bot detection |

---

## Epic & CUJ System

All issues must be tagged with epics and CUJs for scoped testing. Customize these for your project.

**Epic Labels (examples -- replace with yours):**

- `epic:auth` - Authentication and session management
- `epic:billing` - Payments, subscriptions, invoicing
- `epic:core` - Core product features
- `epic:admin` - Admin tools, analytics

**CUJ Format:** `#cuj-name` (e.g., `#auth-login`, `#pay-checkout`, `#core-create`)

**Reference:** See `doc/multi-agent-workflow/EPIC_REGISTRY.md` for the full epic/CUJ registry template.

---

## Branch-Based Deployment

| Branch | Deploys To |
|--------|------------|
| PR branch | Auto-deploy (testing on http://localhost:3100) |
| `staging` | Staging environment |
| `agentdash-main` | Production environment |

**Deployment Rules by Path:**

| Path | Condition | PR Flow | Testing Environment |
|------|-----------|---------|---------------------|
| Default | All sizes, no `staging-required` | Single PR -> `agentdash-main` | http://localhost:3100 |
| Staging | XL + `staging-required` label | PR #1 -> `staging`, PR #2 -> `agentdash-main` | TODO_SET_STAGING_URL |

**Critical Rules:**

- Builder **rebases feature branch on `agentdash-main`** before creating any PR
- **TPM is the ONLY agent that merges to `agentdash-main`**
- **No bulk `staging` -> `agentdash-main` merges** -- each feature gets its own PR to `agentdash-main`
- After production deploy (staging-required only): TPM **rebases `staging` on `agentdash-main`**

---

## Quick Reference

| Task | Command |
|------|---------|
| **Start any issue** | `/workon PAP-XXX` |
| Skip to Builder | `/builder PAP-XXX` |
| Test a PR | `/tester PAP-XXX` |
| Ship after Human-Verified | `/tpm sync` |
| Project planning | `/tpm <project description>` |
| Check status | `/tpm status` |
| Check service health | `/admin health` |

---

## Tools & Integrations

### MCP Tools

| MCP Server | Purpose |
|------------|---------|
| **Linear** | Issue tracking, labels, comments, workflow state |
| **GitHub** | PRs, code review, merges |
| **Claude-in-Chrome** | Browser automation for Chrome CUJ verification |
| **Conductor** | `GetWorkspaceDiff`, `DiffComment`, `AskUserQuestion` |

---

## Safety Rules

### NEVER:

1. **Merge to `agentdash-main` unless you are the TPM agent** -- TPM is the ONLY merge authority
2. Do bulk `staging` -> `agentdash-main` merges -- each feature gets its own PR to `agentdash-main`
3. Deploy to production without `Human-Verified` label
4. Skip testing -- every PR must pass automated + Chrome CUJ verification
5. **Skip smoke tests after any deployment** -- every deployment gets a smoke test
6. Auto-fix production issues
7. Run DELETE/UPDATE on production database without confirmation
8. Create a PR without rebasing feature branch on `agentdash-main` first

### ALWAYS:

1. **Rebase feature branch on `agentdash-main`** before creating any PR
2. **Wait for deployments to finish** before running smoke tests
3. **Run smoke tests after every deployment** -- staging and production, no exceptions
4. Run health checks before/after deployments
5. Document actions in Linear
6. Wait for each deployment to complete before next
7. Have rollback command ready
8. TPM rebases `staging` on `agentdash-main` after production deploy (staging-required only)
9. **Builder writes E2E tests for S+ features**
10. **Tester performs code review before Chrome CUJ verification** -- uses `GetWorkspaceDiff` + `DiffComment`

---

## Related Documentation

- [protocol.md](./protocol.md) - Agent communication protocol (handoffs, schemas, state machine)
- [EPIC_REGISTRY.md](./EPIC_REGISTRY.md) - Epic/CUJ registry template
- [MANUAL_TESTING_GUIDE.md](./MANUAL_TESTING_GUIDE.md) - Manual testing guide template
