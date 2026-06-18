# MAW v6 Protocol

The Multi-Agent Workflow protocol defines the contract that all agents follow when
processing Linear issues through the pipeline. Every state transition, handoff payload,
ownership rule, pickup heuristic, error-recovery path, and context budget is specified
here. Agents MUST NOT deviate from this protocol unless a human explicitly overrides a
specific rule.

---

## 1. Label State Machine

### 1.1 Issue Statuses (Linear built-in)

These are the Linear issue statuses. Exactly one is active at any time.

| Status | Meaning |
|---|---|
| `Backlog` | Unstarted, not yet triaged or prioritized |
| `Todo` | Triaged and ready for autonomous pickup |
| `In Progress` | An agent has claimed the issue and is actively working |
| `Done` | Completed and merged to production |
| `Canceled` | Will not be done (out of scope, superseded, invalid) |
| `Duplicate` | Duplicate of another issue; link the canonical issue |

### 1.2 Workflow Labels

Workflow labels are applied alongside the status to track fine-grained pipeline
position. An issue carries zero or more workflow labels at any time. Labels are
additive during the happy path (earlier labels are removed when they become
irrelevant) and are managed atomically by the owning agent.

#### Pipeline-phase labels

| Label | Set By | Meaning |
|---|---|---|
| `Needs-PM` | Orchestrator / PM | Issue requires PM elaboration before a builder can start |
| `PM-Complete` | PM | PM has elaborated requirements; ready for builder pickup |
| `Building` | Builder | Builder is actively implementing |
| `PR-Open` | Builder | Pull request has been created |
| `CI-Passing` | CI / Builder | CI pipeline passed on the PR |
| `CI-Failing` | CI / Builder | CI pipeline failed on the PR |
| `Testing` | Tester | Tester is running verification |
| `Tests-Passed` | Tester | All automated and CUJ tests pass |
| `Tests-Failed` | Tester | One or more tests failed; issue returns to builder |
| `Review-Ready` | Tester | PR is ready for code review |
| `Review-Approved` | Tester / Reviewer | Code review passed |
| `Review-Changes-Requested` | Tester / Reviewer | Reviewer wants changes before approval |
| `Merge-Ready` | Tester / Reviewer | Approved and ready for TPM to merge |
| `Staging-Deployed` | TPM | Deployed to the staging environment |
| `Staging-Verified` | TPM / Human | Staging smoke tests passed |
| `Production-Deployed` | TPM | Live in production |
| `OTA-Pushed` | TPM | OTA update sent to edge instances |

#### Size labels (exactly one per issue)

| Label | Points | Description |
|---|---|---|
| `size:XS` | 1 | Typo, copy change, single-line CSS fix |
| `size:S` | 2 | Single-file logic change, small bug fix |
| `size:M` | 3 | Multi-file change, new component, 2 layers |
| `size:L` | 5 | Full-stack feature, API + frontend + data model |
| `size:XL` | 8 | Epic-scale, major refactor, system-wide change |

#### Type labels (exactly one per issue)

| Label | Description |
|---|---|
| `Bug` | Defect in existing behavior |
| `Feature` | Net-new capability |
| `Improvement` | Enhancement to existing behavior |
| `Chore` | Maintenance, refactoring, tooling, docs |

---

## 2. State Transitions

### 2.1 Transition Table

Every valid transition is listed below. Any transition not in this table is
**illegal** and agents MUST NOT perform it. The "Actor" column identifies the
agent (or external system) authorized to execute the transition.

| From | To | Actor | Condition |
|---|---|---|---|
| `Backlog` | `Todo` | Human / PM | Issue triaged and prioritized |
| `Todo` | `In Progress` + `Needs-PM` | Orchestrator | Issue lacks elaboration; PM required |
| `Todo` | `In Progress` + `Building` | Builder | Issue already has AC; no PM needed (XS/S quick path) |
| `In Progress` + `Needs-PM` | `In Progress` + `PM-Complete` | PM | Requirements elaborated, AC written |
| `In Progress` + `PM-Complete` | `In Progress` + `Building` | Builder | Builder picks up elaborated issue |
| `In Progress` + `Building` | `In Progress` + `PR-Open` | Builder | PR created, pushed to remote |
| `In Progress` + `PR-Open` | `In Progress` + `CI-Passing` | CI | All CI checks green |
| `In Progress` + `PR-Open` | `In Progress` + `CI-Failing` | CI | One or more CI checks failed |
| `In Progress` + `CI-Failing` | `In Progress` + `Building` | Builder | Auto-fix attempt (see section 6) |
| `In Progress` + `CI-Passing` | `In Progress` + `Testing` | Tester | Tester picks up for verification |
| `In Progress` + `Testing` | `In Progress` + `Tests-Passed` | Tester | All automated + CUJ tests pass |
| `In Progress` + `Testing` | `In Progress` + `Tests-Failed` | Tester | One or more tests failed |
| `In Progress` + `Tests-Failed` | `In Progress` + `Building` | Builder | Auto-fix attempt (see section 6) |
| `In Progress` + `Tests-Passed` | `In Progress` + `Review-Ready` | Tester | Tester posts review request |
| `In Progress` + `Review-Ready` | `In Progress` + `Review-Approved` | Reviewer | Code review approved |
| `In Progress` + `Review-Ready` | `In Progress` + `Review-Changes-Requested` | Reviewer | Changes requested |
| `In Progress` + `Review-Changes-Requested` | `In Progress` + `Building` | Builder | Builder addresses feedback |
| `In Progress` + `Review-Approved` | `In Progress` + `Merge-Ready` | Reviewer | Approved and all checks green |
| `In Progress` + `Merge-Ready` | `Done` + `Production-Deployed` | TPM | TPM merges, deploys, smoke passes (quick path) |
| `In Progress` + `Merge-Ready` | `Done` + `Staging-Deployed` | TPM | TPM merges to staging (staging path) |
| `Done` + `Staging-Deployed` | `Done` + `Staging-Verified` | TPM / Human | Staging smoke tests pass |
| `Done` + `Staging-Verified` | `Done` + `Production-Deployed` | TPM | TPM promotes to production |
| `Done` + `Production-Deployed` | `Done` + `OTA-Pushed` | TPM | OTA update sent to edge |
| Any | `Canceled` | Human | Human cancels the issue |
| Any | `Duplicate` | Human / PM | Identified as duplicate |

### 2.2 Happy Path (Full Pipeline)

The standard flow for an M/L/XL issue that requires PM elaboration:

```
Todo
  --> In Progress + Needs-PM
  --> PM-Complete
  --> Building
  --> PR-Open
  --> CI-Passing
  --> Testing
  --> Tests-Passed
  --> Review-Ready
  --> Review-Approved
  --> Merge-Ready
  --> (TPM merges)
  --> Done + Staging-Deployed      [if staging-required]
  --> Staging-Verified             [if staging-required]
  --> Done + Production-Deployed
  --> OTA-Pushed                   [if edge instances exist]
```

### 2.3 Quick Path (XS/S, No PM Needed)

For small issues where acceptance criteria are already clear:

```
Todo
  --> In Progress + Building
  --> PR-Open
  --> CI-Passing
  --> Tests-Passed
  --> Review-Ready
  --> Review-Approved
  --> Merge-Ready
  --> Done + Production-Deployed
```

### 2.4 Failure Recovery Paths

```
CI-Failing ----> Building          (auto-fix loop, max 3 attempts)
Tests-Failed --> Building          (auto-fix loop, max 2 attempts)
Review-Changes-Requested --> Building  (address feedback, unlimited attempts)
```

After max retry attempts are exhausted, the issue is labeled `Blocked` and a
human is alerted. See section 6 for full error-handling rules.

### 2.5 State Transition Diagram

```
                                +------------+
                                |  Backlog   |
                                +-----+------+
                                      |
                                      v
                                +-----+------+
                         +----->|    Todo     |
                         |      +--+-------+-+
                         |         |       |
                         |    (needs PM)  (has AC)
                         |         |       |
                         |         v       v
                         |    Needs-PM   Building <-----+-----+-----+
                         |         |       |            |     |     |
                         |         v       |     CI-Failing   |  Review-
                         |    PM-Complete  |     (max 3)      |  Changes-
                         |         |       |            Tests-Failed  Requested
                         |         +---+---+            (max 2)
                         |             |
                         |             v
                         |          PR-Open
                         |          /     \
                         |         v       v
                         |   CI-Passing   CI-Failing ---+
                         |         |                    |
                         |         v                    |
                         |      Testing                 |
                         |      /     \                 |
                         |     v       v                |
                         | Tests-     Tests-Failed -----+
                         | Passed
                         |     |
                         |     v
                         | Review-Ready
                         |   /       \
                         |  v         v
                         | Review-   Review-Changes-
                         | Approved  Requested --------+
                         |  |
                         |  v
                         | Merge-Ready
                         |  |
                         |  v
               +---------+ Done
               |         /    \
          (canceled/   v      v
           duplicate) Staging- Production-
                      Deployed Deployed
                        |        |
                        v        v
                      Staging-  OTA-Pushed
                      Verified
                        |
                        v
                      Production-
                      Deployed
                        |
                        v
                      OTA-Pushed
```

---

## 3. Agent Ownership

### 3.1 Ownership Function

The `get_owner(labels, status)` function determines which agent is responsible
for acting on an issue at any given moment. Exactly one agent owns an issue at a
time. No concurrent work on the same issue is permitted.

```python
# Canonical set of labels that indicate active pipeline phase.
PHASE_LABELS = {
    "Needs-PM", "PM-Complete", "Building", "PR-Open",
    "CI-Passing", "CI-Failing", "Testing",
    "Tests-Passed", "Tests-Failed",
    "Review-Ready", "Review-Approved", "Review-Changes-Requested",
    "Merge-Ready",
    "Staging-Deployed", "Staging-Verified",
    "Production-Deployed", "OTA-Pushed",
}


def get_owner(labels: set[str], status: str) -> str | None:
    """
    Return the agent that should act on this issue, or None if no action
    is needed (terminal state or awaiting human).

    Evaluation order matters: check from the end of the pipeline backward
    so that the most-progressed state wins when multiple labels are present
    during an atomic transition.
    """

    # Terminal states -- no agent action needed
    if status in ("Done", "Canceled", "Duplicate"):
        # TPM owns post-Done deployment labels
        if "Merge-Ready" in labels and "Production-Deployed" not in labels:
            return "tpm"
        if "Staging-Deployed" in labels and "Staging-Verified" not in labels:
            return "tpm"
        if "Staging-Verified" in labels and "Production-Deployed" not in labels:
            return "tpm"
        if "Production-Deployed" in labels and "OTA-Pushed" not in labels:
            return "tpm"
        return None

    if status == "Backlog":
        return None  # Human must triage to Todo first

    if status == "Todo":
        return "orchestrator"  # Orchestrator decides PM vs Builder

    # -- In Progress: check pipeline labels in reverse pipeline order --

    if "Merge-Ready" in labels:
        return "tpm"
    if "Review-Approved" in labels:
        return "tpm"  # TPM confirms merge-readiness
    if "Review-Changes-Requested" in labels:
        return "builder"
    if "Review-Ready" in labels:
        return "reviewer"
    if "Tests-Passed" in labels:
        return "tester"  # Tester posts review
    if "Tests-Failed" in labels:
        return "builder"
    if "Testing" in labels:
        return "tester"
    if "CI-Failing" in labels:
        return "builder"
    if "CI-Passing" in labels:
        return "tester"
    if "PR-Open" in labels:
        return "ci"  # Waiting for CI result
    if "Building" in labels:
        return "builder"
    if "PM-Complete" in labels:
        return "builder"
    if "Needs-PM" in labels:
        return "pm"

    # In Progress with no workflow labels -- orchestrator must route
    if status == "In Progress":
        return "orchestrator"

    return None
```

### 3.2 Ownership Rules

1. **Single owner.** At most one agent acts on an issue at any time.
2. **Atomic transitions.** When an agent completes its phase, it MUST update
   labels atomically (remove old phase label, add new phase label) in a single
   Linear API call. Split updates risk race conditions.
3. **No self-assignment across phases.** A builder cannot also act as tester on
   the same issue. The orchestrator enforces separation.
4. **Orchestrator as router.** The orchestrator (`/workon`) does not do domain
   work. It reads state, calls `get_owner()`, and dispatches the correct agent.

### 3.3 Agent-to-Label Mapping

Each agent may only set or remove the labels listed in its row. Touching another
agent's labels is a protocol violation.

| Agent | Labels It May Set | Labels It May Remove |
|---|---|---|
| **Orchestrator** | `Needs-PM`, `Building` (initial routing only) | -- |
| **PM** | `PM-Complete`, `size:*`, type labels | `Needs-PM` |
| **Builder** | `Building`, `PR-Open`, `CI-Passing`, `CI-Failing` | `PM-Complete`, `Tests-Failed`, `Review-Changes-Requested`, `CI-Failing` |
| **Tester** | `Testing`, `Tests-Passed`, `Tests-Failed`, `Review-Ready` | `CI-Passing`, `PR-Open`, `Building` |
| **Reviewer** | `Review-Approved`, `Review-Changes-Requested`, `Merge-Ready` | `Review-Ready` |
| **TPM** | `Staging-Deployed`, `Staging-Verified`, `Production-Deployed`, `OTA-Pushed` | `Merge-Ready` |
| **Human** | Any label | Any label |

---

## 4. Structured Handoff Payloads

ALL agent-to-agent handoffs use structured JSON stored as Linear issue
attachments (not free-text comments). Each payload is validated against the
schema below before the handoff is considered complete. Free-text Linear
comments are used only for human-readable summaries that reference the
attachment.

### 4.1 Attachment Naming Convention

All handoff attachments follow this title pattern:

```
handoff:<from>_to_<to>
```

When multiple attachments share the same title (e.g., successive fix reports),
the receiving agent reads the most recent one by `timestamp`.

### 4.2 PM to Builder

Attachment title: `handoff:pm_to_builder`

```json
{
  "type": "pm_to_builder",
  "version": "6.0",
  "timestamp": "2026-06-01T12:00:00Z",
  "issue_id": "AGE-123",
  "acceptance_criteria": [
    "User can sign up with email and password",
    "Confirmation email is sent within 30 seconds",
    "Duplicate email returns 409 with clear error message"
  ],
  "affected_areas": [
    "server/src/routes/auth.ts",
    "server/src/services/auth.ts",
    "ui/src/components/auth/SignupForm.tsx",
    "packages/db/src/schema/users.ts"
  ],
  "size": "M",
  "deployment_notes": "Requires DB migration (new email_verified column)",
  "test_focus": [
    "auth flow end-to-end",
    "duplicate email handling",
    "email delivery (manual verification)"
  ],
  "out_of_scope": [
    "OAuth/SSO providers",
    "Password reset flow"
  ],
  "cujs": [
    "#auth-signup",
    "#auth-login"
  ]
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `type` | Yes | string | Always `"pm_to_builder"` |
| `version` | Yes | string | Protocol version (`"6.0"`) |
| `timestamp` | Yes | ISO 8601 | When the handoff was created |
| `issue_id` | Yes | string | Linear issue identifier |
| `acceptance_criteria` | Yes | string[] | Testable criteria; each must be independently verifiable |
| `affected_areas` | Yes | string[] | File paths or directories the builder should modify |
| `size` | Yes | string | One of `"XS"`, `"S"`, `"M"`, `"L"`, `"XL"` |
| `test_focus` | Yes | string[] | Areas the tester should concentrate on |
| `deployment_notes` | No | string | Migration, env var, or infra requirements |
| `out_of_scope` | No | string[] | Explicitly excluded from this issue |
| `cujs` | No | string[] | CUJ identifiers from the epic registry |

### 4.3 Builder to CI

Attachment title: `handoff:builder_to_ci`

```json
{
  "type": "builder_to_ci",
  "version": "6.0",
  "timestamp": "2026-06-01T13:30:00Z",
  "issue_id": "AGE-123",
  "pr_url": "https://github.com/agentdash/agentdash/pull/42",
  "pr_number": 42,
  "branch": "feat/AGE-123-signup-flow",
  "base_branch": "main",
  "files_changed": [
    "server/src/routes/auth.ts",
    "server/src/services/auth.ts",
    "ui/src/components/auth/SignupForm.tsx",
    "packages/db/src/schema/users.ts",
    "packages/db/drizzle/0061_add_email_verified.sql",
    "tests/e2e/auth/signup.spec.ts"
  ],
  "test_commands": [
    "pnpm -r typecheck",
    "pnpm test:run",
    "pnpm build",
    "pnpm exec playwright test tests/e2e/auth/signup.spec.ts"
  ],
  "migration_required": true,
  "migration_file": "packages/db/drizzle/0061_add_email_verified.sql",
  "commit_count": 3,
  "lines_added": 287,
  "lines_removed": 12
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `type` | Yes | string | Always `"builder_to_ci"` |
| `version` | Yes | string | Protocol version |
| `timestamp` | Yes | ISO 8601 | When the handoff was created |
| `issue_id` | Yes | string | Linear issue identifier |
| `pr_url` | Yes | string | Full GitHub PR URL |
| `pr_number` | Yes | integer | GitHub PR number |
| `branch` | Yes | string | Feature branch name |
| `base_branch` | Yes | string | Target branch (`"main"` or `"staging"`) |
| `files_changed` | Yes | string[] | All files added, modified, or deleted |
| `test_commands` | Yes | string[] | Ordered commands to run in CI |
| `migration_required` | Yes | boolean | Whether a DB migration is included |
| `migration_file` | No | string | Path to migration file (if `migration_required`) |
| `commit_count` | No | integer | Number of commits in the PR |
| `lines_added` | No | integer | Total lines added |
| `lines_removed` | No | integer | Total lines removed |

### 4.4 Tester to Reviewer

Attachment title: `handoff:tester_to_reviewer`

```json
{
  "type": "tester_to_reviewer",
  "version": "6.0",
  "timestamp": "2026-06-01T14:15:00Z",
  "issue_id": "AGE-123",
  "pr_url": "https://github.com/agentdash/agentdash/pull/42",
  "test_results": {
    "pass": 42,
    "fail": 0,
    "skip": 2,
    "duration_seconds": 87,
    "suite": "pnpm exec playwright test tests/e2e/auth/signup.spec.ts"
  },
  "regression_gates": {
    "typecheck": "pass",
    "unit_tests": "pass",
    "build": "pass"
  },
  "code_review_findings": [
    {
      "severity": "MEDIUM",
      "file": "server/src/services/auth.ts",
      "line": 47,
      "description": "Password hash uses bcrypt with cost 10; consider cost 12 for production",
      "suggestion": "Update BCRYPT_ROUNDS constant to 12"
    }
  ],
  "cuj_verification": {
    "completed": true,
    "cujs_tested": [
      {
        "id": "#auth-signup",
        "status": "pass",
        "evidence": "screenshot:signup-flow-complete.png"
      },
      {
        "id": "#auth-login",
        "status": "pass",
        "evidence": "gif:login-after-signup.gif"
      }
    ]
  },
  "console_errors": [],
  "network_failures": [],
  "recommendation": "approve"
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `type` | Yes | string | Always `"tester_to_reviewer"` |
| `version` | Yes | string | Protocol version |
| `timestamp` | Yes | ISO 8601 | When the handoff was created |
| `issue_id` | Yes | string | Linear issue identifier |
| `pr_url` | Yes | string | Full GitHub PR URL |
| `test_results` | Yes | object | `{pass, fail, skip, duration_seconds, suite}` |
| `regression_gates` | Yes | object | `{typecheck, unit_tests, build}` -- each `"pass"` or `"fail"` |
| `cuj_verification` | Yes | object | `{completed, cujs_tested[]}` |
| `recommendation` | Yes | string | `"approve"`, `"approve_with_comments"`, `"request_changes"`, or `"reject"` |
| `code_review_findings` | No | object[] | `{severity, file, line, description, suggestion}` per finding |
| `console_errors` | No | string[] | Browser console errors observed during CUJ |
| `network_failures` | No | string[] | Failed network requests observed during CUJ |

**Severity values for `code_review_findings`:** `"CRITICAL"`, `"HIGH"`,
`"MEDIUM"`, `"LOW"`.

### 4.5 Reviewer to TPM

Attachment title: `handoff:reviewer_to_tpm`

```json
{
  "type": "reviewer_to_tpm",
  "version": "6.0",
  "timestamp": "2026-06-01T14:45:00Z",
  "issue_id": "AGE-123",
  "pr_url": "https://github.com/agentdash/agentdash/pull/42",
  "pr_number": 42,
  "review_verdict": "approved",
  "review_comments": [
    {
      "file": "server/src/services/auth.ts",
      "line": 47,
      "comment": "MEDIUM finding acknowledged; tracked as follow-up AGE-130"
    }
  ],
  "merge_strategy": "merge",
  "notes": "Clean implementation, good test coverage. One MEDIUM finding deferred to AGE-130.",
  "staging_required": false
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `type` | Yes | string | Always `"reviewer_to_tpm"` |
| `version` | Yes | string | Protocol version |
| `timestamp` | Yes | ISO 8601 | When the handoff was created |
| `issue_id` | Yes | string | Linear issue identifier |
| `pr_url` | Yes | string | Full GitHub PR URL |
| `pr_number` | Yes | integer | GitHub PR number |
| `review_verdict` | Yes | string | `"approved"` or `"changes_requested"` |
| `merge_strategy` | Yes | string | `"merge"`, `"squash"`, or `"rebase"` |
| `review_comments` | No | object[] | `{file, line, comment}` per comment |
| `notes` | No | string | Human-readable summary for TPM |
| `staging_required` | No | boolean | Whether staging deployment is needed before production |

### 4.6 Builder Fix Report (Failure Recovery)

Attachment title: `handoff:builder_fix_report`

```json
{
  "type": "builder_fix_report",
  "version": "6.0",
  "timestamp": "2026-06-01T15:00:00Z",
  "issue_id": "AGE-123",
  "fix_attempt": 1,
  "max_attempts": 3,
  "failure_source": "ci",
  "failures_addressed": [
    {
      "description": "TypeScript error in auth.ts line 47: Property 'hash' does not exist on type 'string'",
      "fix": "Added bcrypt.hash() call before assignment",
      "files_modified": ["server/src/services/auth.ts"]
    }
  ],
  "commits": [
    {
      "sha": "abc1234",
      "message": "fix(AGE-123): add bcrypt hash call in signup service"
    }
  ],
  "local_verification": {
    "typecheck": "pass",
    "unit_tests": "pass",
    "build": "pass"
  }
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `type` | Yes | string | Always `"builder_fix_report"` |
| `version` | Yes | string | Protocol version |
| `timestamp` | Yes | ISO 8601 | When the fix was completed |
| `issue_id` | Yes | string | Linear issue identifier |
| `fix_attempt` | Yes | integer | Which attempt this is (1-indexed) |
| `max_attempts` | Yes | integer | Maximum attempts allowed for this failure source |
| `failure_source` | Yes | string | `"ci"`, `"tests"`, or `"review"` |
| `failures_addressed` | Yes | object[] | `{description, fix, files_modified}` per failure |
| `commits` | No | object[] | `{sha, message}` per fix commit |
| `local_verification` | Yes | object | `{typecheck, unit_tests, build}` -- each `"pass"` or `"fail"` |

---

## 5. Autonomous Pickup Rules

### 5.1 Query Pattern

Each agent periodically queries Linear for issues matching its ownership. The
query runs on agent startup and after each completed unit of work.

```python
def find_next_issue(agent_role: str, team: str = "AgentDash") -> Issue | None:
    """
    Find the highest-priority issue this agent should work on next.
    """
    issues = linear.list_issues(
        team=team,
        status="In Progress",
        limit=50,
    )

    candidates = []
    for issue in issues:
        labels = {label.name for label in issue.labels}
        owner = get_owner(labels, issue.status)
        if owner == agent_role:
            candidates.append(issue)

    if not candidates:
        # Orchestrator also checks Todo for new issues to route
        if agent_role == "orchestrator":
            todo_issues = linear.list_issues(
                team=team, status="Todo", limit=50
            )
            candidates.extend(todo_issues)

    if not candidates:
        return None

    # Sort by priority (Urgent first), then by creation date (FIFO)
    candidates.sort(key=lambda i: (priority_rank(i.priority), i.created_at))
    return candidates[0]
```

### 5.2 Priority Order

Issues are picked in strict priority order. Within the same priority level,
oldest first (FIFO).

| Priority | Rank | Description |
|---|---|---|
| Urgent | 0 | Production outage, security vulnerability |
| High | 1 | Blocking other work, customer-reported bug |
| Medium | 2 | Standard feature work, planned improvements |
| Low | 3 | Nice-to-have, polish, tech debt |
| No priority | 4 | Unprioritized (treated as lowest) |

```python
def priority_rank(priority: str) -> int:
    return {
        "Urgent": 0,
        "High": 1,
        "Medium": 2,
        "Low": 3,
        "No priority": 4,
    }.get(priority, 4)
```

### 5.3 Lock Mechanism

When an agent picks up an issue, it MUST atomically:

1. Set the status to `In Progress` (if not already).
2. Apply its phase label (e.g., `Building`, `Testing`).
3. Post a Linear comment: `"## <Agent> Started\n\nPicked up at <timestamp>."`.

This constitutes the lock. Other agents see the phase label and know the issue
is owned.

```python
def claim_issue(issue_id: str, phase_label: str, agent_name: str) -> bool:
    """
    Atomically claim an issue. Returns False if the issue was already
    claimed by another agent (label changed since our read).
    """
    issue = linear.get_issue(issue_id)
    labels = {label.name for label in issue.labels}

    # Check that no other agent has claimed it since our query
    active_phase_labels = labels & PHASE_LABELS
    if active_phase_labels - {phase_label}:
        return False  # Another agent already transitioned it

    # Atomic update: status + labels in one call
    linear.save_issue(
        id=issue_id,
        status="In Progress",
        labels=list((labels - PHASE_LABELS) | {phase_label}),
    )
    linear.save_comment(
        issue_id=issue_id,
        body=f"## {agent_name} Started\n\nClaimed at {now_iso()}.",
    )
    return True
```

### 5.4 Stale Lock Detection

If an issue has been `In Progress` with an unchanged phase label for longer
than the phase timeout (see section 6.3), it is considered stale. The
orchestrator may reclaim it:

1. Post a comment: `"## Stale Lock Detected\n\nPhase <label> unchanged for
   <duration>. Reclaiming."`.
2. Remove the stale phase label.
3. Re-route through `get_owner()`.

```python
def detect_stale_locks(team: str = "AgentDash") -> list[Issue]:
    """
    Find issues stuck in a phase longer than the timeout.
    """
    issues = linear.list_issues(team=team, status="In Progress", limit=100)
    stale = []
    for issue in issues:
        labels = {label.name for label in issue.labels}
        phase = labels & PHASE_LABELS
        if not phase:
            continue
        phase_label = next(iter(phase))
        timeout = PHASE_TIMEOUTS.get(phase_label)
        if timeout and issue.updated_at < now() - timeout:
            stale.append(issue)
    return stale
```

The default stale threshold is **2 hours** of no label change. Phase-specific
timeouts override this default (see section 6.3).

---

## 6. Error Handling

### 6.1 Retry Limits

Each failure-recovery loop has a maximum number of attempts. After the maximum,
the issue is labeled `Blocked` and a human is alerted.

| Phase | Failure Label | Max Retries | Retry Actor | Escalation |
|---|---|---|---|---|
| CI | `CI-Failing` | 3 | Builder (auto-fix) | `Blocked` + human alert |
| Testing | `Tests-Failed` | 2 | Builder (auto-fix) | `Blocked` + human alert |
| Review | `Review-Changes-Requested` | Unlimited | Builder | Never auto-blocked (human is in the loop) |

### 6.2 Retry Counter

The retry count is tracked via `builder_fix_report` handoff attachments (section
4.6). Each attachment includes `fix_attempt` and `max_attempts`. The orchestrator
reads the latest fix report to determine whether to dispatch another attempt or
escalate.

```python
def should_retry(issue_id: str, failure_source: str) -> bool:
    """
    Check whether another retry is allowed for this failure type.
    Returns True if under the limit, False if exhausted.
    """
    max_retries = {"ci": 3, "tests": 2}
    limit = max_retries.get(failure_source, 0)

    fix_reports = linear.get_attachments(
        issue_id=issue_id,
        title_prefix="handoff:builder_fix_report",
    )
    attempts = sum(
        1 for r in fix_reports
        if json.loads(r.content)["failure_source"] == failure_source
    )
    return attempts < limit
```

### 6.3 Phase Timeouts

Each phase has a maximum wall-clock duration. If exceeded, the orchestrator
reclaims the issue via stale lock detection (section 5.4) and either retries
or escalates.

| Phase Label | Timeout | On Timeout |
|---|---|---|
| `Needs-PM` | 15 minutes | Reclaim, re-dispatch PM |
| `Building` | 45 minutes | Reclaim, re-dispatch builder (counts as retry) |
| `PR-Open` (waiting for CI) | 15 minutes | Check CI status; if still pending, wait; if stuck, reclaim |
| `Testing` | 30 minutes | Reclaim, re-dispatch tester |
| `Review-Ready` | 30 minutes | Alert human (review may require human reviewer) |
| `Merge-Ready` | 15 minutes | Alert human (deployment may be blocked) |

```python
PHASE_TIMEOUTS = {
    "Needs-PM": timedelta(minutes=15),
    "Building": timedelta(minutes=45),
    "PR-Open": timedelta(minutes=15),
    "Testing": timedelta(minutes=30),
    "Review-Ready": timedelta(minutes=30),
    "Merge-Ready": timedelta(minutes=15),
}
```

### 6.4 Circuit Breaker

When an issue exceeds its retry limit for a given failure source, the circuit
breaker activates:

1. Remove all pipeline-phase labels from the issue.
2. Add the `Blocked` label.
3. Post a Linear comment:

```markdown
## Blocked -- Automated Recovery Exhausted

**Phase:** <failing phase>
**Failure source:** <ci | tests>
**Attempts:** <count>/<max>
**Last failure:**
<failure description from latest fix report>

Requires human intervention. To unblock:
1. Investigate the root cause
2. Fix manually or provide guidance in a comment
3. Remove the `Blocked` label
4. Re-run `/workon AGE-XXX` to resume the pipeline
```

4. Set issue priority to `Urgent` if not already.

### 6.5 Catastrophic Failure

If an agent crashes (unhandled exception, OOM, network partition), the stale
lock detector (section 5.4) catches it at the next orchestrator poll. The
orchestrator:

1. Logs the stale lock detection.
2. Removes the stale phase label.
3. Re-routes the issue through `get_owner()`.
4. If the re-routed agent was the same one that crashed and this is the second
   consecutive crash on this issue, escalates to `Blocked` via the circuit
   breaker (section 6.4).

---

## 7. Context Budget

Each agent session operates within a fixed context window. The budget below
ensures agents have sufficient room for reasoning and tool use while preventing
context overflow on large issues.

### 7.1 Per-Agent Allocation

| Segment | Max Tokens | Purpose |
|---|---|---|
| Agent prompt | ~2,000 | Role definition, rules, tool descriptions |
| Issue context | 4,000 | Linear issue body, comments, acceptance criteria |
| Handoff payloads | 2,000 | Structured JSON from upstream agent |
| Codebase map | 8,000 | Repository structure, relevant file summaries |
| Diff context | 16,000 | PR diff, changed file contents |
| Tool output buffer | 8,000 | Accumulated tool call results |
| **Reserved for reasoning** | **~70,000** | Chain-of-thought, planning, tool invocations |
| **Total budget** | **~110,000** | Approximate context window |

### 7.2 Budget Enforcement Rules

1. **Issue context truncation.** If the Linear issue body exceeds 4,000 tokens,
   the agent extracts only: Summary, Acceptance Criteria, Test Plan, and the
   latest 3 comments. Older comments and verbose descriptions are dropped.

2. **Diff windowing.** If the PR diff exceeds 16,000 tokens, the agent
   prioritizes files in this order:
   - Files listed in `affected_areas` of the PM handoff (full diff).
   - Test files (full diff).
   - Remaining files (first 50 lines of diff per file, followed by a
     `[truncated -- <N> lines omitted]` marker).

3. **Codebase map strategy.** The 8,000-token codebase map is built by:
   - Reading the repository directory tree (top 2 levels).
   - Including full content of `CLAUDE.md` and `AGENTS.md`.
   - Including schema definitions for any tables referenced in the issue.
   - Summarizing (not including full content of) other referenced files.

4. **No context sharing between agents.** Each agent session starts fresh. All
   inter-agent information flows through structured handoff payloads (section 4),
   not shared context windows.

5. **Early exit on budget pressure.** If an agent detects it is approaching 90%
   of its context budget (estimated from token counts of accumulated tool
   outputs), it MUST:
   - Save its current progress as a handoff attachment with
     `"type": "partial_progress"`.
   - Post a Linear comment summarizing what was completed and what remains.
   - Exit cleanly so the orchestrator can re-dispatch with a fresh context.

### 7.3 Size-Based Context Adjustments

Larger issues may require more diff and map context. The orchestrator adjusts
allocations based on the issue's size label:

| Size | Diff Context | Codebase Map | Issue Context |
|---|---|---|---|
| `size:XS` | 4,000 | 4,000 | 2,000 |
| `size:S` | 8,000 | 4,000 | 2,000 |
| `size:M` | 16,000 | 8,000 | 4,000 |
| `size:L` | 16,000 | 8,000 | 4,000 |
| `size:XL` | 16,000 | 8,000 | 4,000 |

For XS/S issues, the smaller allocations free up additional tokens for
reasoning, which compensates for the reduced context.

---

## 8. Invariants

The following invariants MUST hold at all times. Violation of any invariant is a
protocol error that agents must self-correct or escalate.

1. **Single owner.** An issue has at most one active agent at any time.
2. **Atomic transitions.** Label changes for a state transition happen in a
   single Linear API call. No intermediate states are visible to other agents.
3. **Forward progress.** An agent must either advance the issue to the next
   state or trigger a well-defined failure recovery path. Silently dropping an
   issue is a protocol violation.
4. **Handoff completeness.** Every state transition includes a structured
   handoff payload attachment. An agent MUST NOT transition labels without
   writing the handoff attachment first.
5. **Idempotent pickup.** If an agent picks up an issue that is already in the
   expected state (e.g., due to a restart), it resumes from the current state
   rather than restarting from scratch.
6. **No cross-agent label mutation.** An agent may only set or remove labels
   listed in its row of the Agent-to-Label Mapping (section 3.3). Touching
   another agent's labels is a protocol violation.
7. **TPM merge exclusivity.** Only the TPM agent merges to the main branch. No
   other agent may perform a merge. This is a hard rule with no exceptions.
8. **Human override supremacy.** A human may set any label or status at any
   time. Agents must respect the resulting state on their next read, even if it
   skips pipeline stages or reverses progress.

---

## 9. Versioning

This document is **MAW Protocol v6.0**. The version string `"6.0"` is embedded
in every handoff payload via the `"version"` field.

### Compatibility Rules

- **Major version bump** (e.g., 6.0 to 7.0): Breaking changes to handoff
  schemas, transition table, or ownership function. All agents must be updated
  before processing new handoffs.
- **Minor version bump** (e.g., 6.0 to 6.1): Additive changes only -- new
  optional fields in handoff schemas, new labels, new optional phases. Existing
  agents continue to function without updates.

### Version Mismatch Handling

Agents receiving a handoff with a version they do not recognize MUST:

1. Log a warning: `"Received handoff version <X> but agent supports v6."`.
2. Attempt best-effort processing (new optional fields are ignored; core schema
   is backward-compatible within a major version).
3. If processing fails due to missing required fields or structural changes,
   escalate to human: `"Handoff version <X> is incompatible with agent v6.
   Manual intervention required."`.
