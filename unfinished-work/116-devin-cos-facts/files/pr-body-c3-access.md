## Thinking Path

> - AgentDash is a fork of Paperclip that orchestrates AI agents for autonomous companies
> - Human onboarding and access control live across /auth, the invite landing, member onboarding, /setup, and Company Settings
> - Scan 5 (lane access) found six gaps: the Members table clips on phones, CoS plan-card hires never wrote an `agent.created` activity, /auth kept offering "Create account" after a claim-link signup, approved invitees were dropped into steward onboarding, /setup's "Skip for now" jumped Home, and several e2e/spec assumptions were stale
> - Each gap either shows a real user the wrong flow or leaves a hire action unaudited
> - This pull request fixes all six and hardens the e2e specs they run under
> - The benefit is a phone-usable access page, an audited hire path, and onboarding that matches the member's actual situation

## What Changed

- **Responsive members table** (`ui/src/pages/CompanyAccess.tsx`): below `sm`, members render as stacked cards (`data-testid="member-card-*"`) carrying identity, email, role, status, grants, Edit and Remove; the five-column grid stays for `sm` and up. New phone-floor e2e test asserts the cards and on-screen actions.
- **CoS plan-card hire audit** (`server/src/routes/onboarding-v2.ts`): the plan-confirm hire path now inserts `agent.created` (actor = hiring user, `details.source = "cos_plan"`) on the acceptance executor, published post-commit via `acceptance.publications` — the same atomicity as the hire itself. Covered by `onboarding-accepted-hire.test.ts`.
- **/auth default mode** (`server/src/routes/health.ts`, `ui/src/pages/Auth.tsx`): health now reports `hasUsers` on both public and authenticated shapes; `defaultAuthMode` shows sign-up only when `selfServeBootstrap && hasUsers === false`, so a claimed box with an existing user (still `bootstrap_pending`) opens on Sign in.
- **Invitee landing** (`ui/src/pages/InviteLanding.tsx`, `MemberOnboarding.tsx`, `server/src/services/member-onboarding.ts`): an approved human join stays on the "You joined the company" confirmation; the member session payload gains `isSteward` (active `agent_stewardships` lookup) so steward wording and the steward guide link render only for actual stewards — ordinary invitees get plain member copy.
- **/setup skip** (`ui/src/pages/FirstRun.tsx`): "Skip for now" on the repository step advances to the first-task step; skipping first task goes to `/cos`. The server keeps no skip state, so a revisit still offers the step.
- **E2E/spec updates**: `multi-user.spec.ts` updated to admin|member roles, the dedicated Invites page, the "Requested access" landing UI, and the local_trusted self-protection contract (403 "cannot remove yourself"); `doctor.test.ts` allocates an ephemeral localhost port instead of a fixed one; `playwright.config.ts` never reuses a running dev server (`PAPERCLIP_E2E_REUSE_EXISTING_SERVER=1` opts back in for local iteration) and its webServer timeout is env-tunable; `multi-user-authenticated` aborts external font fetches that can hold `load`, walks the member-onboarding gate for the invited user, and gets larger expect/navigation/test budgets for slow runners.

## Verification

- `pnpm -r typecheck` — all 25 packages pass
- `pnpm build` — pass
- Server vitest: `health.test.ts` (21), `member-onboarding.test.ts` (3, incl. non-steward `isSteward: false`), `onboarding-accepted-hire.test.ts` (incl. the new `agent.created` assertion) — all pass
- UI vitest: `Auth.test.tsx` (5), `MemberOnboarding.test.tsx` (3), `FirstRun.test.tsx` (16), `InviteLanding.test.tsx`, `CompanyAccess.test.tsx` (6) — all pass
- CLI vitest: `doctor.test.ts` — pass, on an ephemeral port
- Playwright `multi-user.spec.ts` (local_trusted): 18 pass, 2 intentionally skipped (no second non-admin member exists in local_trusted)
- Playwright `multi-user-authenticated.spec.ts` and the new `mobile-floors` access-card test: exercised locally to the final assertions on a saturated dev machine; CI e2e jobs are the gate
- Manual: `hasUsers: false` on a fresh authenticated instance, `bootstrap_pending` + `hasUsers` diverging after a claim is covered by `health.test.ts` cases

## Risks

- `hasUsers` is a new public health field; the count is already inferable from `bootstrapStatus`/`claimed`, so no new exposure
- `MemberOnboardingSession.isSteward` is additive; older clients ignore it
- The plan-card `agent.created` insert runs inside the existing hire transaction — if `insertActivity` throws, the hire rolls back like any other acceptance write
- Low risk overall: server changes are additive, UI changes are layout/copy only

## AgentDash Review

- **Upstream impact:** None - AgentDash scan-5 lane; all touched surfaces are AgentDash-owned pages/routes, nothing intended for upstream cherry-pick
- **Agent-facing prompt surfaces:** None - no prompt surfaces changed; the PR title carries the no-prompt-update marker
- **AgentDash-owned subsystem:** `onboarding-v2` gains the `agent.created` audit for the plan-card hire path (parity with other hire routes); `member-onboarding` session payload gains `isSteward`; health gains `hasUsers`

## Model Used

- Provider: Cognition
- Model: SWE-2 High (Devin CLI agent) — tool use (file editing, shell, test execution, GitHub CLI); long-context iterative verification on a multi-worktree checkout

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have filled out AgentDash Review with upstream impact, prompt-surface impact, and owned subsystem
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
