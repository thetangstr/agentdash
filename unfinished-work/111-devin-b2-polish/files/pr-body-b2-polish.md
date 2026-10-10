## Thinking Path

> - AgentDash is a fork of Paperclip that orchestrates AI agents for autonomous companies
> - The ux6 and canary-1002-2 phone walkthroughs (`.omc/canary/`) showed a set of small but sharp papercuts on real screens
> - On phones, settings pages render an empty top bar (no menu button, no title), the setup adapter cards cram their buttons beside the text, and review controls, checkboxes and skill rows fall under the 44px floor
> - Plan copy repeats itself (bubble + card rationale + card alignment), plan KPIs come out vague, /setup renumbers its steps on revisit, and a signed-up founder on /company-create fires GET /api/adapters before they have org access (403)
> - This pull request polishes each of those: phone-first headers and hit areas, plainer settings and plan copy, a correct /setup resume, and org-access gating on board reads
> - The benefit is that a non-technical owner on a phone can navigate, read and tap every flow the canary exercised

## What Changed

Phone layout and navigation:

- `ui/src/components/BreadcrumbBar.tsx`: the empty-breadcrumb branch now renders the mobile sidebar menu button (aria-label "Open sidebar") plus the workspace name instead of a bare right-aligned toolbar; a parent crumb now truncates on phones (`max-sm:shrink min-w-0 truncate`) so a long workspace name can no longer push the page label off the bar
- `ui/src/pages/BillingPage.tsx`, `ui/src/pages/WorkforceOnboarding.tsx`: register breadcrumbs (workspace > Billing / Workforce) so these pages get real mobile headers
- `ui/src/pages/InstanceAbout.tsx`, `ui/src/pages/InstanceChangelog.tsx`, `ui/src/pages/InstanceUpdates.tsx`: register their own breadcrumbs (Instance Settings > About / Changelog / Updates) instead of falling back to the workspace name
- `ui/src/components/ScrollToBottom.tsx`: the floating button grows to a 44x44 hit area on phones (found by the new Reviews-tab coverage)
- `ui/src/components/onboarding/RuntimeStep.tsx`: adapter-card content and action buttons stack vertically below `sm` instead of sharing one cramped row
- `ui/src/components/IssueResultBlock.tsx`: Accept / Request-changes buttons share one flex group so they stay on one row on phones; request-changes placeholder is now generic ("a short note for the agent, e.g. what to add, fix, or remove")
- `ui/src/pages/CoSConversation.tsx`: the desktop "Review your team" link gets the same compact icon+hover+min-height treatment the mobile ChatPanel link already had
- `ui/src/pages/InstanceChangelog.tsx`: release-note items use `overflow-wrap:anywhere` so long tokens wrap instead of overflowing on phones

Settings and plan copy:

- `ui/src/pages/CompanySettings.tsx`: OpenClaw invite generation button is `variant="outline"`; the stale "Import and export have moved" line is removed; the archive warning is plain language ("Archive this workspace to hide it from the sidebar. Nothing is deleted")
- `ui/src/components/cards/AgentPlanProposal.tsx`: the card no longer re-renders `rationale` — it repeats the chat bubble verbatim, which made the plan read three times; the short/long-term alignment lines stay on the card (they carry forward-looking context the bubble doesn't, and `cos-plan-card-phone.spec.ts` asserts them); all payload fields are intact for downstream materialization
- `server/src/services/cos-plan-naming.ts` + `server/src/services/cos-replier.ts`: shared `PLAN_KPI_GUIDANCE` requires each KPI to carry a concrete number and a period (e.g. "12 qualified renewal calls a month") and rejects vague targets; the goals prompt asks for concrete numbers/periods when discussing scale
- `ui/src/pages/FirstRun.tsx`: the step indicator always lists all three steps; on self-hosted installs step 1 reads "Your AI assistant", so revisiting /setup resumes at "2. Code (optional)" rather than a renumbered step 1

Display and accessibility:

- `ui/src/components/IssueProperties.tsx`: an issue `in_review` with no configured reviewer participants shows its creator as the implicit reviewer instead of "None"
- `ui/src/components/IssueDocumentsSection.tsx`: the stored title is skipped when the document body already opens with a markdown heading (kept when the card is folded, where the title is the only identifier)
- `ui/src/pages/Activity.tsx`: "Show system events" checkbox gains an `aria-label` so screen readers name it (its 44px label hit area was already in place)
- `ui/src/components/DefinitionOfDoneEditor.tsx`: each criterion checkbox is wrapped in a label with a 44x44 hit area and an aria-label derived from the criterion text (or "Criterion N")
- `ui/src/pages/NewAgent.tsx`: company-skill checkbox labels get `max-sm:min-h-11`

API gating:

- `ui/src/hooks/useBoardSessionReady.ts`: new `useBoardOrgAccess()` mirrors the server's `hasBoardOrgAccess` via `/cli-auth/me` (shares the `currentBoardAccess` cache entry with CloudAccessGate, fails open on errors)
- `ui/src/adapters/use-adapter-capabilities.ts`, `ui/src/adapters/use-disabled-adapters.ts`, `ui/src/components/NewAgentDialog.tsx`: `adaptersApi.list()` now waits for org access, so /company-create right after sign-up no longer logs a 403

Tests:

- `tests/e2e/mobile-floors.spec.ts`: seeds a local company skill and a two-criterion Definition of Done (one done) so the issue Reviews tab audits real checkbox rows; adds a 390px breadcrumb regression test with a ~40-char workspace name asserting the page label stays on screen; the audit caught three real findings (a misshapen 13x16 checkbox from `size-4` on a native input, a 20x44 DoD hit label, a 36px Scroll-to-bottom button) — all fixed and re-verified
- New unit tests: `ui/src/hooks/useBoardSessionReady.test.tsx` (useBoardOrgAccess: local trusted, founder without membership, admin/member, fail-open), `ui/src/components/BreadcrumbBar.test.tsx` (empty-breadcrumb fallback on phone vs desktop), IssueProperties implicit-reviewer cases, IssueDocumentsSection heading-led title skip, `server/src/__tests__/cos-replier.test.ts` PLAN_KPI_GUIDANCE in both plan prompts
- `ui/src/pages/FirstRun.test.tsx`, `ui/src/components/__tests__/AgentPlanProposal.test.tsx`, `ui/src/components/cards/AgentPlanProposal.test.tsx`, `ui/src/pages/BillingPage.test.tsx`: updated for the new contracts

## Verification

- `pnpm -r typecheck`: pass (25/26 projects; `@paperclipai/adapter-utils` built first)
- Touched vitest files: FirstRun 15, IssueResultBlock 9, IssueProperties 16, AgentPlanProposal 14, IssueDocumentsSection 10, BillingPage 8, plus NewAgentDialog / Layout / CoSConversation / CoSRoutes / WorkforceOnboarding / CompanySettings.hosted / IssueDetail / FirstRunHomeNudges — all pass; server cos-* prompt tests: 78 pass
- `pnpm build`: pass (pre-existing >500kB chunk warnings only)
- `node scripts/ci/check-no-profile-ux.mjs` and architecture check: 0 errors (6 pre-existing localStorage-branding warnings, none in touched files)
- Playwright `mobile-floors.spec.ts` on `PAPERCLIP_E2E_PORT=4859` (derived embedded Postgres port 24859 — never 54329): 112/112 pass, including the new DoD-backed Reviews-tab audits and the 390px breadcrumb regression test
- Playwright `cos-plan-card-phone.spec.ts`: pass — it caught the first version of the card change (alignment lines removed too aggressively); the card now drops only the bubble-duplicated rationale and keeps the alignment lines the spec asserts
- Manual spot-check: reserved ports 3100 / 3199 / 3120 / 3300 / 54329 untouched before, during and after the e2e run

## Risks

- `useBoardOrgAccess` gates three adapter reads on an extra API call; it fails open on errors, shares a cache key that CloudAccessGate already populates on gated routes, and built-in adapter defaults still answer synchronously, so worst case is the pre-change behaviour
- Showing the issue creator as implicit reviewer is display-only; no review permission logic changed
- The plan-KPI prompt guidance is additive text on the two CoS plan prompts; it shapes wording, not API contracts
- Skipping the stored document title on heading-led bodies could hide a title that differs meaningfully from the heading; the title still renders whenever the document is folded

## AgentDash Review

- **Upstream impact:** Low. Edits are in AgentDash-owned UI components/pages, the mobile-floors spec, and the two AgentDash CoS plan prompts; no inherited upstream code paths changed
- **Agent-facing prompt surfaces:** Changed copy, not contract. `PLAN_KPI_GUIDANCE` and the goals prompt in `cos-replier.ts` / `cos-plan-naming.ts` steer the CoS replier toward concrete KPIs; the worker prompt surfaces (default AGENTS.md, agent-creator-from-proposal.ts) are untouched because no worker-facing behaviour changed
- **AgentDash-owned subsystem:** Board UI (breadcrumbs, onboarding, settings, issue detail, agent creation), CoS replier plan prompts, embedded-Postgres-free e2e spec

## Model Used

- Provider: Cognition (Devin agent)
- Model: SWE-2 High — long-horizon coding model with tool use, shell execution and multi-file editing

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have filled out AgentDash Review with upstream impact, prompt-surface impact, and owned subsystem
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] If this change affects the UI, I have included phone evidence — the canary walkthrough shots in `.omc/canary/ux6/` and `canary-1002-2/` plus the mobile-floors audit output cited above
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [x] If this is upstream-derived, I have followed `doc/UPSTREAM-POLICY.md` and recorded the upstream SHA/reason/verification
- [x] If this changes agent-facing behavior, I have updated both prompt surfaces (default AGENTS.md and agent-creator-from-proposal.ts) or explained why they do not apply
- [x] I will address all Greptile and reviewer comments before requesting merge
