# First real deliverable — the weekly leadership deck

**Date:** 2026-08-04
**Status:** definition of record for the first real cycle. Resolves the three open questions
that gated it (harness plan §Open questions), two of them **by assumption** — every assumption
is marked and gets confirmed or corrected on-site at the mini, which is cheap: facts are rows,
and correcting one is a one-row change.

## The owner's answers (2026-08-04)

| Question | Answer |
|---|---|
| Weekly artifact? | **A deck.** (Matches the P0 spec's canonical scenario — a board/leadership deck-ready artifact with contributor provenance.) |
| SharePoint sheets structured or ad-hoc? | Unknown — **assume the most common shape: ad-hoc worksheets**, no named tables/ranges. |
| Which HubSpot objects? | Unknown — **assume the standard CRM trio: deals, contacts, companies**, with deals carrying the weekly signal. |

## What the code supports today (verified, not assumed)

- Deliverable row: `key, name, cadence ("weekly"), firstApproverUserId, secondApproverUserId`
  (`packages/db/src/schema/deliverables.ts:56-81`). Approver seats per plan criterion G5:
  **first = Titus's seat, second = CEO's seat.** Instrumented per SEAT, never per person.
- Facts: `sourceType: "system" | "human"` (`packages/shared/src/types/deliverables.ts:31`).
  Moving human → system is a one-row dial — that comment is the product thesis.
- **The collection sweep supports exactly one system connector: `sharepoint`.**
  `server/src/services/deliverable-runs.ts:226` flags any other `connectorProvider` as
  `unsupported_connector` (loudly, as designed). Reads go through
  `sharepoint.readWorkbookRange({siteId, itemId, ...})` under the owner's OBO identity.
- Therefore: **HubSpot facts start as `human`-sourced.** The owning agent answers them using
  its steward's BYO HubSpot key (shipped 2026-07-30) and the answer carries provenance. This
  is correct P0 behavior, not a workaround — "trigger, not automate."

## Fact list v1 (implementer-authored; MKThink authors nothing)

System facts (SharePoint, via OBO):

| key | label | source | config (to fill on-site) |
|---|---|---|---|
| `utilization_current` | Utilization, current week | system/sharepoint | siteId, itemId, explicit A1 range |
| `financial_snapshot` | Financial snapshot figures | system/sharepoint | siteId, itemId, explicit A1 range |

Human facts (asked of the named agent; escalate → steward's harness → stall under lease):

| key | label | notes |
|---|---|---|
| `pipeline_by_stage` | Open deals: count + value by stage | agent answers from HubSpot deals via steward key |
| `deals_closed_won` | Closed-won this week | same |
| `deals_new` | New deals this week | same |
| `highlights` | Narrative highlights of the week | genuinely human |
| `risks` | Risks / blockers for leadership attention | genuinely human |
| `next_week_priorities` | Priorities for the coming week | genuinely human |

Checks: a **blocking** presence check on `utilization_current`, `pipeline_by_stage`, and
`deals_closed_won` (a deck with those holes should not reach approvers unflagged); everything
else advisory. Use only kinds in `AUTHORABLE_DELIVERABLE_CHECK_KINDS` — `custom` is
deliberately not authorable.

## Consequences of the ad-hoc SharePoint assumption

Per F4, ad-hoc reads must **fail loudly rather than return a wrong cell** — that machinery
exists; expect it to fire. Two mitigations, decided on-site:

1. Pin reads to explicit A1 ranges after eyeballing the real workbook (ten minutes).
2. Better: convert the source sheets to **named tables** in Excel during the visit (also
   ~ten minutes) and pin facts to names — this survives row inserts, which A1 ranges do not.
   Prefer this if the sheet owner agrees.

## Optional follow-up slice D1 — HubSpot branch in the collection sweep

When the human-sourced HubSpot facts prove stable, add a `hubspot` case beside `sharepoint`
in `deliverable-runs.ts` reading deals via the steward-key service, and flip the three
pipeline facts' rows to `system`. That flip **is the labour-curve story** the measurement
substrate exists to capture — do it after ≥2 real cycles, not before, so B's events record
the before/after. Gates G1/G3/G4 apply (real entry point, adversarial cross-company read).

## Still genuinely open (cannot be assumed)

- Real `siteId`/`itemId`/ranges — on-site, with live OBO creds. Watch the documented #1 risk:
  an Entra OBO response omitting `scope` fails closed and presents as total outage.
- Real HubSpot pipeline/stage names (the human facts tolerate this; D1 cannot).
- Deck template/branding — the pipeline produces a deck-ready reviewed artifact; whether the
  final rendering is a .pptx from a template is a presentation choice for the visit.
