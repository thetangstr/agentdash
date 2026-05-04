# Onboarding Redesign — Deep-Interview-Driven (Deliberate Mode Plan, Round 2)

**Plan ID:** `onboarding-redesign-deep-interview`
**Source spec:** `docs/superpowers/specs/2026-05-04-onboarding-redesign-deep-interview-spec.md`
**Mode:** DELIBERATE (auth path + DB migration + drops a live `databaseHooks.user.create.after` hook in `authenticated` deployment mode)
**Date:** 2026-05-03 (Round 2 revision)
**Round 1 verdicts:** Architect = ENDORSE_WITH_CHANGES; Critic = ITERATE
**This revision:** Eight required changes addressed below. ADR + Pre-mortem + Test plan updated.

---

## 1. RALPLAN-DR Summary

### Principles (5)

1. **Reuse, don't rebuild.** The `/assess` UI, `cos_onboarding_states`, `agent_plan_proposal_v1` card, `/confirm-plan` endpoint, and `dispatch-llm.ts` are already shipped. We swap the engine, not the substrate.
2. **One canonical SKILL.md, two prompt depths.** A single bundled methodology corpus is the source of truth. We inject it into the runtime system prompt at one of two depths chosen per adapter (see Decision C). We do **not** vendor the file as an asset (Decision A); we do **not** rely on per-adapter `~/.<adapter>/skills/` for correctness (Decision B).
3. **Runtime inject is the only correctness path.** Per-adapter skill installation is decorative — most adapters either fall back to `claude_api` (4 of 8) or skip discovery entirely (`cursor`, `claude_api`). The engine works because the prompt contains the methodology, not because a file is on disk.
4. **Resumable by construction.** Every turn persists ambiguity scores, ontology snapshots, dimension scores, and the next planned challenge mode in DB before responding. The engine is stateless; the row is the truth. Single transaction at crystallization.
5. **Brownfield safety.** The drop of `opts.onUserCreated` (in the `authenticated` deployment branch only) lands behind `AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP=true` for one release window. `local_trusted` mode is **explicitly out of scope** because `server/src/index.ts:486-488` short-circuits before `createBetterAuthInstance` is called — that code path is untouched by this plan.

### Decision Drivers (top 3)

1. **User can resume mid-interview.** Round-by-round state must round-trip cleanly through the DB; the engine is stateless, the row is the truth.
2. **Same engine for `/assess` company-mode and `/assess/project`-mode.** One `deep-interview-engine.ts` services both routes; the only difference is the spec output type and downstream consumer (CoS plan vs. DOCX export).
3. **Cost / latency budget under the spawn-adapter constraint.** Three of the wired adapters (`hermes_local`, `claude_local`, plus future `gemini_local`) are spawn-based with no API-level prompt caching (verified: only `anthropic-llm.ts:41` uses `cache_control: ephemeral`). Sending 16.7k SKILL.md tokens × 8+ turns through `argv` is operationally untenable. Prompt depth must be adapter-aware.

### Viable Options

#### Decision A: SKILL.md packaging — TS string constant (recommended) vs. file bundle (rejected)

| Option | Pros | Cons |
|---|---|---|
| **A1. (REJECTED) Bundle as `.md` file** at `packages/cli/skills/deep-interview/SKILL.md`, copy into `dist/` at build. | Humans can `diff` the upstream OMC copy against the bundled copy easily; no string-escaping. | **`cli/esbuild.config.mjs` has no asset-copy step and no `.md` loader (verified).** Asset would be silently stripped from the published bundle. Adding an esbuild copy plugin is extra surface; missing it once and Railway deploys silently regress. |
| **A2. (RECOMMENDED) Embed as TS string constant** at `packages/shared/src/deep-interview-skill.ts` with a sync script `scripts/sync-skill-md.mjs` that reads from `~/.claude/plugins/cache/omc/oh-my-claudecode/<pinned-version>/skills/deep-interview/SKILL.md` and rewrites the TS file. CI guard: `git diff --exit-code packages/shared/src/deep-interview-skill.ts` after running the sync to fail PRs that drift from upstream. | No build-time asset shipping; works identically in dev / `pnpm build` / Docker / Railway / Vercel; trivially injectable into prompts; the sync script is checked-in source so the build contract is explicit. | Round-tripping a 668-line markdown file as a TS template literal is ugly (escaped backticks if any). Sync script becomes part of `pnpm release` workflow. Two pinned constants ship: `SKILL_MD_FULL` and `SKILL_MD_SUMMARY` (see Decision C). |

**Recommendation: A2.** Rationale: the build pipeline does not currently ship non-.ts assets; the antithesis from Architect ("don't vendor SKILL.md, build a 150-line TS engine inspired by it") is partially honored — we DO embed the methodology as a string, but we keep the file as the canonical source via the sync script, so we get the antithesis's build-pipeline robustness without abandoning the OMC methodology corpus.

**Pin upstream version explicitly.** The Mac mini has both `4.10.2` and `4.13.5` cached. The sync script reads `OMC_SKILL_VERSION=4.13.5` (default; bumpable) — never "latest." Documented in `scripts/sync-skill-md.mjs` header.

#### Decision B: Schema — extend `cos_onboarding_states` vs. new `deep_interview_states` table

| Option | Pros | Cons |
|---|---|---|
| **B1. Extend `cos_onboarding_states`** (add `ambiguity_score`, `dimension_scores jsonb`, `ontology_snapshots jsonb`, `challenge_modes_used text[]`, `deep_interview_spec_id uuid`); add new `deep_interview_specs`. | One row per CoS conversation, atomic with phase tracking; matches spec wording. | `/assess/project` has no `assistantConversations` row to FK against — would need synthetic conversation OR nullable `conversation_id` (PK break). |
| **B2. (RECOMMENDED) New `deep_interview_states` table** keyed on `(scope, scopeId)` where scope is `"cos_onboarding" \| "assess_company" \| "assess_project"` and `scopeId` references the matching parent row; plus `deep_interview_specs` for the crystallized output. Keep `cos_onboarding_states` as-is (only add `deep_interview_spec_id` FK). | Project-mode has no conversation, fits naturally; engine code is conversation-agnostic; cleaner separation from CoS phase machine. | Extra table; CoS Phase 2 must `JOIN` (or follow FK on `cos_onboarding_states.deep_interview_spec_id`). |

**Recommendation: B2.** Architect endorsed in Round 1. Critic concurred. Spec deviation (spec line 37) explicitly documented in ADR.

#### Decision C: **(NEW)** Adapter prompt-depth policy — `selectPromptDepth(adapter)`

Critic surfaced: only `claude_api` uses `cache_control: ephemeral` (`anthropic-llm.ts:41` verified). Spawn adapters (`hermes_local`, `claude_local`, future `gemini_local`/`codex_local`) flatten the system prompt into `argv` via `buildFlatPrompt` (verified `dispatch-llm.ts:75-89`). Sending 16.7k tokens × 8 turns = 133.6k tokens uncached, plus argv length risk on local shells.

| Option | Pros | Cons |
|---|---|---|
| **C1. (RECOMMENDED) `selectPromptDepth(adapter)` returns `"full"` or `"summary"`.** `claude_api` → `SKILL_MD_FULL` (~16.7k tokens, cached via `cache_control: ephemeral`). All other adapters (spawn-based or unknown) → `SKILL_MD_SUMMARY` (~150-line methodology distillation, ~3-4k tokens, fits comfortably in argv). Both constants in `packages/shared/src/deep-interview-skill.ts`. | Cost / latency stays bounded for spawn adapters; full methodology still available where caching offsets the size. | Two corpuses to maintain. The summary is a hand-curated distillation that the sync script regenerates by extracting the "Methodology Summary" section of the SKILL.md (the file already has one near the top). If the upstream summary section moves, sync fails loudly. |
| **C2. Always inject full SKILL.md.** | One corpus. | 133k+ tokens per interview on Hermes; argv length risk; cost. Rejected. |
| **C3. Always inject summary.** | Bounded cost. | Loses the full methodology even where caching makes it free. Rejected. |

**Recommendation: C1.** Add `selectPromptDepth(adapter: AgentAdapterType): "full" | "summary"` to `deep-interview-prompts.ts`. Promote to **Phase C HARD acceptance criterion**: assert `claude_api` uses `SKILL_MD_FULL` and any spawn adapter uses `SKILL_MD_SUMMARY` (mocked-adapter unit test).

#### Decision D: **(NEW)** Phase rollout — combine D + F vs. flag-gated D

Critic surfaced: shipping Phase D (engine wired into `/assess`) before Phase F (CoS reads spec) creates a 2-week window where `/assess` produces specs nothing reads. The Free-tier Stripe trial onboarding flow regresses for that window.

| Option | Pros | Cons |
|---|---|---|
| **D1. Combine D + F into a single PR.** | No degraded window; ship the whole flow once. | Larger PR; harder to review; harder to revert F without reverting D. |
| **D2. (RECOMMENDED) Flag-gate Phase D under `AGENTDASH_DEEP_INTERVIEW_ASSESS=true` (default off).** Phase D ships dark — engine wired but unreachable in production. Phase F flips the default to `true` and removes the gate two weeks later. | Each phase reviewable independently; rollback is `unset AGENTDASH_DEEP_INTERVIEW_ASSESS`; matches the existing brownfield-safety pattern (`AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP`). | Two flags in flight simultaneously for one release window. Tracked in follow-ups for removal. |

**Recommendation: D2.** Justification: PRs stay reviewable; each phase is independently shippable; rollback is one env var. The two simultaneous flags both have explicit removal-after-stable-week 2 follow-ups.

### Invalidation rationale

- Decision A: a third option ("download SKILL.md from OMC GitHub at runtime") is rejected — adds network dependency to onboarding, breaks airgapped deploys.
- Decision B: a third option ("inline state into `assistantMessages.metadata`") is rejected — scatters state across rows, makes resume queries `O(N)` on message count.
- Decision C: see C2 / C3 rejection rationale above.
- Decision D: a third option ("ship D + F sequentially with no flag, accept the degraded window") is rejected — `/assess` is the entry point for paid trials; can't tolerate regression.

---

## 2. Pre-Mortem (4 Scenarios)

### Scenario 1: Hermes / claude_local response doesn't follow SKILL.md format strictly

**What fails:** A user picks `hermes_local` at `agentdash setup`. The deep-interview engine sends a turn, but the local model (e.g. a smaller Llama variant) returns prose without the JSON trailer the engine expects (`{"ambiguity_score": 0.3, "dimensions": {...}, "ontology_delta": [...], "next_phase": "challenge:contrarian"}`). The parser throws, the user sees a 500, the round is lost.

**Why:** SKILL.md is a *prompt*, not a contract. Smaller models or older Hermes versions may not honor structured-output instructions. The spec at line 88 calls for a JSON-trailer parser — the parser exists, but the producer is fallible.

**Mitigation:**
- Engine emits a strict response contract in the *user* prompt suffix on every turn (`Reply in plain English to the user, then on a new line emit JSON with keys: ambiguity_score, dimensions, ontology_delta, next_phase, action`).
- If parsing fails, the engine **retries once** with a cleanup turn (`"Your last response was missing the JSON trailer. Re-emit the trailer now, no prose."`). After a second failure, fall back to a deterministic in-process scorer (heuristic counting of question-marks, named entities, constraint keywords) — degraded but not broken.
- Log every parse failure with `adapter`, `round`, `raw_response_first_500_chars` for adapter-quality dashboards.
- Add a `dispatch-llm` smoke-test step to `agentdash setup` that runs one canned deep-interview turn against the chosen adapter and verifies trailer parsing — print a warning at install time, not at first user turn.

### Scenario 2: User loses session mid-interview, session cookie expires

**What fails:** User completes 6 rounds at home, browser closes, comes back the next day. Better-Auth session expired (default 7 days but they may be in incognito). They sign in again and land on `/assess?onboarding=1`. Their old `deep_interview_states` row is keyed on the old `userId`+`companyId`. They see an empty interview and start over, losing 6 rounds.

**Why:** State is keyed on `(scope, scopeId)` where scope=`cos_onboarding` and scopeId=`conversationId`. If the auth session is fresh-bound to a new browser tab, the *user* is the same but the in-flight conversation isn't surfaced.

**Mitigation:**
- On `/assess?onboarding=1` mount, the SPA calls `GET /api/onboarding/in-progress` → `{ conversationId, lastRound, ambiguity, transcript }` for the user's *most-recent unfinished* deep-interview state row. If found, the UI hydrates the wizard with prior turns and resumes at `lastRound + 1`.
- Add a `resumeToken uuid not null default gen_random_uuid()` column to `deep_interview_states`. The SPA stashes it in `localStorage` (`agentdash.onboarding.resumeToken`). On signback, the token unambiguously identifies the row.
- E2E test: signup → 3 rounds → clear session cookie → sign back in → assert wizard resumes at round 4 with prior 3 turns visible.
- TTL on resume: if `deep_interview_states.updated_at > 30 days`, ignore and start fresh with a UI notice.

### Scenario 3: **(REWRITTEN)** Invite-path bootstrap orphans new teammates after the auth-hook drop

**Original Round 1 framing (REMOVED):** "drop-hook strands `local_trusted` bootstrap."
**Why removed:** verified that `server/src/index.ts:486-488` short-circuits to `ensureLocalTrustedBoardPrincipal(db)` BEFORE the `authenticated` branch where `onUserCreated` is wired. `local_trusted` never reaches the auth hook. The original mitigation was solving a non-existent problem.

**Real risk (NEW):** A user accepts an invite to a workspace via Better-Auth signup. The auth-hook drop means signup no longer auto-bootstraps a workspace for them — but they're an *invitee*, so they shouldn't get a fresh workspace; they should join the inviter's. The flow that picks this up is `POST /api/onboarding/bootstrap` at `server/src/routes/onboarding-v2.ts:57`, which calls `orch.bootstrap(req.actor.userId)` directly. That endpoint is **already** independent of the auth hook (verified). So the legitimate concern is a different one:

**What fails:** invitee signs up, the auth-hook is gone, they land at `/company-create` (Phase E behavior). But they're already a member of a workspace via an invite. The Phase E redirect logic must check membership BEFORE redirecting to `/company-create`. If it doesn't, the invitee creates a duplicate workspace and orphans the invite.

**Why:** Better-Auth signup may fire BEFORE the invite-claim handshake. Membership-on-first-mount must be the gate, not "did I just sign up."

**Mitigation:**
- `ui/src/lib/onboarding-route.ts` redirect logic: companyless → `/company-create` ONLY when no pending-invite cookie / membership row exists. Existing membership-check helper (`shouldRedirectCompanylessRouteToOnboarding`) is the right hook.
- Server-side hardening: `POST /api/companies` (the create-company endpoint that `/company-create` calls) returns 409 if the user is already a member of any company — UI catches and routes to `/cos`.
- E2E test: simulate invite-then-signup flow; assert invitee lands at `/cos` of the inviter's workspace, NOT `/company-create`.
- Confirm `bootstrap()` remains callable from `onboarding-v2.ts:57` post-Phase-E (it is — the route owns its own call site, the hook drop is unrelated).
- Out-of-scope, documented: `local_trusted` flow (`AGENTDASH_BOOTSTRAP_EMAIL`) is **untouched** by Phase E. The ensureLocalTrustedBoardPrincipal path lives in a different deployment-mode branch. No regression risk; no test gate needed here. (A one-line E2E "boot in `local_trusted` and land at /cos" is included as belt-and-suspenders.)

### Scenario 4: **(NEW)** Token budget on spawn adapters — argv overflow / cost spike

**What fails:** Without `selectPromptDepth`, every turn ships `SKILL_MD_FULL` (~16.7k tokens) through `buildFlatPrompt` → `argv` for `hermes_local` / `claude_local`. Across 8 rounds × 16.7k = 133.6k tokens with no prefix caching (only `anthropic-llm.ts:41` uses `cache_control: ephemeral`). Cost spike for users on Hermes; argv length risk on user shells with low `ARG_MAX` (Linux default 128KB; macOS 256KB — 16k tokens ≈ 64KB ASCII so close to limit if the conversation grows).

**Why:** Verified: `dispatch-llm.ts:108-140` flattens via `buildFlatPrompt`. No API-level cache. The full SKILL.md is methodology + examples; the methodology alone (~150 lines) is enough for prompt-time reasoning when the model is sufficient.

**Mitigation:**
- Decision C: `selectPromptDepth(adapter)` returns `"full"` for `claude_api`; `"summary"` for `hermes_local` / `claude_local` / `gemini_local` / `codex_local` / unknown adapters.
- Both `SKILL_MD_FULL` and `SKILL_MD_SUMMARY` ship as constants in `packages/shared/src/deep-interview-skill.ts`. Sync script generates both from the upstream SKILL.md (full = whole file; summary = the "Methodology Summary" section that already exists in the OMC SKILL.md, plus the JSON-trailer contract).
- Phase G test: capture `tokens_in` for one stub-LLM run on `claude_api` (full) and one on `hermes_local` (summary); assert `hermes_local_tokens_in <= 0.30 * claude_api_tokens_in`.
- Observability: log `selected_prompt_depth` on every turn so operators can verify in production.

---

## 3. Implementation Phases (7 Ship-able PRs)

Each phase compiles, type-checks, and passes its own tests independently. PR titles use AgentDash MAW conventions (`AGE-NNN: <title>`).

### Phase A — Bundle SKILL.md as TS constants + (optional) best-effort claude_local file drop

**Goal:** `packages/shared/src/deep-interview-skill.ts` exports `SKILL_MD_FULL` and `SKILL_MD_SUMMARY` as TS template-literal constants, kept in sync with the upstream OMC SKILL.md by a checked-in script. Optional best-effort file drop for `claude_local` only (decorative, flagged).

**Files:**
- *new* `packages/shared/src/deep-interview-skill.ts` — exports both constants. Generated, not hand-edited:
  ```ts
  // GENERATED FROM ~/.claude/plugins/cache/omc/oh-my-claudecode/<OMC_SKILL_VERSION>/skills/deep-interview/SKILL.md
  // Run `pnpm sync-skill-md` to regenerate. Do not hand-edit.
  // Pinned upstream version: 4.13.5
  export const SKILL_MD_FULL = `…668 lines as a template literal…`;
  export const SKILL_MD_SUMMARY = `…~150 lines distilled to methodology + JSON contract…`;
  export const SKILL_MD_SOURCE_VERSION = "4.13.5";
  ```
- *new* `scripts/sync-skill-md.mjs` — reads `~/.claude/plugins/cache/omc/oh-my-claudecode/${OMC_SKILL_VERSION}/skills/deep-interview/SKILL.md`, slices the "Methodology Summary" section (the file already has one near the top — confirmed during planning), writes the TS file. Default `OMC_SKILL_VERSION=4.13.5`. Fails loudly if the cache path or summary section is missing.
- *new* `package.json` script (root): `"sync-skill-md": "node scripts/sync-skill-md.mjs"`.
- *new* CI step (in `.github/workflows/*` or equivalent): run `pnpm sync-skill-md && git diff --exit-code packages/shared/src/deep-interview-skill.ts` — fails the PR if a contributor edited the constant by hand or upstream drifted unsynced.
- *modify* `cli/src/commands/setup.ts:304-316` — ONLY for `claude_local` and ONLY when `AGENTDASH_INSTALL_SKILL_FILE=true` (default false), best-effort write the SKILL.md to `~/.claude/skills/deep-interview/SKILL.md`. No type changes; no per-adapter installer; no path map. Runtime-inject is the contract; this is decorative observability for users browsing `~/.claude/skills/`.
- *new* `cli/src/utils/__tests__/maybe-install-claude-local-skill.test.ts` — golden test for the best-effort file drop: writes, idempotent on re-run, no-ops when flag is unset.

**Adapter strategy table (REVISED — install is no longer load-bearing):**

| `AgentAdapterType` | Runtime prompt-depth (Decision C) | File drop |
|---|---|---|
| `claude_api` | `SKILL_MD_FULL` (cached via `cache_control`) | none — pure API |
| `claude_local` | `SKILL_MD_SUMMARY` | best-effort `~/.claude/skills/deep-interview/SKILL.md` when `AGENTDASH_INSTALL_SKILL_FILE=true` |
| `hermes_local` | `SKILL_MD_SUMMARY` | none — falls through to `claude_api` if dispatch fails (verified `dispatch-llm.ts:124`) |
| `cursor` | `SKILL_MD_SUMMARY` | none — desktop app, no skills dir |
| `codex_local` | `SKILL_MD_SUMMARY` (also currently falls back to `claude_api` per `dispatch-llm.ts:142-146`) | none |
| `gemini_local` | `SKILL_MD_SUMMARY` (also currently falls back) | none |
| `opencode_local` | `SKILL_MD_SUMMARY` (also currently falls back) | none |
| `acpx_local` | `SKILL_MD_SUMMARY` (also currently falls back) | none |

**Acceptance criteria:**
1. `pnpm sync-skill-md` against the pinned `4.13.5` SKILL.md regenerates `packages/shared/src/deep-interview-skill.ts` with both constants populated.
2. `git diff --exit-code packages/shared/src/deep-interview-skill.ts` after sync is empty (CI gate).
3. `import { SKILL_MD_FULL, SKILL_MD_SUMMARY } from "@agentdash/shared/deep-interview-skill"` works from `server/src/services/`.
4. `pnpm build` produces a published `cli/dist/` that does NOT depend on any non-`.ts` asset for the deep-interview path (verify with `tar tf cli-*.tgz | grep -v ".ts" | grep -v ".js" | grep skill` returns empty or only the optional file-drop fixture).
5. With `AGENTDASH_INSTALL_SKILL_FILE=true` and adapter=`claude_local`, `agentdash setup` writes `~/.claude/skills/deep-interview/SKILL.md` and prints `→ Deep-interview skill installed for claude_local at <path>`. Idempotent on re-run.
6. With the flag unset (default), `agentdash setup` is silent on the file drop and the engine still works (verified by Phase G E2E).

**A.0 (PREREQUISITE — REFRAMED as documentation/discoverability, NOT type-safety unblocking):**
Audit `AGENT_ADAPTER_TYPES` (`packages/shared/src/constants.ts:30`). Note: `AgentAdapterType` is already defined as `(typeof AGENT_ADAPTER_TYPES)[number] | (string & {})` (line 42 verified) — meaning the type already accepts arbitrary strings. Adding `claude_api` and `hermes_local` to the const is purely for discoverability (autocomplete, exhaustive-switch hints) and not required for type-safety. Grep for exhaustive switch statements over the const to confirm no call site assumes closure (none found in current pass; verify before merge). **A.0 is a 1-line constants change, not a blocker.**

**Risks:**
- The OMC SKILL.md doesn't have a clearly-marked "Methodology Summary" section, so the sync script's slicing heuristic fails. Mitigation: sync script supports a fallback `SKILL_MD_SUMMARY_PATH=…` env var that reads a hand-curated summary file checked in at `scripts/skill-md-summary-fallback.md`. Fail loudly with instructions if both paths fail.
- Two pinned SKILL.md versions on the dev machine (4.10.2, 4.13.5). The script always reads `OMC_SKILL_VERSION=4.13.5` — never "latest." Documented in the script header and CI.

---

### Phase B — Schema migration

**Goal:** add tables/columns for deep-interview state and crystallized specs.

**Files:**
- *new* `packages/db/src/schema/deep_interview_states.ts`:
  ```ts
  export const DI_SCOPES = ["cos_onboarding", "assess_company", "assess_project"] as const;
  export type DeepInterviewScope = (typeof DI_SCOPES)[number];

  export const deepInterviewStates = pgTable("deep_interview_states", {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),               // DeepInterviewScope
    scopeId: uuid("scope_id").notNull(),          // conversationId | onboardingSessionId | projectAssessmentId
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    round: integer("round").notNull().default(0),
    ambiguityScore: doublePrecision("ambiguity_score").notNull().default(1.0),
    dimensionScores: jsonb("dimension_scores").$type<DimensionScores>().notNull().default({}),
    ontologySnapshots: jsonb("ontology_snapshots").$type<OntologySnapshot[]>().notNull().default([]),
    challengeModesUsed: text("challenge_modes_used").array().notNull().default(sql`ARRAY[]::text[]`),
    transcript: jsonb("transcript").$type<TranscriptTurn[]>().notNull().default([]),  // engine cache, see "Transcript source-of-truth" below
    deepInterviewSpecId: uuid("deep_interview_spec_id").references(() => deepInterviewSpecs.id, { onDelete: "set null" }),
    resumeToken: uuid("resume_token").notNull().defaultRandom(),
    status: text("status").notNull().default("in_progress"),  // "in_progress" | "crystallized" | "abandoned"
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }, (t) => [
    index("dis_scope_idx").on(t.scope, t.scopeId),
    index("dis_company_user_idx").on(t.companyId, t.userId),
    uniqueIndex("dis_resume_token_idx").on(t.resumeToken),
  ]);
  ```
- *new* `packages/db/src/schema/deep_interview_specs.ts`:
  ```ts
  export const deepInterviewSpecs = pgTable("deep_interview_specs", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    finalAmbiguity: doublePrecision("final_ambiguity").notNull(),
    goal: text("goal").notNull(),
    constraints: jsonb("constraints").notNull().default([]),
    successCriteria: jsonb("success_criteria").notNull().default([]),
    ontology: jsonb("ontology").notNull().default([]),
    transcript: jsonb("transcript").notNull().default([]),  // FROZEN snapshot at crystallization, see "Transcript source-of-truth"
    rawMarkdown: text("raw_markdown").notNull(),            // for DOCX export
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  }, (t) => [
    index("dis_specs_company_idx").on(t.companyId),
  ]);
  ```
- *modify* `packages/db/src/schema/index.ts` — export both new tables.
- *new* migration file in `packages/db/src/migrations/` — generated by `pnpm db:generate` (Drizzle picks the next sequence number; current latest is `0078_pretty_solo.sql` so the next will be `0079_*`; **do NOT hard-code a number** in the plan — let the generator pick it at execution time).
- *modify* `packages/db/src/schema/cos_onboarding_states.ts` — add column `deepInterviewSpecId uuid references deep_interview_specs(id) on delete set null`.

**Transcript source-of-truth contract:**
- **Canonical** (the timeline): `assistantMessages` rows for the conversation. Read by UI; never lossy.
- **Engine cache** (denormalized for per-turn speed): `deep_interview_states.transcript` JSONB. Rebuilt from `assistantMessages` on resume to keep them in sync. Engine reads this on every turn; if missing, falls back to a `SELECT … ORDER BY created_at` from `assistantMessages`.
- **Frozen export** (snapshot): `deep_interview_specs.transcript` JSONB. Written ONCE at crystallization; immutable thereafter. Used for DOCX export and audit.

**Key types** (in `packages/shared/src/deep-interview.ts`):

```ts
export interface DimensionScores {
  goal: number;          // 0..1
  constraints: number;
  criteria: number;
  context: number;
}

export interface OntologyEntity {
  name: string;
  type: "core_domain" | "supporting" | "external_system";
  fields?: string[];
  relationships?: string[];
}

export interface OntologySnapshot {
  round: number;
  entities: OntologyEntity[];
  newCount: number;
  changedCount: number;
  stableCount: number;
  stabilityRatio: number;
}

export type ChallengeMode = "contrarian" | "simplifier" | "ontologist";

export interface TranscriptTurn {
  round: number;
  question: string;
  targetDimension: keyof DimensionScores;
  answer: string;
  ambiguityAfter: number;
  challengeMode?: ChallengeMode;
}
```

**Acceptance criteria:**
1. `pnpm db:generate` produces a migration that applies cleanly to a fresh DB (sequence number is auto-picked).
2. `pnpm db:migrate` applied twice is a no-op the second time.
3. `pnpm -r typecheck` passes.
4. `packages/db/src/schema/index.ts` exports the new tables.
5. New tables exist on the live Mac mini DB after `pnpm db:migrate`.

---

### Phase C — Deep-interview engine (server-side)

**Goal:** `server/src/services/deep-interview-engine.ts` runs the Socratic loop, scores ambiguity, tracks ontology, picks challenge modes, persists per-turn, dispatches via `dispatch-llm` with adapter-aware prompt depth.

**Files:**
- *new* `server/src/services/deep-interview-engine.ts`:
  ```ts
  export interface DeepInterviewEngine {
    startOrResume(input: { scope: DeepInterviewScope; scopeId: string; userId: string; companyId: string; initialIdea: string; adapter: AgentAdapterType }): Promise<DeepInterviewState>;
    submitTurn(stateId: string, answer: string): Promise<TurnResult>;
    crystallize(stateId: string): Promise<DeepInterviewSpec>;
  }
  ```
- *new* `server/src/services/deep-interview-parser.ts` — JSON-trailer parser; one-retry-on-malformed strategy from Pre-mortem #1.
- *new* `server/src/services/deep-interview-prompts.ts` — composes system prompt = `<selectPromptDepth(adapter) === "full" ? SKILL_MD_FULL : SKILL_MD_SUMMARY> + <scope-specific framing> + <round-specific challenge-mode fragment>`. Imports both constants from `@agentdash/shared/deep-interview-skill`. **`selectPromptDepth(adapter: AgentAdapterType): "full" | "summary"` is exported and unit-tested.** Challenge fragments fire at rounds 4 (contrarian), 6 (simplifier), 8 (ontologist). Brownfield weights (Goal 35% / Constraints 25% / Criteria 25% / Context 15%) baked into scoring instructions.
- *new* `server/src/services/__tests__/deep-interview-engine.test.ts` — uses a stub LLM that returns canned responses with valid JSON trailers; asserts state machine transitions, ambiguity scoring, ontology stability, challenge-mode firing, **and that the system prompt ships `SKILL_MD_FULL` for `claude_api` and `SKILL_MD_SUMMARY` for `hermes_local`** (token-budget invariant).
- *new* `server/src/services/__tests__/deep-interview-parser.test.ts` — golden tests for valid/malformed/missing trailers; one-retry path; deterministic-fallback path.
- *new* `server/src/services/__tests__/deep-interview-prompts.test.ts` — `selectPromptDepth(adapter)` returns the right depth for each `AgentAdapterType`; default unknown-adapter is `"summary"`.

**Key types** (in addition to those from Phase B):

```ts
export interface LLMResponseTrailer {
  ambiguity_score: number;
  dimensions: DimensionScores;
  ontology_delta: OntologyEntity[];
  next_phase: "continue" | "crystallize" | "challenge:contrarian" | "challenge:simplifier" | "challenge:ontologist";
  action?: "ask_next" | "force_crystallize";
}
```

**Acceptance criteria:**
1. `submitTurn` against a stub LLM dispatches through `dispatch-llm.ts`, persists per-turn state, returns parsed `TurnResult` in <50ms (excluding LLM call).
2. After 3 successful turns, JSON-trailer parser called 3 times, no fallback path triggered.
3. Forcing a malformed response triggers retry; two malformed responses triggers deterministic fallback; both covered by tests.
4. Challenge mode `contrarian` is injected exactly when `state.round` transitions 3→4 with no prior contrarian; verified by spying on `composePrompt`.
5. When `ambiguity_score ≤ 0.20`, `crystallizedSpec` is non-null and a `deep_interview_specs` row exists.
6. Hard cap: `round=20` crystallizes regardless of ambiguity.
7. **(NEW HARD GATE)** `composePrompt({ adapter: "claude_api" })` system prompt contains `SKILL_MD_FULL`; `composePrompt({ adapter: "hermes_local" })` contains `SKILL_MD_SUMMARY` (string-equality assertion in unit test).

**Risks:** prompt token budget — addressed by Decision C / `selectPromptDepth`.

---

### Phase D — Wire engine into `/assess` (company + project) — flag-gated dark ship

**Goal:** existing `/assess` and `/assess/project` route shapes preserved, but underlying LLM calls go through `deep-interview-engine.ts` **only when `AGENTDASH_DEEP_INTERVIEW_ASSESS=true`** (default off). UI shape unchanged.

**Files:**
- *modify* `server/src/routes/assess.ts` — wrap engine swap in `if (process.env.AGENTDASH_DEEP_INTERVIEW_ASSESS === "true") { /* engine path */ } else { /* legacy anthropic-llm path */ }`. Both paths return the same response shape. Default OFF.
- *modify* `server/src/routes/assess-project.ts` (and `server/src/services/assess-project.ts`) — same flag-gated swap.
- *modify* `server/src/services/assess-prompts.ts` and `server/src/services/assess-project-prompts.ts` — left as-is for now; deletion deferred to follow-ups after `AGENTDASH_DEEP_INTERVIEW_ASSESS` becomes default-true.
- *new* `GET /api/onboarding/in-progress` route — returns the user's most recent `in_progress` deep-interview state for resume.
- *minor* `ui/src/api/assess.ts` — add `getInProgressInterview()`.
- *minor* `ui/src/pages/AssessPage.tsx` — when `?onboarding=1`, skip mode-chooser and call `getInProgressInterview()`.

**Phase D rollout strategy (Decision D2):**
- Phase D ships dark: `AGENTDASH_DEEP_INTERVIEW_ASSESS=false` everywhere by default. Phase D PR includes integration tests that pin the flag to `true` so the engine path is exercised in CI even though prod traffic stays on legacy.
- Phase F (later) flips the default to `true` AND removes the `false` branch in the same PR. Two-week stable window after that, then the flag itself is removed.

**Acceptance criteria:**
1. With `AGENTDASH_DEEP_INTERVIEW_ASSESS=true` (CI/test), existing `/assess` Playwright smoke passes — UI shape preserved.
2. With the flag unset (default), `/assess` behavior is byte-identical to pre-PR (no behavioral change in prod after this PR alone).
3. New unit test (flag forced on): `runAssessment` with stub LLM through 3 turns; assert `deep_interview_states.round = 3`.
4. `/assess/project` (flag forced on) produces a `deep_interview_specs` row with `scope='assess_project'`.
5. `?onboarding=1` query param hides the mode-chooser and auto-starts company-mode interview.
6. Resume: posting a turn, killing the request mid-stream, reloading, and posting another turn does not lose the prior turn (verified via DB row inspection).

---

### Phase E — Auth chain rewire: drop `onUserCreated` (authenticated-mode only), add `/company-create`, redirect chain

**Goal:** signup → `/company-create` (extracted form) → `/assess?onboarding=1` → `/cos`. The `databaseHooks.user.create.after` no longer auto-bootstraps a company **in `authenticated` deployment mode only**. `local_trusted` mode is untouched.

**Scope clarification (REVISED):**
- `server/src/index.ts:486-488` short-circuits `local_trusted` deployments via `ensureLocalTrustedBoardPrincipal` BEFORE `createBetterAuthInstance` is called (line 521-547). Therefore the auth-hook drop only affects `authenticated` mode. `local_trusted` is **explicitly out of scope** for this phase.
- Flag rename: `AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP` (was `AGENTDASH_LEGACY_AUTOBOOTSTRAP` in Round 1) — the `_AUTH_` infix makes the scope unambiguous.

**Files:**
- *modify* `server/src/index.ts:521-547` — gate the `onUserCreated` block: `if (process.env.AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP === "true") { /* legacy: pass onUserCreated */ } else { /* v2: pass undefined */ }`. Log `[auth] auto-bootstrap on signup is disabled (v2 flow)` once at boot when in v2 mode.
- *new* `ui/src/pages/CompanyCreatePage.tsx` — extracted from `OnboardingWizard.tsx:392` (the `handleStep1Next` flow that calls `companiesApi.create`). Same form, same `POST /api/companies` call, same validation. On success: `navigate('/assess?onboarding=1', { replace: true })`. Note: the current implementation lives in `OnboardingWizard.tsx`, NOT a `WelcomePage.tsx` (which does not exist in the repo — verified).
- *modify* `ui/src/components/OnboardingWizard.tsx` — extract the company-create step into the new page; the wizard either delegates to the new page for step 1 OR is bypassed entirely for new signups (decision documented in the PR; existing returning-user flows that use the wizard's later steps are preserved).
- *modify* `ui/src/App.tsx` — add `<Route path="/company-create" element={<CompanyCreatePage />} />` outside the `boardRoutes()` block (user has no company yet at this point).
- *modify* `ui/src/pages/Auth.tsx:65-67` — change `nextPath` default from `/cos`-or-equivalent to `/company-create` for fresh signups; if user already has a company (returning user), keep existing redirect.
- *modify* `ui/src/lib/onboarding-route.ts` — `shouldRedirectCompanylessRouteToOnboarding` redirects companyless users to `/company-create`, with **explicit invitee guard** (Pre-mortem #3 mitigation): if the user has any company membership row, never redirect to `/company-create` — go straight to `/cos` of the inviter's workspace.
- *modify* `server/src/routes/companies.ts` (the `POST /api/companies` handler) — return 409 if the user is already a member of any company. UI catches the 409 and routes to `/cos`.

**Acceptance criteria:**
1. `grep "onUserCreated" server/src/index.ts` shows the call is gated behind `AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP`.
2. Fresh signup (Playwright, `authenticated` deployment): email/password → land on `/company-create`.
3. Submitting `/company-create` form → `/assess?onboarding=1` with the wizard already in onboarding mode.
4. Existing user signin path: still lands on the same default destination (no regression).
5. **Invite-flow regression test (Pre-mortem #3):** simulate invite-then-signup; assert invitee lands at `/cos` of the inviter's workspace, NOT `/company-create`. Backed by the `POST /api/companies` 409 server-side guard.
6. **`local_trusted` belt-and-suspenders:** cold-start `pnpm dev` with `AGENTDASH_BOOTSTRAP_EMAIL=test@example.com` set; assert local-trusted user lands on `/cos` directly (this code path is untouched by Phase E; the test exists to confirm we didn't accidentally cross-wire).

**Risks:** Better-Auth client-side redirect logic may have multiple call sites (signup form, magic-link, OAuth). Audit `ui/src/pages/Auth.tsx` and any post-auth router guards.

---

### Phase F — CoS reads spec, skips Phase 1; flips Phase D flag

**Goal:** when `/assess` crystallizes a spec, navigation to `/cos` causes the CoS-replier to read the spec instead of running its own goals-capture loop. Phase 2 (plan presentation) generates `agent_plan_proposal_v1` from the spec. **Single-transaction crystallize-and-advance helper** stitches the two state machines.

**Files:**
- *new* `server/src/services/deep-interview-crystallize.ts` — exports `crystallizeAndAdvanceCos(db, stateId): Promise<{ specId, conversationId }>` which runs in a SINGLE Drizzle transaction:
  ```ts
  await db.transaction(async (tx) => {
    // 1. Insert deep_interview_specs row (or update if status changes)
    const spec = await tx.insert(deepInterviewSpecs).values({ ... }).returning();
    // 2. Update deep_interview_states: status='crystallized', deep_interview_spec_id=spec.id
    await tx.update(deepInterviewStates).set({ status: "crystallized", deepInterviewSpecId: spec.id }).where(eq(deepInterviewStates.id, stateId));
    // 3. Update cos_onboarding_states: deep_interview_spec_id=spec.id, phase='plan'
    //    (only when scope === 'cos_onboarding')
    if (state.scope === "cos_onboarding") {
      await tx.update(cosOnboardingStates).set({ deepInterviewSpecId: spec.id, phase: "plan" }).where(eq(cosOnboardingStates.conversationId, state.scopeId));
    }
    return { specId: spec.id, conversationId: state.scopeId };
  });
  ```
  This is the **single transition contract** between the two state machines. Replaces the current 3-write race surface.
- *modify* `server/src/services/cos-replier.ts` — new branch in the system-prompt builder: if `cos_onboarding_states.deep_interview_spec_id` is set, fetch the spec, inject summary as "user-provided context", force `phase = "plan"` (skipping `"goals"`).
- *modify* `server/src/services/cos-onboarding-state.ts` — when transitioning from missing-state to first turn, look for an existing `deep_interview_specs` row in scope `cos_onboarding` for this user/company; if found, set `phase = "plan"` directly and link the spec.
- *modify* `ui/src/pages/CoSPage.tsx` — on first mount with a fresh conversation that has a linked spec, render a synthetic "Here's what I know about your company:" message summarizing the spec, then render the auto-generated plan card.
- *modify* `server/src/routes/assess.ts` and `server/src/routes/assess-project.ts` — on `ambiguity_score <= 0.20` (or hard-cap), call `crystallizeAndAdvanceCos(db, stateId)` instead of separate writes.
- *modify* `server/src/routes/assess.ts` — **flip `AGENTDASH_DEEP_INTERVIEW_ASSESS` default to `true`** AND remove the legacy branch (the flag is now a kill-switch only). Two stable weeks after merge, the flag and the legacy `assess-prompts.ts` are deleted in a follow-up.

**Acceptance criteria:**
1. Crystallizing a spec then navigating to `/cos` produces an `agent_plan_proposal_v1` card on first turn (no goals back-and-forth).
2. The card's `rationale` references at least one constraint and one success criterion verbatim from the spec.
3. `/api/onboarding/confirm-plan` materializes agents identically to the pre-existing flow.
4. **Single-transaction guarantee:** force a DB error mid-`crystallizeAndAdvanceCos` (in a test); assert that `deep_interview_specs`, `deep_interview_states.status`, and `cos_onboarding_states.phase` all roll back together.
5. With `AGENTDASH_DEEP_INTERVIEW_ASSESS` unset post-merge, the engine path runs (default-true). Setting it to `false` re-enables legacy as a kill-switch.

**Risks:** PR `cos-replier` is fairly recent and the prompt structure is fragile. Read `cos-replier.ts` end-to-end before modifying.

---

### Phase G — E2E happy path (Playwright)

**Goal:** one `tests/e2e/onboarding-deep-interview.spec.ts` that drives the full flow against a stub LLM (deterministic) and an assertion that the same flow works against real Hermes on the Mac mini (`maxiaoer@192.168.86.45`) when `E2E_HERMES=1`.

**Files:**
- *new* `tests/e2e/onboarding-deep-interview.spec.ts`:
  - Persona: "Chris CTO" — signs up, names company "Chris's Robotics", picks 3 deep-interview answers from a canned set, sees plan card with at least 2 agents (CoS + one role), confirms, asserts agents row exists.
- *new* `tests/e2e/fixtures/deep-interview-stub-llm.ts` — a tiny HTTP server the test boots that returns canned responses with valid JSON trailers; `dispatch-llm.ts` is pointed at it via env var. The stub also records `tokens_in` per turn for the token-budget assertion.
- *modify* `tests/e2e/playwright-multiuser.config.ts` — add this spec to the project list.

**Acceptance criteria:**
1. `pnpm exec playwright test tests/e2e/onboarding-deep-interview.spec.ts` passes against the stub.
2. With `E2E_HERMES=1` and the Mac mini reachable, the same spec passes against real Hermes (informational; not a CI gate in v1).
3. **Resume scenario:** sub-test interrupts after round 2 by clearing cookies, re-signs-in, asserts the wizard resumes at round 3 with prior turns visible.
4. **Invite-flow scenario (Pre-mortem #3):** simulate invite-then-signup; assert invitee lands at `/cos` of the inviter's workspace, NOT `/company-create`.
5. **(NEW) Adapter token-budget sanity (Pre-mortem #4 / Decision C):** capture `tokens_in` from the stub LLM for one full run on `claude_api` (full SKILL.md path) and one on `hermes_local` (summary path). Assert `tokens_in_hermes <= 0.30 * tokens_in_claude_api`. Fails the build if `selectPromptDepth` isn't actually being routed.

**Risks:** Playwright auth state restoration. Reuse the `playwright-multiuser-authenticated.config.ts` patterns for the resume sub-test.

---

## 4. Expanded Test Plan (Deliberate Mode)

### Unit
- `selectPromptDepth(adapter)` — golden tests for every `AgentAdapterType` value; default unknown-adapter is `"summary"`.
- `parseTrailer` golden cases: well-formed, missing-trailer, partial-JSON, retry path, fallback-deterministic path.
- `scoreAmbiguity` weighted formula (brownfield 35/25/25/15) on hand-crafted dimension inputs.
- `computeOntologyStability` against a fixture sequence of 3 ontology snapshots; assert `stabilityRatio` matches the spec's table values (0.625, 0.875).
- `pickChallengeMode` deterministic given `(round, modesAlreadyUsed)`.
- `crystallizeAndAdvanceCos` — happy path; mid-transaction failure rolls back all three writes.
- `maybeInstallClaudeLocalSkill` (Phase A optional file drop) — writes when flag set + adapter=claude_local, no-ops otherwise, idempotent.

### Integration
- `deep-interview-engine.startOrResume` against a stub LLM through `dispatch-llm`; full 3-round happy path; assert DB rows.
- `/assess` route end-to-end against the stub (with `AGENTDASH_DEEP_INTERVIEW_ASSESS=true`); response shape matches existing UI contract.
- `/assess/project` route end-to-end against the stub; produces a `deep_interview_specs` row with `scope='assess_project'`.
- Resume: kill engine mid-turn, restart server, hit `GET /api/onboarding/in-progress`, assert exact prior state.
- **Token-budget integration:** stub LLM records `tokens_in`; assert `claude_api` path sends `SKILL_MD_FULL` (~16k tokens) and `hermes_local` path sends `SKILL_MD_SUMMARY` (~4k tokens).
- **Single-transaction integration:** force a DB error in the middle of `crystallizeAndAdvanceCos`; assert all three tables rolled back.

### E2E (Playwright)
- **Happy path:** signup → company-create → assess (3 rounds, stub) → /cos → plan card → confirm → agents materialize.
- **Resume after browser close:** signup → 2 rounds → kill cookies → re-signin → resume → finish → assert single agents row.
- **Invite-flow safety (Pre-mortem #3):** invite-then-signup → invitee lands at `/cos` of inviter's workspace, NOT `/company-create`.
- **`local_trusted` belt-and-suspenders:** cold-start `pnpm dev` with `AGENTDASH_BOOTSTRAP_EMAIL` set; assert local-trusted user lands on `/cos` (verifies Phase E didn't cross-wire).
- **(NEW) Adapter token-budget sanity (Pre-mortem #4):** stub LLM records `tokens_in`; one run on `claude_api` (full), one on `hermes_local` (summary); assert `hermes_local <= 0.30 * claude_api`.
- **Adapter switch mid-interview:** start with `claude_local`, switch to `hermes_local`, finish; assert no error and final spec exists. (Informational, not a hard gate.)

### Observability
Add structured log lines (pino) at:
- `[deep-interview-engine] turn dispatched` — `{ stateId, round, scope, adapter, dimensionScores, ambiguityScore, challengeMode, latencyMs, selectedPromptDepth }`
- `[deep-interview-parser] trailer parse` — `{ stateId, status: "ok"|"retry"|"fallback", rawFirst200Chars }`
- `[deep-interview-engine] crystallized` — `{ stateId, finalAmbiguity, rounds, specId, transactionMs }`
- `[deep-interview-crystallize] tx outcome` — `{ stateId, scope, conversationId, success: true|false, error? }` (single emission per `crystallizeAndAdvanceCos` call)
- `[onboarding-orchestrator] bootstrap skipped` — `{ reason: "v2_flow_drops_auth_hook", deploymentMode: "authenticated" }` (one-shot at first signup after deploy)
- `[install-deep-interview-skill] result` — `{ adapter, path, status, bytesWritten }` (only when flag is on)
- `[deep-interview-prompts] selected depth` — `{ adapter, depth, tokenEstimate }`

Dashboards/alerts (follow-up, not v1 gate):
- Trailer-parse fallback rate by adapter — alarm if >5% over 1h.
- Resume rate (interviews where `state.updatedAt - createdAt > 1h`) — sanity check.
- `selectedPromptDepth` distribution — alarm if `claude_api` ever ships `summary` (regression on Decision C).

---

## 5. ADR — Onboarding Redesign via OMC Deep-Interview

**Decision**

Migrate the post-signup onboarding flow to `signup → /company-create → /assess?onboarding=1 (deep-interview engine) → CoS plan card → confirm → agents`.

The deep-interview SKILL.md is bundled into AgentDash as **TS string constants** (`SKILL_MD_FULL` and `SKILL_MD_SUMMARY` in `packages/shared/src/deep-interview-skill.ts`), kept in sync with the upstream OMC corpus by a checked-in script with a CI guard. The constant chosen at runtime depends on the active adapter via `selectPromptDepth(adapter)`: `claude_api` ships the full corpus (cached via `cache_control: ephemeral`); all other adapters ship the summary to bound spawn-adapter cost / argv length.

State persists in two new tables (`deep_interview_states`, `deep_interview_specs`) keyed by `(scope, scopeId)` so the same engine drives `/assess` company-mode, `/assess/project`-mode, and the CoS-onboarding scope. The transition between deep-interview state and CoS state machine is handled by a single Drizzle transaction (`crystallizeAndAdvanceCos`).

The auto-bootstrap auth hook is dropped **only in `authenticated` deployment mode**; `local_trusted` (the dev/founding-user flow) is untouched because `server/src/index.ts:486-488` short-circuits before the auth wiring runs. The drop is gated behind `AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP=true` for one release window.

Phase D ships dark behind `AGENTDASH_DEEP_INTERVIEW_ASSESS` (default off). Phase F flips the default to `true` and removes the legacy branch, with the flag itself removed two stable weeks after.

**Drivers** (top 3)
1. User can resume mid-interview cleanly (state machine = DB row).
2. One engine for company-mode + project-mode + CoS-onboarding.
3. Cost / latency budget under the spawn-adapter constraint (Hermes / claude_local have no prefix caching).

**Alternatives Considered**
- **Architecture A — pure server-side TS reimplementation of deep-interview methodology.** Architect's antithesis. Rejected for full reimplementation because it abandons the OMC corpus, but the spirit (build a 150-line summary, don't depend on the full file) is honored via Decision C's `SKILL_MD_SUMMARY` for spawn adapters. The summary IS a ~150-line TS-string-driven engine for the cost-sensitive path; the full corpus is only used where caching makes it free.
- **Architecture B — runtime prompt-inject only, no install.** **Chosen.** Renamed from "B+D" in Round 1. The per-adapter installer is dropped (3 of 8 adapters install cleanly, 4 fall through to `claude_api`, 1 unverified). The optional `claude_local` file-drop is a flagged decoration, not a correctness path.
- **Architecture C — install-only, no runtime inject.** Rejected: most adapters either don't scan their skills directory or fall through to `claude_api`; engine is dead for them without runtime inject.
- **Architecture D — install + inject (Round 1 recommendation).** Rejected on Round 2 evidence: install is decorative for everyone except `claude_local`. Architecture B + Decision C carries the same correctness with less surface area.
- **Schema B1 — extend `cos_onboarding_states`.** Rejected: `/assess/project` has no conversation row to FK against. Spec deviation explicitly documented.
- **Packaging A1 — bundle SKILL.md as `.md` file.** Rejected on Round 2: `cli/esbuild.config.mjs` has no asset-copy step; would silently strip the file. A2 (TS string constant + sync script + CI guard) is robust to the build pipeline.
- **Decision C2 (always full SKILL.md).** Rejected: 133k+ tokens per Hermes interview; argv length risk. C3 (always summary) rejected because it loses the methodology where caching makes it free.
- **Decision D1 (combine D + F into one PR).** Rejected: too large for review, harder to revert F without reverting D. D2 (flag-gated D) preserves rollback granularity.

**Why Chosen**
Architecture B + `selectPromptDepth` + Schema B2 + Packaging A2 minimizes surface area:
- **One canonical methodology corpus** (synced from upstream OMC with a CI guard) — no in-house drift.
- **Two purpose-built tables** keyed by `(scope, scopeId)` — same engine across all three scopes.
- **One single-transaction crystallize-and-advance helper** — no race surface between state machines.
- **Adapter-aware prompt depth** — bounded cost / argv length on spawn adapters; full methodology on `claude_api` where caching makes it free.
- **Flag-gated subtractive changes** — both the auth-hook drop and the assess-engine swap are flagged with explicit removal-after-stable-week-2 follow-ups.

**Consequences**

*Positive*
- Resumable onboarding by construction; no special-case state restoration.
- Same engine across all assess modes — fix once, fix everywhere.
- The OMC deep-interview methodology stays canonical (no in-house drift).
- Cost / latency stays bounded for spawn adapters.
- `local_trusted` development flow is untouched; no risk of breaking `pnpm dev` boot.

*Negative*
- Two SKILL.md constants to maintain (full + summary). Sync script automates regeneration; CI guard catches drift.
- Two new DB tables in a brownfield monorepo with 78 migrations already.
- Drop of auto-bootstrap hook is a behavioral break in `authenticated` mode. Flag-gated for one release window.
- Two simultaneous flags in flight (`AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP`, `AGENTDASH_DEEP_INTERVIEW_ASSESS`); both have explicit removal follow-ups.

**Follow-ups (deferred from v1)**
- Phase F revision loop (`POST /api/onboarding/revise-plan` is still a 501 stub).
- Multi-language deep-interview (English only in v1).
- Voice / video onboarding modality.
- Auto-update bundled SKILL.md from upstream OMC (manual `pnpm sync-skill-md` re-run picks it up in v1).
- Cross-adapter consistency tests (changing adapter mid-interview is an informational E2E, not a gate).
- **Remove `AGENTDASH_DEEP_INTERVIEW_ASSESS` flag and the legacy `assess-prompts.ts` / `assess-project-prompts.ts` two stable weeks after Phase F lands** (calendar reminder: 2026-05-31).
- **Remove `AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP` flag and the legacy auth-hook code path two stable weeks after Phase E lands** (calendar reminder: 2026-05-24).
- **Remove `AGENTDASH_INSTALL_SKILL_FILE` flag and decide whether the optional file drop earned its keep** (review at 2026-06-15).
- Wire `gemini_local` / `codex_local` / `opencode_local` / `acpx_local` properly in `dispatch-llm.ts` (currently all fall through to `claude_api`); the `selectPromptDepth` policy is already correct for them but actual dispatch is not.
- Verify Hermes binary's actual skills-path empirically on the Mac mini (open question carried over).

---

## Appendix — File Inventory

### New files
- `packages/shared/src/deep-interview-skill.ts` (generated; both constants)
- `packages/shared/src/deep-interview.ts` (shared types)
- `scripts/sync-skill-md.mjs`
- `scripts/skill-md-summary-fallback.md` (only if upstream slicing heuristic fails)
- `cli/src/utils/__tests__/maybe-install-claude-local-skill.test.ts`
- `packages/db/src/schema/deep_interview_states.ts`
- `packages/db/src/schema/deep_interview_specs.ts`
- `packages/db/src/migrations/00XX_*.sql` (auto-generated; sequence number picked by `pnpm db:generate` at execution)
- `server/src/services/deep-interview-engine.ts`
- `server/src/services/deep-interview-parser.ts`
- `server/src/services/deep-interview-prompts.ts`
- `server/src/services/deep-interview-crystallize.ts`
- `server/src/services/__tests__/deep-interview-engine.test.ts`
- `server/src/services/__tests__/deep-interview-parser.test.ts`
- `server/src/services/__tests__/deep-interview-prompts.test.ts`
- `server/src/services/__tests__/deep-interview-crystallize.test.ts`
- `server/src/routes/onboarding-in-progress.ts` (or extend an existing onboarding route file)
- `ui/src/pages/CompanyCreatePage.tsx`
- `tests/e2e/onboarding-deep-interview.spec.ts`
- `tests/e2e/fixtures/deep-interview-stub-llm.ts`

### Modified files
- `cli/src/commands/setup.ts` (optional `claude_local` file drop, flagged)
- `packages/shared/src/constants.ts` (A.0 documentation: add `claude_api`, `hermes_local` to `AGENT_ADAPTER_TYPES` for discoverability — type already widens via `(string & {})`)
- `packages/db/src/schema/index.ts` (export new tables)
- `packages/db/src/schema/cos_onboarding_states.ts` (add `deepInterviewSpecId`)
- `server/src/index.ts:521-547` (gate `onUserCreated` behind `AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP`)
- `server/src/routes/assess.ts` (engine swap, flag-gated by `AGENTDASH_DEEP_INTERVIEW_ASSESS`; later flips default)
- `server/src/routes/assess-project.ts` (engine swap)
- `server/src/routes/companies.ts` (409 if user already a member — invite-flow guard)
- `server/src/services/cos-replier.ts` (read spec, skip Phase 1)
- `server/src/services/cos-onboarding-state.ts` (link spec on first turn)
- `ui/src/pages/Auth.tsx` (redirect to `/company-create`)
- `ui/src/pages/AssessPage.tsx` (handle `?onboarding=1`)
- `ui/src/lib/onboarding-route.ts` (companyless → `/company-create` UNLESS member of any company)
- `ui/src/api/assess.ts` (`getInProgressInterview`)
- `ui/src/App.tsx` (`/company-create` route)
- `ui/src/components/OnboardingWizard.tsx` (extract step 1 into `CompanyCreatePage`; NOTE: this file holds the form; `WelcomePage.tsx` does NOT exist)
- `tests/e2e/playwright-multiuser.config.ts`
- `package.json` (root: add `sync-skill-md` script)
- `.github/workflows/*` (add CI step for `sync-skill-md` drift check)

### Files explicitly NOT touched (Round 2 scope clarification)
- `server/src/index.ts:486-488` (`ensureLocalTrustedBoardPrincipal` and the `local_trusted` deployment-mode branch). Phase E only touches the `authenticated` branch.
- `cli/esbuild.config.mjs` (no asset-copy step needed; A2 packaging avoids this).

### Open questions tracked separately
See `.omc/plans/open-questions.md`.
