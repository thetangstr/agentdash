# Agent Communication Protocol

**Version:** 3.0
**Last Updated:** 2026-03-10

This document formalizes how MAW agents communicate through Linear issues, PR comments, and labels in a **workspace-scoped** model where each Conductor workspace handles exactly one Linear issue.

---

## 1. Handoff Payloads

Each agent transition requires specific data. Missing required data blocks the receiving agent.

### PM -> Builder

| Field | Required | Location | Description |
|-------|----------|----------|-------------|
| Epic label | Yes | Linear labels | `epic:<name>` |
| Size label | Yes | Linear labels | `XS`, `S`, `M`, `L`, or `XL` |
| Estimate | Yes | Linear estimate | Fibonacci points (1, 2, 3, 5, 8) |
| Summary | Yes | Issue description | What and why |
| Acceptance criteria | Yes | Issue description | Checkbox list |
| CUJ references | M+ | Issue description | `#cuj-name` tags |
| Test plan | M+ | Issue description | Exact commands to run |

### Builder -> Tester

| Field | Required | Location | Description |
|-------|----------|----------|-------------|
| PR number | Yes | Linear comment | GitHub PR reference |
| PR target | Yes | Linear comment | `agentdash-main` (default) or `staging` (staging-required) |
| Branch name | Yes | Linear comment | Feature branch name (rebased on `agentdash-main`) |
| Rebase confirmation | Yes | Linear comment | Confirm feature branch is rebased on latest `agentdash-main` |
| Spec path | M+ | Linear comment | `specs/<num>-<name>/spec.md` |
| Test plan path | M+ | Linear comment | `specs/<num>-<name>/test-plan.md` |
| Test scope | Yes | PR body | Commands or CUJ list |
| E2E test file | S+ | Linear comment | Path to E2E test file |
| `PR-Ready` label | Yes | Linear labels | Signals handoff complete |

### Tester -> Human (Locally-Tested or Staging-Tested)

After automated E2E tests AND Chrome-based CUJ verification both pass:

| Field | Required | Location | Description |
|-------|----------|----------|-------------|
| Automated test results | Yes | Linear comment | Pass/fail with counts |
| Chrome CUJ results | Yes | Linear comment | Per-CUJ pass/fail with GIF links |
| GIF recordings | Yes | Linear comment | Visual evidence of CUJ walkthroughs |
| Console/network health | Yes | Linear comment | No errors confirmed |
| Human verification checklist | Yes | Linear comment | ONLY agent-impossible items |
| Code review results | S+ | Linear comment | Summary of findings + inline DiffComments |
| Quality gate label | Yes | Linear labels | `Locally-Tested` (default) or `Staging-Tested` (staging-required) |
| Test URL | Yes | Linear comment | http://localhost:3100 or TODO_SET_STAGING_URL |

**Human verification checklist includes ONLY items agents cannot verify:**
- Third-party dashboard transactions
- Email delivery
- Webhook processing
- AI-generated content quality
- OAuth popup flows

### Tester -> Builder (Failure)

| Field | Required | Location | Description |
|-------|----------|----------|-------------|
| Failure list | Yes | Linear comment | What failed |
| Sub-issues | Yes | Linear sub-issues | One per failure |
| Screenshots | Yes | Sub-issues | Visual evidence |
| Steps to reproduce | Yes | Sub-issues | How to trigger |
| `Tests-Failed` label | Yes | Linear labels | Signals failure |

### TPM -> Production

After human adds `Human-Verified` label and `/tpm sync` runs:

| Field | Required | Location | Description |
|-------|----------|----------|-------------|
| PR merged to `agentdash-main` | Yes | Linear comment | PR number merged |
| PR #2 created (staging-required) | If applicable | Linear comment | PR targeting `agentdash-main` from feature branch |
| Deployment URLs | Yes | Linear comment | Frontend + Backend |
| Health check results | Yes | Linear comment | Pass/fail |
| Prod smoke test results | Yes | Linear comment | Pass/fail |
| Rollback command | Yes | Linear comment | How to revert |
| Staging rebase status | staging-required | Linear comment | Confirm staging rebased on agentdash-main |
| `In-Production` label | Yes | Linear labels | Signals live |

---

## 2. Linear Issue Schema

### Required Structure

```markdown
# AGE-XXX: <Imperative verb> <object>

## Summary
<1-2 sentences: What this does and why>

## Acceptance Criteria
- [ ] <Criterion 1>
- [ ] <Criterion 2>
- [ ] <Criterion 3>

## CUJs
- #<cuj-1>: <description>
- #<cuj-2>: <description>

## Test Plan

**Epic:** epic:<name>
**Size:** <XS|S|M|L|XL>

### Automated Tests
```bash
<exact command to run>
```

### Manual Verification
- [ ] <manual check 1>
- [ ] <manual check 2>
```

### Required Labels

| Label | When Required | Set By |
|-------|---------------|--------|
| `epic:<name>` | Always | PM |
| `<XS\|S\|M\|L\|XL>` | Always | PM or Builder |
| `PR-Ready` | After PR created | Builder |
| `Testing` | During test run | Tester |
| `Tests-Passed` | Automated E2E tests pass | Tester |
| `Tests-Failed` | Any test fails | Tester |
| `Locally-Tested` | Automated + Chrome CUJ verification pass (default) | Tester |
| `Staging-Tested` | Automated + Chrome CUJ verification pass (staging-required) | Tester |
| `Human-Verified` | Human approves external items | Human |
| `Prod-Smoke-Passed` | Production smoke tests pass | TPM |
| `In-Production` | Live in prod | TPM |

**Optional labels:**
| Label | When Used | Set By |
|-------|-----------|--------|
| `PM-Validated` | PM validates as user (optional enrichment) | PM |
| `staging-required` | XL issues needing staging | PM |

### Required Estimate

| Size | Points | Meaning |
|------|--------|---------|
| XS | 1 | Typo, single-line fix |
| S | 2 | Single-file change |
| M | 3 | Multi-file, new component |
| L | 5 | Full-stack feature |
| XL | 8 | Epic, major refactor |

---

## 3. Handoff Comment Templates

### Builder -> Tester Handoff

```markdown
## Handoff: Builder -> Tester

**Issue:** AGE-<number>
**PR:** #<pr_number>
**Branch:** `pap-<number>-<short-name>`

### Issue Context
- **Size:** <XS|S|M|L|XL>
- **Epic:** epic:<name>
- **CUJs:** #<cuj-1>, #<cuj-2>

### Artifacts
- Spec: `specs/<number>-<name>/spec.md`
- Test Plan: `specs/<number>-<name>/test-plan.md`

### Test Scope
```bash
<exact test command>
```

### What to Verify
1. <key behavior 1>
2. <key behavior 2>
3. <key behavior 3>

### E2E Tests
- New: `tests/e2e/<epic>/<feature>.spec.ts`
- Updated: `tests/e2e/<epic>/<existing>.spec.ts`

@tester Ready for E2E testing + Chrome CUJ verification.
```

### Tester -> Human Handoff (Locally-Tested or Staging-Tested)

```markdown
## Tested: Ready for Human Verification

**Issue:** AGE-<number>
**PR:** #<pr_number>

### Automated Test Results
- **Total:** X tests
- **Passed:** X
- **Failed:** 0
- **Skipped:** 0

### Chrome CUJ Verification
| CUJ | Status | GIF |
|-----|--------|-----|
| #<cuj-1>: <description> | PASS | [recording](<gif-url>) |
| #<cuj-2>: <description> | PASS | [recording](<gif-url>) |

### Browser Health
- **Console errors:** None
- **Failed network requests:** None
- **Responsive check:** Passed (desktop + mobile)

---

## Human Verification Checklist (Agent-Impossible Items)

**Test URL:** <http://localhost:3100 or TODO_SET_STAGING_URL>

These items require human verification because agents cannot access external systems:

- [ ] <Third-party dashboard transaction visible> (if applicable)
- [ ] <Email received> (if applicable)
- [ ] <Webhook processed> (if applicable)
- [ ] <AI content quality acceptable> (if applicable)

---

**If ALL items pass:** Add `Human-Verified` label, then run `/tpm sync`
**If ANY item fails:** Add `Tests-Failed` label with details
```

### Tester -> Builder Handoff (Failure)

```markdown
## Tests Failed

**Issue:** AGE-<number>
**PR:** #<pr_number>

### Summary
- **Total:** X tests
- **Passed:** X
- **Failed:** Y

### Failures

#### 1. <Test Name>
- **CUJ:** #<cuj-name>
- **Expected:** <expected behavior>
- **Actual:** <actual behavior>
- **Screenshot:** <link>
- **Sub-issue:** AGE-<number>-1

#### 2. <Test Name>
- **CUJ:** #<cuj-name>
- **Expected:** <expected behavior>
- **Actual:** <actual behavior>
- **Screenshot:** <link>
- **Sub-issue:** AGE-<number>-2

### Console Errors
```
<any relevant errors>
```

@builder Fixes needed. See sub-issues for details.
```

### TPM -> Production Complete

```markdown
## Shipped to Production

**Issue:** AGE-<number>
**Deployed:** <timestamp>

### URLs
- **Frontend:** https://TODO_SET_PRODUCTION_URL
- **Backend:** https://TODO_SET_BACKEND_PROD_URL

### Verification
- [x] Health check passed
- [x] Smoke tests passed
- [x] No console errors

### Rollback Command
```bash
git revert <commit_sha> && git push origin agentdash-main
```

Feature is now live in production.
```

---

## 4. State Detection Logic

Agents use this logic to determine which agent owns an issue. All agents are **workspace-scoped** -- they only track the single issue their workspace is working on.

```python
def get_owner(issue) -> str | None:
    """
    Determine which agent should act on this issue.
    Returns: 'pm', 'builder', 'tester', 'tpm', or None (human/done)

    Workspace-scoped: each workspace tracks exactly one issue.
    """
    labels = {label.name for label in issue.labels}

    # Terminal state - no owner
    if "In-Production" in labels:
        return None

    # TPM auto-ships after human verification
    if "Human-Verified" in labels:
        return "tpm"

    # Human owns - awaiting external-system verification
    if "Locally-Tested" in labels or "Staging-Tested" in labels:
        return None  # Human must add Human-Verified

    # Tester owns - automated tests passed, Chrome CUJ next
    if "Tests-Passed" in labels:
        return "tester"  # Tester continues to Chrome CUJ

    # Tester owns - PR testing
    if "PR-Ready" in labels:
        return "tester"
    if "Testing" in labels:
        return "tester"

    # Builder owns - fix failures
    if "Tests-Failed" in labels:
        return "builder"

    # Builder owns - has spec, needs implementation
    if has_spec_or_criteria(issue) and not has_linked_pr(issue):
        return "builder"

    # PM owns - needs elaboration
    if not has_epic_label(labels):
        return "pm"
    if not has_size_label(labels):
        return "pm"
    if not has_acceptance_criteria(issue):
        return "pm"

    # Default to builder if has epic/size but no PR
    return "builder"


def has_epic_label(labels: set) -> bool:
    return any(l.startswith("epic:") for l in labels)


def has_size_label(labels: set) -> bool:
    return bool(labels & {"XS", "S", "M", "L", "XL"})


def has_spec_or_criteria(issue) -> bool:
    desc = issue.description or ""
    return "## Acceptance Criteria" in desc or "## Summary" in desc


def has_acceptance_criteria(issue) -> bool:
    desc = issue.description or ""
    return "## Acceptance Criteria" in desc and "- [ ]" in desc


def has_linked_pr(issue) -> bool:
    return "github.com" in (issue.description or "") and "/pull/" in (issue.description or "")
```

---

## 5. Error Communication

### Error Comment Template

```markdown
## Agent Error: <Agent Name>

**Issue:** AGE-<number>
**Phase:** <current phase>
**Timestamp:** <ISO timestamp>

### Error Type
<One of: Test Failure, Deployment Failure, API Error, Timeout, Unknown>

### Details
<Specific error message or description>

### Context
```
<Stack trace, logs, or additional context>
```

### Recovery Action
<What the next agent/human should do>

### Blocking
- [ ] This error blocks further progress
- [ ] Manual intervention required
```

### Error Types

| Error Type | Set By | Recovery |
|------------|--------|----------|
| Test Failure | Tester | Builder fixes, re-adds PR-Ready |
| Deployment Failure | TPM | Check logs, retry or rollback |
| API Error | Any | Retry or escalate to human |
| Timeout | Any | Retry with longer timeout |
| Linear API Error | Any | Retry 3x, then manual tracking |
| GitHub API Error | Any | Retry 3x, then manual PR |

---

## 6. Validation Rules

### Before Handoff Validation

Each agent MUST validate before handing off:

**PM -> Builder:**
- [ ] Epic label exists
- [ ] Size label or estimate exists
- [ ] Summary section exists
- [ ] Acceptance criteria exist (with checkboxes)
- [ ] CUJs listed (for M+)
- [ ] Test plan included (for M+)

**Builder -> Tester:**
- [ ] PR created and linked
- [ ] Branch pushed to origin
- [ ] Unit tests pass locally
- [ ] Spec committed (for M+)
- [ ] Test plan committed (for M+)
- [ ] Handoff comment posted
- [ ] E2E test file created/updated (S+ with user-facing behavior)
- [ ] E2E test passes locally
- [ ] `PR-Ready` label added

**Tester -> Human (Locally-Tested or Staging-Tested):**
- [ ] Automated E2E tests passed
- [ ] Chrome CUJ verification passed (all CUJs walked)
- [ ] GIF recordings captured
- [ ] Console/network health confirmed
- [ ] Human verification checklist posted (agent-impossible items only)
- [ ] Code review completed (S+)
- [ ] Inline comments left via DiffComment (if findings)
- [ ] E2E test existence verified for S+ features
- [ ] `Locally-Tested` or `Staging-Tested` label added

**TPM -> Production (after Human-Verified):**
- [ ] `Human-Verified` label present
- [ ] PR merged to `agentdash-main` (TPM is the ONLY agent that merges to agentdash-main)
- [ ] Health checks pass
- [ ] Smoke tests pass
- [ ] Rollback command documented
- [ ] `In-Production` label added
- [ ] Issue marked Done
- [ ] Staging rebased on agentdash-main (staging-required only)

---

## 7. Label State Machine

### Default Flow (all sizes, no `staging-required`)
```
PR-Ready -> Testing -> Tests-Passed -> Locally-Tested -> Human-Verified -> TPM merges -> In-Production
[preview]  [preview]  [preview]      [preview]        [preview]        [agentdash-main]        [production]
              |
         Tests-Failed (back to Builder, rebase on agentdash-main, re-push)
```

### Staging-Required Flow (XL + `staging-required`)
```
PR #1->staging  Testing  Tests-Passed  Staging-Tested  Human-Verified  TPM: PR #2->agentdash-main  TPM merges  Prod Smoke  In-Production
 [staging]   [staging]   [staging]     [staging]        [staging]         [agentdash-main]          [agentdash-main]      [prod]       [production]
                |                                                                                                      |
           Tests-Failed                                                                                    TPM rebases staging
           (back to Builder)                                                                                on agentdash-main
```

### Complete State Diagram

```
                    +--------------------------------------------+
                    |                                            |
                    v                                            |
+----------+   +----------+   +-------------+                  |
| PR-Ready |-->| Testing  |-->|Tests-Passed |                  |
+----------+   +----------+   +-------------+                  |
     ^              |                |                          |
     |              v                v                          |
     |         +-------------+  +----------------+             |
     |         |Tests-Failed |  |Locally-Tested  |             |
     |         +-------------+  |or Staging-Tested|            |
     |              |           +----------------+             |
     +--------------+                |                         |
           (Builder fixes)           v                         |
                              +------------------+             |
                              | Human-Verified   |             |
                              | (human adds)     |             |
                              +------------------+             |
                                       |                       |
                          +------------+------------+          |
                          |                         |          |
                (default) v            (staging-req) v          |
                 +--------------+         +--------------+     |
                 |TPM merges PR |         |TPM: PR #2    |     |
                 |to agentdash-main       |         |-> agentdash-main, merge|     |
                 +--------------+         +--------------+     |
                          |                         |          |
                          v                         v          |
                 +--------------+         +--------------+     |
                 |In-Production |         |In-Production |     |
                 |              |         |+ rebase stg  |     |
                 +--------------+         +--------------+     |
                                                    |          |
                                                    +----------+
                                              (Tests-Failed possible
                                               on prod smoke -> revert)
```

### Valid Transitions

> **Note:** Code review (Phase 3.5) is internal to the Tester's workflow between automated E2E tests and Chrome CUJ verification. It does not create a new label state. If code review finds CRITICAL/HIGH issues, the Tester sets `Tests-Failed` and the normal fix loop applies.

| From | To | Triggered By |
|------|----|--------------|
| (none) | PR-Ready | Builder creates PR (rebased on agentdash-main) |
| PR-Ready | Testing | Tester starts automated tests |
| Testing | Tests-Passed | All automated E2E tests pass |
| Testing | Tests-Failed | Any test fails |
| Tests-Failed | PR-Ready | Builder fixes + rebases on agentdash-main |
| Tests-Passed | Locally-Tested | Chrome CUJ verification passes (default path) |
| Tests-Passed | Staging-Tested | Chrome CUJ verification passes (staging-required path) |
| Locally-Tested | Human-Verified | Human approves external-system items |
| Staging-Tested | Human-Verified | Human approves external-system items |
| Human-Verified | In-Production | TPM merges PR to agentdash-main + prod smoke passes (default) |
| Human-Verified | (TPM creates PR #2) | TPM creates PR -> agentdash-main (staging-required) |
| (PR #2 created) | In-Production | TPM merges PR #2 to agentdash-main + prod smoke passes |

### Invalid Transitions (Blocked)

| From | To | Reason |
|------|----|--------|
| PR-Ready | In-Production | Must pass testing, Chrome CUJ, human verification |
| Tests-Failed | In-Production | Must fix and retest |
| Tests-Passed | In-Production | Must have Locally-Tested/Staging-Tested and Human-Verified first |
| Tests-Passed | Human-Verified | Must have Locally-Tested/Staging-Tested (Chrome CUJ) first |
| (any) | Merge to agentdash-main | Only TPM agent can merge to agentdash-main |
| (any) | Human-Verified | Only humans can set |
| (any) | Locally-Tested/Staging-Tested | Only Tester can set (after both phases pass) |

---

## 8. Quick Reference

### Agent Ownership by Label

| Labels Present | Owner | Action |
|----------------|-------|--------|
| In-Production | None (done) | Issue complete |
| Human-Verified | TPM | Auto-ship: merge to agentdash-main, prod smoke test |
| Locally-Tested or Staging-Tested | Human | Verify external-system items, add Human-Verified |
| Tests-Passed | Tester | Continue to Chrome CUJ verification |
| PR-Ready, Testing | Tester | Run automated E2E tests |
| Tests-Failed | Builder | Fix failures, rebase on agentdash-main, re-push |
| (has spec, no PR) | Builder | Implement and create PR |
| (missing epic/size) | PM | Elaborate requirements |

### Two-Phase Orchestration

| Phase | Command | Owner | Scope |
|-------|---------|-------|-------|
| Intake -> Tested | `/workon AGE-XXX` | Orchestrator (workspace-scoped) | PM -> Builder -> Deploy + Smoke -> Tester (auto + chrome) |
| Human-Verified -> Production | `/tpm sync` | TPM (global) | Scan ALL Human-Verified -> Merge -> Prod smoke -> In-Production |

### Deployment Path Routing

| Condition | PR Target | Testing Environment | Quality Gate |
|-----------|-----------|---------------------|--------------|
| All sizes, no `staging-required` | `agentdash-main` | http://localhost:3100 | `Locally-Tested` |
| XL + `staging-required` | `staging` | TODO_SET_STAGING_URL | `Staging-Tested` |

### Required Comment Tags

| Tag | Purpose |
|-----|---------|
| `@builder` | Notify Builder agent |
| `@tester` | Notify Tester agent |
| `@human` | Notify human reviewer |

---

## Related Documentation

- [sop.md](./sop.md) - Main workflow SOP
- [EPIC_REGISTRY.md](./EPIC_REGISTRY.md) - Epic/CUJ registry template
- [MANUAL_TESTING_GUIDE.md](./MANUAL_TESTING_GUIDE.md) - Manual testing guide template
