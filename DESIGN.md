# Design

## Source of truth

Status: **Approved for build by Yang on October 29, 2026, together with the LLD.** Gate 1 adds
read-only Profile, Access and Performance tabs; editing, approval and history views come in
later gates (`doc/plans/2026-10-29-agent-performance-management-lld.md` §9).
Date: October 28, 2026 (America/Los_Angeles); status updated October 29.

Scope: Agent Performance Management operating-persona creation and linked
performance evidence, not a redesign of every AgentDash surface.

Requirements: [discovery draft](doc/plans/2026-10-28-agent-performance-management-discovery.md).
Evidence reviewed: `AGENTS.md`, `README.md`, `doc/PRODUCT.md`, the existing
assessment/evaluation/workforce code, `ui/src/App.tsx`, `AgentConfigForm.tsx`,
`AgentPlanProposal.tsx`, `AgentCreatorStudio.tsx`, `ui/src/styles/tokens.css`,
`docs/design/claude-design-system.md`, `doc/plans/2026-09-30-one-ux.md`, and the
existing Storybook/UX-baseline paths. No live UI, customer deployment or new
screenshots were inspected; interaction recommendations need later validation.

Current code uses Porcelain/clay tokens; the older design-system document names
coral values. Preserve the implemented tokens and primitives, not the older hex
values. Do not introduce a second theme to resolve that documentation mismatch.

## Brand

Calm, capable, evidence-led and business-readable. Trust comes from named owners,
versioned obligations, visible sources, honest missing evidence and inspectable
results. Avoid gamified trust scores, anthropomorphic reliability promises,
avatar-derived capability meters and a wall of raw model logs.

## Product goals

Help an owner configure autonomous AgentDash workers and assess continued trust.
Make the operating persona understandable before asking for runtime details.
Create a profile once; avoid asking the human to grade every task.

Non-goals: a new chat app, a new generic evaluation engine, a company-specific
UI fork, automatic hiring/activation, or visual polish masquerading as readiness.

Success signals to validate: time and effort to produce a usable profile, owner
corrections, clarity of gaps/authority, fewer repeated explanations and accurate
interpretation of evidence. Numeric targets await an observed baseline and owner
agreement; none has been established.

## Personas and jobs

- Business owner: translate responsibilities into an operating plan; see what is
  working, which gaps require action and what needs approval.
- Agent operator: inspect/edit source-backed profile fields and prepare bounded
  setup without accidental activation or permission expansion.
- Evaluator/reviewer: compare evidence with prospective criteria and report
  disagreement, coverage and uncertainty without becoming the business owner.

The managed worker is the autonomous AgentDash agent. Its runtime/provider and
the owner's personal harness are different concepts.

## Information architecture

Reuse existing Team/Agents entry points (`agents/new`, `agents/:agentId/:tab`)
and the company evaluation surface. Route names for any additional tabs remain
proposals until the current tab contract is reviewed.

Creation/revision flow: **Work to own → Operating profile → Boundaries and checks
→ Review plan**. Start from Markdown import/paste, an existing agent or an
approved role template. Existing agents receive proposed revisions, not duplicates.

The primary profile shows: purpose/duties; business owner; sources/knowledge;
skills and access; cadence and escalation; performance checks; communication
style. Runtime configuration is progressively disclosed as advanced setup.

Agent page tabs (LLD §6): Profile, Access, Performance, beside Overview, Runs and Settings.
Readiness gaps appear inside Profile and Access, and revision history inside Profile once
revisions exist (gate 2). Connect performance evidence to the profile/scenario version it assesses.

## Design principles

1. Every material field distinguishes supplied fact, proposal, confirmation and
   setup verification; a generated value is not silently promoted to truth.
2. Keep draft saving separate from plan approval, provisioning and trial start.
   Previewing must not invoke a provisioning GET or launch a run.
3. Capability and authority are separate. Neither an instruction nor a skill
   selection grants access. Show “Requested / not configured” where appropriate.
4. Keep automated assessment, human acceptance, actual use and outcomes separate.
5. Show obligations never attempted, not only the successful work that produced
   records. Unknown and stale are first-class states, not zero or failure.
6. One company UX; capability refusals get an explanatory state, not hidden
   profile-specific navigation. No new `productProfile` branches in the UI.
7. Owner-confirmed first-version boundary: the performance manager proposes
   operating-profile/cadence changes for owner approval; it never auto-applies
   them, including changes labeled low risk. Ordinary worker actions already
   authorized by the existing plan do not need a new per-action approval.

## Visual language

Reuse `ui/src/styles/tokens.css`: warm near-white surfaces, ink text and clay
accent. Use existing serif heading/sans body/mono technical-detail conventions,
4-pixel spacing scale, generous radii and restrained elevation. Read token names
through the existing primitives; no new hardcoded palette.

Use color only with a text label/icon for state. Motion is functional and subtle;
respect reduced motion. An existing avatar may identify the worker, but does not
encode readiness or add a required customization step.

## Components

Reuse Button/Card/Badge, MarkdownEditor, existing form primitives, owner/report
pickers, AgentPlanProposal and the agent-detail layout. Verify component contracts
before implementation rather than copying inline styles from the studio spike.

Proposed new compositions, not new design primitives:

- Scenario outline: covered duties, existing worker/proposed role and open gaps.
- Operating-profile editor with a live source-backed preview.
- Provenance field label with source/version and explicit proposal/missing state.
- Authority summary separating requested, configured and prohibited actions.
- Readiness gap list with owner, blocking reason and evidence.
- Performance case list with due/delivered/assessed/accepted/used states and a
  drill-down to evidence, versions and burden; no single overall trust gauge.
- Profile revision diff preserving prior evidence and showing stale applicability.

Proposed actions: Save draft, Export Markdown, Request plan approval. Any later
provision/configure/start-trial action needs its own reviewed authority contract.
For manager recommendations, show the proposed revision/diff, cited evidence,
reason, affected duties and owner decision state. Pending or rejected proposals
leave the active profile/cadence unchanged. An owner approval is not itself a
permission expansion or proof that the change was applied; retain separate
decision and application receipts through the authorized path.

## Accessibility

Design target: WCAG 2.2 AA, to be validated later, not a current compliance claim.
Use semantic labels, descriptions and headings; keyboard-operable steps and
source links; visible focus and inline errors associated with fields. Do not
move focus unexpectedly when extraction fills a draft. Announce save/errors via
appropriate live regions, not toasts alone. No color-only status, drag-only
scenario editing or hover-only evidence. Maintain readable contrast in both themes.

## Responsive behavior

Desktop: editor plus sticky preview/gaps summary; source details open without
losing the edited field. Narrow screens: stacked editor/preview, collapsible
sections and persistent explicit save action. Preserve focus and draft data
when changing sections. Case comparisons become labeled cards, not clipped
tables. Touch targets and disclosures must work without hover. Reuse current
breakpoints; exact visual baselines are still to be selected.

## Interaction states

- Empty: explain a useful responsibility and offer paste/import or existing-agent
  assessment; do not fill fictional company facts without labeling them.
- Loading/extraction: show progress and allow the owner to inspect/edit the brief;
  preserve their edits if extraction returns later.
- Partial/missing: identify the exact unknown and its owner; allow draft saving.
- Conflict/stale: show the revision that changed and a comparison; never overwrite
  current permissions, persona or criteria silently.
- Error/offline: preserve the visible unsaved draft; explain that nothing started.
  No automatic customer connection or provider retry to “repair” a preview.
- Success: say “Draft saved,” not “Agent ready” or “Agent started.”
- Disabled/unavailable: show the missing capability and authorized next step.
- Performance empty: “No observed cases yet,” not a zero score. Missing external
  use data remains unknown; no click is not evidence of nonuse or distrust.

## Content voice

Plain language: “Work this agent owns,” “What it needs,” “What it may do,”
“When to ask,” “How we will judge the work.” Explain runtime jargon only in
advanced setup. “Persona” includes operating role and style, not personality alone.
Use dates, sources and qualified claims. Never display a stored assessment
confidence value as a probability of business success.

## Implementation constraints

React/Vite/Tailwind and existing shared schemas/component system. All objects and
reads must be tenant/visibility scoped. Source documents and model suggestions
are untrusted content, not UI instructions or authority. Keep private task/harness
feedback out of company-wide profile text unless explicitly allowed.

Do not treat `AgentCreatorStudio` sample modules or its calculated coverage as
real capabilities. Preserve public-doc privacy. The current profile/hiring,
workforce, governance and correction queues should be reused, not bypassed.

Later verification should cover keyboard/mobile/contrast, draft persistence,
stale edits, company isolation, honest empty states, no save-to-start side effect,
and consistent profile delivery across supported adapters. No implementation,
tests, browser trials or screenshot baselines were run for this draft.

## Open questions

- [ ] Yang: map the first real responsibility to actual AgentDash workers and
  an accountable owner; this determines useful default fields and case evidence.
- [x] Yang: the first version is advisory-only. Manager-proposed profile/cadence
  changes require owner approval before application, including low-risk changes.
- [ ] Yang/business owner: agree baseline, thresholds, reviewer and use evidence;
  this determines the first performance view and trial decision.
- [ ] Yang: approve the save/approval/provision/trial separation and UI flow
  before mockup implementation or runtime integration.
