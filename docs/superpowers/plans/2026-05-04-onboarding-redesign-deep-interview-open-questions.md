# Open Questions

## onboarding-redesign-deep-interview — 2026-05-03 (Round 2 update)

### Resolved by Round 2 revision

- [x] **Adapter constants gap.** ~Phase A.0 must add `claude_api`/`hermes_local` to `AGENT_ADAPTER_TYPES`.~ Reframed: `AgentAdapterType` already widens via `(string & {})` (verified `packages/shared/src/constants.ts:42`), so the addition is documentation/discoverability, not type-safety unblocking. A.0 is now a 1-line constants change with no architectural implications.
- [x] **SKILL.md token budget.** ~Decide before Phase C ships whether to truncate.~ Resolved by Decision C: `selectPromptDepth(adapter)` ships `SKILL_MD_FULL` for `claude_api` (cached) and `SKILL_MD_SUMMARY` (~150 lines / ~4k tokens) for spawn adapters. Phase C unit test + Phase G E2E asserts the routing.
- [x] **Schema spec deviation.** Architect Round 1 endorsed B2; Critic concurred. Documented in ADR.
- [x] **`AGENTDASH_LEGACY_AUTOBOOTSTRAP` removal date.** Renamed to `AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP` for scope clarity. Calendar reminder set: 2026-05-24 (two stable weeks after Phase E lands).
- [x] **Build pipeline asset shipping.** Verified `cli/esbuild.config.mjs` has no asset-copy step. Decision A flipped from A1 (file bundle) to A2 (TS string constant + sync script + CI guard).

### Still open

- [ ] **Hermes skills directory (decorative).** Spec says `~/.hermes/hermes-agent/skills/...`; vanilla install commonly uses `~/.hermes/skills/...`. Verify empirically by reading `node_modules/hermes-paperclip-adapter/` (or running `hermes --version --verbose` on the Mac mini). — Why it matters: only relevant if we extend the optional `AGENTDASH_INSTALL_SKILL_FILE` flag beyond `claude_local`. **Lower priority now** — runtime inject is the correctness path; install is decorative.
- [ ] **`opencode_local` and `acpx_local` skills paths.** Logged as `status: "todo"` in Round 1; with Architecture B in Round 2, no longer blocking. — Why it matters: documented as follow-up to "wire `gemini_local` / `codex_local` / `opencode_local` / `acpx_local` properly in `dispatch-llm.ts`" — currently they all fall through to `claude_api` per `dispatch-llm.ts:142-146`.
- [ ] **Cursor onboarding UX.** Cursor is a desktop app — no skills install, runtime inject is the only path (and it dispatches via `claude_api` fallback per `dispatch-llm.ts`). Confirm cursor-as-CoS-adapter is in scope for v1 onboarding; if not, gate `/assess?onboarding=1` to non-cursor adapters. — Why it matters: runtime inject through cursor's adapter has not been smoke-tested for deep-interview prompts.
- [ ] **OMC SKILL.md "Methodology Summary" section presence.** Sync script slices the section by heading; if the upstream SKILL.md doesn't have one (or moves it), the script falls back to `scripts/skill-md-summary-fallback.md`. **Verify before Phase A merge** that the pinned `4.13.5` SKILL.md actually has a clearly-marked summary section the script can find. — Why it matters: A fallback that's always used = drift between full and summary corpuses with no guard.
- [ ] **`POST /api/companies` 409 contract.** New invite-flow guard returns 409 when the user is already a member. Confirm no existing client (CLI, internal scripts) calls this endpoint expecting "always create" semantics. — Why it matters: behavioral change; could break automation outside the Better-Auth signup flow.
- [ ] **`AGENTDASH_DEEP_INTERVIEW_ASSESS` flag removal date.** Set: 2026-05-31 (two stable weeks after Phase F flips the default). Confirm no production rollback would need to revert past that date. — Why it matters: feature flags rot; document the kill date and follow through.
- [ ] **`AGENTDASH_INSTALL_SKILL_FILE` flag review date.** Set: 2026-06-15. Decide whether the optional `claude_local` file drop earned its keep or should be removed. — Why it matters: dead-flag accumulation.

### Carried forward (analyst-flagged from prior pass — still open)

(none — Round 1 analyst questions were either resolved or rolled into the items above)
