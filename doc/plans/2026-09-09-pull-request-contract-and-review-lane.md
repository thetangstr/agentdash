# The pull-request contract and a review lane for Agent Runner

Status: **proposal, nothing implemented.** Written 2026-09-09 after researching how
operators actually run a software lifecycle on Paperclip. Merges, pushes to `main` and
deployments remain held by the founder; this document asks for decisions, not for a merge.

Sources for the outside practice are listed in §7. Everything in §1 is evidence from our own
instance and repository, gathered 2026-09-08 and 2026-09-09.

## 1. What our own record shows

| Fact | Evidence |
|---|---|
| Agents have no pull-request contract | No occurrence of "feature branch", "open a PR" or "never merge" in any of the four agent-facing prompt surfaces |
| We are producing duplicate pull requests | #630 `lane/age-1-runtime-model-reporting` and #631 `jules/age1-runtime-model-reporting` are the same AGE-1 fix |
| The review lane is backed up | 14 open pull requests; 7 opened on or before 2026-09-05 |
| The acceptance loop never closes | Zero rows in `verdicts` for this company; agents receive 403 on the definition-of-done write |
| Silence is not monitored | Maya and Priya failed 189 consecutive runs across roughly 40 hours before a human noticed |
| Not a gap | The heartbeat already skips agents with nothing to do (`hasWakeworthyWork`, `skippedNoWork`), so the community's wake pre-check is already ours |

The through-line is that we govern the **issue** carefully and the **pull request** not at all.
Our agents invented their own git workflow because we never gave them one, and the quality gate
we did build, verdicts plus definition of done, has never once closed on this company.

## 2. What operators outside do instead

The converged practice is that the pull request is the code-review surface and the issue is the
status surface, with the agent explicitly unable to merge its own work. The vendor's own
how-to states the agent is configured to refuse merging, a human merges, and the issue then moves
to `done` carrying the merge commit. QA runs before the human gate and returns evidence, and
failed work bounces back with a precise defect report rather than a vague rejection.

We do not need to adopt anyone's methodology to get this. It is a role contract plus one gate.

## 3. Proposed changes

### C1. Give agents a pull-request contract (small, agent-facing)

Add to the agent prompt surfaces, in the repository's own words:

- Work on a feature branch, never on `main`. One branch per issue. Name the branch after the
  change, not after the ticket.
- Before opening a pull request, search for an existing one touching the same area and link
  whatever you find. If a close one exists, help it over the line instead of opening a parallel one.
- Fill the pull-request template. Post the pull-request URL in the issue thread.
- Move the issue to `in_review` only after continuous integration is green.
- **Never merge.** Merging is the founder's act. When it is merged, the issue moves to `done`
  carrying the merge commit.

This changes agent-facing behaviour, so it lands in all four surfaces per the repository
convention in `AGENTS.md`, and the drift check enforces that.

### C2. Make the two surfaces distinct, and gate the disposition (medium)

- The pull request is where the diff is read and the checks are watched. The issue tracks status
  and carries the merge commit. Neither is copied into the other.
- **Add the disposition gate.** An agent may not move an issue to `in_review` without a real
  review path: a linked pull request with green checks, a pending approval, a human assignee, or
  a scheduled monitor. Refuse otherwise with a named reason. This is the one rule that would have
  prevented the unsupported completions our own evaluator raised.
- **Decide the definition-of-done path** (open as D-C2 in the evaluator calibration plan). Either
  agents can write a definition of done, or a named human attests instead. Until one is chosen,
  acceptance stays unmeasurable and the evaluator's O1 metric is insufficient by construction.

### C3. Run a review lane over the backlog (small, mostly founder decisions)

- Close one of #630 or #631 with a one-line rationale, keep the better diff.
- Give each of the 7 pull requests older than 2026-09-05 one disposition: merge, rebase with a
  fresh run, or close with a reason. This is the same triage AGE-20 applied to the stale set in
  September, and it worked.
- For anything that survives, batch the review rather than reviewing one pull request at a time.

### C4. Extend the pull-request body validator (small)

We already run `scripts/ci/check-pr-process.mjs`. Two cheap additions, both proven upstream:

- A duplicate-search affirmation, so the author states they looked for a parallel pull request.
- A test-coverage check keyed off the conventional-commit prefix: `feat` and `fix` must touch a
  test file; `docs`, `chore` and `ci` must not touch source. This catches mislabelled changes as
  well as missing tests.

### C5. Alert on silence, not only on errors (small to medium)

Surface an agent whose recent runs have all failed, or that has had no successful run within a
threshold, to the board and to its accountable human. Our 40-hour outage produced 189 failure
records and no alert, because monitoring watches for crashes rather than for the absence of
success. The threshold and the surface are the design questions; the principle is not.

### C6. Sync the operating-semantics we are missing (needs a cherry-pick decision)

Our copy of the execution-semantics document is 369 lines against upstream's 857, and our core
agent skill is 357 against 630. The missing material is exactly the operating discipline:
delegating review tasks, the courier pattern for lateral coordination, monitors and watchers, and
the liveness contract. Governed by the rubric in `doc/UPSTREAM-POLICY.md`, so it is a founder call.

## 4. Sequence

1. C1 and C3 first. They are cheap and they stop the two active bleeds, duplicate work and a
   stale queue.
2. C2's gate next. It is the real quality change and it is what makes the evaluator's acceptance
   metric measurable.
3. C5, so the next silent failure is caught in hours rather than days.
4. C4 and C6 when convenient.

## 5. Decisions needed

- **D1** Approve the C1 wording, or edit it. It becomes a role contract for every coding agent.
- **D2** The definition-of-done path: agent-writable, or human attestation. This is D-C2 restated.
- **D3** Dispositions for the 7 stale pull requests, and which of #630 or #631 to keep.
- **D4** Whether C6's upstream sync is worth doing under the cherry-pick rubric.

## 6. What this proposal does not do

It does not merge anything, deploy anything, or change any agent's adapter or model. It does not
adopt an external methodology such as BMAD, GSD or OpenSpec; the research found the community
treats those as pluggable skills, and nothing here forecloses that choice.

## 7. Sources for the outside practice

- Paperclip discussions, notably the token-consumption thread, the BMAD and staged-planning
  threads, the multi-repository question, and the dockerised git-push thread.
- The vendor how-to for connecting an agent to GitHub, which is the source of the two-surface
  model and the refuse-to-merge configuration.
- The vendor's engineering solution page, for the lead, coder, QA and human-review shape.
- An operator's four-month failure-mode write-up, which is the source of the alert-on-silence
  rule and the single-source-of-truth rule for instruction files.
