# What is left tonight, and the plan to execute it

**Written:** 2026-08-17, ~00:15. For review before execution.

Everything below is either measured or explicitly marked as an assumption.
The headline: **the platform work is done and verified; the thing that has
never been tested is the platform doing actual work.** That is what the RFP
scenario is for, and it is the centre of this plan.

---

## Part 1 — the list

### A. Blocking the RFP scenario (must fix to validate end to end)

| # | item | state | evidence |
|---|---|---|---|
| **B1** | Agent web search under confinement | **BLOCKED, close** | Ancestor-metadata fix landed and works — path errors gone. Remaining: `mcporter` reads `~/.claude/settings.json`, which the sandbox correctly denies. Needs a synthetic HOME or an mcporter config path override |
| **B2** | Knowledge base — past MKThink projects | **absent** | `company_context` = 0 rows, `assets` = 0, the only 4 documents are auto-generated continuation summaries. "Find a similar past project" has nothing to search |
| **B3** | mkboard agents cannot be woken by timer | **by design, but unset** | all six have `heartbeat.enabled` false/unset. Assignment and @mention still work (`wakeOnDemand` defaults true) |
| **B4** | Second human (Sam) | **decided** | I play Sam via API — agreed |

### B. Known defects and gaps, not blocking the scenario

| # | item | state |
|---|---|---|
| **D1** | 7 cost surfaces still render `$0.00` | confirmed visually by the browser walkthrough; Gate 2's enumerated remainder |
| **D2** | Plugin `GET /status` trips the rate limiter 12× on ordinary navigation | cosmetic, real |
| **D3** | `packages/connect` typecheck fails on a dangling `droid-local` tsconfig reference | pre-existing, reproduced on clean HEAD |
| **D4** | Packaged install not re-run since G6 / role collapse / O1-O2 | proven earlier, but that predates tonight |
| **D5** | RLS backstop deferred | app-side enforcement done and leak-tested; DB-level needs per-request connection identity |

### C. Owner-gated, cannot be done by me

| # | item | who |
|---|---|---|
| **H1** | **Reboot test** — boot without login | you, tomorrow |
| **H2** | mkcert CA install on Titus's / Sam's / Megan's machines | each person, once |
| **H3** | Sam and Megan accepting their invites | them |
| **H4** | Retention windows (Q6) — client-data policy | you |

---

## Part 2 — the plan

Three goals, executed in order. Each has a **falsifiable exit condition** — not
"it looks right" but a specific observation that would prove it wrong.

### Goal 1 — Agents can research, confined *(est. 30–45 min)*

Unblocks everything else. Loop until the exit condition holds.

1. Give the sandboxed child a **synthetic HOME** containing only `.mcporter`
   (and symlinks to what hermes genuinely needs), so tools that probe `~` find
   an empty, safe home instead of yours.
2. Falsify each time: Exa search returns a real result **and**
   `~/.config/agentdash/*.env`, `~/.ssh` and `~/.claude` all stay denied.
3. If a synthetic HOME breaks hermes's own state, fall back to an explicit
   mcporter config path and record why.

**Exit:** a confined process returns a live RFP title from Exa, while a
confined `cat` of the Resend key still fails. Both, in one run.

**Give up if:** not solved in ~45 minutes. Then the scenario runs with search
performed by me and seeded, the limitation recorded plainly, and Goal 2
proceeds — because the multi-agent test is worth more than the search path.

### Goal 2 — Seed the knowledge base *(est. 30 min)*

3. Seed **past MKThink project records** into `company_context` /
   documents — clearly marked `SEED — synthetic, generated 2026-08-17`, so no
   one ever mistakes generated history for real company memory.
4. Seed the **real RFPs already found** (Lakeway TX RFQ 26-1011, Ventura,
   Pittsboro, Alhambra, North Branch) as source material — these are genuine
   public documents, not inventions.
5. Enable heartbeat at **30 min** on the three chosen agents.

**Exit:** an agent run can retrieve both a seeded past project and a real RFP,
read back from the database.

### Goal 3 — Run the scenario end to end *(est. 60–90 min)*

Titus's real goal, three agents, two humans:

6. Titus sets direction; **Sam is refused** when he tries (A1).
7. Sam creates the project and owns it (A3/A4).
8. Three issues, one per agent, assigned — waking them without a timer.
9. Agents research → match to past work → draft a response.
10. An agent `@mentions` Sam with a question; Sam's reply wakes it.
11. Chief raises the **publish-or-hold** approval; Titus decides.
12. Sam restricts the project; a second member cannot see it (A5).
13. **Verify every claim against the database** — the honesty check.

**Exit:** a draft RFP response exists, each claim traces to a real source or
is explicitly marked unavailable, and the approval trail names who decided.

**The finding to watch for:** with no real past-project data beyond what I
seed, an agent may fabricate. That is the single most valuable thing this run
can tell us, and a fabricated-but-plausible response is a **worse** outcome
than an honest empty one. Record either way.

---

## How I will run it

- **Loop per goal**, not per step: work the goal until its exit condition
  holds or the give-up bound is reached, then report before moving on.
- **Every claim measured.** Probe live, read the database back, treat a 400 as
  inconclusive, and falsify each guard.
- **Report what I did not do**, every time.
- I will **stop and show you** the scenario's output before anything is marked
  passing — an agent-written RFP response is exactly the artefact where
  "looks right" is most dangerous.

## What I recommend cutting if time runs short

D1–D4 all wait. **Goal 3 is the one that matters** — it is the only item that
answers the question you have been asking all night: what does it actually
take for these agents to finish a piece of work together?
