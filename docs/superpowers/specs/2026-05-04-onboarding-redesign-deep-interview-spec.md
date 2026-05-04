# Deep Interview Spec: AgentDash post-signup onboarding — assess-driven via OMC deep-interview

## Metadata
- Interview ID: 2026-05-04-onboarding-redesign-deep-interview
- Rounds: 3
- Final Ambiguity Score: 14.75%
- Type: brownfield
- Generated: 2026-05-04
- Threshold: 20%
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown

| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Goal Clarity | 0.90 | 0.35 | 0.315 |
| Constraint Clarity | 0.85 | 0.25 | 0.213 |
| Success Criteria | 0.85 | 0.25 | 0.213 |
| Context Clarity | 0.75 | 0.15 | 0.113 |
| **Total Clarity** | | | **0.853** |
| **Ambiguity** | | | **14.75%** |

## Goal

After a user signs up, route them through a multi-step onboarding: **company creation → assess (UI reused) → Socratic deep-interview powered by OMC's `deep-interview` skill running through the chosen adapter → CoS-generated `agent_plan_proposal_v1` → user confirms → agents materialize**. The deep-interview spec produced at the end of assess is the input the CoS reads to generate the plan.

## Constraints

- **Reuse the existing `/assess` UI** — wizard layout, mode chooser, streaming chat-style turn rendering, clarifying-question card, follow-up card, DOCX export. Do not build a new screen.
- **Replace the underlying engine** of `/assess` (and `/assess/project`) with OMC's deep-interview methodology — Socratic targeting of the weakest dimension, weighted ambiguity scoring (brownfield weights), ontology tracking with stability ratio, challenge-agent modes (contrarian, simplifier, ontologist) at rounds 4/6/8.
- **Install the deep-interview skill into the chosen adapter's skills directory at `agentdash setup` time** — once we know which adapter the user picked (from `AGENTDASH_DEFAULT_ADAPTER`), copy `deep-interview/SKILL.md` into the adapter's standard skills location (e.g. `~/.claude/skills/deep-interview/SKILL.md`, `~/.hermes/skills/deep-interview/SKILL.md`, `$CODEX_HOME/skills/deep-interview/SKILL.md`, plus equivalents for `gemini_local`, `claude_api`).
- **Belt-and-suspenders skill availability** — also inject the SKILL.md content into the system prompt sent through `dispatch-llm` at runtime, so the deep-interview methodology is in scope regardless of whether the adapter natively discovered the skills directory.
- **Existing `/assess/project` flow** is also migrated to deep-interview, with its own spec output (a project assessment, not a CoS plan).
- **Keep #138's CoS chat + plan-card + materialize endpoints intact** — the CoS Phase 1 goals capture step is REPLACED by reading the deep-interview spec; Phases 2 (plan presentation), 3 (revise), 4 (materialize), 5 (steady state) stay.
- **Drop the auto-create-on-signup company hook** (the orchestrator in `databaseHooks.user.create.after`). Company creation is now an explicit step driven by the user.
- **Spec persistence** — interview state (rounds, ambiguity scores, dimensions, ontology snapshots) lives in the existing `cos_onboarding_states` table (extended), so users can close the browser mid-interview and resume.
- **Adapter-agnostic** — must work with whichever of the 8 supported adapters the user picked at setup (`claude_api`, `claude_local`, `hermes_local`, `gemini_local`, `codex_local`, `opencode_local`, `acpx_local`, `cursor`).

## Non-Goals

- v1 does NOT swap the `/assess` UI's framework (still React + the existing wizard component); only the engine underneath changes.
- v1 does NOT implement plan revision (`POST /api/onboarding/revise-plan` stays a 501 stub from #138).
- v1 does NOT implement multi-language (English only).
- v1 does NOT implement voice / video onboarding.
- v1 does NOT auto-update the installed SKILL.md when OMC publishes a new version. Manual `agentdash setup` re-run picks up the latest.
- v1 does NOT support cross-adapter consistency tests (changing adapter mid-interview).
- The `/assess/project` migration is explicitly part of v1; the v1 onboarding flow above is the primary deliverable, project mode rides along.

## Acceptance Criteria

### Setup-time install
- [ ] After `agentdash setup` completes successfully, `<adapterSkillsDir>/deep-interview/SKILL.md` exists for the chosen adapter (path varies by adapter).
- [ ] On second `agentdash setup` run with same adapter, install is idempotent — no duplicate files, last-modified timestamp updated only if SKILL.md changed.
- [ ] `agentdash setup` prints a short confirmation line: `→ Deep-interview skill installed for hermes_local at ~/.hermes/skills/deep-interview/SKILL.md`.
- [ ] When the adapter is changed via `agentdash setup adapter`, the skill is installed into the new adapter's directory.

### Post-signup flow
- [ ] After Better Auth sign-up, the user is redirected to a **company creation page** (the existing UI in `WelcomePage.tsx`, extracted into a route at `/company-create` for clarity).
- [ ] `databaseHooks.user.create.after` no longer auto-bootstraps a company; the orchestrator's `bootstrap()` only fires on explicit company creation.
- [ ] Submitting the company-create form creates the company row AND creates the CoS agent (the orchestrator's existing logic, just triggered later in the flow).
- [ ] After company creation, the user is redirected to `/assess?onboarding=1` — the existing assess UI in onboarding mode.

### Deep-interview engine on `/assess` (company mode and onboarding mode)
- [ ] Each user turn through the assess UI is dispatched through `dispatch-llm.ts` to the user's chosen adapter.
- [ ] System prompt includes the OMC deep-interview SKILL.md content + a reference to the installed path.
- [ ] After every user answer, server scores ambiguity across 4 dimensions (Goal, Constraints, Success Criteria, Context) with brownfield weights and persists the scores in `cos_onboarding_states` (extended schema).
- [ ] Ontology entities are extracted each turn; stability ratio computed and persisted.
- [ ] Challenge-agent modes (contrarian / simplifier / ontologist) activate at rounds 4 / 6 / 8 by injecting the appropriate prompt fragment.
- [ ] When ambiguity ≤ 20% (or hard cap at round 20), the engine crystallizes a structured spec into a `deep_interview_specs` row attached to the conversation.

### Deep-interview engine on `/assess/project` (project mode)
- [ ] Same engine as company mode; output is a project-assessment spec (separate row type, no CoS hand-off — just downloadable as DOCX/markdown).
- [ ] Existing project intake fields (name, goal, description, sponsor) become the deep-interview's "initial idea" input.

### Hand-off to CoS
- [ ] When onboarding-mode assess completes, the SPA navigates to `/cos`.
- [ ] The CoS reads the latest deep-interview spec for the conversation as initial context — replacing the goals-capture loop from PR #138's Phase 1.
- [ ] CoS skips Phase 1 (goals capture) and goes directly to Phase 2 (plan presentation), generating an `agent_plan_proposal_v1` card from the spec.
- [ ] User clicking "Set it up" on the plan card triggers `POST /api/onboarding/confirm-plan` (existing from #138) — agents are materialized for real.

### Resume
- [ ] If the user closes the browser mid-interview and returns to `/assess?onboarding=1` later, they pick up at the next unanswered question with all prior turns still in the timeline.
- [ ] If the user re-runs `agentdash setup` and changes their adapter, the in-progress interview's prompts switch to the new adapter on the next turn (no in-place migration of past turns).

### Tests
- [ ] Unit test for the SKILL.md installer (writes to the right per-adapter path; idempotent re-run).
- [ ] Unit test for the JSON-trailer parser handling deep-interview's structured outputs (ambiguity scores, ontology entities, phase decisions).
- [ ] E2E test (Playwright) for the full happy path: signup → company-create → assess (≥3 deep-interview rounds via mocked LLM stub OR real Hermes if available) → /cos → plan card → confirm → assert agents row exists.

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|---|---|---|
| The user wants a brand-new "company readiness dashboard" page after onboarding | "What's the single visible artifact at the end?" (Round 1) | Picked option **A** — same end state as PR #138 (plan card → confirm → agents). The work in #138 is preserved, just deferred behind company-create + assess. |
| Existing `/assess` UI gets thrown out and replaced with a Socratic chat | "How much of `/assess` stays?" (Round 2) | **E** — UI reused; only the engine underneath is replaced with OMC deep-interview. |
| Deep-interview is implemented from scratch in TypeScript | "How does the engine actually run behind the chosen adapter?" (Round 3) | **D** — install the SKILL.md into the adapter's skills directory at `agentdash setup` time AND inject into the system prompt at runtime. Use the actual OMC skill, don't re-implement. |
| Each adapter gets a different deep-interview implementation | (implicit) | Single SKILL.md, copied to per-adapter paths. The methodology is one canonical document. |
| Project-mode assess is a separate concern that stays as-is | "For Assess for project, even though outside of the company onboarding flow, should also be using omc's deep-interview" (user follow-up) | Project mode also migrates to the deep-interview engine. Same engine, different spec output type. |

## Technical Context

### Existing pieces (from explore agent)

- **Company creation**: `POST /api/companies` route at `server/src/routes/companies.ts:45-225`; UI form embedded in `ui/src/pages/WelcomePage.tsx` (NOT a standalone page — extract into `/company-create` route).
- **Assess flow**: backend at `server/src/routes/assess.ts` (company mode + project mode endpoints); UI at `ui/src/pages/AssessPage.tsx`; client at `ui/src/api/assess.ts` (`runAssessment`, `research`, `getAssessment`, project variants).
- **Schemas already present**: `onboarding_sessions`, `onboarding_sources`, `company_context` for assess persistence; `cos_onboarding_states` (added in PR #138) for CoS phase tracking.
- **Routes registered**: `/onboarding` → WelcomePage, `/assess` → AssessPage, `/assess/history`, `/dashboard`, `/cos`. No `/company-create` yet — to be added.
- **CoS infrastructure (from PR #138)**: `cos-replier.ts` with phase-aware system prompt, `cos-onboarding-state` service, `agent_plan_proposal_v1` card kind in `@paperclipai/shared`, `POST /api/onboarding/confirm-plan` and stub for `/revise-plan`, UI card renderer at `AgentPlanProposal.tsx`.
- **OMC deep-interview SKILL.md**: lives at `~/.claude/plugins/cache/omc/oh-my-claudecode/4.10.2/skills/deep-interview/SKILL.md` on this dev machine; AgentDash needs to source from a versioned location bundled with the install.

### New pieces to build

- **`scripts/install-adapter-skill.ts`** (or extension of existing `install-cli.sh`): per-adapter SKILL.md installer. Maps `AGENTDASH_DEFAULT_ADAPTER` → install path. Idempotent.
- **`server/src/services/deep-interview-engine.ts`**: orchestrator that runs the Socratic loop, calls `dispatch-llm` per turn, scores ambiguity, tracks ontology, applies challenge modes, persists to `cos_onboarding_states`.
- **DB migration**: extend `cos_onboarding_states` with columns: `ambiguity_score float`, `dimension_scores jsonb`, `ontology_snapshots jsonb`, `challenge_modes_used text[]`, `deep_interview_spec_id uuid`. Plus new `deep_interview_specs` table for crystallized output.
- **`server/src/routes/assess.ts`**: replace internal LLM calls with calls into `deep-interview-engine.ts`. Keep route shapes.
- **UI**: minor — add `/company-create` route extracting WelcomePage's form; thread `?onboarding=1` query param through AssessPage to bypass mode-chooser.
- **Auth.tsx**: change post-signup redirect to `/company-create`.
- **`databaseHooks.user.create.after`**: drop the orchestrator call; user's company is created when they explicitly hit the form.

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|---|---|---|---|
| User | core domain | id, email, name | has many Companies (via membership) |
| Company | core domain | id, name, emailDomain, description | has many Users; has one CoSAgent; has one DeepInterviewSpec (onboarding) |
| AssessUI | supporting | wizard, modes (company/project) | renders DeepInterviewEngine output |
| DeepInterviewEngine | core domain | rounds, ambiguity, ontology, challenges | dispatches via dispatch-llm; produces DeepInterviewSpec |
| DeepInterviewSpec | core domain | goal, constraints, criteria, ontology, transcript | consumed by CoSAgent for plan generation |
| AdapterSkillInstall | external system | adapterType, skillPath | installed at `agentdash setup` time |
| CoSAgent | core domain | id, role=chief_of_staff, adapterType | reads DeepInterviewSpec; emits AgentPlanCard |
| AgentPlanCard | core domain | rationale, agents[], alignment | confirms via `/api/onboarding/confirm-plan` → HiredAgents |
| HiredAgents | core domain | id, role, adapterType per agent | one per row in the plan card payload |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|---|---|---|---|---|---|
| 1 | 6 | 6 | - | - | N/A |
| 2 | 8 | 2 (DeepInterviewEngine, DeepInterviewSpec) | 1 (AssessReport→AssessUI) | 5 | 0.625 |
| 3 | 9 | 1 (AdapterSkillInstall) | 0 | 8 | 0.875 |

Domain model converged.

## Interview Transcript

<details>
<summary>Full Q&A (3 rounds)</summary>

### Round 1
**Q (targeting Success Criteria, weakest at 0.30):** When the user finishes the whole sequence (signup → company create → assess → Socratic interview), what is the single visible artifact they land on? A. CoS chat with plan card / B. Dashboard with assess report / C. CoS with assessment summary AND plan card / D. New "company readiness dashboard" page / E. Other.
**A:** A
**Ambiguity after:** 37.5% (Goal 0.70, Constraints 0.40, Criteria 0.70, Context 0.70)

### Round 2
**Q (targeting Constraints at 0.40):** What does assess capture and produce? A. Reuse `/assess` company-mode as-is, CoS reads markdown report. B. New structured intake form. C. Restructure to produce both. D. Skip assess entirely, go straight to deep-interview Socratic. E. Other.
**A:** E — reuse assess UI but replace underlying engine with OMC's deep-interview skill (in whichever adapter, preinstalled at setup); spec output must be consumable by the CoS. Apply same to `/assess/project`.
**Ambiguity after:** 21% (Goal 0.85, Constraints 0.70, Criteria 0.85, Context 0.70)

### Round 3
**Q (targeting Constraints at 0.70):** How does the deep-interview engine run behind the chosen adapter? A. Server-side reimplementation. B. Inject SKILL.md into prompts. C. Install SKILL.md into adapter skills dir at setup time. D. Hybrid B + C.
**A:** Indifferent, as long as it works and gets installed during the prior `agentdash setup` step.
**Ambiguity after:** 14.75% (Goal 0.90, Constraints 0.85, Criteria 0.85, Context 0.75) — **threshold met**.

</details>
