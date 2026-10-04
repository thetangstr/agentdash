## Thinking Path

> - AgentDash is a fork of Paperclip that orchestrates AI agents for autonomous companies
> - The board UI (React pages, activity formatting, breadcrumbs, chat) is the surface owners read every day
> - The v2026.1003.0 hosted canary flagged copy written for operators, not owners: internal terms ("Enroll role", "Revision 0", "Inference spend"), cryptic glyphs (a red "–" before ref chips, a 🔵 in the breadcrumb, a bare "System" actor), and phone-only gaps (a hidden connection word, an empty "›" crumb, a chat that loses its place on resize)
> - Left as-is, the product reads like a debugging console instead of a workspace an owner can trust
> - This pull request rewrites the flagged copy in plain language and fixes the phone-only mechanics behind it
> - The benefit is a board that explains itself in the owner's words on every screen size

## What Changed

- **Workforce:** owner-language copy — removed "Revision N" and "Human-confirmed facts" phrasing, "Enroll role" → "Assign role", readiness blurb now says being connected to a model is not the same as being ready to deliver; the consent checkbox's label row is documented as the 44px phone tap target
- **Activity:** `heartbeat.cancelled` renders "stopped <Agent>'s run — <reason>" (issue marked done / cancelled / comment interrupt), naming the issue when the audit carries its identifier; a cancel caused by closing an issue credits AgentDash, not the person; every `work_product_updated` reason reads as what happened — "accepted/requested changes on/resubmitted/reopened the <document>" — instead of "updated a deliverable", and slugged document keys are humanised ("product description"); the system actor is named "AgentDash" everywhere it appeared as "System" (activity, issue detail, comment and chat threads, live-update toasts); ref-chip sections show their "Added references"/"Removed references" label instead of a lone colored glyph
- **Issues list:** the `document_revision_required` refusal is an info-tone toast — "Review <identifier> before marking it done" with an "Open the issue" link — matching the updated server conflict message, instead of a red "Issue update failed"
- **Costs:** subtitle and tile say "Model usage"; budget tile says "No budget limit set" (and shows the cap amount when a cap exists but usage is unpriced); the agent page's BYOK spend card shows the month's counted tokens plus "Billed by your model provider"; the run table's all-dash Cost column hides when no run is priced
- **Settings:** AdapterManager, PluginManager, and PluginSettings breadcrumbs all read "Instance Settings › …"; the Alpha badge and the external-adapters/plugins alpha notices render only for instance admins via a new `useIsInstanceAdmin()` hook
- **Phone:** ConnectionStatus keeps its state word visible on phones only for non-connected states — the steady "Connected" is screen-reader-only below md so it costs no header width; the live-issue breadcrumb drops the raw 🔵 emoji (the header badge carries live state); ChatPanel re-pins to the bottom on scroller resize only when the reader was already at the bottom; the fleet card names a hire "Your Chief of Staff" (or drops the line) instead of repeating its name as the subtitle, on phone and desktop. The canary's empty "›" crumb is **not** fixed here — its cause is the parent crumb collapsing to 0px at 390px, which #1014 fixes by replacing the parent crumb with a back chevron on phones

## Verification

- `pnpm -r typecheck` — all packages pass
- `pnpm build` — all packages build
- Touched unit tests pass: AgentDetail (monthCountedTokens, AgentSpendFigure, BYOK Cost column), activity-format (cancel reasons + issue naming, accepted-deliverable, changes-requested/resubmitted/reopened reasons, humanised document keys), issueDetailBreadcrumb (empty label), useBoardSessionReady (useIsInstanceAdmin), AdapterManager (breadcrumbs + alpha gating), ControlPlanePanels (fleetRowSubtitle dedup + CoS), Issues (refusal toast), WorkforceOnboarding, ConnectionStatus (sr-only Connected on phone vs visible warnings), ActivityRow (AgentDash credit on status-close cancels), IssueReferenceActivitySummary (visible labels), ChatPanel (resize pin: re-pin at bottom, not when scrolled up)
- Server acceptance suites pass: issue-review-acceptance, work-product-review-loop, issue-mutation-acceptance
- `tests/e2e/mobile-floors.spec.ts` on a unique port (server 6111, embedded Postgres 26111): all audits pass
- Manual spot-checks: the canary screenshots in `.omc/canary/canary-1003-0/` map one-to-one to the fixes above

## Risks

- Low risk overall: copy changes and conditional rendering; no schema, API contract, or data-model changes
- `useIsInstanceAdmin` fails open on access-check errors — an admin with a transient network failure still sees the alpha notice (intentional, matches existing gate behavior)
- Hiding the Cost column when no run is priced changes the run table's shape on BYOK workspaces only; priced runs restore it
- The server conflict message for `document_revision_required` changed wording only — the error code, status, and details payload are unchanged

## AgentDash Review

- **Upstream impact:** None - all changes are inside AgentDash-owned UI copy, formatting, and presentation code; nothing cherry-picked
- **Agent-facing prompt surfaces:** None - no agent behavior, endpoint, state transition, or prompt text changed; the activity formatter and toast copy are board-side rendering
- **AgentDash-owned subsystem:** Board UI copy layer (activity formatting, breadcrumbs, toasts, onboarding/workforce text) — reviewed for consistency with the one-UX rule: no profile branching added

## Model Used

- Provider: Anthropic — Model: Claude (SWE-2 High coding agent, Devin CLI) — tool use + code execution; changes implemented and verified via the repo's own typecheck, unit, and Playwright suites

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have filled out AgentDash Review with upstream impact, prompt-surface impact, and owned subsystem
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] If this change affects the UI, I have included before/after screenshots
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [x] If this is upstream-derived, I have followed `doc/UPSTREAM-POLICY.md` and recorded the upstream SHA/reason/verification
- [x] If this changes agent-facing behavior, I have updated both prompt surfaces (default AGENTS.md and agent-creator-from-proposal.ts) or explained why they do not apply
- [x] I will address all Greptile and reviewer comments before requesting merge
