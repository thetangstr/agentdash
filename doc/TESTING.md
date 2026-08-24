# Testing before it reaches a customer

AgentDash ships to on-prem instances over the air, straight from a git branch.
That is fast and it means a bad commit on `main` is a bad commit on somebody's
machine within one update cycle. This document describes the branch that exists
to stop that, and how to stand up an instance to test against that is not
anybody's production.

## Two branches

| Branch | What it is | Who runs it |
|---|---|---|
| `main` | What customers run. Protected: `verify`, `check`, `policy`, `drift`, `audit`, `dependency-audit` all required, admins included. | Production instances |
| `staging` | The candidate. Deliberately **not** protected, so a work-in-progress can be pushed and exercised without ceremony. | Test instances |

The flow:

```
feature branch  ──PR──▶  staging  ──test on a real instance──▶  PR  ──▶  main  ──OTA──▶  customer
```

`staging` being unprotected is the point — it is where something half-finished
can be put on a real machine and driven. The gate that matters is the PR from
`staging` into `main`, which runs the full matrix like any other.

If `main` moves ahead of `staging` (a hotfix, say), bring `staging` forward
before testing anything else, or you are testing a tree nobody will ever run:

```sh
git fetch origin
git push origin origin/main:refs/heads/staging   # fast-forward when staging has no unique commits
```

## Pointing an instance at `staging`

The over-the-air updater tracks a branch, so a test machine differs from
production by one flag:

```sh
node ~/.agentdash/bin/agentdash-source-update.mjs --branch staging --check
node ~/.agentdash/bin/agentdash-source-update.mjs --branch staging \
  --backup-command "AGENTDASH_INSTANCE=<instance> /bin/sh ~/agentdash/deploy/agentdash-backup.sh"
```

Production keeps its default of `main`. Nothing about a test instance should
ever be able to move a production checkout.

### Locking a production machine to one branch

`--branch` is one flag, and the interesting branches are the dangerous ones. A
machine that runs a customer's instance should say so, in a file it owns:

```sh
mkdir -p ~/.agentdash/deployments
echo main > ~/.agentdash/deployments/allowed-branch
```

With that present the updater refuses to deploy anything else, at plan time — so
even `--check` says no rather than reporting what a forbidden update would do:

```
This machine is locked to the "main" branch and refuses to deploy "staging".
```

Rollback is deliberately still allowed: rolling back is what you do when a
deploy went wrong, and the lock must not stand between an operator and the last
known-good commit.

The lock is absent by default, so test instances are unaffected. It is opt-in
per machine because the machine is the only thing that knows which kind of
machine it is.

## Standing up an instance that is not production

A test instance needs its own database, its own port, and **no credentials that
can reach the outside world**. The last part is not optional: an instance with a
real email key will send real email to whatever address a test creates, and one
with a real model key will spend real money on a customer's plan.

```sh
# 1. Its own database, on the same embedded Postgres or your own
createdb agentdash_test     # or: psql -c 'create database agentdash_test'

# 2. Its own env file — note what is deliberately absent
cat > ~/.config/agentdash/test.env <<'ENV'
PORT=3199
DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:54329/agentdash_test
PAPERCLIP_PUBLIC_URL=http://127.0.0.1:3199
PAPERCLIP_BIND=127.0.0.1
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_MIGRATION_AUTO_APPLY=true
PAPERCLIP_INSTANCE_ID=test
AGENTDASH_SELF_SERVE_BOOTSTRAP=true
AGENTDASH_INVITE_VALIDATION=off
AGENTDASH_DEFAULT_ADAPTER=process
AGENTDASH_ENFORCE_LICENSE=false
BETTER_AUTH_SECRET=test-only-secret-not-a-real-one-00000000
PAPERCLIP_AGENT_JWT_SECRET=test-only-jwt-secret-not-a-real-one-0000
ENV

# 3. Run it
AGENTDASH_ENV_FILE=~/.config/agentdash/test.env AGENTDASH_INSTANCE=test \
  /bin/zsh deploy/agentdash-server.sh
```

**Copy nothing from a production env file.** It is tempting to lift the license
block or a model key across; every one of those lines is a way for a test to
reach something real. Turning license enforcement off removes the only reason to
want them.

`AGENTDASH_DEFAULT_ADAPTER=process` makes agents run `echo` instead of a model.
That exercises the whole scheduler, run, metering and issue plumbing at zero
cost. Switch a single agent to a real adapter only when the thing under test is
the adapter itself.

## The full pass

```sh
node scripts/e2e/full-pass.mjs                        # against 127.0.0.1:3199
E2E_BASE=http://127.0.0.1:4000 node scripts/e2e/full-pass.mjs
```

It drives the product in order — sign up, company, both kinds of agent,
credentials and the refusals, release and re-kind, invite a colleague, hand over
accountability, read it back through an agent key and over MCP, then wake an
agent and wait for the run to finish. It exits non-zero if anything fails.

It refuses to run against a non-loopback host or the production ports 3102 and
3112, because it creates users and companies and does not clean up. The intended
teardown is dropping the database:

```sh
dropdb agentdash_test   # or: psql -c 'drop database agentdash_test with (force)'
```

## What a test instance must never touch

On a machine that also runs production — which is the situation on the reference
deployment — the boundary is worth stating explicitly:

- **Not** `~/.config/agentdash/<production instance>.env`
- **Not** the production database
- **Not** ports 3102 or 3112
- **Not** the launchd daemons in `/Library/LaunchDaemons/com.agentdash.*`
- **Not** `git checkout` in the production checkout — the updater refuses a dirty
  tree, and a stray branch switch there is a production deploy waiting for the
  next restart
- **Never** `--branch staging` against a customer's instance. `staging` exists to
  be driven on a test machine; it is not a thing a customer runs. Lock the
  production machine as above so this is refused rather than remembered

The safest arrangement is a different machine entirely, which is what `staging`
is for.
