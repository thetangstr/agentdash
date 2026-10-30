# Agent Performance Management: discovery and design draft

Status: **Draft for Yang's alignment. Not approved for implementation or trials.**

Date: October 28, 2026 (America/Los_Angeles).

Repository evidence: local checkout at `c625911f56c5e212f9a851397a720358e009b798`,
branch `codex/acceptance-criteria-enforcement`, including the uncommitted
paired-harness evaluation slice. This is code inspection, not verification of a
customer deployment or a fresh GitHub comparison. No implementation, tests,
provider calls, provisioning, customer connections or configuration changes were
performed for this discovery pass.

## 1. What we want to make possible

A company describes the work it wants owned in a Markdown brief: roughly ten
scenarios, including work removed from people and genuinely new work. AgentDash
turns that brief into a proposed operating plan, then helps the company determine
whether its autonomous agents are earning continued trust through real evidence.

The product promise to validate is: **describe the business responsibility once;
get an inspectable agent operating plan, then see whether the work is actually
getting done acceptably and with less supervision.** This is a hypothesis, not a
claim of proven customer value.

Yang confirmed two primary decisions for the first version:

1. Choose and configure an agent operating plan for owner approval.
2. Decide whether existing agents are earning continued trust.

Yang also confirmed a good persona-creation UI is in scope. A persona means the
**full operating profile, including communication style**, not just a name,
avatar or personality prompt.

Yang confirmed the first-version change boundary: **the performance manager
proposes changes for owner approval; it does not apply them automatically**, even
when a proposed change is labeled low risk. This covers changes it recommends to
the worker's operating profile or cadence. It does not require a new human
approval for every ordinary worker action already authorized by the existing plan.

The worker being managed is the autonomous agent inside AgentDash. Claude Code,
Codex and other adapters are execution runtimes; a person's paired local session
can provide feedback, but is not the target worker product.

## 2. What the owner should provide next

Please return a company brief, the actual AgentDash agent roster to use, how
those agents should be set up, and how their performance should be measured.
Do not create an agent just to fill a role listed below. One existing agent can
cover several responsibilities when its scope and capacity support that choice.

```markdown
# Company agent-work brief

Company / tenant identifier:
Business owner and report recipient:
Business objective:
Existing autonomous AgentDash agents (IDs, roles, accountable owners):
Approved company sources and their owners:
Restrictions / actions that remain human-owned:

## Scenario S01 — [a real responsibility]
Stakeholders and decision this supports:
Current process and who does it today:
Work to remove from people, or new work to enable:
Trigger / frequency / deadline / timezone:
Inputs and authoritative sources (include freshness rules):
Expected flow and counterpart agents / people:
Deliverable and delivery destination:
What acceptable work means; examples / counterexamples if available:
What acceptance does NOT prove (for example, actual use):
Required systems and read / draft / write authority:
What the agent may decide; what needs approval:
Escalation owner and when to escalate:
Baseline, measurement source and unresolved target decisions:
Known setup / review / correction burden:
Failure consequences and unacceptable failures:

## Scenario S02 … S10
Repeat the scenario fields; leave missing facts explicitly unknown.
```

Ten is a useful portfolio size, not a requirement to invent ten use cases. Start
with a genuine scenario and extend the same structure. Do not substitute industry
averages, model confidence or guessed time savings for company evidence.

## 3. What already exists, and what it does not establish

| Existing piece, observed in this checkout | Useful foundation | Limit relevant to this proposal |
| --- | --- | --- |
| Readiness assessment and project assessment | Company intake, generated assessment and jumpstart documents; project intake asks about measurable baselines and targets. | Consulting-style reports are not observed worker performance. `assess.ts` persists fixed confidence values such as `0.95`; these must not be presented as success probability. |
| Agent plan proposal and hiring path | Plans contain roles, responsibilities and KPIs; accepted plans can create managed workers. | A generated plan is not an executable, verified operating profile. Proposal review must stay separate from provisioning and activation. |
| Workforce brief, enrollment and readiness | Approved company facts, source references, pinned role templates/skills, first-job artifact and a current neutral passed verdict; pending required facts prevent readiness. | Readiness is scoped to this enrollment and first-job evidence, not proof of arbitrary duties or continued reliability. Human review of shared company facts remains an existing boundary. |
| Company evaluator | Company-scoped evidence ledger, replayable/versioned milestone cards, contracts, confidence/coverage, findings, correction/disposition records and review items. | Defaults are engineering-oriented. Cadence is opt-in in code; no current tenant configuration was inspected. Existing composites are not business-wide success probabilities. |
| DoD, verdict and handoff infrastructure | A flagged backlog-exit DoD guard, review queue/verdict routes and dependency/ownership machinery. | A DoD existing is not proof that all criteria were met. This discovery does not certify every completion or dependency-release path. |
| Private memory and correction delivery | Versioned per-agent memory and corrections offered on ordinary wakes, above the adapter/session layer. | Memory informs; it cannot grant authority. Stored or delivered feedback does not prove a lesson was applied correctly. |
| Paired-harness assessments added locally on October 28 | Version-bound automated acceptance replies, private receipts and workflow-scoped lessons for the paired agent's next wake. | Uncommitted, not deployed. Evidence references are harness-supplied claims; no automatic task closing, human approval or actual-use inference. No explicit semantic mapping into the company evaluator was found. |
| Existing agent UI | Agent details/configuration, plan proposal cards and an agent-creator studio. | The studio says “Phase 0 — avatar A/B spike,” uses sample capabilities and has no backend. It is not a functioning operating-profile editor. |

Evidence locations are listed in section 12. “Exists in code” is deliberately
separate from deployed, enabled, exercised or proven useful.

## 4. Proposed smallest coherent product slice

Build **one versioned scenario-to-operating-profile loop**, not another generic
grading engine or a fleet of newly hired agents:

1. Import/paste the company's Markdown brief and preserve its revision.
2. Extract scenarios, clearly separating supplied facts, proposed interpretations
   and missing decisions. Ask only questions that materially change the plan.
3. Match each scenario to existing workers and approved capabilities. Recommend
   reuse, a bounded change, a new role proposal, a deterministic workflow or
   keeping the work human-owned. Explain why; never create roles automatically.
4. Present/edit the operating persona and its readiness gaps in a usable UI.
5. Produce a reviewed operating plan and a prospective performance contract for
   a representative real job. Saving the draft does not start work.
6. After separately authorized trials, show evidence against those same
   responsibilities, including work owed but never started, supervision effort,
   and unresolved outcome questions. Recommend continue, narrow, repair, pause
   or gather more evidence; do not manufacture a universal trust score.

The **first design deliverable** is this draft and the linked UI contract. The
**first implementation milestone**, if approved later, should cover brief →
scenario mapping → editable persona → operating plan and measurement contract.
Observed-performance reporting is the linked next stage, not a claim already
proved by a generated plan.

## 5. Operating persona: the reusable contract

Each version identifies a company, agent (or explicitly unbound draft), owner,
brief/scenario revisions and source references. It includes:

- Identity and style: name/title, concise role summary, audience, tone, example
  response, how uncertainty is communicated. Identity never substitutes for capability.
- Responsibility: business outcome, duties owned, work explicitly not owned,
  stakeholder needs and the scenarios covered.
- Company understanding: authoritative sources, relevant rules, freshness and
  known unknowns; distinguish approved shared facts from task-private inputs.
- Capability and access: required skills/tools, verified vs claimed availability,
  data scopes, counterpart dependencies and execution environment constraints.
- Authority: allowed read/draft/write actions, approval boundaries, budget and
  irreversible-action restrictions. Proposed authority is not an active grant.
- Operating rhythm: trigger/cadence, due obligations, quiet hours/timezone,
  reporting recipient, dependency waits, retry limits and escalation rules.
- Performance: criteria and evidence per scenario, grader/reviewer identities,
  baseline source, human burden, cost/time limits and owner-agreed thresholds.
- Lifecycle: draft, setup incomplete, ready for a bounded trial, trial observed,
  operating under an approved scope, or needs reassessment. These are proposed
  product states, not new database enums or a replacement for existing agent status.

An existing agent gets a proposed profile revision, not a second identity. New
personas remain unbound drafts until authorized provisioning. Preserve the
previous profile and judgments when a brief, source, model, skill or mandate
changes; determine which evidence remains applicable rather than silently
resetting history or carrying trust forward.

Terminology caution: the existing `mandates` table represents delegated
permissions/scope/spend/expiry. A business-role charter is not itself such a
permission grant; do not overload that table just because both use “mandate.”

## 6. UI proposal

Follow [DESIGN.md](../../DESIGN.md), scoped to this feature and still a draft.

- Enter from the existing Team/Agents creation flow, or assess an existing agent.
  Paste/import a brief rather than filling a long form from scratch.
- Four progressive sections: **Work to own → Operating profile → Boundaries and
  checks → Review plan**. Keep an editable profile and source-backed preview
  side by side on desktop; stack them on mobile.
- Show provenance beside material fields: from brief, inferred/proposed, owner
  confirmed, setup verified, or missing. A polished preview must not look ready
  when access or evidence is unverified.
- Keep runtime/provider details in advanced setup; keep business responsibility,
  owner, output and next blocker visible first.
- Offer “Save draft” and “Export Markdown.” Separate later actions to approve
  the plan, provision/configure the worker and authorize a bounded trial. Their
  performance manager cannot apply proposed profile/cadence changes without
  owner approval. Approval and subsequent application retain existing permissions;
  neither draft saving nor an assessment starts execution.
- A performance tab compares the current profile with evidence: work due,
  attempted/delivered, assessed, accepted, used, outcomes and burden. Every
  summary links to its cases, dates and coverage gaps. No avatar-derived
  coverage meter, leaderboard or “95% ready” badge.

This is an information/interaction design, not a rendered or usability-tested
mockup. Reuse the current token/component system, not an additional design system.

## 7. Roles to map onto the actual AgentDash roster

| Responsibility, not an instruction to hire | Work and limits | Owner input needed |
| --- | --- | --- |
| Business owner | Confirms objectives, authoritative sources, authority and the decision to accept operational risk. Does not rate every routine result. | Actual owner and delegate identities. |
| Performance planner / manager | Reads the authorized brief and roster, drafts scenario mappings/personas, identifies readiness gaps and proposes evidence-backed changes. Advisory-only in the first version; owner approval is required before applying proposed profile/cadence changes. | Existing agent ID, permitted inputs, report owner and cadence. A CoS may cover this before a new role is justified. |
| Autonomous business worker(s) | Own approved business duties in AgentDash; produce inspectable artifacts and execution receipts; escalate gaps within scope. | Actual workers, setup instructions and scenarios assigned. |
| Evaluator / reviewer | Checks result/process evidence independently where required, records uncertainty and disputes, and reports missing coverage. Does not self-certify its own plans or expand worker authority. | Existing evaluator/reviewer, independence policy and evaluation method. |
| Optional personal harness | Contributes scoped automated acceptance/correction feedback from its person's delegation loop. | Whether available; lack of a running harness must not erase business obligations or disable all assessment. |

The performance-management function also needs evaluation: scenario coverage,
unsupported recommendations, false-ready/false-blocked cases, actionable gaps,
owner correction effort and the results of recommendations actually adopted.
Yang will supply reference judgments and acceptable targets; we must not let the
manager establish its own success by approving its own plans.

## 8. Measuring readiness and performance honestly

**Before trials:** use a per-scenario evidence/gap matrix. For knowledge, skill,
access, authority, dependencies and measurement, record evidenced, declared but
unverified, missing/blocked, or not applicable with a reason and owner. Readiness
means prerequisites for a specified trial are covered, not “an X% chance of success.”

**After authorized trials:** preserve the entire planned case set, including
failures, blocked/not-started work, retries, cancellations and unknowns. Report
counts/denominators, scenario/risk coverage, versions, dates and uncertainty.
Repeated runs of the same input are not independent customer validations.

| Measurement | What to capture and compare | What must not be inferred |
| --- | --- | --- |
| Work owed | Expected trigger/deadline and whether the agent noticed and started it. | Only issued tasks or successful runs cannot be the denominator. |
| Task quality | Criterion-level result, evidence/version, grader type, contradictions and unknowns. | A completion status or nonempty artifact is not correctness. |
| Acceptance and use | Separate automated assessment, authorized human acceptance and observed use/inclusion/send records. | A harness's “accepted” is neither a human signature nor proof of use. |
| Human burden | Setup/context, answering/chasing, review and correction minutes, plus repeated explanations. Separate first job from recurring jobs. | Comment counts are only proxies, not minutes or saved effort. |
| Time and cost | End-to-end turnaround, blocked time, model/tool/reviewer/retry cost and missing cost data. | Fast runs or low token spend do not establish value. |
| Business outcomes | Customer-owned metric, source, observation window and confounders. | Accepted deck content does not prove better business decisions or revenue. |

Compare the current human workflow and competent ordinary-assistant use with
equivalent authorized facts, tools and assets. For genuinely new work there may
be no prior-workflow baseline: say so and assess usefulness/value directly.
Targets are proposed from the measured baseline and explicitly agreed by the
business owner. No fabricated savings, readiness percentage or universal score.

Use the existing [workforce outcome protocol](2026-09-29-workforce-outcome-evaluation.md)
as a starting point for paired jobs and fair comparisons. Do not silently adopt
a fixed one-week pilot: first real job, then repetition according to job cadence
and failure risk. Time windows and sample size must fit the responsibility.

## 9. Feedback, memory and disagreement

Agent-to-agent feedback is the normal low-friction signal. Preserve source
identity, artifact/criterion/profile versions and the original assessment.
Task-only corrections stay on the case. Reusable lessons retain person/workflow
scope and source receipt; company-wide knowledge or policy changes retain their
existing approval boundary. Nothing learned grants access or authority.

If a personal harness approves a result but an independent reviewer finds an
unsupported claim or an unauthorized action, retain the disagreement and route
it to the accountable owner. Do not resolve it by vote, erase the failure or
convert harness confidence into human approval. Use sampled calibration and
exception review rather than requiring a human to score every task.

## 10. Design/gap analysis and likely integration

- Reuse revisioned issue documents for the initial brief, operating profile and
  plan; pin company/agent/scenario/source revisions. Prefer a small validated
  scenario/profile manifest over a new parallel workspace or knowledge store.
  New schema/API contracts remain proposals until requirements are aligned.
- Reuse workforce facts, templates, input holds and first-job readiness; add
  scenario coverage and explicit knowledge/access/authority gaps rather than
  replace existing gates with generated prose.
- Reuse existing plan/hire confirmation. A persona save must not invoke hire,
  heartbeat, enrollment, permission changes or `/me/agent`-style provisioning
  merely to preview a profile.
- Reuse the evaluation ledger/cards/replay for evidence-backed reporting, but
  design domain-specific evidence profiles. Today derived contracts retain an
  engineering-default evidence set and no derived measurable acceptance criteria.
  Do not label a deck deficient solely for lacking a PR/CI record, or silently
  waive safety evidence. Profile and contract exceptions need explicit policy.
- Map harness receipts as attributed automated observations, not customer
  acceptance dispositions. This mapping and actual-use/burden measurement are
  gaps; the local receipt tool alone does not close them.
- Validate outcome/process metrics and authority rules against actual approved
  operating plans. The existing historical authority-calibration report shows
  why a missing record or an unknown previous owner must not be called misconduct.
- Extend existing agent creation/details and evaluation views. Do not build a
  new app, duplicate company-specific UX or treat the avatar prototype as a
  verified capabilities catalogue.

## 11. Acceptance criteria and staged validation (proposed, not run)

### Design gate — current stage

1. The owner can use this Markdown to supply the real scenarios, agents, setup
   instructions and performance measures. Confirmed decisions and open proposals
   are distinguishable.
2. All scenarios map to a worker/role proposal or an explicit unresolved gap.
   Each has owner, outputs, prerequisites, authority, cadence and measurable checks.
3. Persona design covers the full operating profile and style; the owner can
   trace material fields to the brief or a labeled proposal.
4. Readiness and observed performance remain distinct; no unsupported success
   estimate, customer-use inference or automatic permission grant appears.
5. Yang aligns the first scenario, roster, UI flow and change-approval boundary
   before any implementation, tests, new agents or trials.
6. A manager recommendation includes the proposed revision, evidence and reason,
   affected responsibilities, expected benefit/risks, and owner decision state.
   Pending/rejected proposals do not change the active profile or cadence. An
   automated assessment, low-risk label or memory entry cannot count as approval.
   Approved changes still require an authorized application path and retain the
   previous version and decision provenance.

### Later stage A — offline walkthrough, after approval

Walk one supplied scenario through the plan/profile design. Include missing or
stale sources, overlapping agents, absent authority, duplicate triggers and a
disagreement between evaluator and requester. Confirm useful output and narrow
the first implementation milestone. A fictional case is labeled fictional.

### Later stage B — bounded representative job, separately authorized

Pin brief/profile/criteria/runtime versions and the baseline; record every
planned attempt and who can judge it. Check useful artifact, honest state,
source correctness, permitted actions, elapsed cost and supervision burden.
Fatal privacy, authorization or false-execution claims block expansion regardless
of averages. Agree quality/time/burden thresholds with the owner before launch.

### Later stage C — repeat and assess continued trust

Repeat according to cadence/risk, including a second similar job to test reuse
and changed inputs to test refresh. Compare the baseline and all observed cases;
report limitations. Validate another materially different workflow/company
before claiming the product works across customers. Separately validate persona
usability, accessibility, draft safety, tenant isolation and runtime delivery.

### Open alignment decisions

- [x] Primary purpose: operating-plan configuration **and** continued trust.
- [x] Persona: full operating profile, including style.
- [ ] Which real scenario and actual agent roster anchor the first walkthrough?
- [x] First-version performance manager proposes changes for owner approval;
  no automatic application of operating-profile or cadence changes, including
  low-risk changes. Existing authorized worker autonomy is unchanged.
- [ ] Who approves baseline/thresholds, judges disagreements and observes use?
- [ ] Which systems and evidence are actually accessible to the proposed agents?
- [ ] Confirm the first UI's save/approval/provision/trial separation and the
  smallest milestone to implement after review.
- [x] October 29: the **agent** is the subject of evaluation; project and goal
  results roll up into the evaluation of the agents who led or did the work.
- [x] October 29: humans define what good looks like (criteria, evidence,
  thresholds); agents may draft criteria for human approval. Results first.
- [x] October 29: humans define access — what an agent can see, do and talk to —
  and it is one of the most important things they set.

The low-level design built on these decisions (revision 2, after Codex review round 1):
[overview and profile](2026-10-29-agent-performance-management-lld.md),
[agent evaluation](2026-10-29-agent-evaluation-lld.md) and
[agent access](2026-10-29-agent-access-lld.md).

MK-specific context is private and not copied into this repo document. No MK
connection or customer mutation is part of this plan. A disconnected environment
is an access blocker, not evidence that an agent failed a business responsibility.

## 12. Local source map

- [Product and runtime distinction](../PRODUCT.md), [one UX](2026-09-30-one-ux.md).
- [Existing assessment](../../server/src/services/assess.ts),
  [project prompts](../../server/src/services/assess-project-prompts.ts).
- [Plan validator](../../packages/shared/src/validators/agent-plan.ts),
  [managed hiring](../../server/src/services/agent-creator-from-proposal.ts).
- [Workforce facts/enrollment/readiness](../../server/src/services/workforce.ts),
  [input scoping](../../server/src/services/workforce-inputs.ts).
- [Evaluator routes](../../server/src/routes/evaluation.ts),
  [contract resolution/default evidence](../../server/src/services/evaluation/scoring/contract.ts),
  [metrics](../../server/src/services/evaluation/scoring/metrics.ts),
  [confidence](../../server/src/services/evaluation/scoring/confidence.ts),
  [scorecard replay/versioning](../../server/src/services/evaluation/scorecards.ts),
  [scheduler opt-in](../../server/src/index.ts),
  [existing authority calibration](2026-09-07-company-evaluator-authority-calibration.md).
- [DoD guard](../../server/src/services/dod-guard.ts),
  [current patch invocation](../../server/src/services/issue-patch-actions.ts),
  [verdict orchestration](../../server/src/services/cos-verdict-orchestrator.ts).
- [Permission mandates](../../packages/db/src/schema/mandates.ts),
  [private versioned memory](../../packages/db/src/schema/agent_memory.ts).
- Local harness-feedback contract and implementation: not on `main`; they live uncommitted on
  branch `codex/acceptance-criteria-enforcement` (`doc/plans/2026-10-28-paired-harness-evaluation.md`,
  `server/src/services/work-evaluations.ts`).
- [Creator studio prototype](../../ui/src/pages/AgentCreatorStudio.tsx),
  [agent configuration](../../ui/src/components/AgentConfigForm.tsx),
  [plan proposal UI](../../ui/src/components/cards/AgentPlanProposal.tsx).
