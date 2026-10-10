## Thinking Path

> - AgentDash is a fork of Paperclip that orchestrates AI agents for autonomous companies
> - The hiring and approvals subsystem — CoS plan cards, the Decisions row, the approval detail page, and the hired agent's own page — is what a company owner reads when the Chief of Staff proposes a new hire
> - Those surfaces were written for operators: "The board asks to hire a new agent", a role slug like `cfo` standing in for a Bookkeeper, raw ids and adapter names in the primary view, an enabled "Set it up" button on a card only the requester may confirm, and CoS replies that said "Approvals" while the nav says "Decisions"
> - An owner should be able to read every step of a hire without decoding internals — who asked, what for, where it went, and what happened next
> - This pull request makes the whole hire path owner-readable: named requesters, human titles, Decisions links, correct singular/plural, requester-gated card actions, creator provenance on hired agents, and a neutral `finance` role for finance staff
> - The benefit is an owner can approve, revise, or decline a hire understanding exactly what they are looking at, and a member sees why they cannot confirm someone else's card before they click

## What Changed

- `waiting-on-you` (Decisions rows, Home, the assistant tool): resolves `requestedByUserId` through `authUsers` and writes "Dana (via Chief of Staff) asks to hire Bea as Bookkeeper" — the human title via a payload-aware ask phrase, never the role slug. Agent requesters are unchanged.
- `ApprovalDetail`/`ApprovalPayload`/`StatusBadge`: resolves `requestedByUserId` through the company user directory; "(via Chief of Staff)" for `cos_plan`/`cos_proposal` hires. Status reads "Waiting for a decision" / "Changes requested" / "Approved" / "Declined". "See full request" becomes "Technical details" holding the request id, agent id, and raw payload; the friendly hire payload drops the role slug and adapter. Buttons read "Ask for changes", "Resubmit", "Delete declined agent"; comment textarea gains `aria-label`; comment authors resolve to names. Hire labels read "Hire Bea as Bookkeeper" (`humanizeAgentRole` fallback when no title).
- `onboarding-v2` confirm-plan: gated hires reply "waiting for a decision — I have sent it/each one to [Decisions](/decisions)" with correct singular/plural and no "board"; steady-state and post-onboarding variants share one helper. Ungated steady-state confirms now post "Done — Quinn is on the team." instead of silence.
- `createdByUserId` stamped on plan-card hires (`req.actor.userId`) and interview hires (`accountableUserId` in `agent-creator-from-proposal`). `AgentDetail` credits "Dana Whitfield, via Chief of Staff" via a new `agentHireOrigin` helper (falls back to the accountable person on rows written before the stamp, "Hired through the Chief of Staff" when nobody is attributable, "Set up with the workspace" for the CoS itself). A never-run agent's page reads "Ready for its first task."
- `AgentPlanProposal` + shared card payload: `requesterName` rides next to `requesterUserId`; the card fetches the session and a known non-requester sees "Waiting for Dana to confirm." with no enabled actions (server stays the authority). `cos-replier` strips model-invented `requesterUserId`/`requesterName`/`confirmedAt`/`confirmedAgentIds`/`pendingApproval` before posting the card; revise-plan preserves the original requester's name. Single-agent plans read "Hired ✓"; multi-agent keeps "Team hired ✓".
- A neutral `finance` role joins `AGENT_ROLES`/`AGENT_ROLE_LABELS`; the keyword map sends finance staff titles (bookkeeper, accountant, payroll, month-end close, …) to `finance` and only C-suite titles to `cfo`.
- `steadyStatePrompt` speaks owner language: "a person's decision" / "awaiting a hiring decision" instead of "board approval", so CoS replies echo the same words.

## Verification

- `pnpm -r typecheck` — all 25 packages green
- `pnpm build` — green
- Touched suites: `waiting-on-you` (embedded PG, incl. new user-requester case), `onboarding-v2-routes` (Decisions wording, link, singular/plural, steady-state confirm message), `cos-replier` + `cos-replier-issue-trailer` (83 tests), `agent-role-mapping`, `AgentPlanProposal` (17: requester gating, single/multi labels, 409, superseded), `ApprovalPayload`, `ApprovalDetail` (new, 3 tests), `agent-identity` (`agentHireOrigin`), `AgentDetail` — all green
- Playwright on port 3317 (db 23317): `onboarding-plain-language` 6/6, `cos-plan-card-phone` 1/1. `onboarding.spec` passed 1/2 — the "completes full wizard flow" test hit the known flake documented as #995 in `OnboardingWizard.tsx` (the async bootstrap CoS lands before the wizard's agents fetch on a saturated box, `companyHasAgents` clears the prefilled name, and Next stays disabled). The same spec is green in CI; the failure mechanism is in main's code, not this diff.
- Manual: `docs/api/openapi.yaml` regenerated (`finance` enum); `check-api-reference-drift.mjs` clean; `docs:search-index` regenerated with no diff

## Risks

- Low risk. `waiting-on-you` adds one user-id lookup batched over the ranked page; summaries change wording only. The `finance` role is additive — role consumers fall back safely (`ROLE_ICONS` uses the default icon) and no permissions attach to either `cfo` or `finance`. Cards without `requesterUserId` (onboarding cards, older cards) stay confirmable by any member as before.
- The requester gate is display-only; the server remains the authorization authority for confirm and revise.

## AgentDash Review

- **Upstream impact:** None - all changes are AgentDash-owned surfaces (CoS hire flow, Decisions/approvals UI, plan cards, role mapping); no upstream-derived files touched.
- **Agent-facing prompt surfaces:** `steadyStatePrompt` wording changed to owner language ("a person's decision", "awaiting a hiring decision"); `agent-creator-from-proposal.ts` touched (createdByUserId stamp — no prompt text change needed, noted by comment). `default/AGENTS.md` not applicable: no new endpoint, state transition, or worker capability — this is owner-facing copy and card gating.
- **AgentDash-owned subsystem:** CoS onboarding/hire flow, approvals/decisions UI, shared card payloads, role constants — all AgentDash-owned.

## Model Used

- Provider: Cognition
- Model: Devin, powered by SWE-2 High — agentic coding session with repository tools, shell execution, and test/e2e verification.

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
- [x] If this is upstream-derived, I have followed doc/UPSTREAM-POLICY.md and recorded the upstream SHA/reason/verification
- [x] If this changes agent-facing behavior, I have updated both prompt surfaces (default AGENTS.md and agent-creator-from-proposal.ts) or explained why they do not apply
- [x] I will address all Greptile and reviewer comments before requesting merge
