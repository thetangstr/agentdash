# Deep Interview — Methodology Summary

This is a hand-curated distillation of the OMC `deep-interview` SKILL.md
methodology. It is the contract used by `selectPromptDepth(adapter)` for
spawn-based adapters where the full ~16.7k-token SKILL.md cannot be cached
or fit comfortably in argv. It is also the fallback the sync script ships
to environments that do not have the upstream OMC SKILL.md cached on disk.

Pinned upstream version: 4.13.5

## Purpose

Replace vague ideas with crystal-clear specifications by asking targeted
Socratic questions that expose hidden assumptions, measuring clarity across
weighted dimensions, and refusing to proceed until ambiguity drops below the
resolved threshold for this run.

## Per-round flow

Repeat until `ambiguity_score <= threshold` OR the hard cap (round 20) is
reached:

1. Identify the WEAKEST clarity dimension from the previous round's scores.
   Name it explicitly (score, gap, why this dimension is highest-leverage).
2. Ask exactly ONE question targeted at that dimension. Never batch multiple
   questions into one turn.
3. Receive the user's answer (plain English).
4. Score clarity on every dimension from 0.0 to 1.0 using the brownfield or
   greenfield weights below. Compute the new ambiguity score.
5. Update the ontology snapshot for this round (entities, fields,
   relationships) and compute stability vs. the previous snapshot.
6. Decide the next phase: continue, crystallize (if at or below threshold),
   or activate a challenge agent (see below).
7. Persist the round to state before responding so the engine is resumable.

Each round emits exactly ONE question to the user, then a JSON trailer the
engine parses for state. The engine never asks two questions in one turn.

## Ambiguity scoring (brownfield weights)

Brownfield projects modify existing code, so context-clarity matters in
addition to goal/constraint/criteria clarity. The weighted scoring is:

| Dimension                    | Weight |
|------------------------------|--------|
| Goal Clarity                 | 35%    |
| Constraint Clarity           | 25%    |
| Success Criteria Clarity     | 25%    |
| Context Clarity (brownfield) | 15%    |

For greenfield projects (no existing codebase to modify), the weights are
40 / 30 / 30 / 0, omitting context clarity. AgentDash onboarding always
runs in brownfield mode against the user's own product.

`ambiguity = 1 - sum(dimension_score * weight)` — so an ambiguity score of
`0.0` means perfect clarity and `1.0` means we know nothing.

## Ontology stability tracking

After every round, extract every key entity (nouns the user discussed)
together with its type (core domain / supporting / external system),
its fields (key attributes), and its relationships (e.g. "User has many
Orders"). Compare against the previous round's snapshot:

- `stable_entities` — present in both rounds with the same name.
- `changed_entities` — different name but same type and >50% field
  overlap (treat as renamed, not as new+removed).
- `new_entities` — present this round, not matched by any previous entity.
- `removed_entities` — present last round, not matched to any current entity.
- `stability_ratio` — `(stable + changed) / total_entities`, where 1.0
  means the ontology has fully converged. Round 1 has no previous snapshot
  so `stability_ratio` is N/A. If a round produces zero entities,
  `stability_ratio` is also N/A (avoids division by zero).

A high stability ratio over consecutive rounds is a signal that further
interviewing is yielding diminishing returns and crystallization is near.

## Challenge-agent modes

To prevent the interview from converging on shallow consensus, specific
challenge-agent perspectives activate at specific round thresholds. Each
mode runs at most once per interview, then normal Socratic questioning
resumes. The engine tracks `challenge_modes_used` to prevent repetition.

| Mode        | Activates                          | Purpose                |
|-------------|------------------------------------|------------------------|
| Contrarian  | round 4+                           | Challenge assumptions  |
| Simplifier  | round 6+                           | Remove complexity      |
| Ontologist  | round 8+ when `ambiguity > 0.3`    | Find essence           |

- **Contrarian** asks "What if the opposite were true?" — surfaces
  assumptions the user hasn't questioned.
- **Simplifier** asks "What's the simplest version?" — strips scope creep.
- **Ontologist** asks "What IS this, really?" — re-derives the entity
  ontology from scratch when the conversation has stalled at high
  ambiguity. Only activates if ambiguity is still above 0.3 at round 8+,
  because at that point the interview is grinding rather than converging.

## Exit criteria

The interview crystallizes a spec when ANY of:

- `ambiguity_score <= 0.20` (the resolved threshold for AgentDash
  onboarding; configurable via `omc.deepInterview.ambiguityThreshold`).
- `round >= 20` (hard cap — crystallize regardless of ambiguity to avoid
  an unbounded interview).
- The user explicitly opts to exit early (the engine returns the partial
  spec with a clear "ambiguity is still high" warning).

The crystallized spec records the goal, constraints, success criteria,
ontology, and final ambiguity score. AgentDash persists this as a
`deep_interview_specs` row that downstream consumers (CoS plan card,
DOCX export) read.

## Per-turn JSON-trailer contract

Every engine turn instructs the LLM to reply in plain English to the user,
then on a new line emit a JSON trailer with these keys:

```json
{
  "ambiguity_score": 0.42,
  "dimensions": {
    "goal": 0.7,
    "constraints": 0.5,
    "criteria": 0.6,
    "context": 0.4
  },
  "ontology_delta": [
    { "name": "Order", "type": "core_domain", "fields": ["id", "total"], "relationships": ["belongs_to User"] }
  ],
  "next_phase": "continue",
  "action": "ask_next"
}
```

Valid `next_phase` values: `continue`, `crystallize`,
`challenge:contrarian`, `challenge:simplifier`, `challenge:ontologist`.
Valid `action` values: `ask_next`, `force_crystallize`.

If the trailer is missing or malformed, the engine retries once with a
cleanup turn ("Your last response was missing the JSON trailer. Re-emit
the trailer now, no prose."). After a second failure, the engine falls
back to a deterministic in-process scorer and continues — degraded but
not broken.
