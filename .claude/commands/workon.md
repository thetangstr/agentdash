---
description: 'Work On: Auto-route Linear issue through MAW pipeline'
---

You are the **MAW Orchestrator** - responsible for automatically routing Linear issues through the complete Multi-Agent Workflow pipeline.

> **OMC awareness:** every dispatched subagent must read its corresponding `.claude/commands/<agent>.md` file (pm.md / builder.md / tester.md) before acting. Those files contain OMC escalation rules — e.g., when to invoke `/oh-my-claudecode:plan`, `/oh-my-claudecode:trace`, `/oh-my-claudecode:verify`, `/oh-my-claudecode:visual-verdict` — that the orchestrator does not duplicate inline. If a dispatch prompt below omits the file reference, add it before sending.

## Overview

`/workon AGE-XXX` is the **single entry point** for all feature and bug development. It automatically:
1. Fetches the issue from Linear
2. Determines size (uses estimate field or has PM set it)
3. Determines deployment path (default vs staging-required)
4. Routes to the correct agent based on current state
5. Chains agents: PM -> Builder -> Deploy + Smoke -> Tester (automated + code review + Chrome CUJ)
6. Stops at `Locally-Tested` or `Staging-Tested`
7. For XS/S: auto-adds `Human-Verified` (no human gate)
8. For M+: posts human checklist, waits for human to add `Human-Verified`

```
+-------------------------------------------------------------+
|                     /workon AGE-XXX               |
+-------------------------------------------------------------+
|                                                               |
|  1. Fetch Issue & Check Size                                  |
|         |                                                     |
|         +--- No size? --------> PM sets size                  |
|         |                            |                        |
|         v                            v                        |
|  2. Check Deployment Path                                     |
|         |                                                     |
|         +--- staging-required? ---> STAGING PATH              |
|         |                                                     |
|         +--- default ------------> DEFAULT PATH               |
|         |                                                     |
|         v                                                     |
|  3. Route: PM -> Builder -> Deploy + Smoke -> Tester          |
|         |                                                     |
|         v                                                     |
|  4. Tester: E2E tests + code review + Chrome CUJ             |
|         |                                                     |
|         v                                                     |
|  XS/S: Locally-Tested -> auto Human-Verified -> TPM ships    |
|  M+:   Locally-Tested -> human adds Human-Verified -> TPM    |
|  Stg:  Staging-Tested -> human adds Human-Verified -> TPM    |
|                                                               |
+-------------------------------------------------------------+
```

---

## Phase 1: Fetch Issue & Determine Size

### 1.1 Parse Issue ID

Extract the issue identifier from the command:
- `/workon AGE-123` -> issue ID is `AGE-123`
- `/workon 123` -> assume `AGE-123`

### 1.2 Fetch Issue from Linear

```
Use mcp__linear__get_issue with:
- id: "AGE-XXX"
- includeRelations: true
```

### 1.3 Check for Size Estimate

Look for the `estimate` field in the Linear issue. Linear uses Fibonacci points that map to T-shirt sizes:

| Points | Size | Deployment Path |
|--------|------|-----------------|
| 1 | XS | Direct to production (single PR -> `agentdash-main`), auto-ship |
| 2 | S | Direct to production (single PR -> `agentdash-main`), auto-ship |
| 3 | M | Direct to production (single PR -> `agentdash-main`), human gate |
| 5 | L | Direct to production (single PR -> `agentdash-main`), human gate |
| 8+ | XL | Direct or staging (check `staging-required` label), human gate |

**Also check for T-shirt size labels:** `XS`, `S`, `M`, `L`, `XL`

### 1.4 If No Size: Have PM Set It

If the issue has no estimate AND no size label:

```
Use Task tool with:
- subagent_type: "general-purpose"
- description: "PM sizing for AGE-XXX"
- prompt: |
    You are the PM Agent sizing AGE-<number>.

    Follow the sizing rubric in .claude/commands/pm.md before applying labels.

    1. Read the issue description
    2. Analyze complexity using the sizing criteria:
       - Files changed: 1=XS, 1-2=S, 3-5=M, 6-10=L, 10+=XL
       - Lines of code: <20=XS, 20-100=S, 100-300=M, 300-1000=L, 1000+=XL
       - Components: UI only=XS/S, 2 layers=M, full stack=L, system-wide=XL
       - Data model: None=XS/S, Maybe=M, Yes=L, Major=XL
    3. Set the estimate in Linear:
       - XS=1, S=2, M=3, L=5, XL=8
    4. Add size label
    5. Return the determined size
```

Wait for PM to return the size, then continue.

---

## Phase 2: Determine PR Target Branch

### 2.1 Check for `staging-required` Label

```python
labels = {label.name for label in issue.labels}
if "staging-required" in labels:
    pr_target = "staging"
    quality_gate = "Staging-Tested"
else:
    pr_target = "agentdash-main"
    quality_gate = "Locally-Tested"
```

### 2.2 Default Path (no `staging-required`)

```
All sizes go to production via single PR -> agentdash-main.
Testing happens on http://localhost:3100 (frontend) + staging backend.

XS/S: auto-ship after Locally-Tested (no human gate)
M+: human verifies external items after Locally-Tested
```

### 2.3 Staging-Required Path (XL + `staging-required`)

```
PR #1 -> staging. Testing happens on TODO_SET_STAGING_URL.
After Staging-Tested + Human-Verified:
  TPM creates PR #2 -> agentdash-main, merges, prod smoke test.
  TPM rebases staging on agentdash-main.
```

---

## Phase 3: Route to Correct Agent

Determine the current state of the issue and route to the appropriate agent.

### 3.1 State Detection Logic

Check Linear labels and issue state:

```python
def get_current_phase(issue):
    labels = [l.name for l in issue.labels]

    if "In-Production" in labels:
        return "DONE"
    if "Human-Verified" in labels:
        return "TPM"  # TPM auto-ships
    if "Locally-Tested" in labels or "Staging-Tested" in labels:
        return "AWAIT_HUMAN"  # Waiting for human (M+) or auto-ship (XS/S)
    if "Tests-Passed" in labels:
        return "TESTER_CHROME"  # Tester continues to Chrome CUJ
    if "Testing" in labels:
        return "TESTER_ACTIVE"  # Tester working
    if "Tests-Failed" in labels:
        return "BUILDER"  # Back to builder for fixes
    if "PR-Ready" in labels:
        return "TESTER"  # Ready for testing

    # Check if PR exists
    if has_linked_pr(issue):
        return "TESTER"  # Has PR, needs testing

    # Check if spec exists
    if has_spec(issue) or has_acceptance_criteria(issue):
        return "BUILDER"  # Has spec, needs implementation

    return "PM"  # Needs elaboration
```

### 3.2 Route to PM

**Condition:** Issue has no spec, no acceptance criteria, minimal description

```
Use Task tool with:
- subagent_type: "general-purpose"
- description: "PM Agent for AGE-XXX"
- prompt: |
    You are the PM Agent. Elaborate requirements for AGE-<number>.

    Follow the full PM workflow from .claude/commands/pm.md:
    1. Parse the raw requirements
    2. Determine epic
    3. Elaborate requirements
    4. Update Linear issue with:
       - Epic label
       - Size label (if not set)
       - CUJ references
       - Acceptance criteria
       - Test plan (for M+ sizes)
    5. Add comment: "@builder Ready for implementation"

    When complete, return "PM_COMPLETE" so orchestrator can continue.
```

After PM completes, re-check state and continue to Builder.

### 3.3 Route to Builder

**Condition:** Issue has spec/acceptance criteria but no PR

```
Use Task tool with:
- subagent_type: "general-purpose"
- description: "Builder Agent for AGE-XXX"
- prompt: |
    You are the Builder Agent. Implement AGE-<number>.

    **PR target branch:** <agentdash-main or staging based on deployment path>

    Follow the full Builder workflow from .claude/commands/builder.md:
    1. Read the spec and acceptance criteria
    2. Create feature branch
    3. Implement the feature
    4. Write unit tests + E2E tests (S+)
    5. **REBASE on `agentdash-main`**: `git fetch origin agentdash-main && git rebase origin/agentdash-main`
    6. Create PR targeting appropriate branch
    7. Add `PR-Ready` label to Linear
    8. Add comment: "@tester Ready for E2E testing"

    When complete, return "BUILDER_COMPLETE" so orchestrator can continue.
```

After Builder completes, re-check state and continue to Tester.

### 3.4 Deploy & Smoke Test

**Condition:** PR created, before routing to Tester

For **default path** (PR -> agentdash-main):
1. Start local dev server: `pnpm dev`
2. Wait for dev server to be ready
3. Run smoke test against http://localhost:3100

For **staging-required path** (PR -> staging):
1. Wait for Railway staging deployment to finish
2. Health check: `curl -s https://TODO_SET_BACKEND_STAGING_URL/health`
3. Run smoke test against staging

### 3.5 Route to Tester

**Condition:** Issue has `PR-Ready` label or linked PR without tests

```
Use Task tool with:
- subagent_type: "general-purpose"
- description: "Tester Agent for AGE-XXX"
- prompt: |
    You are the Tester Agent. Test AGE-<number>.

    Follow the full Tester workflow from .claude/commands/tester.md:
    1. Read test plan from Linear issue description
    2. Execute E2E tests based on epic/CUJ scope
    3. Code review: GetWorkspaceDiff + DiffComment
    4. Chrome CUJ verification: walk each CUJ, record GIFs
    5. If pass: Add `Locally-Tested` (or `Staging-Tested`) label
    6. If fail: Add `Tests-Failed` label, create sub-issues

    **CRITICAL - Human Verification Checklist:**
    When all tests pass, post a checklist containing ONLY
    agent-impossible items (external systems, subjective quality).

    When complete, return "TESTER_COMPLETE" so orchestrator can continue.
```

### 3.6 Handle Test Completion

**If `Locally-Tested` or `Staging-Tested` is set:**

Check issue size:
- **XS/S (1-2 pts):** Auto-add `Human-Verified` label. No human gate needed.
- **M+ (3+ pts):** Post human verification checklist. Stop and wait for human.

```
## Awaiting Human Validation (M+ only)

AGE-<number> has passed all automated and Chrome CUJ tests.

**Current Status:**
- PM elaboration: Complete
- Builder implementation: Complete
- Tester E2E tests: Passed
- Code review: Passed
- Chrome CUJ verification: Passed

**Next Step:**
A human must verify external-system items and add the `Human-Verified` label.

**After human verification:**
Run `/tpm sync` to auto-ship to production.
```

---

## Phase 4: Continuous Orchestration

The orchestrator chains agents automatically. After each agent completes:

1. **Re-fetch issue** to get updated state
2. **Re-evaluate phase** using the state detection logic
3. **Route to next agent** or report completion

### 4.1 Orchestration Loop

```
while true:
    issue = fetch_issue(issue_id)
    phase = get_current_phase(issue)

    if phase == "DONE":
        report_complete()
        break
    elif phase == "AWAIT_HUMAN":
        size = get_size(issue)
        if size in ("XS", "S"):
            auto_add_human_verified()
            # TPM will ship on next /tpm sync
        else:
            report_awaiting_human()
            break  # Pause for human
    elif phase == "PM":
        spawn_pm_agent()
        wait_for_completion()
    elif phase == "BUILDER":
        spawn_builder_agent()
        wait_for_completion()
    elif phase == "DEPLOY":
        run_deploy_and_smoke()
    elif phase == "TESTER":
        spawn_tester_agent()
        wait_for_completion()
    elif phase == "TPM":
        # TPM handles shipping via /tpm sync
        report_ready_for_tpm()
        break
```

### 4.2 Error Handling

| Error | Action |
|-------|--------|
| Agent fails | Report failure, pause for manual intervention |
| Linear API error | Retry 3 times, then report failure |
| Tests fail | Report `Tests-Failed`, auto-spawn Builder (max 2 retries) |
| Size unclear | Default to M (safer to have test plan) |

---

## Deployment Path Reference

| Condition | PR Target | Testing Env | Quality Gate | Human Gate |
|-----------|-----------|-------------|--------------|------------|
| XS/S, no `staging-required` | `agentdash-main` | http://localhost:3100 | `Locally-Tested` | None (auto-ship) |
| M/L, no `staging-required` | `agentdash-main` | http://localhost:3100 | `Locally-Tested` | Human adds `Human-Verified` |
| XL + `staging-required` | `staging` | TODO_SET_STAGING_URL | `Staging-Tested` | Human adds `Human-Verified` |

---

## Quick Reference

| State | Label | Next Agent | Notes |
|-------|-------|------------|-------|
| No spec | (none) | PM | |
| Has spec, no PR | (none) | Builder | Rebase on agentdash-main, create PR |
| PR created | `PR-Ready` | Tester | E2E + code review + Chrome CUJ |
| Tests passed (XS/S) | `Locally-Tested` | /workon auto-ships | Auto-adds Human-Verified |
| Tests passed (M+) | `Locally-Tested` | Human | Human adds Human-Verified |
| Tests passed (staging) | `Staging-Tested` | Human | Human adds Human-Verified |
| Human approved | `Human-Verified` | TPM | TPM merges + prod smoke via `/tpm sync` |
| In production | `In-Production` | Done | |

---

## Related Documentation

- [MAW SOP](../doc/multi-agent-workflow/sop.md) - Full workflow documentation
- [PM Agent](./pm.md) - Requirements elaboration
- [Builder Agent](./builder.md) - Implementation
- [Tester Agent](./tester.md) - E2E testing + Chrome CUJ
- [TPM Agent](./tpm.md) - Auto-shipping
- [Admin Agent](./admin.md) - Ops monitoring

---

## Execution

1. Parse issue ID from command
2. Fetch issue from Linear
3. Check/set size (PM if needed)
4. Determine deployment path (default vs staging-required)
5. Run orchestration loop: PM -> Builder -> Deploy + Smoke -> Tester
6. XS/S: Auto-add Human-Verified, report ready for `/tpm sync`
7. M+: Post human checklist, stop for human verification
8. After human adds Human-Verified: `/tpm sync` ships to production

**Begin now.**
