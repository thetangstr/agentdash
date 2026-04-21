# Agent Plans Eval Suite (AGE-41)

Offline eval suite that grades the Chief of Staff dynamic plan generator
against a deterministic 8-dimension rubric.

## Running

From the repo root:

```sh
pnpm --filter @agentdash/server test -- agent-plans-eval
```

Or all server tests (includes this one):

```sh
pnpm --filter @agentdash/server test:run
```

## Structure

- `../../server/src/__tests__/fixtures/agent-plans-scenarios.ts` — 20 reference
  scenarios, each a `(CompanyContextBundle, GoalInterviewPayload)` pair that
  exercises a different combination of archetype, industry, roster state, and
  operator constraints. Lives inside the server package so vitest can load it
  without walking outside the workspace tsconfig scope.
- `rubric.md` — human-readable description of the 8-dimension rubric.
- `../../server/src/__tests__/agent-plans-eval.test.ts` — eval harness that
  runs every scenario through `generateDynamicPlan`, scores via the rubric,
  asserts the A+ bar (avg ≥ 8/10 AND every dim ≥ 8/10 for 18/20 scenarios).

## A+ Bar

- At least **18/20 scenarios** must pass A+ (every dimension ≥ 8/10).
- All 20 scenarios must clear the hard floor (min dim ≥ 6/10).
- Suite average across all dimensions ≥ 8/10.

See `server/src/services/agent-plans-rubric.ts` for the scoring implementation.
