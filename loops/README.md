# loops/ — the loop-engineering substrate

This is the **shared brain** for AgentDash's agent loops: a plain markdown + frontmatter
knowledge base, in git, that loops (and humans) read and write so work **compounds** across
sessions instead of starting from zero each time.

It is the [`loop-engineer-template`](https://github.com/JayZeeDesign/loop-engineer-template)
model, adapted for AgentDash. Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full design and
the rationale; this file is the one-screen orientation.

## The model in four lines

- **Artifacts** are global, foldered by **kind** — [`signals/`](signals/) (evidence: feedback,
  ideas, frictions, observations) and [`docs/`](docs/) (durable knowledge: analyses, decisions,
  learnings). `domain:` is a frontmatter **field (a list)**, never a folder.
- **Domains** ([`domains/`](domains/)) are **loops** — a recurring thread of work. A domain's
  `README` is its live state (goal, cadence, backlog, timeline) and **links** to artifacts; it
  never contains them.
- **[`LOG.md`](LOG.md)** is the global activity feed — one line per bulk of work shipped. Every
  MAW agent reads the last few entries before starting and appends one when it finishes.
- **Earn the structure.** Start with `signal` + `doc` only. Add a new kind / domain only when
  it's genuinely justified (see `ARCHITECTURE.md` → "Earning a new kind").

## Two consumers, one substrate

1. **MAW dev workflow** (now) — `/builder`, `/tester`, `/workon` read `LOG.md` for cross-issue
   context, file `signals/` for friction/ideas/bugs they notice in passing, and append to
   `LOG.md` on completion. This is what turns the otherwise-amnesiac pipeline into a compounding
   one.
2. **The AgentDash product** (the bigger opportunity) — AgentDash already runs agent loops
   (heartbeat, scheduler, CoS). This same substrate is how those loops would share a brain:
   Atlas Wire and Meridian are `domains`; the signals a support loop logs feed the product loop.
   Treated here as a documented model, not yet wired into product code.

## Where things live

| I want to… | Go to |
|---|---|
| capture feedback / an idea / a friction (with frequency) | [`signals/`](signals/) |
| record an analysis / decision / thing we learned | [`docs/`](docs/) |
| see a loop's goal / cadence / current state | `domains/<loop>/README.md` |
| skim what shipped recently | [`LOG.md`](LOG.md) |
| spin up a new loop | run the `new-loop` skill (`.claude/skills/new-loop`) |
| make a repo agent-ready | run the `setup-codebase-harness` skill |
