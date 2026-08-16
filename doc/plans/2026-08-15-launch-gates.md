# Launch gates

**Supersedes the sequencing in** `2026-08-15-launch-readiness.md` (that document
keeps the evidence and the reasoning; this one is the checklist).
**Written:** 2026-08-15

Five gates. A gate is **closed** until every one of its acceptance criteria has
been demonstrated — not reasoned about, demonstrated, with the command and its
output. Work does not begin on a later gate while an earlier one is open, with
one deliberate exception noted at Gate 3.

Every acceptance criterion below is falsifiable and names the exact probe. If a
criterion cannot be checked by running something, it is not a criterion.

---

## Gate 0 — The metering question (decide before building)

This is a decision, not work, and it blocks Gate 2's scope.

### What is actually true

Established today, by probe rather than assumption:

- `agent_api_keys`, `cost_events`: **0 rows**. `heartbeat_runs.usage_json`:
  **0 of 30 runs**.
- The Hermes adapter *does* try to parse usage. `dist/server/execute.js` carries
  `TOKEN_USAGE_REGEX = /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i`
  and builds a usage object when it matches.
- It never matches. Across 12 runs on both instances, **zero outputs contain the
  word "token"** in any form.
- Not a truncation artefact: total captured output per run is 1,113–2,080 bytes,
  barely larger than the stored excerpt. There is no large log hiding a summary.

So the chain is: Hermes prints no token counts → the regex finds nothing →
`usage_json` stays null → no cost event is written → the costs page renders over
an empty table. **We do not fail to store cost. The source never reports it.**

### The options, honestly

| | what it gives | what it costs |
|---|---|---|
| **A. Label it "not measured"** | truthful UI immediately | no cost figures at all |
| **B. Make Hermes emit usage** | real tokens, real cost | unknown — depends on whether the CLI can, which we have not established |
| **C. Meter at the provider** | real tokens for MiniMax calls | provider-side integration we do not have |
| **D. Estimate from bytes** | a number | a number that is **not** cost; invites exactly the false confidence we are trying to avoid |

**Recommendation: A now, B investigated in parallel, D never.** A confident zero
on a spend dashboard is the most damaging thing this product can display to
someone deciding whether to trust it with money.

### Acceptance

- [ ] Owner decides A, B, or C, and the decision is written into this file.
- [ ] If B: a 30-minute timebox establishes whether `hermes` has a usage flag at
      all. Result recorded either way.

**Gate 0 closes when the decision is recorded.** Nothing below depends on which
option is chosen, only that one is.

---

## Gate 1 — Nobody meets a control that refuses them

**Why:** the API now refuses direction changes that the UI still offers. That is
worse than shipping no guard, because a person cannot tell a boundary from a bug.

### In scope

Goals, projects, mandates: inline editors, delete controls, and the
URL-reachable configuration and budget tabs.

### Out of scope, deliberately

Issues, comments, deliverables. Those are *work*, agents and members keep them,
and nothing about them changed.

### Acceptance

- [x] `GET /api/me/capabilities?companyId=` returns role, instance-admin flag and
      a boolean per capability. **Probe:** agent key → 200 with every capability
      false. *Done.*
- [x] `canSetCompanyDirection` is one predicate serving both the enforcing assert
      and the reporting endpoint. **Probe:** grep shows a single implementation.
      *Done.*
- [x] Goal title, description and delete obey it. **Probe:**
      `GoalDetail.permissions.test.tsx`, falsified by stripping the wiring.
      *Done.*
- [x] Project name and the configuration/budget tabs obey it. *Done — tabs
      render an explanation instead of controls.*
- [ ] **Mandates obey it.** Probe: an equivalent page test, falsified.
- [ ] **A refused mutation shows the server's own sentence**, not "Error".
      Probe: force a 403 mid-session and read the screen.
- [ ] **Walk every direction surface signed in as a `member` and meet no control
      that fails.** This is the gate's real test and it is manual.

**Gate 1 closes when a member can use the product for an hour without
encountering a refusal.**

---

## Gate 2 — Nothing on screen is a confident lie

**Why:** the failure mode of this codebase is not crashes. It is HTTP 200 with
nothing done, and numbers that look measured and are not. Four instances found
in one day: a stale bundle served to deep links, `definitionOfDone` discarded,
`completedAt` rewritten, a published npm package that CI called green.

### In scope

Costs, token counts, run counts, "last seen" values, and any figure a person
might act on.

### Acceptance

- [ ] Whatever Gate 0 decided is implemented. If A: every cost and token surface
      reads **"not measured"** and no zero is displayed anywhere a measured value
      would go. Probe: load the costs page against `uat`, which has zero cost
      events, and read it.
- [ ] Run counts, wall-clock and model/provider are shown, because those we do
      know. Probe: the same page shows 30 runs for `uat`.
- [ ] A test asserts the "not measured" path, falsified by making the API return
      a zero and watching it fail.
- [ ] No other surface reports a total derived from `usage_json`. Probe: grep for
      consumers and check each.

**Gate 2 closes when every number on screen is one we measured.**

---

## Gate 3 — Four people, on their own machines, for a week

**The exception:** this gate may start while Gate 2 is open, because it takes
calendar time and it is the only gate that finds unknown unknowns. It may not
*close* before Gate 2 does.

### In scope

Titus plus three colleagues. Role model, decided: Titus is owner and instance
admin; colleagues are `member`, with **their own agent via stewardship** and
**read-only** goals and projects. Both live companies are already on the
`agentdash_mk` profile with stewardship active, so the mechanism exists.

### Acceptance

- [ ] Three agents created, one per colleague, each with a stewardship row.
      Probe: `select count(*) from agent_stewardships` returns 4.
- [ ] Each colleague pairs their own machine with a connect code and reaches
      `✔ Connected`. Probe: `claude mcp list` on each machine.
- [ ] Each completes one real piece of work through their own harness. Probe:
      four issues moved to done with that person's agent as actor.
- [ ] **Zero SSH sessions by us during the week.** Any intervention is a defect,
      logged with what the person could not do alone.
- [ ] Each colleague can see the company goals and cannot change them. Probe:
      ask them to try.

**Gate 3 closes on four completed pieces of work with no intervention.**

---

## Gate 4 — The client's machine holds no source, and agents cannot rewrite it

**Why:** 191 MB of git history and 2,329 source files currently sit on the
machine, owned and writable by the account the server runs as, with no sandbox
on the server-side execution path.

### In scope, corrected against what was verified

- Ship a built artefact. **Not 10–20 MB** — all 12 workspace packages export
  `.ts` directly and `@embedded-postgres/darwin-arm64` alone is 145 MB. Choose:
  build all 12 and rewrite their `exports`, esbuild-bundle the server the way
  `cli` already is, or keep `tsx` and drop the "no source" claim.
- Run as an account that cannot write the install. This is a **migration**: the
  Postgres cluster, secrets master key, workspaces, plugins and *two* backup
  trees all derive from `os.homedir()`, and harness credentials must be
  re-established under the new uid.
- Route agent execution through the seatbelt profile that **already exists** at
  `cli/src/bridge/sandbox.ts`, keyed to the resolved cwd, not to
  `workspaces/<agent>` (heartbeat resolves cwd four different ways).
- Rotate the database credentials off `paperclip:paperclip`.

### Out of scope

Tamper-detection manifests. Worth doing, not worth blocking a handover.

### Acceptance

- [ ] Fresh machine, one command, serving. Probe: run it on a scratch account.
- [ ] `find <install> -name .git` returns nothing.
- [ ] The service account cannot write the install. Probe: attempt a write as
      that user and get `EACCES`.
- [ ] An agent cannot read `~/.config/agentdash` or write outside its workspace.
      Probe: run one that tries.
- [ ] Nightly **and** hourly backups still run afterwards. Probe: force both.
- [ ] Database credentials are no longer `paperclip:paperclip`.

**Gate 4 closes when a fresh install serves with no source on disk and a
confined agent.**

---

## Gate 5 — The remaining authority gaps

Each verified live, then closed, then re-verified — the pattern that has worked
all day.

### Acceptance

- [ ] Plugin host `goals.create/update` enforces capabilities at dispatch.
- [ ] `assertInviteRoleCeiling` applies to agents. Today an agent holding
      `users:invite` can invite a human as **owner**.
- [ ] A CEO-role agent cannot `PATCH /companies/:id` name or description.
- [ ] Each has a probe showing the old behaviour and the new 403.

**Gate 5 closes when all three probes return 403.**

---

## What is explicitly not in any gate

Saying so plainly so it does not creep in:

- `agentdash.cloud` relay — deferred; `mkmini.local` plus Tailscale covers the office
- A Claude Code plugin — `npx agentdash-connect` is published and works
- Any new agent capability — the gap is trust and operability, not features
- MDM negotiation — out of scope by the owner's decision
- Tamper-detection manifest — Gate 4 out-of-scope, revisit after handover

## Status

| gate | state |
|---|---|
| 0 — metering decision | **open — needs the owner** |
| 1 — no refusing controls | open (4 of 7 criteria met) |
| 2 — no confident lies | open, blocked on Gate 0 |
| 3 — four people, one week | open, may start early |
| 4 — packaging and least privilege | open |
| 5 — remaining authority gaps | open |
