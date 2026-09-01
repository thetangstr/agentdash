---
name: new-loop
description: Spin up a new loop (domain) in the loops/ knowledge base — gather its charter, scaffold domains/<loop>/README.md, ensure the signals/ + docs/ substrate exists, do ONE real test run, and record it in the loop README's Timeline and in loops/LOG.md. Use when the user says "set up a new loop", "create a domain", "start a new beat/workstream", or names a recurring job they want an agent to own.
user_invocable: true
---

# new-loop — spin up a new loop

A **loop** (a `domain`) is a recurring thread of work an agent owns: a charter, a cadence, and the
artifacts it produces. This skill creates one, proves it works with a single real run, and leaves
behind a `loops/domains/<loop>/README.md` that is the loop's live state.

Read `loops/ARCHITECTURE.md` first if you haven't — it's the model this skill instantiates.

## When to use

The user wants to stand up a recurring workstream/beat/job (e.g. "a weekly SEO loop", "a support
triage loop", "a competitor-watch loop"). Don't use this for a one-off task — that's a Linear
`AGE-*` issue (run `/workon`), or a `doc`/`signal` in `loops/`.

## Inputs to gather (ask only what's missing)

Infer from the request; ask a short clarifying round only for what you can't:

1. **name** — kebab-case, the loop's home folder (`loops/domains/<name>/`). Keep it short.
2. **goal** — one line: the outcome this loop drives.
3. **cadence** — `manual` / `daily` / `weekly` / a cron expr. Default `manual`.
4. **what it does** — what it consumes (signals? data? an inbox? a URL?) and produces (signals?
   docs? a report? code changes via `/workon`?).
5. **tools/data** — sources or credentials it needs (point at a setup skill or `.env`; never
   inline secrets — and never the `claude`/`claude_local` adapter for localhost testing, per the
   project directive).

If the request is already specific, infer all five and just confirm in your summary.

## Procedure

### 1. Ensure the substrate exists

From the repo root, confirm these exist (they ship with the repo — don't recreate):
`loops/signals/README.md`, `loops/docs/README.md`, `loops/domains/README.md`, `loops/LOG.md`.
Do **not** pre-create a `tasks/` folder — committed work lives in Linear (`AGE-*`); link to it.

### 2. Scaffold the loop README

Create `loops/domains/<name>/README.md` from the template in `loops/domains/README.md`, filled
with the gathered inputs: frontmatter (`kind: domain`, `domain`, `status: active`, `goal`,
`cadence`), a 2-4 line description, `## Current focus`, `## Backlog` (inline to-dos, link
`[[signal]]`/`AGE-*`), and an empty `## Timeline`. If `loops/domains/<name>/` already exists,
stop and ask whether to update instead of overwrite.

### 3. Do ONE real test run

This is the point of the skill: prove the loop runs, not just that the folder exists. Actually run
it once at small scale with its real tools/data (triage a few real tickets, pull one SERP, fetch
the inbox, scope one code change via `/workon`, …). If a credential is missing, do the
furthest-reachable dry run and note the gap. Producing an artifact is **optional** — a run that
surfaces nothing worth filing is a real result.

Two **required** outputs regardless:
- Append one dated line to the loop README's `## Timeline`:
  `YYYY-MM-DD | test run — <what you did and found / "nothing actionable yet">`.
- Append one entry to `loops/LOG.md` using its grammar:
  ```
  ## YYYY-MM-DD · <loop-name> loop created + first run · #ops
  What: <one line — what the loop is and what the first run did/found>.
  Refs: loops/domains/<name>/README.md (new)[, any artifact created].
  ```

### 4. Report back

Summarize: the charter (five inputs), what the test run did/found, artifacts created (or "none"),
missing tools/credentials to wire up, and how to run it again (cadence + entry point).

## Notes

- **Don't gold-plate the scaffold.** A loop README is live state, not a spec — start lean.
- **One loop = one separable workstream.** If it's really part of an existing loop, add a
  `domain:` tag + a backlog line there instead of creating a near-duplicate domain.
- For loops that ship code, the loop's "run" drives the MAW pipeline (`/workon AGE-<n>`); point
  the README's Backlog at the Linear issues.
