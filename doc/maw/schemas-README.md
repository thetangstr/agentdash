# MAW v6 Handoff Schemas

Structured JSON Schema definitions (draft-07) for every agent-to-agent transition in the Multi-Agent Workflow pipeline.

## Why schemas

MAW agents communicate through Linear comments and labels. Without a contract, handoff payloads drift -- fields get dropped, downstream agents parse freeform text unreliably, and retry/escalation logic breaks. These schemas pin the contract so each agent knows exactly what it must produce and what it can expect to consume.

## Schema overview

| Schema | Producer | Consumer | Trigger |
|--------|----------|----------|---------|
| `pm_to_builder` | PM | Builder (via /workon) | Issue elaborated, acceptance criteria written |
| `builder_to_ci` | Builder | Tester | PR created, PR-Ready label applied |
| `tester_to_reviewer` | Tester | Human / auto-verify | Tests + code review + CUJ verification complete |
| `reviewer_to_tpm` | Human / orchestrator | TPM | Human-Verified label applied |
| `tpm_merge_report` | TPM | Linear (terminal) | Merge-deploy-smoke cycle complete |
| `ota_manifest` | TPM | Dashboard / all agents | `/tpm sync` or `/tpm status` |

## Pipeline flow

```
PM  --[pm_to_builder]-->  Builder  --[builder_to_ci]-->  Tester
                                                           |
                                              [tester_to_reviewer]
                                                           |
                                                    Human / Auto-verify
                                                           |
                                              [reviewer_to_tpm]
                                                           |
                                                         TPM
                                                           |
                                              [tpm_merge_report]
                                                           |
                                                        Done

TPM also produces [ota_manifest] on every /tpm sync as a full pipeline snapshot.
```

## How agents use these schemas

### Producing a handoff

1. The agent builds a JSON object conforming to the relevant schema.
2. The `handoff_type` discriminator field identifies which schema applies.
3. The payload is posted as a Linear comment (either as a fenced JSON block or rendered into the existing Markdown comment templates from the agent command files).
4. The agent applies the appropriate Linear label (e.g. `PR-Ready`, `Locally-Tested`, `Human-Verified`).

### Consuming a handoff

1. The downstream agent (or `/workon` orchestrator) reads the latest Linear comment matching the expected `handoff_type`.
2. It validates required fields are present.
3. It uses the payload to drive its phase -- e.g., the Tester reads `builder_to_ci.e2e_tests.run_command` to know which test suite to execute.

### Schema routing by discriminator

Every schema has a `handoff_type` field with a `const` value. Agents can parse the handoff type from a comment and load the appropriate schema:

```
handoff_type: "pm_to_builder"       -> PM -> Builder transition
handoff_type: "builder_to_ci"       -> Builder -> Tester transition
handoff_type: "tester_to_reviewer"  -> Tester -> Human/Reviewer transition
handoff_type: "reviewer_to_tpm"     -> Reviewer -> TPM transition
handoff_type: "tpm_merge_report"    -> TPM terminal report
handoff_type: "ota_manifest"        -> Full pipeline state snapshot
```

## Shared definitions

The schema file includes reusable definitions under `definitions`:

- **issue_ref** -- Minimal Linear issue pointer (id, title, url).
- **t_shirt_size** -- XS/S/M/L/XL enum with point mapping.
- **deployment_path** -- `default` or `staging-required`.
- **label_set** -- Array of Linear label strings.
- **cuj_entry** -- Critical User Journey reference (id + description).
- **test_result_entry** -- Individual test outcome (name, status, detail, evidence).
- **code_review_finding** -- Diff finding with file, line, severity, description, suggested fix.
- **regression_gate_result** -- Mandatory typecheck/test/build gate outcome.

## Key fields by schema

### pm_to_builder

- `acceptance_criteria` (required) -- The testable AC list that Builder implements against.
- `cujs` -- CUJ list that flows through the entire pipeline to Tester.
- `test_plan` -- Automated command and manual checks for Tester (required for M+).
- `deployment_path` -- Determines PR target branch and quality gate label.

### builder_to_ci

- `pr` (required) -- PR number, URL, base/head branch, files changed.
- `regression_gates` (required) -- Evidence that typecheck/test/build passed before handoff.
- `e2e_tests` -- Test files and run command for Tester to execute.
- `fix_attempt` -- Retry counter (0-2). At 2+ failures Tester escalates to human.
- `execution_engine` -- Which OMC engine built this (direct, team-2, team-3, ralph).

### tester_to_reviewer

- `verdict` (required) -- pass/fail/blocked. Drives label application and routing.
- `e2e_results` -- Total/passed/failed counts plus UltraQA cycle count.
- `code_review.findings` -- Structured findings with severity. Critical/High block the handoff.
- `cuj_verification` -- Per-CUJ pass/fail with evidence paths (screenshots, GIFs).
- `human_only_checklist` -- Items only a human can verify (external systems, content quality).
- `failure_sub_issues` -- Linear sub-issues created for each failure when verdict is `fail`.

### reviewer_to_tpm

- `verification_method` (required) -- How Human-Verified was applied (`human`, `auto-xs-s`, `auto-pre-real-users`).
- `wave` -- Wave context for multi-issue project orchestration.
- `pr` -- The PR that TPM should merge. For staging-required, may be PR #2.

### tpm_merge_report

- `merge_result` (required) -- `shipped`, `reverted`, or `blocked`.
- `health_check` -- Post-deploy backend/frontend HTTP status.
- `smoke_test` -- Production smoke test outcome.
- `staging_rebase` -- Whether staging was rebased after a staging-required merge.
- `wave_progress` -- Updated wave counts and whether the next wave is ready.

### ota_manifest

- `issues` -- Every active issue with TPM-derived pipeline state, wave assignment, and action needed.
- `waves` -- Per-wave progress (total, shipped, in-progress, blocked, complete).
- `sync_actions` -- Actions taken during this sync cycle.
- `human_attention_required` -- Prioritized list of items needing human action.

## Label lifecycle

Labels flow through the pipeline and are tracked in every handoff's `labels_applied` field:

```
(none)  ->  PR-Ready  ->  Testing  ->  Tests-Passed  ->  Locally-Tested  ->  Human-Verified  ->  In-Production
                              |                                |
                              v                                v
                         Tests-Failed                   Staging-Tested
                              |                                |
                              v                                v
                        (back to Builder)               Human-Verified
```

## Validation

Agents should validate handoff payloads against these schemas before acting. A missing required field indicates an upstream agent bug -- log the error and escalate rather than proceeding with partial data.
