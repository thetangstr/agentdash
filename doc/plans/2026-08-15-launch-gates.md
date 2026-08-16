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

### Decision — **A**, taken by the owner on 2026-08-15

Label it "not measured". No cost or token figure is displayed unless we measured
it, and no zero ever stands in for an unknown. B stays available later if Hermes
gains a usage flag; D is rejected permanently.

### Acceptance

- [x] Owner decides A, B, or C, and the decision is written into this file.
- [x] Recorded above.

**Gate 0 is CLOSED.**

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
- [x] **Mandates obey it.** The grant form is replaced by an explanation for a
      member; the granted-mandates list stays visible, because seeing what your
      agent may do is the point of read-only. Probe:
      `MandatesTab.permissions.test.tsx`, falsified by removing the gate.
- [x] **A refused mutation shows the server's own sentence**, not "Error".
      `updateGoal` had NO error handler at all — a refused save rendered nothing
      and left the stale value looking saved. Probe:
      `GoalDetail.permissions.test.tsx` "surfaces the server's sentence",
      falsified by gutting the handler.
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

- [~] **Partly done.** The costs summary now carries `measured`, and the
      Inference-spend tile reads "Not measured" instead of $0.00 when nothing
      was ever recorded. Probe: `costs-service.test.ts` "distinguishes
      unmeasured from zero", falsified by hardcoding `measured: true`. Both live
      companies have 0 cost events, so both will show it.
      **Scope corrected.** "13 remaining surfaces" was wrong in both
      directions. Most are ROW-DRIVEN — BillerSpendCard, ProviderQuotaCard,
      BudgetIncidentCard, RunTranscriptView and the rest format values off rows
      (`entry.costCents`, `row.inputTokens`). With no cost events there are no
      rows, so nothing renders and there is no false zero. The risk is only
      where a surface AGGREGATES to a total or defaults to 0.
      By that test the real list was six, on two pages — and I found the last
      three only by writing a test that asserts over a whole REGION rather than
      one element at a time. Missing a surface is the failure mode here; a test
      naming each surface reproduces the miss.
      - [x] `Costs.tsx` Inference-spend tile
      - [x] `Costs.tsx` headline spend figure — **missed on the first pass**,
            on the same page and the same value, which would have shown
            "Not measured" in one place and "$0.00" in another
      - [x] `Costs.tsx` "usage" token box — **missed on the second pass**, in
            the same card as the headline I had just gated
      - [x] `Costs.tsx` budget utilisation bar and its "0% of monthly budget
            consumed" caption. Utilisation is spend over budget, so unmeasured
            spend makes it a green bar reporting headroom the owner does not
            know they have — the most actionable false claim on the page
      - [x] `Costs.tsx` Budget tile subtitle "$0.00 of $500.00". The cap is
            real and is still stated; what is gone is not knowable
      - [x] `UserProfile.tsx` — done properly, server-side. The profile payload
            now carries `measured`, scoped to the **company** and unbounded by
            date exactly as `CostSummary.measured` is. `costEventCount` could
            not answer this: a person with no attributed events looks identical
            whether the instance meters or not, and calling that zero real is a
            judgement about a colleague's work made out of a gap in our own
            instrumentation. Three surfaces on that page were fed by the same
            empty table — the hero stat, the per-window columns, and the
            14-day chart — and the chart now draws completions, which we know,
            instead of fourteen flat bars under a "tokens / day" legend.
            **Probes:** live uat before → `measured: undefined`, tokens 0 beside
            5 completed issues; after → `measured: false`, same 5 completed.
            Falsified four ways: hardcode `measured: true` (server test fails),
            scope the count to the user's own issues (only the discriminating
            test fails), hardcode `measured = true` in the page (4 UI tests
            fail), and loosen to `!== false` (the older-server test fails).
      Finance ledger tiles are deliberately untouched: finance events are
      invoices and credits, not derived from tokens, so a zero there is a real
      zero and there is no evidence they cannot be measured.

- [x] Run counts and wall-clock are shown, because those we do know. **Done** —
      `GET /companies/:id/costs/run-activity` and a strip inside the Inference
      ledger card, directly beside the figure we cannot produce. It renders
      nothing at all when there are no runs, since a row of dashes would put
      the page back where it started.
      **Criterion narrowed, and why:** "model/provider" was in the original
      wording and is **not achievable** — `heartbeat_runs` has no model or
      provider column, so those are as unavailable as the token counts.
      Deriving them from the agent's configured adapter would be a guess about
      what actually ran, which is option D from Gate 0 under another name.
      Not silently dropped; recorded here as needing a schema change.
      **Probe:** uat 73 runs, every one with both `started_at` and
      `finished_at`; median 7.98s, p90 24.8s, 2,892s total. (An earlier note in
      this file said "median 41s" — 41s was the MEAN. Corrected.)
      Falsified five ways: render the strip when `totalRuns` is 0, remove the
      strip entirely, swap the route's guard for the weaker
      `assertCompanyAccess`, restore the wrong status literal, and drop
      `timed_out` from the failure set. Each fails its specific test.
      **A real bug caught by reading the database back rather than trusting the
      200.** The endpoint returned `succeededRuns: 0` and `failedRuns: 0` out of
      73 — because the filter used `'completed'`, which is a `RUN_LIVENESS_STATE`
      and not a `heartbeat_runs.status` value at all. The status set is
      queued | scheduled_retry | running | succeeded | failed | cancelled |
      timed_out. My unit test had passed because it seeded the same invented
      literal the implementation filtered on, so it agreed with itself. Now
      pinned to `HEARTBEAT_RUN_STATUSES` on both sides, and the test seeds every
      status the system actually writes.
      **One caveat recorded honestly:** the route-guard test is structural, not
      behavioural. The behavioural version could not discriminate — with the
      stubbed db in that file `access.canUser` resolves truthy, so a member
      reaches this route *and* the pre-existing `/costs/summary`, and the
      outside-the-company actor that does return 403 is refused by either
      guard. It proves the guard is wired, not that the guard is correct.
- [x] A test asserts the "not measured" path, falsified by making the API return
      a zero and watching it fail. *Done — `costs-service.test.ts`,
      `user-profile-routes.test.ts` (3 cases), `UserProfile.measured.test.tsx`
      (7 cases). Each was run against a sabotaged implementation and failed.*
- [x] No other surface reports a total derived from `usage_json`. Probe: grep for
      `formatCents(… ?? 0)` and `reduce`-style aggregation, then read each hit.
      *Done — the surviving hits are the finance ledger tiles, which are
      invoices and credits rather than token-derived, and row-driven displays
      that render nothing when there are no rows.*

**Gate 2 is CLOSED.** Every number on screen is one we measured, and the two
pages that had nothing to show now show run counts and wall-clock instead of
nothing.

**Two things this gate did not do**, stated so they do not read as covered:
model and provider per run need a schema change, and the route-guard test above
is structural rather than behavioural.

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

- [x] Plugin host `goals.create/update` enforces capabilities at dispatch.
      **The criterion was already met, and the note that raised it was wrong.**
      `createHostClientHandlers` wraps every handler in `gated(method, …)` and
      `METHOD_CAPABILITY_MAP` maps both writes to their capabilities. (I first
      read `plugin-capability-validator.ts`, whose `assertOperation` has no
      callers, and nearly reported that NO host operation was checked. It is a
      second, unwired validator; the live one is in the SDK.)
      **What was actually missing was the probe.** Nothing asserted any of it,
      so "enforced" rested on a reading rather than a run — and this gate's own
      rule is that an unrunnable criterion is not a criterion. Now:
      `plugin-goals-capability.test.ts`, 6 cases, including a plugin that holds
      `goals.read` but not `goals.create` (refusing a plugin with no
      capabilities at all would prove much less) and controls in both
      directions.
      **And the probe found something worse than the thing it was written for.**
      The first falsification FAILED to fail: deleting the gate from SDK source
      broke no test. `@paperclipai/plugin-sdk` is consumed through its
      `exports` map, which points at `dist`, and `ensure-plugin-build-deps.mjs`
      checked only that `dist/index.js` EXISTED — never whether it was stale.
      So every SDK source edit was invisible to `pnpm typecheck` AND to the
      server suite, indefinitely. Green over an artifact nobody rebuilt: the
      same failure as the npm package earlier today, in the other direction.
      Fixed: the script now compares source mtimes against the output, and the
      server's vitest runs it as `globalSetup` (typecheck already did; tests
      did not). Re-falsified with no manual rebuild — the sabotage now fails.
- [x] `assertInviteRoleCeiling` applies to agents. **Done.** The check compared
      the requested role against the ACTOR's human role, and an agent has none,
      so it returned early and applied no ceiling at all.
      **Probe, before** (uat, agent key + a temporary `users:invite` grant):
      invites created at owner, admin, operator and viewer — all 201. Reading
      the rows back showed the owner invite carried a full grant bundle
      including `users:manage_permissions`, `users:invite` and `joins:approve`.
      An agent cannot grant itself authority, but it could mint a human who
      can rewrite everyone's permissions.
      **The fix:** a fixed ceiling of `viewer` for agents. Read-only is
      participation; above it is authority, and authority should come from a
      person. A human can always raise an agent's invite afterwards; the
      reverse cannot be undone once accepted.
      **A second hole the ceiling alone did not close:** invite creation has
      its own `?? "operator"` default, so an agent omitting `humanRole` was
      CHECKED as viewer and then STORED as operator — a refused role arriving
      through the front door, at 201 both before and after. The route now
      passes the role it checked rather than the raw body.
      **Probe, after:** owner/admin/operator → 403 with a sentence naming the
      rule, viewer → 201, no-role-named → 201 stored as `viewer` with empty
      grants. Confirmed by reading `defaults_payload` back.
      Falsified three ways: restore the early return (3 tests fail), raise the
      ceiling to owner (4 fail), store the raw body again (the default-bypass
      test fails, and only that one).
      **Cleanup:** all 6 probe invites revoked (none accepted), the temporary
      `users:invite` grant removed, the probe key revoked. uat has 0 unrevoked
      unaccepted invites and only the 6 real CoS keys.
- [x] A CEO-role agent cannot `PATCH /companies/:id` name or description.
      **Done.** The role check was already right; the FIELD LIST was the hole.
      `updateCompanyBrandingSchema` legitimately carries name and description
      for human callers and was doing double duty as the agent's boundary, so a
      CEO agent could rename the company through **two** routes.
      **Probe, before:** with a real CEO-role agent key on uat,
      `PATCH /companies/:id {name}` → 200 and the database read back
      `"RENAMED BY CEO AGENT"`; `PATCH /:id/branding {description}` → 200 and
      the description was rewritten. Both confirmed by reading the row back.
      **Probe, after:** rename → 403, description → 403, rename smuggled in
      beside a legitimate `brandColor` → 403, and `brandColor` alone → 200 with
      the colour applied and name and description untouched.
      Refusal is a 403 with a sentence, not a 400 "Validation error" — a reader
      cannot tell that from a bug, which is the Gate 1 rule.
      Falsified four ways: remove the explicit refusal (4 route tests fail),
      drop `description` from the forbidden list (1 fails), drop `.strict()`
      from the agent schema (the smuggling test fails). Widening the schema
      back to the human one alone does NOT fail a route test — the explicit
      guard already covers it — which is why the schema is tested directly.
      **Cost of the probe, recorded:** renaming the company on uat overwrote
      its real description, and my first restore wrote `null` because I had not
      captured the value before probing. Recovered byte-for-byte from the
      03:38 backup. The probe agent is terminated rather than deleted —
      `activity_log` references it, and erasing that would be erasing the
      record of what happened.
- [x] Each has a probe showing the old behaviour and the new 403. *Two of the
      three had a live before/after on uat, read back from the database. The
      third was already enforced, so there is no "old behaviour" to show — its
      probe is the test that was missing, plus the falsification that exposed
      the stale-dist problem.*

**Gate 5 is CLOSED.**

Two items were real privilege-escalation paths, both proven live and both now
refused with a sentence. The third was already correct and merely unverified —
worth saying plainly, because a gate that reports three fixes when it made two
is the same kind of false confidence Gate 2 exists to remove.

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
| 0 — metering decision | **closed — A, label "not measured"** |
| 1 — no refusing controls | open (4 of 7 criteria met) |
| 2 — no confident lies | **closed** — every criterion demonstrated |
| 3 — four people, one week | open, may start early |
| 4 — packaging and least privilege | open |
| 5 — remaining authority gaps | **closed — 2 real gaps fixed, 1 already correct** |
