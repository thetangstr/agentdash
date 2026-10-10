## Thinking Path

> - Batch-3 brief `c3-a11y.md` collects the phone/a11y/jargon findings from the UX scans: a breadcrumb parent that eats the page title's space on phones, feedback thumbs next to real review actions on the same deliverable, plan cards that show only the first responsibility, unnamed icon-only controls, insider jargon, and three different spellings of the redaction mask
> - On phones the parent crumb's truncated text competed with the page label for width; a labelled back chevron gives the title the space and keeps a 44px target
> - A document deliverable waiting on Accept / Request changes also offered Helpful / Needs work thumbs — two review affordances for one pending review
> - Secret masks reached the UI in several spellings (`***REDACTED***`, `***SECRET_REF***`, the server's bracketed `REDACTED_*` markers and the git helper's `redacted-github-token`); the shared lib now maps every known marker to one owner-friendly "•••• hidden" at render time, stored values untouched
> - The benefit is a phone UI that reads like it was written for an owner: named controls, plain words, and one consistent mask wherever a redaction shows

## What Changed

Phone breadcrumb:
- `ui/src/components/BreadcrumbBar.tsx`: on phones, linked parent crumbs render a chevron with `aria-label="Back to <parent>"` and a 44px target instead of truncated text; desktop text is unchanged and the current-page label never shrinks

Review feedback:
- `ui/src/components/IssueDocumentsSection.tsx`: while a shipped deliverable for the issue sits at `ready_for_review` (the same `queryKeys.shipped` query `IssueResultBlock` already uses, so the request dedupes), per-document `OutputFeedbackButtons` no longer render — the explicit Accept / Request changes actions own the pending review. Stored feedback semantics are unchanged

Agent plan proposal:
- `ui/src/components/cards/AgentPlanProposal.tsx`: all known responsibilities render as a compact list instead of only the first; placeholder values like `Unknown`/`N/A` still filter out

Accessible names:
- `ui/src/pages/Agents.tsx`: the List / Org-chart toggle is a named `role="group"` with `aria-label` + `aria-pressed` on each button
- `ui/src/components/PropertiesPanel.tsx`: the close control is `aria-label="Close properties panel"`
- `ui/src/components/IssueProperties.tsx`: the assignee / project / parent arrow links name their destination ("Open agent <name>", "Open project <name>", "Open parent issue <id>")
- `ui/src/components/PageTabBar.tsx` + `ui/src/pages/AgentDetail.tsx`: the mobile tab `<select>` takes an `ariaLabel` prop ("Agent sections", "Agent settings sections"; "Page sections" default)
- `ui/src/pages/CompanySettings.tsx`: Workspace name, Description, Logo and Brand color value inputs get `aria-label`s
- `ui/src/pages/CoSConversation.tsx`: the mobile "Review" link is announced as "Review — opens your Workforce page"
- `ui/src/components/StatusIcon.tsx`: the standalone circle names itself via `role="img"` (the previous `aria-label` on a bare span was inert), and the icon-only status picker in the Issues list is now a real `<button>` named after the current status — it was an unfocusable span trigger
- `ui/src/components/IssuesList.tsx`: the List / Board toggle buttons get `aria-label` + `aria-pressed` inside a labelled group

Plain language:
- `ui/src/components/TaskOutcomeQualityPanel.tsx`: "DoD coverage" → "Definition of done coverage", "green runs" → "successful runs"
- `ui/src/pages/Routines.tsx`: "Recurring work definitions that materialize into auditable execution issues" → "Work that repeats on a schedule — each run creates a tracked task"
- `ui/src/components/AgentKindBadge.tsx`: kind badges say what they mean — "Runs solo", "Run by <name>", "No one runs it yet" — with the explanation in the tooltip; enum names stay in data-testids
- `ui/src/pages/AgentDetail.tsx`: "Model: auto/k3" drops the adapter's `auto` routing prefix and shows the model name (or nothing when `auto` is all there is)
- `ui/src/pages/Auth.tsx`: "access this instance" → "sign in to your workspace"
- `ui/src/pages/InstanceExperimentalSettings.tsx`: the restart toggle drops the `pnpm dev:once` literal for "For local development servers only"
- `ui/src/pages/OrgChart.tsx`: Import/Export "company" → "workspace"
- `ui/src/adapters/adapter-display-registry.ts`: "Runs on your workspace server" → "Runs on your server" (fits the 9rem Team column)

Sidebar workspace name:
- `ui/src/components/SidebarCompanyMenu.tsx`: the truncated company name gets `title` so the full name is a hover away

One redaction mask:
- `ui/src/lib/redactSecrets.ts`: new `SECRET_MASK_DISPLAY = "•••• hidden"` and `displayMaskedSecrets`, which maps every stored marker spelling (`***REDACTED***`, `***SECRET_REF***`, the bracketed `REDACTED`/`REDACTED_*` server markers, `redacted-github-token`) onto it; the module's `redactSecrets`/`redactSecretsInValue` wrappers normalize their output so every existing call site (transcripts, run views, tool outputs) shows one mask. The `(?: hidden)?` tail in the marker regex keeps the wrapper idempotent under re-redaction
- `ui/src/components/IssueChatThread.tsx`: chat message bodies render through `redactSecrets` — own messages and comments show the same mask as transcripts
- `ui/src/components/CommentThread.tsx`: comment bodies render through `redactSecrets`
- `ui/src/pages/AgentDetail.tsx`: env/command/path displays emit `SECRET_MASK_DISPLAY` and normalize server-baked markers flowing through

Tests:
- `BreadcrumbBar.test.tsx`: phone chevron labelled "Back to <parent>", page name kept whole, desktop text preserved
- `accessible-names.test.tsx` (new): mobile tab select and Properties close button have names
- `IssueProperties.test.tsx`: the assignee arrow link is named after the agent
- `StatusIcon.test.tsx`: the icon-only button and standalone circle are named
- `redactSecrets.test.ts`: every stored marker spelling renders as `•••• hidden`
- Mask assertions updated to `•••• hidden` in `readableTranscript.test.ts`, `ReadableTranscript.test.tsx`, `RunTranscriptView.test.tsx`, `IssueChatThread.test.tsx`
- `AgentKindBadge.test.tsx`, `TaskOutcomeQualityPanel.test.tsx`: plain-language expectations

## Verification

- `pnpm -r typecheck`: pass (25 packages)
- `pnpm build`: pass
- `ui` vitest on touched files: `BreadcrumbBar` (4), `accessible-names` (3), `IssueProperties` (19), `StatusIcon` (6), `redactSecrets` (10), `readableTranscript` (118), `ReadableTranscript` (5), `RunTranscriptView` (9), `IssueChatThread` (52), `IssueDocumentsSection` (8+3), `IssueResultBlock` (10), `IssuesList` grouping-adjacent, `CommentThread` (6), `AgentPlanProposal` (13), `TaskOutcomeQualityPanel` (1), `AgentKindBadge` (9), `Agents` (6), `CompanySettings` (2), `CoSConversation` (11), `OrgChart` (5), `Routines` (5), `Auth` (4), `AgentDetail` (25) — all pass
- `IssuesList.test.tsx`: 15 tests fail with empty renders both before and after this change (verified by checking out `origin/main` and re-running — identical failures). Pre-existing local-environment breakage on this box, unrelated to the diff; CI runs this suite
- Playwright on `PAPERCLIP_E2E_PORT=3477` (db 23477): `mobile-floors.spec.ts` + `mobile-lists.spec.ts`

## Risks

- The mask is display-only; stored values still carry the original markers, so any surface that bypasses `ui/src/lib/redactSecrets` could still show a raw `***REDACTED***` — the three bypassing render paths found (chat text, comments, agent env) are now wired through
- `redactSecrets` on chat/comment bodies is new display hygiene; benign text passes through byte-for-byte (covered by the "leaves ordinary text alone" cases), but an unusual credential-shaped word in a human's message could be masked
- `StatusIcon`'s icon-only trigger changed element (`span` → `button`); anything styling the raw span still works, but deeply nested selectors could notice
- Plain-language strings may be referenced by docs or screenshots elsewhere

## AgentDash Review

- **Upstream impact:** Low. All edits are in AgentDash-owned UI components and libs; no schema, API or adapter contract changes
- **Agent-facing prompt surfaces:** No agent-facing behavior change — worker-visible words and endpoints are untouched, so neither prompt surface applies; the PR title carries the no-prompt-update marker
- **AgentDash-owned subsystem:** Breadcrumbs, issue chat/comments, Issues list, agent pages, plan proposal card, team badges, settings copy, redaction display

## Model Used

- Provider: Cognition
- Model: SWE-2 High (Devin CLI agent), tool use and code execution

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have filled out AgentDash Review with upstream impact, prompt-surface impact, and owned subsystem
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots
- [ ] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] If this is upstream-derived, I have followed `doc/UPSTREAM-POLICY.md` and recorded the upstream SHA/reason/verification
- [x] If this changes agent-facing behavior, I have updated both prompt surfaces (default AGENTS.md and agent-creator-from-proposal.ts) or explained why they do not apply
- [x] I will address all Greptile and reviewer comments before requesting merge
