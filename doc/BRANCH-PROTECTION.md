# Branch protection — operator setup

**Status:** Required for full Hermes guardrails (issue #257)
**Owner:** repo admin
**Audience:** human operator of `thetangstr/agentdash`

---

## Why

The CI lanes added in this PR (`hermes-pr-audit`, `hermes-prompt-drift`) enforce
Hermes's directives on PRs, but PR checks **only fire when a PR is opened**.
Without server-side branch protection, anyone (including Hermes itself) can
bypass the whole system by pushing directly to `main`. That is exactly the
pattern #254 / #257 were filed to stop.

This doc is the one-time admin step that turns the policy into a wall.

## What to enable

GitHub branch protection on `main` with:

- ✅ Require a pull request before merging
- ✅ Require status checks to pass before merging
  - Required checks (mark them required after they've run at least once):
    - `Hermes PR Audit / audit`
    - `Hermes Prompt Drift Check / drift`
    - `Agents MD Drift Check / check`
    - The existing `pr` / `e2e` lanes you care about
- ✅ Require branches to be up to date before merging (catches `main` advancing during review)
- ✅ Do not allow bypassing the above settings
- ✅ Restrict who can push to matching branches → empty list (PR-only)

Optional but recommended:
- ✅ Require linear history (avoids merge commits on main)
- ✅ Require signed commits (only if you're already on a signed-commit workflow)
- ❌ Require approvals (1+ reviewer) — set to 0 for now, since Claude/Hermes self-merge after CI green per the autonomous-ship window memo

## How (CLI, two commands)

You need a token with admin rights on the repo (the default `gh` token has
this if you're signed in as the repo owner).

### 1. Enable protection

```sh
gh api \
  -X PUT \
  -H "Accept: application/vnd.github+json" \
  repos/thetangstr/agentdash/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "audit",
      "drift",
      "check"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": true
}
EOF
```

`enforce_admins: true` is the critical line — it stops you (and Hermes) from
slipping a direct push through admin privilege.

The `contexts` list names the **check JOB names** (not workflow names). The
Hermes audit workflow's job is named `audit` (see `.github/workflows/hermes-pr-audit.yml`),
the drift workflow's job is named `drift`, and the existing agents-md drift
job is named `check`. If you add more required workflows, append their job
names here.

### 2. Verify

```sh
gh api repos/thetangstr/agentdash/branches/main/protection | \
  jq '{
    required_status_checks: .required_status_checks.contexts,
    enforce_admins: .enforce_admins.enabled,
    require_pr: (.required_pull_request_reviews | has("required_approving_review_count")),
    linear_history: .required_linear_history.enabled
  }'
```

Expected:

```json
{
  "required_status_checks": ["audit", "drift", "check"],
  "enforce_admins": true,
  "require_pr": true,
  "linear_history": true
}
```

### 3. Test (optional, recommended)

In a new branch, push a commit that opens a PR with no `## Regression suite`
heading in the body. Confirm the merge button is disabled until the
`audit` check fails out, then close the PR. Then try to `git push origin main`
directly — the push should be rejected with a branch-protection error.

## Bypass procedure

When you _genuinely_ need to push directly to `main` (e.g. emergency revert
of a broken merge):

```sh
# Temporarily disable:
gh api -X DELETE repos/thetangstr/agentdash/branches/main/protection

# Push your fix:
git push origin main

# Re-enable:
gh api -X PUT ... # rerun the command from step 1
```

Every bypass should be logged in the PR or incident report it relates to.
If you find yourself bypassing more than once a month, something is wrong
with the audit lane configuration — file an issue.

## Why these specific settings

| Setting | Why |
|---|---|
| `enforce_admins: true` | Without this, the owner (and Hermes via the owner's token) bypasses protection. Defeats the entire point. |
| `required_linear_history: true` | Squash-merge-only matches existing convention. Forbids merge commits, keeps `main` reviewable. |
| `allow_force_pushes: false` | Force pushes silently rewrite history; never wanted on a protected default branch. |
| `allow_deletions: false` | Belt-and-suspenders against accidentally `git push origin :main`. |
| `dismiss_stale_reviews: false` | Required approvals are 0 anyway, so dismissal behavior is moot. Listed for clarity. |
| `lock_branch: false` | `lock_branch: true` would block ALL changes including PR merges — not what we want. |

## Related

- [`docs/agents/hermes-prompt.md`](../docs/agents/hermes-prompt.md) — the directives this enforces
- [`.github/workflows/hermes-pr-audit.yml`](../.github/workflows/hermes-pr-audit.yml) — the audit lane
- [`.github/workflows/hermes-prompt-drift.yml`](../.github/workflows/hermes-prompt-drift.yml) — the drift check
- [`scripts/ci/check-hermes-pr-audit.mjs`](../scripts/ci/check-hermes-pr-audit.mjs) — the audit logic
- [`scripts/ci/check-hermes-prompt-drift.mjs`](../scripts/ci/check-hermes-prompt-drift.mjs) — the drift logic
- Issue [#254](https://github.com/thetangstr/agentdash/issues/254) — original Hermes self-tune brief
- Issue [#257](https://github.com/thetangstr/agentdash/issues/257) — the meta gap this closes
