# AgentDash-MK — remaining work after the harness landed

**Status:** the harness is merged. This note carries the work the machine-move
handoff left open, so the open items live in the repo instead of in an untracked
file on one machine.

Supersedes `agentdash-mk-RESUME.md`, which was a machine-move handoff written on
2026-08-02 and is now obsolete: its restore path (clone `codex/agentdash-mk`, or
`git fetch` a 28 MB bundle) described work that has since been squash-merged to
`main` as `cd296cf5` — "stewarded-agent workforce harness, deliverable pipeline,
and measurement" (#467).

## What landed

All eight harness slices, the zk-artifact flake fix, the Graph Learning System
plan, and the Mac-mini runbook are in `main`. The plans of record are:

- `doc/plans/2026-08-02-harness-implementation-plan.md` — the shipped slices, gates, dependency graph.
- `doc/plans/2026-08-02-graph-learning-system.md` — GL foundations (B/C/G/H) shipped; GL-1..GL-5 are forward work. Its defining rule: the graph measures pipelines/steps/seats, **never a named person**.
- `doc/plans/2026-08-02-mac-mini-test-runbook.md` — standing the branch up on a Mac mini (non-frozen install, license mint, `claude_local` BYOT) and running the first real cycle.
- `docs/superpowers/specs/2026-07-28-human-agent-workforce-p0-spec.md` — the stewardship/ceilings/approval-authority model the harness implements.

The handoff's deferred-merge caveat ("merge to `main` is blocked by a lockfile
CI gap") is resolved: #467 merged with a lockfile refresh, and the `verify` lane
timeout in `.github/workflows/pr.yml` is now `35` minutes, matching the comment
that had long asked for it.

## Still open

1. **Two signup gaps** — design-partner reach and the subscribe-without-paying
   path. Context is in commit `653dd76d` ("Let a design partner reach AgentDash-MK
   and subscribe without paying") and the harness plan's open questions.
2. **Final cumulative full-suite verification** as one checkpoint across
   everything, rather than per-slice gates.
3. **GL-1..GL-5** in the Graph Learning System plan.

## The boundary that matters most

Carried forward unchanged from the handoff, because it is still true:

> The harness machinery is built and green, but **no real weekly cycle has ever
> run** — every figure came from a mocked Microsoft Graph, no timer has fired
> outside a test, no approver has read the review surface. The machinery is
> proven; the judgement encoded in it is unvalidated.

## Two traps worth carrying forward

- **Branch parallel agents from the feature branch, not the outer repo's `main`.**
  Three parallel agents once produced nothing because they were branched at
  `main` instead of the harness branch.
- **Commit atomically, every slice.** That is what made the machine switch
  lossless — the branch carried the work regardless of which machine produced it.
