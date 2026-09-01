# signals/ — evidence

One file per **signal**: a piece of feedback, an idea, a friction, or an observation worth
remembering. Signals are **deduped and frequency-counted** — when the same thing shows up again,
you don't make a new file, you add a `## Timeline` entry to the existing one and bump `frequency`.

This README is the schema. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the model.

## When a MAW agent files a signal

While doing issue work, agents notice things that aren't the issue: a recurring bug, a confusing
flow, a missed opportunity, a flaky test. Don't drop them — file a signal here (or bump an
existing one) and link the Linear issue / PR. That's the mechanism that lets the support-style,
SEO-style, and product-style loops cross-pollinate.

## Frontmatter

```yaml
---
kind: signal
category: feedback | idea | friction | observation   # what sort of signal
frequency: 1                # how many times seen; increment on recurrence
sources: []                 # where it came from (Linear AGE-*, PR #, url, ticket id)
domain: []                  # which loop(s) this feeds — a list of domain names
status: open | triaged | actioned | closed
---
```

## Body

A short statement of the signal (what, and why it matters), then an optional append-only
`## Timeline` accumulating each sighting:

```
## Timeline
2026-06-21 | AGE-132 — hit the same SKU-mapping confusion again while building deployment SKUs
```

`frequency` = number of Timeline entries. Link related artifacts with `[[slug]]`.

## Naming

`<short-kebab-slug>.md`, or a stable id like `SIG-<n>.md` if you prefer running numbers.
