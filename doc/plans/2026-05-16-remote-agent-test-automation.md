# Remote Agent Test Automation Plan

## Goal

Create a repeatable target-machine testing loop for AgentDash where another agent can pull the latest GitHub version, run the same verification we expect before merge, capture diagnostics, and file actionable GitHub issues for failures.

The target loop should complement normal PR CI. PR CI proves the branch in GitHub-hosted runners. Target-machine testing proves the branch or release on a real machine with the target agent/runtime environment.

## Current Baseline

- Repository: `https://github.com/thetangstr/agentdash.git`
- Main PR workflow: `.github/workflows/pr.yml`
- Existing PR checks: dependency policy, `pnpm -r typecheck`, `pnpm test:run`, release registry test, `pnpm build`, canary release dry run, and Playwright e2e.
- Existing release smoke workflow: `.github/workflows/release-smoke.yml`
- Default local test command: `pnpm test`
- PR-ready verification from `AGENTS.md`: `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`

## Manual Target-Machine Runbook

Use this when delegating to another machine or another agent before the automation exists.

### Prerequisites

- macOS or Linux target machine.
- GitHub CLI authenticated with issue write access: `gh auth status`.
- Node.js 24.
- pnpm 9.15.4.
- Git.
- Playwright browser dependencies available, or permission to run `npx playwright install --with-deps chromium`.
- Enough disk space for `node_modules`, Playwright browsers, build output, and test artifacts.

### Fresh Checkout

```sh
mkdir -p ~/agentdash-target-tests
cd ~/agentdash-target-tests

if [ ! -d agentdash/.git ]; then
  git clone https://github.com/thetangstr/agentdash.git
fi

cd agentdash
git fetch origin --prune
git checkout "${AGENTDASH_TEST_REF:-main}"
git pull --ff-only origin "${AGENTDASH_TEST_REF:-main}"
git rev-parse HEAD
```

For a pull request branch, set `AGENTDASH_TEST_REF` to the branch name, for example:

```sh
export AGENTDASH_TEST_REF=codex/invite-token-primitives
```

### Clean Install

```sh
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
```

If the target machine intentionally tests manifest drift or a branch without an updated lockfile, use `pnpm install --no-frozen-lockfile` and report that deviation in the issue.

### Verification Commands

Run the commands in this order and stop at the first failure unless the agent has been asked to collect a full failure matrix.

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Run browser suites when the change touches UI flows, onboarding, adapters, release packaging, or deployment:

```sh
npx playwright install --with-deps chromium
PAPERCLIP_E2E_SKIP_LLM=true \
AGENTDASH_DEEP_INTERVIEW_ASSESS=true \
AGENTDASH_ALLOW_MULTI_COMPANY=true \
AGENTDASH_RATE_LIMIT_DISABLED=true \
AGENTDASH_ADAPTER_ENV_BYPASS=true \
pnpm run test:e2e
```

Run release smoke when testing an installed or published package:

```sh
pnpm run test:release-smoke
```

Run adapter-specific smoke checks when the change touches OpenClaw or invite/gateway behavior:

```sh
pnpm run smoke:openclaw-join
pnpm run smoke:openclaw-gateway-e2e
```

### Failure Issue Template

When a command fails, file or update a GitHub issue with this structure:

```md
## Target-machine test failure

Ref: `<branch-or-tag>`
Commit: `<git rev-parse HEAD>`
Machine: `<os/version/arch>`
Node: `<node --version>`
pnpm: `<pnpm --version>`
Command: `<failed command>`

## Failure Summary

<one-paragraph summary of the first actionable failure>

## Reproduction

```sh
git clone https://github.com/thetangstr/agentdash.git
cd agentdash
git checkout <ref>
pnpm install --frozen-lockfile
<failed command>
```

## Evidence

- First failing test or step:
- Relevant stack trace:
- Artifact links:

## Triage

Likely owner area: `<server/ui/db/adapter/e2e/release>`
Suspected cause: `<evidence-backed hypothesis, or unknown>`
Blocking merge/release: `<yes/no>`
```

Suggested labels:

- `target-machine-test`
- `ci`
- `bug`
- Area label such as `server`, `ui`, `adapter`, `e2e`, or `release`

Issue deduplication rule: before creating a new issue, search open issues for the same command, commit, and first failing test. If found, comment with the new run evidence instead of opening a duplicate.

## Target-Agent Prompt

Use this prompt when handing the task to another agent:

```text
You are testing AgentDash on a target machine. Pull the latest requested ref from https://github.com/thetangstr/agentdash.git, install dependencies with pnpm 9.15.4 and Node 24, run the verification commands below, and file GitHub issues for actionable failures.

Target ref: <branch, PR ref, tag, or main>

Required commands:
1. pnpm -r typecheck
2. pnpm test:run
3. pnpm build

Conditional commands:
- Run pnpm run test:e2e with the documented CI env flags when the change touches UI, onboarding, adapters, or browser workflows.
- Run pnpm run test:release-smoke when testing an installed/published version.
- Run OpenClaw smoke scripts when the change touches OpenClaw join/gateway behavior.

For every failure:
- Capture OS, Node, pnpm, ref, commit, command, first failing test, and stack trace.
- Upload available logs or Playwright artifacts.
- Search existing open issues first and update a matching issue instead of duplicating it.
- If no matching issue exists, create a GitHub issue using the Target-machine test failure template.
```

## CI Automation Plan

### Phase 1: Add a Dispatchable Target Test Workflow

Add `.github/workflows/target-machine-test.yml` with:

- `workflow_dispatch` inputs:
  - `ref`: branch, tag, or SHA to test.
  - `profile`: `core`, `browser`, `release-smoke`, or `full`.
  - `open_issue`: boolean, default `true`.
- `workflow_call` so other workflows can invoke it.
- A self-hosted runner option for real target machines and an Ubuntu fallback for parity checks.
- Node 24 and pnpm 9.15.4 setup.
- Artifact upload for test logs, Playwright reports, server logs, and command metadata.

Profiles:

- `core`: `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`.
- `browser`: `core` plus Playwright e2e with the same env flags used in `.github/workflows/pr.yml`.
- `release-smoke`: existing release smoke harness.
- `full`: browser plus adapter smoke scripts that can safely run in CI.

Acceptance criteria:

- The workflow can be run manually against any branch or SHA.
- It records exact ref, commit, runner name, OS, Node, and pnpm in an artifact.
- It fails when any required command fails.
- It uploads diagnostics on both success and failure.

### Phase 2: Automated Issue Filing

Add a small script, for example `scripts/ci/file-target-test-issue.mjs`, that:

- Reads a JSON run summary from the target workflow.
- Extracts the failed command, first failing test, and artifact URL.
- Computes a stable failure signature from `profile + command + first failing test + normalized error head`.
- Searches open GitHub issues with `target-machine-test` and that signature.
- Comments on the existing issue when the signature matches.
- Creates a new issue when no match exists.

Use `GITHUB_TOKEN` in Actions with:

```yaml
permissions:
  contents: read
  issues: write
  actions: read
```

Acceptance criteria:

- One repeated failure updates one existing issue.
- A distinct failure creates a distinct issue.
- The issue body includes reproduction steps, command, commit, environment, and artifact links.
- The script can run in dry-run mode locally without creating issues.

### Phase 3: Close the Loop from PRs

Update `.github/workflows/pr.yml` to optionally call the target workflow for labeled PRs:

- Trigger when a PR has label `target-test`.
- Use `workflow_call` with `profile=browser` or `profile=full`.
- Post a PR comment with the target workflow URL and resulting issue links.

Keep this opt-in first to avoid burning target-machine capacity on every PR.

Acceptance criteria:

- Adding `target-test` to a PR starts the target test workflow.
- Removing the label stops future target runs.
- The PR has a visible link to target-machine results.

### Phase 4: Scheduled Mainline Validation

Add a scheduled run for `main`:

- Nightly `core`.
- Weekly `full`.
- Always file/update issues on failure.

Acceptance criteria:

- Mainline target failures produce durable issues without manual intervention.
- The issue signature prevents issue spam.
- Artifacts remain available long enough for triage.

## Fix Workflow After Issues Are Filed

1. Triage the GitHub issue and confirm whether it reproduces locally.
2. If it reproduces here, fix on the active branch and run the narrow failing command first.
3. Run the PR-ready verification set before handoff:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

4. Push the fix and re-run the target workflow against the fixed ref.
5. Close the issue only after the target workflow passes or the issue is proven environmental with evidence.

## Risks and Mitigations

- Risk: target machine failures are environmental. Mitigation: include machine metadata, dependency versions, and artifact links in every issue.
- Risk: issue spam from repeated failures. Mitigation: use stable failure signatures and update existing issues.
- Risk: expensive full-suite runs on every PR. Mitigation: make target testing label-driven first, then add scheduled mainline runs.
- Risk: secrets leak in logs. Mitigation: rely on GitHub masking, avoid printing environment dumps, and redact known token patterns in the issue-filing script.
- Risk: target agents test stale code. Mitigation: record `git rev-parse HEAD` and the requested ref in every run summary and issue.

## Proposed Implementation Order

1. Add the target workflow with `core` and `browser` profiles.
2. Add run summary and artifact upload.
3. Add dry-run issue filing.
4. Enable real issue filing for manual dispatch failures.
5. Wire opt-in PR label execution.
6. Add scheduled mainline validation.
7. Extend to release smoke and adapter-specific smoke profiles.

## Implementation Notes

Current branch implementation covers steps 1-5 and includes early support for step 7:

- `.github/workflows/target-machine-test.yml` provides manual dispatch and `workflow_call` entry points.
- `scripts/ci/run-target-test-profile.mjs` runs `core`, `browser`, `release-smoke`, and `full` profiles and writes a JSON summary plus command logs.
- `scripts/ci/file-target-test-issue.mjs` creates or updates GitHub issues from failed summaries, with dry-run support and stable failure-signature dedupe.
- `scripts/ci/file-target-test-issue.test.mjs` verifies failure normalization, signature stability, body generation, and area-label inference.
- `.github/workflows/pr.yml` runs the issue-filing helper tests in normal PR verification and invokes the target workflow when a PR has the `target-test` label.

Step 6 is intentionally left as a follow-up until target-runner capacity and desired cadence are settled.
