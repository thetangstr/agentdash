---
kind: doc
domain: [meta]
type: decision
status: adopted
---

# Knowledge-base architecture (the loop substrate)

How `loops/` is organized as the operating substrate for long-lived, autonomous agent loops
(and the humans steering them). Everything is plain **markdown + frontmatter in git** — diffable,
reviewable, agent-writable. This doc is the durable record of the model and the options rejected,
so the shape stays intentional as it grows.

Adapted from the [`loop-engineer-template`](https://github.com/JayZeeDesign/loop-engineer-template)
(AI Jason / AI Builder Club). The credit and the proven shape are theirs; the AgentDash mapping
is ours.

---

## The model (v1 — deliberately minimal)

Two ideas only:

1. **Artifacts** are global, foldered by **kind**; `domain:` is a **field (a list)**, not a
   folder. Each artifact has exactly one home (by *what it is*). Cross-cutting is handled by tags
   + `[[links]]` — never by duplicating or by nesting inside a domain.
2. **Domains** are "loops" — a thread of work with a charter, cadence, and (optionally) metrics.
   A domain folder holds only its **README (charter/state)** + **machinery** (metrics,
   collectors). It **links** artifacts; it never contains them.

### Kinds (start with just these two)

| kind | what it is | folder | key frontmatter |
|---|---|---|---|
| `signal` | evidence: feedback / idea / friction / observation (deduped, frequency-counted) | `signals/` | `category, frequency, sources[], domain[], status` |
| `doc` | durable knowledge: an analysis, a decision, a thing you learned | `docs/` | `domain[], status?, links` |

That's enough to run almost any loop. Each folder's `README` is its schema — read it before
adding artifacts of that kind. Committed work doesn't need its own kind to start: a loop's
to-dos live inline as a backlog in its domain `README`. Promote them to a `task` kind only once
you've earned it (below). **In AgentDash, committed feature work already has a home — Linear (the
`AGE-*` issues the MAW pipeline runs on). Don't reinvent it as a `task` kind; link to the Linear
issue from signals/docs instead.**

### Earning a new kind

Default to an existing kind. Add a new one **only** when it has all three of: its own status
machine **and** queryable frontmatter fields **and** a distinct body shape. Otherwise it's a
`doc` or a `signal` with a tag, or a backlog line in a domain README. If you can't name the
distinct status machine, you haven't earned the kind yet.

### Domains (loops)

A domain is one loop: a separable workstream with its own cadence/owner. Spin up a new domain
only when that's true — otherwise just add a `domain:` tag to an existing one. A domain's
`README` is its live state: goal/charter, current focus, a backlog of links, links to evidence,
optional metrics, and a `## Timeline`. It **points at** artifacts; it never holds them. Use the
`new-loop` skill to scaffold one.

### Body convention — two layers

Each artifact = a normal **main body** + an optional appended **`## Timeline`** (append-only,
dated: `YYYY-MM-DD | source — what happened`). *"What's true now"* = body; *"what happened"* =
Timeline. A `signal`'s `frequency` = number of Timeline entries; recurrence bumps the existing
file, it does not create a new one.

### Logs & data

- **`LOG.md`** (in `loops/`) — global activity feed: one line per bulk of work shipped. Detail
  lives in each artifact's `## Timeline`. Append one entry right before the commit that ships.
- **No separate `daily`/`journal` kind.** A domain's run-log is its `README`'s `## Timeline`.
  Two log surfaces total: per-artifact `## Timeline` + the global `LOG.md`.
- **`domains/<x>/metrics/*.jsonl`** — numeric time-series, written by **deterministic collectors**
  (code/scripts, *not* the LLM). Agents read & interpret. Don't pay an LLM to fetch numbers.

### Rules (DRY + MECE)

1. **One concept = one home** (by kind). Everyone else links via `[[slug]]`.
2. **`domain:` is a field (list), not a folder.** Cross-cutting = multi-tag + multi-link.
3. **Collectors write data; agents write knowledge.**
4. **Frontmatter = anything you'd query.** Prose for everything else.

---

## How this maps onto AgentDash

| Template concept | AgentDash home |
|---|---|
| committed work (`task`) | **Linear `AGE-*` issues** (the MAW pipeline) — link, don't duplicate |
| the dev "loop" that ships an issue | the MAW pipeline: `/workon` → `/builder` → `/tester` → `/tpm` |
| codebase harness (legible/executable/verifiable) | `AGENTS.md`/`CLAUDE.md` (legible) · `pnpm dev` (executable) · `tests/e2e` + `/tester` verifier gate (verifiable) |
| custom lints with remediation | `scripts/check-architecture.mjs` (`pnpm check:architecture`) |
| product agent loops | the AgentDash **heartbeat + scheduler** running real companies (Atlas Wire, Meridian) — candidate `domains` once the substrate is wired into the product |

---

## Deferred — add only when the need is real (do NOT pre-build)

| Later | Trigger to add it |
|---|---|
| `task`/`ticket`/`campaign` kinds | a recurring entity outgrows Linear + signals |
| `trigger:` field (cron / webhook / event) | first non-manual loop wired to a real trigger |
| `domains/*/metrics/*.jsonl` collectors | a loop needs tracked numbers over time |
| derived index (sqlite / vector) | retrieval volume outgrows ripgrep (~10⁴⁺ artifacts) |
| reconcile / consolidation daemon | autonomous volume creates dupes / contradictions |

The substrate extends to all of these without a rebuild (markdown stays the system of record;
layer a cache/daemon on top).

## Options considered, and why not

1. **Folder-by-domain.** ❌ Cross-cutting artifacts have no single home → forces duplication.
2. **Folder-by-kind only, no domains.** ❌ Loses the thread-of-work cohesion; "where's the X
   loop?" has no home.
3. **Half-nested** (some kinds global, some under domains). ❌ The asymmetry *is* the bug.
4. **Pure database** (Notion-style). ❌ for now — we want the data code-adjacent, diffable,
   reviewable, in *this* repo. A DB can be derived later.
5. **Heavy taxonomy upfront.** ❌ Premature; every kind you can't justify causes friction. Start
   with 2, earn more.
