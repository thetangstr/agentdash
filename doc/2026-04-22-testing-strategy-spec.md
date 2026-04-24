# Deep Interview Spec: Testing Strategy to Cut AgentDash Escape Rate

## Metadata
- Interview ID: testing-strategy-2026-04-22
- Rounds: 3
- Final Ambiguity Score: 19.5%
- Type: brownfield
- Generated: 2026-04-22
- Threshold: 0.2 (MET)
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Goal Clarity | 0.90 | 0.35 | 0.315 |
| Constraint Clarity | 0.75 | 0.25 | 0.188 |
| Success Criteria | 0.70 | 0.25 | 0.175 |
| Context Clarity | 0.85 | 0.15 | 0.128 |
| **Total Clarity** | | | **0.805** |
| **Ambiguity** | | | **0.195** |

## Goal

Cut AgentDash's **Defect Escape Rate (DER)** below 5% within 60 days by eliminating three specific classes of pre-release escape that unit tests cannot catch:

1. **Contract drift** between in-monorepo layers (server SSE chunks ↔ UI parser, Zod validators ↔ DB).
2. **Adapter subprocess failure modes** (exit-code semantics, stderr containing TUI crash markers, bootstrap stdout being mistaken for reply).
3. **SSE / streaming lifecycle races** (request-body consumption timing vs. client disconnect, partial stream close).

The strategy is "real-system simulation, not more mocks": build three AgentDash-specific test harnesses that exercise the actual failure modes, enforce them at the right trigger point, and measure DER as the headline KPI.

## Constraints

- PR CI time may grow to ~30 min if parallelized (operator-trust cost >> CI-time cost).
- Add **at most one** new runtime test dependency, and only if clearly earned. Prefer Zod + existing `vitest`/`supertest`/`Playwright` stack.
- Pre-push hook acceptable only if lightweight (changed-file scope, <60s typical).
- Blocking merge policy applies only to listed "critical surfaces"; elsewhere advisory.
- Real-adapter CI runs are **nightly** against a $5/day-capped account — never per-PR.
- Must integrate with AgentDash's existing multi-agent workflow (Tester agent in `.claude/commands/tester.md`) instead of reinventing enforcement.
- No `.husky/` exists today; whichever hook manager we pick must be lightweight.

## Non-Goals

- Not adopting Pact (overkill for monorepo; Zod-as-contract covers the same ground).
- Not adopting MSW or Nock (supertest + real embedded Postgres is the existing harness; don't regress to HTTP mocks).
- Not setting a repo-wide coverage percentage threshold (DER is the metric, not coverage).
- Not running the full suite pre-commit or pre-push (will get disabled if slow).
- Not rebuilding a parallel GitHub Actions enforcement layer — reuse the Tester agent as the gate.
- Not moving away from embedded Postgres; it's the one good call inherited from paperclip.
- Not rewriting existing 27 Playwright specs or 264+ vitest tests.

## Acceptance Criteria

### Infrastructure

- [ ] **AC-1.** `packages/shared/src/chunks/assistant-chunks.ts` exists and exports a `z.discriminatedUnion` schema covering every chunk type the assistant SSE route emits (`text`, `tool_use`, `tool_result`, `error`, `done`). A matching `AssistantChunk` TypeScript type is exported.
- [ ] **AC-2.** `server/src/routes/assistant.ts` types its SSE writes against the shared schema (either by direct import or by a `writeChunk(chunk: AssistantChunk)` helper). TypeScript refuses to compile if the server emits a field the schema doesn't declare.
- [ ] **AC-3.** `ui/src/components/ChatPanel.tsx` replaces its local `chunk` literal type with `assistantChunkSchema.safeParse(json)` and switches on the parsed `chunk.type`. An invalid chunk is logged and ignored, not crashed on.
- [ ] **AC-4.** `server/src/__tests__/helpers/sse-client.ts` exists and exposes a helper that spins up the real Express app on an ephemeral port, opens a real `fetch`-based reader (not supertest), and returns `{ readNext(), close(), events() }` for lifecycle-aware tests.
- [ ] **AC-5.** `packages/adapters/_testing/fixture-adapter.ts` exists and exports `fixtureAdapter({ stdout, stderr, exitCode, signal, timedOut, summary, resultJson, usage })` producing an `AdapterExecuteFn`-shaped function. It can be registered via the existing adapter registry under a synthetic adapterType like `fixture`.

### Tests that must exist and pass

- [ ] **AC-6.** `server/src/__tests__/assistant-sse-lifecycle.test.ts` covers:
  - Chunk stream delivers N chunks end-to-end for a successful CoS reply (via fixture adapter).
  - Client close mid-stream causes server to stop yielding within 250ms.
  - Server `res.close` vs `req.close` timing — explicit assertion that the response writer does NOT get aborted before any chunk yields.
  - Graceful handling of `[DONE]` sentinel.
- [ ] **AC-7.** `server/src/__tests__/assistant-llm-adapter-fixtures.test.ts` covers the following behaviors (fixture-adapter driven):
  - exit=0 + `result.summary` populated → one `text` chunk, exact content match.
  - exit=0 + summary empty + stdout with prose → stdout fallback used.
  - exit=1 + summary empty + stdout present → stdout is NOT used; diagnostic `(No model output…)` chunk emitted.
  - exit=1 + stderr containing `AgentLoop has been terminated` → friendly codex-Ink crash message, no raw `<n7>` leak.
  - stdout containing `TOOL_CALL: … END_TOOL_CALL` markers → `tool_use` chunks emitted in order, de-duplicated.
  - exit=1 + empty everything → diagnostic chunk with stderr tail appended.
- [ ] **AC-8.** `packages/shared/src/__tests__/assistant-chunks.test.ts` covers:
  - Every chunk shape emitted by the server in AC-7 round-trips through the schema.
  - Unknown `type` is rejected with a parse error.
  - Extra unknown fields are preserved or stripped consistently (spec choice: strict parse — extras cause an error, surfaced as drift).
- [ ] **AC-9.** `server/src/__tests__/validator-parity.test.ts` — a generic test that takes every Zod `updateXxxSchema` in `packages/shared/src/validators/`, finds the matching DB schema column set, and asserts that every DB column relevant to PATCH is covered by the Zod schema (catches the `credentialMode` silent-strip class). Initially allow a declarative whitelist of exceptions.
- [ ] **AC-10.** `tests/e2e/assistant-chat-chief-of-staff.spec.ts` — a Playwright spec that opens the chat panel, sends a message, and asserts DOM state: bubble containing user text, assistant bubble non-empty, no `<n7>` or React error-boundary text visible, no raw stdout prefix like `[paperclip]` rendered.

### Enforcement

- [ ] **AC-11.** `.github/workflows/pr.yml` gains a job (or existing job gains a step) that runs `pnpm test:run --related` against the PR's changed files. Existing `typecheck + test:run + build` job remains. Total PR CI time target: < 20 min p50, < 30 min p95.
- [ ] **AC-12.** `scripts/precommit/pre-push.sh` exists. Invoked by a `package.json` `prepare` hook that installs a native `.git/hooks/pre-push`. Runs `pnpm typecheck && pnpm test:run --changed` with a soft-fail flag (developer can bypass with `SKIP_PRE_PUSH=1`). Completes in < 60s on typical changes.
- [ ] **AC-13.** `.claude/commands/tester.md` (the Tester agent protocol) is updated to:
  - Parse the PR diff for files matching a "critical surfaces" list.
  - Require a matching Playwright or contract test touching the changed surface.
  - If missing, block with verdict: `missing user-visible test for <file>`.
  - Run the matching Playwright spec headed; attach trace on failure.
- [ ] **AC-14.** `doc/TESTING.md` documents the critical surfaces list, the DER metric definition, and the per-PR testing expectation, replacing the current reliance on CLAUDE.md's regression block.
- [ ] **AC-15.** `.github/workflows/nightly-real-adapter.yml` exists and runs a ~6-scenario smoke against each supported adapter (`claude_local`, `codex_local`, `gemini_local`) using real CLI binaries and a budget-capped account. Dashboard surfaces failures.

### Observability

- [ ] **AC-16.** Every defect logged in Linear or equivalent is tagged with `origin` (subsystem) and `discovery_phase` (one of: `pre-push` / `ci` / `review` / `staging` / `production`). Onboarding for the tag schema is in `doc/TESTING.md`.
- [ ] **AC-17.** Weekly automation emits a DER report: `(defects discovered post-release) / (total defects) × 100`, rolling 30-day window. Target: ≤ 5%.
- [ ] **AC-18.** DER report also segments by subsystem so we can tell whether the new harnesses are moving the assistant / adapter / validator numbers specifically.

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|---|---|---|
| "We need more tests." | Paperclip has 4 e2e specs vs our 27 and still escapes. Volume isn't the lever. | Focus on test *type* and *orchestration*, not volume. |
| "Pact-style contract testing is the answer." | Pact is designed for cross-repo microservices. | In a monorepo, Zod discriminated unions + shared schema gives the same drift-prevention at ~zero tool cost. |
| "Add a pre-commit hook that runs the full suite." | Slow hooks get disabled. | Lightweight pre-push only (typecheck + changed-file tests), with a skip flag. |
| "Coverage % is the success metric." | Coverage is a lagging proxy; DER is the real outcome. | DER is the KPI. Coverage not enforced. |
| "Run real adapters on every PR." | Flaky + expensive + slow + auth expiry. | Nightly at $5/day cap; PR CI uses the fixture adapter. |
| "Build a new GitHub Actions enforcement framework." | Tester agent already reads PR diffs and runs tests. | Extend Tester protocol; don't build a parallel enforcement layer. |

## Technical Context

### Current test infrastructure (verified)

- Vitest: ~264 tests across server/ui/cli/packages. Embedded Postgres via `@agentdash/db`.
- Playwright: 27 e2e specs (`tests/e2e/`), Chromium only, 60s timeout, retries 0.
- CUJ: `scripts/test-cujs.sh` (60 bash+curl assertions).
- CI: `.github/workflows/pr.yml` runs `typecheck + test:run + build`; `e2e.yml` is `workflow_dispatch` only.
- No pre-commit/pre-push hooks anywhere.
- No coverage thresholds configured.
- No server-chunk ↔ UI-parser contract layer.

### Known escapes from this session (evidence)

1. `req.on("close")` fired immediately on POST body consumption, aborting SSE before any chunk yielded. Unit test with supertest did not model the lifecycle.
2. `ChatPanel.tsx` read `chunk.toolName / chunk.toolInput / chunk.error` while server emitted `chunk.name / chunk.input / chunk.message`. No contract test.
3. `updateAgentSchema` lacked `credentialMode`; Zod silently stripped the field from PATCH bodies, making the AgentDetail toggle a no-op.
4. codex-local adapter exit=1 with Ink-TUI stderr (`"The above error occurred in the <n7> component"`, `AgentLoop has been terminated`) was surfaced verbatim to the chat bubble. Adapter fallback logic used raw stdout prefix (`[paperclip] Using Paperclip-managed Codex home…`) as the "reply text".
5. `prev[prev.length - 1]!` in ChatPanel tool_use handler could inject `undefined` into the messages array when prev was empty, crashing MessageBubble.

All five have a matching harness in the Acceptance Criteria above.

### Critical surfaces list (binding for AC-13, reviewable)

- `server/src/routes/assistant.ts`
- `server/src/services/assistant*.ts`
- `server/src/services/billing*.ts`
- `server/src/services/budget*.ts`
- `server/src/services/approvals.ts`
- `packages/adapters/*/src/server/**`
- `packages/shared/src/validators/**`
- `ui/src/components/ChatPanel.tsx`
- `ui/src/components/OnboardingWizard.tsx`
- `ui/src/components/NewAgentDialog.tsx`

Changes to these files require a co-shipped Playwright or contract test. The list lives in `doc/TESTING.md` and is append-only; removals require a PR with justification.

## Ontology (Key Entities)

| Entity | Type | Fields / Responsibility |
|---|---|---|
| Escape | core domain | subsystem, discovery_phase, class |
| Layer Boundary | core domain | server↔UI, validator↔DB, adapter↔consumer |
| Real System | external system | SSE stream, subprocess, browser |
| Test Harness | core domain | name, subsystem, scope |
| Merge Gate | process | trigger, enforcement-mode, owner |
| DER | metric | rolling window, formula, segmentation |
| Contract Test | test type | schema source, drift detection |
| Chunk Schema | artifact | discriminated union of SSE/WS event types |
| Subprocess Fixture | artifact | stdout/stderr/exit knobs |
| SSE Lifecycle Harness | artifact | ephemeral port, real stream, timing asserts |
| Tester Agent | actor | reads diff, chooses tests, blocks merge |

Stability at final round: 9/11 entities stable from round 2 or newly stable (2 held across rounds, 3 added and held, 0 removed or renamed).

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|---|---|---|---|---|---|
| 1 | 5 | 5 | - | - | N/A |
| 2 | 7 | 2 (DER, Contract Test) | 0 | 5 | 71% |
| 3 | 11 | 4 (Chunk Schema, Subprocess Fixture, SSE Lifecycle Harness, Tester Agent) | 0 | 7 | 64% |

Note: ratio dips in round 3 because new implementation-specific entities were introduced at the solution layer. Core domain (Escape, Layer Boundary, DER, Contract Test) is stable — the growth is below the concept line, not shifting it.

## Interview Transcript

<details>
<summary>Full Q&A (3 rounds)</summary>

### Round 1 — Goal Clarity
**Q:** Which of A/B/C/D/E/F best matches the pain — contract drift, real-system simulation gap, CI orchestration gap, assertion weakness, mix, or other?
**A:** B — real-system behavior not simulated.
**Ambiguity:** 48.5%

### Round 2 — Success Criteria
**Q:** If the testing setup is "fixed" in 60 days, what is measurable about that? A/B/C/D/E?
**A:** (After upstream-paperclip check and industry-best-practice research) — 1: DER-as-headline, <5% over rolling window.
**Ambiguity:** 35.7%

### Round 3 — Constraints
**Q:** 5-axis tolerance envelope for CI time, tooling, pre-push, enforcement, real-adapter cost.
**A:** (User asked for recommendations given AgentDash's nature; I proposed 1c / 2b-with-Zod-contract-twist / 3b / 4b / 5b plus three AgentDash-specific harnesses and Tester-agent reuse.)
**Ambiguity:** 19.5% — below threshold.

</details>

## Implementation sketch (phased)

### Phase A — Foundations (week 1)
- AC-1, AC-2, AC-3, AC-8: Zod chunk schema + server parity type + UI parse.
- AC-14: `doc/TESTING.md` skeleton with critical-surfaces list.

### Phase B — Harnesses (week 2)
- AC-4: SSE lifecycle helper.
- AC-5: Fixture adapter.
- AC-6, AC-7: Tests written against the harnesses.
- AC-9: Validator-parity test.
- AC-10: First Playwright spec for the Chief-of-Staff chat path.

### Phase C — Enforcement (week 3)
- AC-11: PR CI job for related-tests.
- AC-12: Pre-push hook with skip flag.
- AC-13: Tester-agent protocol update (edit `.claude/commands/tester.md`).

### Phase D — Observability + real adapters (week 4)
- AC-15: Nightly real-adapter workflow.
- AC-16, AC-17, AC-18: DER tagging + weekly report.

Each phase ships as its own PR, reviewed independently. Phase A is the highest-ROI single PR and should land first — it retroactively prevents the ChatPanel drift class forever.
