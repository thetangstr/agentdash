# docs/ — durable knowledge

One file per **doc**: something you learned, analyzed, or decided that you want to be findable
later. If a signal is raw evidence, a doc is the worked-through version: an analysis, a writeup,
a decision and its rationale, a how-it-works note.

This README is the schema. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the model.

> **Not to be confused with the repo's `doc/` and `docs/` directories.** Those hold product
> specs, plans, and the Mintlify site. `loops/docs/` is specifically the loop substrate's
> durable-knowledge layer — short, atomic, densely-linked notes produced by loop runs. When in
> doubt: a multi-page design spec belongs in `doc/plans/`; a one-page "here's what we learned /
> decided" note belongs here.

## Frontmatter

```yaml
---
kind: doc
domain: []                  # which loop(s) this belongs to
status: draft | adopted | superseded   # optional; use when a doc can be acted on or replaced
links: []                   # related artifacts, [[slug]] or paths
---
```

Optionally add a `type:` field (e.g. `analysis`, `decision`, `learning`) if you want to filter
docs by shape — but don't force it. Most docs are just knowledge.

## Body

Main text = *what's true now*. Append an optional `## Timeline` for *what happened* (revisions,
supersessions, when a decision was revisited). Link liberally with `[[slug]]`.

## Naming

`<short-kebab-slug>.md` or `<TOPIC>-<YYYY-MM>.md` — whatever reads well and sorts sensibly.
