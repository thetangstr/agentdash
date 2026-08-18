# Getting AgentDash to a state we can hand over

**Written:** 2026-08-15, after a day of probing the running instances
**Scope:** one on-prem install for MKThink. Not a public launch.

---

## What "ready" has to mean

Not "the features exist." They mostly do. Ready means one falsifiable thing:

> **Titus and three colleagues use AgentDash for one working week, on their own
> machines, without Yang in the loop — and nothing silently lies to them.**

Three words in that sentence are load-bearing:

- **their own machines** — the local-harness path has to work for people who did
  not build it.
- **without Yang** — every recovery has to be self-service or automatic. Today
  most recoveries are an SSH session.
- **silently lies** — the recurring failure in this codebase is not a crash. It
  is HTTP 200 with nothing done. Four found today alone: a stale bundle served to
  deep links, `definitionOfDone` discarded, `completedAt` rewritten, a broken npm
  package that CI called green. That class is what makes a product feel haunted.

## Where we actually are

Verified today against the running instances, not inferred.

### Works, with evidence

| | evidence |
|---|---|
| MCP endpoint | `✔ Connected`, 72 tools, real Claude Code, over `mkmini.local` |
| Connect codes | agent paired by short code; reuse refused; key named `CoS — mac.lan` |
| `agentdash-connect` on npm | 0.1.4, published by CI over OIDC with SLSA provenance |
| Dual-stack reachability | `tcp46`, both families 200, IPv6-first `.local` resolves |
| Direction authority | 11 routes guarded; 7 agent bypasses found and closed, each probed 200→403 |
| Backups | nightly launchd job + hourly in-server |

### Broken or absent, with evidence

| | evidence | severity |
|---|---|---|
| **Cost/token metering** | 30 runs, 30 produced output, **0 recorded usage**, 0 cost events | **blocker** |
| **Source shipped to client** | 191 MB `.git`, 2,329 source files, writable by the service user | **blocker** |
| **No UI permission model** | zero permission hooks in `ui/src`; a member sees Edit, gets a bare 403 | **blocker** |
| Local DB bypass | `paperclip:paperclip` on loopback, agents share the server uid | high |
| Agent execution unconfined | seatbelt exists in `cli/src/bridge/sandbox.ts`, unused server-side | high |
| Plugin host writes goals | no capability enforcement at dispatch | medium |
| Agent invite ceiling | agent with `users:invite` can invite a human as **owner** | medium |
| Machine sleeps | `pmset` fixed today; auto-login still absent | medium |

### The thing that should worry us most

**Nobody except Yang has ever really used this.** Both instances together hold
9 issues, all `done`, 30 runs, and one bridge endpoint. Every workflow beyond
"Yang drives it" is theory. The plan below front-loads *use*, not features,
because a week of real use will find more than another week of building.

---

## The goal

> **By the end of Week 2, four people at MKThink have each completed real work
> through AgentDash on their own machine, the install carries no source code,
> and every failure they hit either self-recovered or told them plainly what
> went wrong.**

Three checkpoints, each falsifiable:

- **W1D3 — Nobody is locked out.** Four humans signed in, each paired a machine
  by connect code, each ran one agent task end to end. Zero SSH sessions.
- **W1D5 — Nothing lies.** Every 403 explains itself in the UI. Cost and token
  figures are either real or visibly absent — never a confident zero.
- **W2D5 — Handover.** A fresh Mac Mini goes from bare to serving in one
  command, from a built artefact with no `.git`, running as a user that cannot
  modify the install.

---

## Workstreams, in order

Ordered by *what blocks a person*, not by what is interesting.

### 1. Truth in the UI (2 days) — blocks everything else

The API now refuses things the UI still offers. That is worse than before the
guards: a member clicks Edit on a goal and gets a bare 403.

- `GET /api/me/capabilities?companyId=` returning role, instance-admin flag, and
  a resolved boolean per capability. Server is the only source of truth.
- `useCapability()` hook; components ask, never re-derive.
- Direction controls render read-only rather than disabled — the UI is
  inline-edit, not buttons, so this is read-only variants and gated tabs, not
  `display:none`.
- Every 403 surfaces the server's sentence. No toast that says "Error".
- **Acceptance:** sign in as a `member`, walk every direction surface, and never
  meet a control that fails.

### 2. Metering that is honest (1 day) — blocker

`hermes_local` emits no token counts in `-q` mode, so cost is structurally
unknowable today. We ship cost UI over an empty table.

- Find whether Hermes can emit usage at all; if not, say so in the UI.
- If it cannot: **show "not measured" rather than 0**. A confident zero on a
  spend dashboard is the most damaging lie in the product.
- Record what we *can* know: wall-clock, run counts, model, provider.
- **Acceptance:** the costs page never shows a number we did not measure.

### 3. Four people, one week (3 days, overlapping) — the real test

- Onboard Titus + 3 colleagues for real: invites, roles, connect codes, MyAgent.
- Decide the role each colleague gets. **They will be `member`, so they cannot
  set direction** — confirm with Titus that this is what he wants before they
  find out by hitting a 403.
- One real deliverable per person, produced through their own harness.
- **Acceptance:** four humans, four machines, four completed pieces of work,
  zero interventions from us.

### 4. Packaging and least privilege (3 days) — blocker for handover

Corrected against what was actually verified:

- Ship a built artefact. All 12 workspace packages export `.ts`, so either build
  them all, esbuild-bundle the server as `cli` already does, or keep `tsx` and
  drop the "no source" claim. **Not 10–20 MB** — embedded-postgres alone is
  145 MB. The win is dropping 191 MB of `.git` and the dev tree.
- Run as a user that cannot write the install. This is a **migration, not a
  chown**: Postgres cluster ownership, secrets master key, workspaces, harness
  credentials, and two backup trees all derive from `os.homedir()`. Rehearse it
  on a scratch account first.
- Route server-side agent execution through the seatbelt profile that already
  exists in `cli/src/bridge/sandbox.ts`, keyed to the *resolved* cwd.
- Rotate the database credentials off `paperclip:paperclip`.
- **Acceptance:** fresh machine, one command, no `.git` on disk, and an agent
  that cannot write to the install directory or read `~/.config/agentdash`.

### 5. Close the remaining authority gaps (0.5 day)

Plugin-host goal writes, the agent invite-role ceiling, CEO-agent company
rename. Each gets the same treatment: probe live, guard, probe again.

---

## What I would *not* do before handover

Saying this explicitly so it does not creep in:

- The `agentdash.cloud` relay. Deferred twice already, still greenfield, and
  `mkmini.local` plus Tailscale covers the office.
- A Claude Code plugin. `npx agentdash-connect` works and is published.
- Any new agent capability. The gap is trust and operability, not features.

---

## The prompt

Hand this to an agent, or use it as the standing goal for the loop.

> You are getting AgentDash ready to hand to MKThink: one on-prem install on a
> Mac Mini, used by Titus and three colleagues from their own machines for a
> working week without us in the loop.
>
> Work `doc/plans/2026-08-15-launch-readiness.md` in order — UI truth, honest
> metering, four real users, packaging and least privilege, remaining authority
> gaps. Do not start a later workstream while an earlier one has a failing
> acceptance test.
>
> Rules, learned the hard way on this codebase:
>
> 1. **Probe the running instance before and after every change.** A test that
>    passes against the checkout proves nothing about what ships — a broken npm
>    package went out with CI green because nothing looked at the artefact.
> 2. **A non-403 is not a pass.** A 400 usually means validation ran before the
>    guard and your payload never reached it. Re-probe with a valid body.
> 3. **Treat HTTP 200 as a claim, not a result.** Read the database back. Four
>    silent-write bugs were found today; all returned 200.
> 4. **When tests push back, they are usually right.** Guarding routines the
>    strict way broke ten tests that encoded a deliberate delegation model. The
>    tests were the design speaking.
> 5. **Falsify every guard.** Revert the fix, watch the test fail, restore it.
>    An untested guard is a comment.
> 6. **Report what you did not do.** Scope you skipped, checks you could not
>    run, and anything you are unsure of belongs in the summary, not omitted.
>
> Verify with the owner rather than assuming: what role Titus's colleagues get,
> whether "works in the office" is an acceptable network promise for six months,
> and whether shipping without cost metering is acceptable if it is labelled
> honestly.

---

## Honest estimate

**9–10 working days** of build, plus a real week of use running alongside from
day three. The use is not a phase after the build; it is how the build gets
validated.

The largest risk is not in this plan. It is that four people using this for a
week will surface a class of problem we have not imagined, because so far the
only person who has ever really used it built it.
