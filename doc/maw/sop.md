# Multi-Agent Workflow v6 -- Standard Operating Procedure

This document describes how all feature and bug development works at AgentDash. Read this end-to-end before touching any issue.

---

## 1. Mandatory Policy

**All feature and bug development goes through MAW.** No exceptions unless the work falls into one of these two categories:

- **Production hotfixes** -- Critical breakage in production that cannot wait for the full pipeline. Hotfixes still require a PR, CI green, and a post-merge smoke test, but they skip PM elaboration, formal sizing, and the Tester agent loop. The on-call human owns the hotfix and documents it in Linear after the fact.
- **Pure infrastructure** -- CI configuration, dependency bumps, tooling scripts, documentation-only changes. These go through normal PR review but do not require Linear issues, PM elaboration, or the Tester agent.

Everything else -- features, bug fixes, refactors with user-facing impact, data model changes, API changes -- enters the MAW pipeline.

**One agent per issue at a time.** No two agents may work on the same Linear issue concurrently. The orchestrator enforces this by checking issue labels before dispatching.

---

## 2. Pipeline Overview

The full lifecycle of a change, from idea to production:

```
Linear Issue (Todo)
    |
    v
Orchestrator picks up issue
    |
    v
PM Agent -- elaborate requirements, set size, write acceptance criteria
    |
    v
Builder Agent -- architect, implement, write tests, create PR
    |
    v
Tester Agent -- automated tests, code review, Chrome CUJ verification
    |
    v
Reviewer -- independent code review (agent or human, based on size)
    |
    v
Human Verification Gate (M+ sizes)
    |
    v
TPM Agent -- merge to main, deploy, production smoke test
    |
    v
In Production -- OTA update to edge instances
```

For XS/S issues the pipeline is compressed: PM sets size, Builder implements, Tester verifies, and TPM ships without a human gate. The full pipeline still runs -- only the human verification step is removed.

### Label-Driven State Machine

Every transition in the pipeline is tracked by Linear labels. Agents read labels to determine what to do next and write labels to signal completion. The canonical label flow:

```
(no labels) -> PM elaborates -> (spec in description)
  -> Builder implements -> PR-Ready
  -> Tester starts -> Testing
  -> Tests pass -> Tests-Passed -> Locally-Tested (or Staging-Tested)
  -> Human approves (M+) -> Human-Verified
  -> TPM ships -> In-Production
```

If tests fail: `Tests-Failed` is applied, Builder is re-spawned for fixes (max 2 retries), then Tester re-runs. After 2 failed fix attempts, the issue escalates to a human.

---

## 3. Agent Descriptions

### 3.1 Orchestrator

**What it does:** Routes Linear issues through the pipeline by reading their current state and dispatching the correct agent. Handles retries and timeouts.

**When it acts:** Invoked by `/workon AGE-123`. Runs a continuous loop: fetch issue, determine phase from labels, dispatch the next agent, wait for completion, re-fetch, repeat.

**Tools:** Linear MCP (read issues, labels), Task tool (spawn subagents).

**Key behaviors:**
- Parses issue ID from the command
- Checks for size estimate; dispatches PM to set one if missing
- Determines deployment path (direct vs staging-required)
- Chains agents sequentially: PM -> Builder -> Tester -> (human gate) -> TPM
- Re-fetches issue state after each agent completes to decide the next step
- Retries Linear API calls up to 3 times on transient failure
- Defaults to size M if sizing is ambiguous (safer to have a test plan)
- Auto-spawns Builder on test failure (max 2 retries before human escalation)

### 3.2 PM (Product Manager)

**What it does:** Elaborates raw requirements into structured Linear issues with acceptance criteria, CUJ definitions, and test plans.

**When it acts:** When an issue has no spec, no acceptance criteria, or no size estimate.

**Tools:** Linear MCP (create/update issues, comments, labels), OMC deep-interview and plan skills for ambiguous requests.

**Key behaviors:**
- Extracts key concepts, user types, and epic mapping from raw descriptions
- Assigns T-shirt size using the sizing rubric (files changed, LOC, components, data model, risk)
- Writes structured issue description: summary, user stories, acceptance criteria, test plan, out-of-scope
- Sets the `staging-required` label on XL issues that touch auth, payments, or shared UI
- Optionally validates deployed features as a real user (browser automation) before human sign-off
- Maintains the epic registry and manual testing guide

### 3.3 Builder

**What it does:** Implements the feature described in a Linear issue. Creates a feature branch, writes code and tests, and opens a PR.

**When it acts:** When an issue has acceptance criteria but no PR.

**Tools:** Git, GitHub CLI, Linear MCP, pnpm (typecheck/test/build), OMC team pipeline for M+ sizes.

**Key behaviors:**
- Creates feature branch from main (`pap-<number>-<short-name>`)
- For XS/S: writes the change directly
- For M: delegates to OMC team pipeline with 2 parallel executor workers
- For L: delegates to OMC team pipeline with 3 parallel executor workers
- For XL: delegates to OMC team pipeline with Ralph persistence loop (retry-on-fail)
- Writes unit tests and E2E tests (required for S+ sizes)
- Runs mandatory regression suite: `pnpm -r typecheck && pnpm test:run && pnpm build`
- Rebases on latest main before creating PR
- Creates PR targeting main (or staging for staging-required issues)
- Adds `PR-Ready` label and posts handoff comment for Tester
- **Never merges to main** -- that is TPM's exclusive authority
- On test failure callback: reads failure details, fixes root cause, pushes to existing PR branch, re-requests testing

### 3.4 Tester

**What it does:** Runs the full verification suite against a PR: automated tests, code review, and Chrome CUJ (Critical User Journey) verification.

**When it acts:** When an issue has the `PR-Ready` label.

**Tools:** pnpm (typecheck/test/build), Playwright, Linear MCP, Chrome browser automation (navigate, screenshot, form input, console/network monitoring, GIF recording), OMC UltraQA and qa-tester.

**Key behaviors:**
- Runs mandatory regression gates first: `pnpm -r typecheck && pnpm test:run && pnpm build`
- Runs issue-specific E2E tests via OMC UltraQA (up to 5 auto-fix cycles)
- Performs code review on the PR diff (security, architecture, performance, error handling)
- Leaves inline comments with severity ratings (CRITICAL/HIGH block, MEDIUM/LOW are advisory)
- For M+ issues: delegates browser CUJ verification to qa-tester agent
- For XS/S issues: runs inline Chrome CUJ verification (navigate, interact, screenshot, verify)
- Checks for console errors and failed network requests
- Tests responsive behavior for UI changes (375x667 mobile viewport)
- On pass: adds `Locally-Tested` (or `Staging-Tested`), posts human verification checklist
- On fail: adds `Tests-Failed`, creates sub-issues for each failure, auto-spawns Builder (max 2 retries)
- Runs `/oh-my-claudecode:verify` as final pre-handoff confirmation that acceptance criteria are met

### 3.5 Reviewer

**What it does:** Provides an independent code review separate from the Tester's review. Can be an agent (code-reviewer, security-reviewer) or a human, depending on issue size and risk.

**When it acts:** After Tester passes automated tests and before human verification gate.

**Tools:** GitHub PR review tools, diff analysis, OMC code-reviewer and security-reviewer agents.

**Key behaviors:**
- For XS/S: agent code review is sufficient (performed as part of Tester's Phase 1.5)
- For M: agent code review required; human spot-check recommended
- For L/XL: human code review mandatory
- Security-reviewer is triggered automatically for changes touching auth, billing, or email
- Review findings at CRITICAL or HIGH severity block the PR and send it back to Builder
- Review comments are posted as inline PR comments on GitHub

### 3.6 TPM (Technical Program Manager)

**What it does:** Sole merge authority to main. Plans multi-issue projects into waves. Ships verified features to production. Coordinates OTA updates.

**When it acts:** Invoked by `/tpm sync` (the primary command). Also handles project planning (`/tpm <description>`), wave management (`/tpm wave`), and status reporting (`/tpm status`).

**Tools:** Git, GitHub CLI (`gh pr merge`), Linear MCP, curl (health checks), pnpm (smoke tests).

**Key behaviors:**
- **Only agent that merges to main** -- this is a hard rule, no exceptions
- Derives all state from Linear on every invocation (stateless)
- Sequential merge protocol: completes the full cycle for one PR before starting the next (merge -> deploy -> health check -> smoke test -> Linear update)
- For staging-required issues: creates PR #2 targeting main after staging verification passes
- Reverts immediately on failed production smoke tests (`git revert HEAD`)
- Rebases staging on main after every production deploy (staging-required issues)
- Breaks projects into independently shippable issues with dependency DAGs
- Plans execution waves (topological sort); wave N+1 starts only after all wave N issues reach In-Production
- Displays a dashboard on every sync showing issue states, actions taken, and items needing human attention

### 3.7 Admin

**What it does:** Monitors service health, deployment status, and operational statistics. The ops toolkit.

**When it acts:** Invoked by `/admin` (full check), `/admin health` (service health), or `/admin status` (deployment status).

**Tools:** curl (health endpoints), GitHub API (deployment history), database queries (read-only).

**Key behaviors:**
- Checks backend and frontend health across all environments (production, staging)
- Reports response times and HTTP status codes
- Queries database for usage statistics (read-only, never writes)
- Compares production vs staging when debugging discrepancies
- Documents anomalies in Linear
- Never runs DELETE or UPDATE queries on production without explicit human confirmation
- Never modifies production environment variables or schema directly

---

## 4. Size-Based Policy

Issue size determines the rigor of testing, the human involvement required, and the deployment path.

### Sizing Rubric

| Criterion | XS | S | M | L | XL |
|-----------|----|----|----|----|-----|
| Files changed | 1 | 1-2 | 3-5 | 6-10 | 10+ |
| Lines of code | <20 | 20-100 | 100-300 | 300-1000 | 1000+ |
| Components | UI only | Single layer | 2 layers | Full stack | System-wide |
| Data model | None | None | Maybe | Yes | Major |
| Risk | Cosmetic | Low | Medium | High | Critical |
| Fibonacci points | 1 | 2 | 3 | 5 | 8+ |

### Testing Requirements by Size

| Size | Unit Tests | E2E Tests | Test Plan | Code Review | Chrome CUJ |
|------|-----------|-----------|-----------|-------------|------------|
| XS | Optional | None | None | Agent (inline) | Agent (inline) |
| S | If logic change | Required | None | Agent (inline) | Agent (inline) |
| M | Required | Required | Required | Agent + human spot-check | qa-tester agent |
| L | Required | Required | Full plan with CUJs | Human mandatory | qa-tester agent |
| XL | Required | Full suite | Full spec | Human mandatory | qa-tester agent |

### Human Gate Policy

| Size | Human Verification | Rationale |
|------|-------------------|-----------|
| **XS** | Not required | Auto-ship after CI + agent review pass. Low risk, cosmetic changes. |
| **S** | Not required | Auto-ship after CI + agent review pass. Single-file, low-risk changes. |
| **M** | Agent review + human spot-check | Requires either a full human review OR agent review with periodic human spot-checks. The human checklist is posted but does not block shipping if only agent-verifiable items remain. |
| **L** | Human review mandatory | A human must review the PR, verify external-system items, and add the `Human-Verified` label before TPM can ship. |
| **XL** | Human review mandatory | Same as L, plus staging verification is required if the `staging-required` label is set. |

### Builder Execution Engine by Size

| Size | Engine |
|------|--------|
| XS | Builder writes the change directly |
| S | Builder writes the change directly |
| M | OMC team pipeline with 2 parallel executor workers |
| L | OMC team pipeline with 3 parallel executor workers |
| XL | OMC team pipeline with Ralph persistence loop (auto-retry on verification failure) |

---

## 5. Deployment Environments

### 5.1 Development (Local)

- **URL:** http://localhost:3100
- **Purpose:** Local development and initial testing
- **How to start:** `pnpm dev`
- **Database:** Embedded PostgreSQL (auto-managed at `~/.paperclip/instances/default/db/`)
- **Who uses it:** Builder (implementation), Tester (E2E tests and Chrome CUJ for default-path issues)
- **Notes:** Never use the `claude` CLI for local LLM testing -- use the `minimax` adapter instead. See CLAUDE.md for details.

### 5.2 CI (GitHub Actions)

- **Purpose:** Automated quality gates on every PR
- **What runs:** `pnpm -r typecheck && pnpm test:run && pnpm build`
- **Gate rule:** All PRs must pass CI before any review (agent or human) begins. PRs with failing CI are not eligible for the Tester pipeline.
- **Who uses it:** Triggered automatically on PR creation and push. Tester checks CI status before starting.

### 5.3 Staging

- **URL:** Configured via environment (per LAUNCH.md)
- **Purpose:** Pre-production verification for high-risk changes
- **Deploys:** Auto-deploy on merge to staging branch (staging-required XL issues only)
- **Who uses it:** Tester (staging-path E2E tests and Chrome CUJ), human reviewers for `staging-required` issues
- **Gate rule:** `Staging-Tested` label required before promotion to production. For M+ sizes, human must also add `Human-Verified`.

### 5.4 Production

- **URL:** Configured via environment (per LAUNCH.md)
- **Purpose:** Live customer-facing environment
- **Deploys:** On merge to main (only TPM merges to main)
- **Who uses it:** End users, Admin agent (health monitoring)
- **Gate rule:** Production deploys require staging verification first for staging-required issues. TPM runs smoke tests after every deploy and reverts immediately on failure.

### 5.5 Edge Instances (OTA)

- **Purpose:** Distributed instances that receive over-the-air updates from production
- **Update mechanism:** OTA from production after production health check is green
- **Gate rule:** OTA updates only proceed when the production health check returns 200. TPM coordinates OTA timing. No OTA push during active production incidents.

### Deployment Path Summary

| Condition | PR Target | Test Environment | Quality Gate | Human Gate |
|-----------|-----------|-----------------|--------------|------------|
| XS/S, no `staging-required` | main | localhost:3100 | `Locally-Tested` | None (auto-ship) |
| M, no `staging-required` | main | localhost:3100 | `Locally-Tested` | Human spot-check |
| L, no `staging-required` | main | localhost:3100 | `Locally-Tested` | Human mandatory |
| XL + `staging-required` | staging | staging URL | `Staging-Tested` | Human mandatory |

---

## 6. Entry Points

There are multiple ways to feed work into the MAW pipeline. All of them converge on the same Linear-driven state machine.

### 6.1 Linear Directly

Create an issue in the AgentDash team on Linear. Set it to `Todo` status. The orchestrator (or Contractor, see below) picks it up from the queue.

- **Best for:** Product managers, designers, stakeholders filing feature requests or bug reports.
- **What happens:** The issue enters the pipeline at the PM phase. PM elaborates requirements, sets size, and hands off to Builder.

### 6.2 CLI (`/workon`)

In a Claude Code terminal session:

```
/workon AGE-123
```

This invokes the Orchestrator, which fetches the issue from Linear and routes it through the full pipeline.

- **Best for:** Engineers who want to drive a specific issue through the pipeline from their terminal.
- **Variants:** `/workon 123` (assumes AGE-123 prefix).

### 6.3 Individual Agent Commands

For targeted interventions when you need to invoke a specific agent directly:

| Command | What it does |
|---------|-------------|
| `/pm <description>` | Elaborate requirements and create/update a Linear issue |
| `/builder AGE-123` | Implement a specific issue (skips PM phase) |
| `/tester AGE-123` | Run the Tester workflow on a specific issue |
| `/tpm sync` | Ship all `Human-Verified` issues to production |
| `/tpm status` | Read-only dashboard of all issue states |
| `/admin health` | Check service health across environments |

### 6.4 Claude Code Desktop

The same slash commands (`/workon`, `/pm`, `/builder`, `/tester`, `/tpm`, `/admin`) work in Claude Code desktop sessions. No difference in behavior from the CLI.

### 6.5 Contractor (Anthropic Cloud Agent)

Contractor is Anthropic's cloud-hosted agent. It connects to Linear via webhook and picks up issues from the Todo queue automatically.

- **Best for:** Unattended development. File an issue in Linear, Contractor handles the rest.
- **How it works:** Linear webhook fires on issue creation/update -> Contractor evaluates the issue -> runs the same PM -> Builder -> Tester pipeline as `/workon`.
- **Limitation:** Contractor cannot perform Chrome CUJ verification (no browser). It handles automated tests and code review only. Browser-based verification falls to a local agent or human.

### 6.6 Any MCP-Connected Tool

Any tool with the Linear MCP connected (Cursor, Codex, OpenCode, etc.) can create Linear issues or read issue state. The pipeline is Linear-native -- it does not depend on which tool created the issue.

- **Best for:** Teams using mixed tooling. Everyone files to Linear; agents pick up from the same queue.
- **Requirement:** The tool must have Linear MCP configured to read/write issues and labels.

---

## 7. Safety Rules

These rules are non-negotiable. Violation of any rule requires a post-incident review.

### 7.1 Concurrency

- **One agent per issue at a time.** The orchestrator checks labels before dispatching. If an issue has `Testing` label, no Builder can be dispatched to it. If it has a linked in-progress PR, no second Builder starts.
- **Sequential merge protocol.** TPM completes the full ship cycle for one PR (merge -> deploy -> health check -> smoke test -> Linear update) before starting the next. No parallel merges to main.

### 7.2 Merge Authority

- **TPM is the sole merge authority to main.** No other agent -- Builder, Tester, PM, Admin, Orchestrator -- may merge a PR to main. This is enforced by convention and documented in every agent's command file.
- **No force pushes to main.** Force pushes to main are prohibited for all agents and humans. Force-with-lease is permitted on feature branches and staging only.

### 7.3 CI and Review Gates

- **All PRs must pass CI before review.** A PR with failing CI is not eligible for Tester pickup, agent review, or human review. Fix CI first.
- **All PRs must pass the mandatory regression suite.** Builder runs `pnpm -r typecheck && pnpm test:run && pnpm build` before creating a PR. Tester re-runs the same suite before starting issue-specific tests. Both must pass.
- **Code review is mandatory for all sizes.** XS/S get agent review (as part of Tester). M+ get agent review plus human involvement (spot-check for M, mandatory for L/XL).

### 7.4 Production Deployment

- **Production deploys for staging-required issues require staging verification first.** The `Staging-Tested` label must be present before TPM creates the production PR.
- **Smoke tests run after every production deploy.** TPM runs production smoke tests immediately after deployment. Failure triggers an immediate revert (`git revert HEAD`).
- **Health checks bracket every deploy.** TPM checks health before merge (to confirm a clean baseline) and after deployment (to confirm the change did not break anything).

### 7.5 OTA Updates

- **OTA updates require production health check green.** No OTA push proceeds if the production health endpoint returns non-200.
- **No OTA during active incidents.** If production smoke tests have failed and a revert is in progress, OTA is paused until health is restored.

### 7.6 Retry and Escalation

- **Max 2 Builder fix attempts per test failure.** After 2 failed fix cycles (Tester -> Builder -> Tester -> Builder -> Tester -> fail), the issue escalates to a human. No infinite loops.
- **UltraQA cycles do not count against the retry budget.** UltraQA's internal 5-cycle auto-fix loop is a single Tester pass. The 2-retry limit applies to full Tester -> Builder round-trips.
- **Size defaults to M when unclear.** If the orchestrator or PM cannot determine size, it defaults to M. This ensures a test plan is written and human review is available. Safer to over-test than under-test.

### 7.7 Data Safety

- **No destructive database operations without explicit human confirmation.** Admin agent uses read-only queries. Any DELETE, UPDATE, or schema change on production requires a human to confirm in chat.
- **No secrets in PRs.** Builder and Tester check for exposed secrets, API keys, and credentials in diffs. Any finding at CRITICAL severity blocks the PR.

---

## Quick Reference Card

### Issue Lifecycle Labels

| Label | Set By | Meaning | Next Step |
|-------|--------|---------|-----------|
| *(none)* | -- | Needs elaboration | PM sets size and writes AC |
| `PR-Ready` | Builder | Implementation complete | Tester picks up |
| `Testing` | Tester | Tester is active | Wait |
| `Tests-Passed` | Tester | Automated tests passed | Tester continues to Chrome CUJ |
| `Tests-Failed` | Tester | Failures found | Builder auto-spawned for fix (max 2x) |
| `Locally-Tested` | Tester | All verification passed (direct path) | Human gate (M+) or auto-ship (XS/S) |
| `Staging-Tested` | Tester | All verification passed (staging path) | Human adds `Human-Verified` |
| `Human-Verified` | Human or Auto | Approved for production | TPM ships on next `/tpm sync` |
| `Prod-Smoke-Passed` | TPM | Production smoke tests passed | -- |
| `In-Production` | TPM | Live in production | Done |

### Common Commands

| Command | Purpose |
|---------|---------|
| `/workon AGE-123` | Full pipeline: PM -> Builder -> Tester -> ship |
| `/tpm sync` | Ship all verified issues, display dashboard |
| `/tpm status` | Read-only summary of all issues |
| `/admin health` | Check service health across environments |
| `/pm fix the login bug` | Elaborate requirements into a Linear issue |
| `/builder AGE-123` | Implement a specific issue directly |
| `/tester AGE-123` | Test a specific issue directly |
