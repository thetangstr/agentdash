# Test Plan: {FEATURE_NAME}

**Linear Issue:** {ISSUE_ID}
**Branch:** {BRANCH_NAME}
**Test Environment:** `http://localhost:3100`
**Spec Document:** `specs/{NUMBER}-{FEATURE}/spec.md`

> For Tester: Run `pnpm dev` before testing.

---

## Feature Scope Definition

> **IMPORTANT:** Only test what's listed in "In Scope". Do NOT report issues for "Out of Scope" items.

### What This Feature Does
{1-2 sentence description of the feature's purpose}

### In Scope (MUST Test)
These are the specific changes introduced by this PR:

| Area | What Changed | Pages Affected |
|------|--------------|----------------|
| {UI/API/DB} | {Specific change} | `/page1`, `/page2` |
| {UI/API/DB} | {Specific change} | `/page3` |

**Components Modified:**
- `ui/src/components/{Component1}.tsx`
- `server/src/routes/{route}.ts`

**New Functionality:**
- [ ] {New feature 1}
- [ ] {New feature 2}

**Modified Behavior:**
- [ ] {Changed behavior 1} - was: {old}, now: {new}

### Out of Scope (Do NOT Test)
These areas are NOT part of this PR. If you find issues here, note them but do NOT fail the test:

- {Unrelated feature 1} - Not modified in this PR
- {Pre-existing bug} - Known issue, tracked in AGE-XX
- Performance optimization - Not a goal of this PR

### Dependencies
Features this PR depends on (should already work):
- {Feature A} - Required for {reason}

### Regression Risk
Areas that COULD break due to these changes (quick sanity check):
| Risk Area | Why | Quick Check |
|-----------|-----|-------------|
| {Area 1} | Shares {component/API} | Verify {action} still works |

---

## Test Configuration

### Environment
| Environment | Frontend URL | Backend URL |
|-------------|--------------|-------------|
| **Local Testing** | `http://localhost:3100` | `https://TODO_SET_BACKEND_STAGING_URL` |
| Production | `https://TODO_SET_PRODUCTION_URL` | `https://TODO_SET_BACKEND_PROD_URL` |

> **Note:** All testing happens on http://localhost:3100 unless staging-required. Production URLs listed for reference only.

### Test Credentials
| Role | Email | Password | When to Use |
|------|-------|----------|-------------|
| Standard User | `TODO_SET_TEST_USER_EMAIL` | `TODO_SET_TEST_USER_PASSWORD` | Default for most tests |

### Prerequisites
Before starting tests, verify:
- [ ] Frontend running at http://localhost:3100 (`pnpm dev`)
- [ ] User is logged in with correct role
- [ ] {Feature-specific prerequisite}

---

## Critical User Journeys

> CUJs are ordered by priority. CUJ 1 is the primary happy path. If CUJ 1 fails, stop testing and report immediately.

### CUJ 1: {Primary Happy Path Name}

**Purpose:** {What user goal does this test?}

**User Story:** As a {role}, I want to {action}, so that {benefit}.

**Preconditions:**
- User is logged in as {role}
- User is on `/{starting-page}`

**Steps:**
| Step | Action | Expected Result | Screenshot |
|------|--------|-----------------|------------|
| 1 | Navigate to `/{page}` | Page loads, no console errors | `cuj1-01-page-load.png` |
| 2 | Click "{button/element}" | {Expected behavior} | |
| 3 | Enter "{value}" in {field} | Input accepted, no validation error | |
| 4 | Click "{submit}" | {Success state} | `cuj1-04-success.png` |
| 5 | Refresh page | Data persists | |

**Verification Checklist:**
- [ ] Success message: "{exact expected message}"
- [ ] URL changed to: `/{expected-path}`
- [ ] Console: No errors (warnings OK)
- [ ] Data persisted (verify after refresh)

**Pass Criteria:** All checkboxes must be checked.

---

### CUJ 2: {Secondary Path or Variation}

**Purpose:** {What alternative flow does this test?}

**Steps:**
| Step | Action | Expected Result | Screenshot |
|------|--------|-----------------|------------|
| 1 | {Action} | {Expected} | |
| 2 | {Action} | {Expected} | |

**Verification Checklist:**
- [ ] {Verification 1}
- [ ] {Verification 2}

---

### CUJ 3: {Error Handling / Edge Case}

**Purpose:** {What error scenario does this test?}

**Steps:**
| Step | Action | Expected Result | Screenshot |
|------|--------|-----------------|------------|
| 1 | {Action that triggers error} | Error handled gracefully | |
| 2 | {Recovery action} | User can continue | |

**Verification Checklist:**
- [ ] Error message is user-friendly (not technical)
- [ ] User is not stuck (can retry or navigate away)
- [ ] No console errors (error was caught)

---

## Edge Cases

> Only test edge cases if all CUJs pass.

| ID | Scenario | Steps | Expected | Priority |
|----|----------|-------|----------|----------|
| E1 | {Edge case name} | {Brief steps} | {Expected behavior} | High |
| E2 | {Edge case name} | {Brief steps} | {Expected behavior} | Medium |

---

## Visual & Responsive Testing

> Only test if all CUJs pass.

### Viewport Testing
| Viewport | Width | Checklist |
|----------|-------|-----------|
| Desktop | 1920px | [ ] Layout correct [ ] No overflow |
| Laptop | 1366px | [ ] Layout adapts [ ] No horizontal scroll |
| Tablet | 768px | [ ] Responsive layout [ ] Touch targets adequate |
| Mobile | 375px | [ ] Mobile layout [ ] Text readable |

---

## Accessibility Checklist

> Only test if all CUJs pass.

- [ ] **Keyboard:** Can complete CUJ 1 using only keyboard (Tab, Enter, Escape)
- [ ] **Focus:** Focus indicators visible on all interactive elements
- [ ] **Labels:** Form inputs have associated labels
- [ ] **Alt text:** Images have meaningful alt text
- [ ] **Contrast:** Text is readable

---

## Console Health Check

After completing all CUJs, check browser console for:

| Check | Status | Notes |
|-------|--------|-------|
| React errors | [ ] None | |
| API 4xx errors | [ ] None | |
| API 5xx errors | [ ] None | |
| CORS errors | [ ] None | |

---

## Regression Quick Check

> Only if regression risks were identified in Scope section.

| Risk Area | Quick Check | Status |
|-----------|-------------|--------|
| {Area from scope} | {What to verify} | [ ] OK |

---

## Test Results Template

### Pass Report
```markdown
## All Tests Passed - {ISSUE_ID}

**Environment:** http://localhost:3100
**Tested:** {DATE}
**Tester:** Tester Agent

### Results
| Test | Status | Notes |
|------|--------|-------|
| CUJ 1: {name} | Pass | |
| CUJ 2: {name} | Pass | |
| Edge Cases | Pass | {X}/{Y} tested |
| Visual/Responsive | Pass | All viewports OK |
| Console Health | Clean | No errors |

**Recommendation:** Ready for human verification.
```

### Fail Report
```markdown
## Tests Failed - {ISSUE_ID}

**Environment:** http://localhost:3100
**Tested:** {DATE}

### Failure Details

#### Failure 1: CUJ 2 Step 3 (BLOCKING)
- **Expected:** {expected}
- **Actual:** {actual}
- **Severity:** Blocking
- **Console Error:** {error if any}

**Recommendation:** Fixes required before merge.
@builder Please address blocking issues above.
```

---

## Notes for Tester Agent

### Execution Order
1. **Read entire test plan first** - Understand scope before testing
2. **Verify scope** - Only test In Scope items
3. **Execute CUJs in order** - Stop if CUJ 1 fails
4. **Check console after each CUJ** - Errors may appear async
5. **Complete visual/a11y only if CUJs pass**
6. **Do regression quick check last**

### Severity Guide
| Severity | Meaning | Action |
|----------|---------|--------|
| Blocking | Core feature broken | FAIL test, stop testing |
| Non-blocking | Visual/minor issue | Note in report, continue testing |
| Observation | Not a bug, just noting | Note in report, does not affect pass/fail |

### When to STOP Testing
- CUJ 1 fails completely (page won't load, crash, etc.)
- 3+ blocking issues found
- Environment is broken (backend down, auth broken)
