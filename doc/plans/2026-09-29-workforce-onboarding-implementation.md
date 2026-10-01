# Workforce onboarding to first useful job implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Integrate versioned role templates, company learning, durable clarification and reviewed first-job completion into the launch product.

**Architecture:** A shared catalog and company-scoped workforce enrollment service reuse existing skills, company context, issues, documents/work products and neutral verdicts. All hiring routes select the same pinned template; every supported worker adapter receives that role's procedures and current approved company context. Persisted questions hold dependent dispatch and explicit human-approved answers can update company knowledge.

**Tech Stack:** TypeScript, Express, Drizzle/Postgres, Zod, React/ReactQuery, Vitest, existing adapter utilities.

**Spec:** `doc/plans/2026-09-29-workforce-templates-requirements.md`, sections11-12; build authorized by the founder September29.

## Current progress

- **Built and reviewed:** marketing and sales templates, approved company context, durable clarification, first-job artifact/review readiness, integration through hiring, and the human UI. The named-human bridge foundation and canonical issue/tree acceptance prerequisites are also reviewed.
- **Working on now:** Task5, making every human-facing workflow available through API/MCP/bridge. Credential provenance, native source tracking, shared identity, permission integration and separate skill-installation stages have passed their scoped reviews. Required inactive-owner recovery is blocked by a reproduced stewardship-transfer deadlock; Task5b1a is incomplete. The September30 draft PR publishes reviewed work, excluding the unfinished recovery source.
- **Required recovery fix:** a real local test demonstrated that a pending required question can strand its task after the named human owner leaves. Safe discovery, explicit cancellation/replacement and a genuine answer by the new accountable human are mandatory before the parent integration gate passes.
- **Remaining launch proof:** complete the transport coverage ledger, run the composed onboarding-to-reviewed-output workflow with isolation/recovery checks, pass full typecheck/tests/build, and perform real marketing/sales output-quality and cost trials. Deterministic tests do not certify customer output quality.

See the [build evidence](2026-09-29-workforce-build-evidence.md) for tested commits and the [transport coverage ledger](2026-09-29-human-control-plane-transport-coverage.md) for pending page/action families. Work remains on the isolated feature branch; launch is not certified.

## Global Constraints

- No new dependencies. Work only in `codex/workforce-onboarding-20260929`; main/live3199/customer/Monica/ExecOS/Funnel stay untouched.
- Launch catalog is `marketing-content` and `sales-support`, version1. Role does not grant authority. Preserve capacities, approvals, budgets, atomic checkout and activity logs.
- Company knowledge is explicitly shared by a human; never flatten private/project answers into company truth. Agent-proposed facts remain unconfirmed until human review.
- Pending questions hold only the dependent issue. Cancellation is not a sufficient answer. Repeated wakes do not spend adapter calls while waiting.
- First-job acceptance requires actual artifact evidence and a neutral passed verdict, not setup completion or an agent-written flag.
- Use real local database/route tests where correctness depends on state, isolation or concurrency. External model/providers stay fake in deterministic tests; real outcome quality remains a separate launch gate.
- Update all4 agent-facing surfaces, preserving the unified default worker bundle. CEO/CoS files are inert explanatory comments, not restored personas.
- Human-facing launch workflows must be available through API/MCP/bridge with equivalent actor/company scope and confirmation. No laptop-execution capability widening, Gmail sends, calendar/CRM rollout, paid provider calls, deployments or customer outreach in this feature.
- Every local commit follows Lore trailers; stage only owned paths. Never revert another person's edits. Implementers do not spawn children.

## Shared contracts

Catalog `WorkforceTemplate`: `{ id, version:1, name, description, responsibilities:string[], requiredFactKeys:string[], procedures:string[], skills:{key:string,name:string,description:string,content:string}[], qualityChecks:string[], suggestedMetrics:string[], starterJob:{ title, description } }`. Marketing keys: `offer`, `audience`, `brandVoice`, `approvedClaims`; sales keys: `offer`, `pricing`, `idealCustomer`, `qualificationRules`. Procedures instruct source lookup, use of actual assets, focused clarification, appropriate escalation, tangible deliverables and honest execution state.

`WorkforceBrief`: `{ revision:number, sources:{id:string,label:string,content:string}[], facts:{key:string,value:string,sourceReference:string}[], confirmedByUserId:string|null, updatedAt:string|null }`. Sources are explicit company-wide shared input; facts in the current brief are human-confirmed. Empty brief revision0 is valid. Bounds: max12sources; content<=12000chars/source; max40facts; key<=120chars; value<=4000chars; sourceReference<=500chars; duplicate keys/IDs rejected. Runtime prompt has a bounded summary; full authorized sources are available via API.

New `workforce_enrollments` table: ID/companyId/agentId/templateId/templateVersion/objective/goalId/metricsJSON/learnedBriefRevision/firstJobIssueId/installedSkillKeysJSON/skillInstallError/createdAt/updatedAt. One current enrollment per agent, immutable template assignment for launch. Agent/company association must be checked in every service lookup; FK alone is insufficient. No mutable accepted flag. Current acceptance is derived from first job, artifacts and latest neutral verdict.

`WorkforceReadiness`: `{ phase:'learning'|'needs_input'|'working'|'awaiting_review'|'ready'|'refresh_needed', missingFactKeys:string[], pendingQuestionIds:string[], firstJobIssueId:string|null, acceptedVerdictId:string|null, briefRevision:number, learnedBriefRevision:number|null, reason:string }`.

`workforceService(db)` methods:
- `getBrief(companyId):Promise<WorkforceBrief>`
- `updateBrief(companyId,{expectedRevision,sources,facts},actor:{userId:string}):Promise<WorkforceBrief>`; company-row serialization, compare revision409, append immutable revision and update current in one transaction.
- `proposeFacts(companyId,agentId,{facts,sourceReferences}):Promise<proposal>`; own-company agent input stays proposed, never published automatically.
- `enroll(companyId,agentId,{templateId,objective?,goalId?,metrics?},actor):Promise<enrollment>`; same selection idempotent, different selection409; preserve agent metadata/custom instructions.
- `getEnrollment(companyId,agentId):Promise<enrollment|null>`
- `getReadiness(companyId,agentId):Promise<WorkforceReadiness|null>`
- `startFirstJob(companyId,agentId,actor):Promise<issue>`; company/agent serialization, idempotent existing job, assign enrolled agent, ordinary DoD criteria, originKind `workforce_onboarding`. Preserve all issue creation contracts. Optional enrollment goalId must reference an existing goal in the same company and is copied onto the first job; reject cross-company goal references. Metrics are declared targets, not claimed outcome measurements.
- `acknowledgeLearning(companyId,agentId,revision,actor):Promise<enrollment>`; only exact current revision; actor is own agent or authorized board.
- `ensureSkillsInstalled(companyId,agentId,actor):Promise<enrollment>`; idempotently register curated version-pinned local SKILL.md content with existing companySkills service, assign through existing skill mechanism, and record installation/error; run filesystem work outside parent hiring DB transactions.
- `getRuntimeContext(companyId,agentId,issueId?):Promise<WorkforceRuntimeContext|null>`; known pinned catalog plus current approved knowledge, scoped sources and task requirements; never authorization.

Company routes under `/api/companies/:companyId/workforce`: GET templates/brief; PUT brief; POST proposals; GET/POST agents/:agentId/enrollment; GET agents/:agentId/readiness; POST agents/:agentId/first-job; POST agents/:agentId/learned; POST agents/:agentId/install-skills retry. Company access everywhere; human direction authority for publishing facts/enrollment/job start; worker reads/proposals/learning limited to own agent. Activity logs all mutations.

## Task 1: Catalog, approved company context and enrollment/first-job backend

**Owned files:** new shared `types/workforce.ts`, `validators/workforce.ts`, `workforce-templates.ts` and exports; new DB schema `workforce_enrollments.ts`, exports and generated migration; new server `services/workforce.ts`, `routes/workforce.ts`, registration in app; tests `workforce.test.ts` and `workforce-routes.test.ts`. Add `workforceTemplateId` to agent validator and service create signature only as needed; strip it before inserting schema columns. Core creation records enrollment using the shared catalog. Default no-selection creation remains unchanged. Do not edit other hiring materializers yet.

**Interfaces:** produces the contracts above and `resolveWorkforceTemplate(id,version=1)` in shared catalog. `agentService.create` accepts optional `workforceTemplateId`; no extra raw DB column/unchecked metadata flag. UI and Task2 consume API/shared types.

- [x] Write red real-database/route tests for company isolation, agent self-scope, human-only brief publish, empty/current brief, concurrent revision409, immutable history, stable enrollment/pin, simultaneous first-job creation, current-revision acknowledgment, passed-verdict-plus-artifact acceptance versus failed/escalated/pending verdict.
- [x] Run targeted Vitest and record the expected failures before production changes.
- [x] Implement bounds and source/fact validation, role catalog with substantive procedures/quality checks and real curated SKILL.md content, idempotent existing-library skill registration helper, enrollment schema, migrate, serialized service operations and routes.
- [x] Use the existing issue/document/work-product/verdict services; startup job is a normal issue. Missing knowledge permits learning/clarification, not fabricated completed output. Readiness verifies persisted facts/questions/evidence.
- [x] Re-run targeted tests, shared/DB/server typecheck as practical, diff check; report command/logs and red/green evidence.
- [x] Commit owned files using Lore; write task report and freeze for independent review.

Test behavior examples:
```ts
const brief = await svc.updateBrief(companyA,{expectedRevision:0,sources:[],facts:[{key:'offer',value:'Tax preparation',sourceReference:'Owner intake'}]},owner);
expect(brief.revision).toBe(1);
await expect(svc.updateBrief(companyA,{expectedRevision:0,sources:[],facts:[]},owner)).rejects.toMatchObject({status:409});
await expect(svc.enroll(companyB,agentA,{templateId:'sales-support'},owner)).rejects.toMatchObject({status:404});
const [one,two]=await Promise.all([svc.startFirstJob(companyA,agentA,owner),svc.startFirstJob(companyA,agentA,owner)]);
expect(one.id).toBe(two.id);
```

## Task 2: Real clarification waits and runtime company learning

**Owned files:** shared question types/validators in `types/issue.ts`, `validators/issue.ts`; MCP worker question tool in `tools.ts`; `services/issue-thread-interactions.ts`, issue respond route, `services/heartbeat.ts`, workforce service readiness/compatibility internals, central agent adapter-change compatibility guard, scoped issue completion/input query guard, owned-question WaitingOnYou projection/shared read model and first-job route wake; new shared adapter workforce renderer and exports, every adapter prompt assembly that consumes worker directives/memory; question card component/test; all4 prompt surfaces; focused tests for text answers, sharing, runtime rendering and dispatch. Do not change Task1 catalog/service contracts without a ledger ruling.

**Interfaces:** add `selectionMode:'text'`, empty options only for text; optional `companyFactKey` on question; a named answer owner resolved from the issue assignee's existing accountability, pinned on the interaction and validated against active company membership at creation and answer; only its authenticated owner answers workforce fact questions. Unpaired agents need assignment before asking; cancellation/replacement explicitly changes ownership. The card/comment fallback uses the same human response endpoint and interaction/question IDs, not inferred comment text; answer `{questionId,optionIds:[],text}` for text; response optional `shareWithCompany:boolean` defaultfalse. Existing single/multi payloads retain behavior. Human opt-in sharing allowed only for company-level (projectIdnull) issues and known enrolled template fact keys. Otherwise preserve answers on the issue without globalizing them. Company brief mutation and interaction answered transition commit atomically. Required input is satisfied by current approved company facts or appropriately scoped answered task questions; opting out of global sharing must not prevent the task from using its own answer. Pending/cancelled required questions never become readiness merely from wake metadata. Cancellation may be cleared only by explicit sufficient input/replacement or cancelling the dependent job, not by an automatic retry loop.

- [x] Write red tests: required trimmed text, illegal selected IDs/text combinations, duplicate question answer, cancelled required question, project/private answer not shared, agent cannot publish facts, opt-in answer survives restart/new hire, concurrent answers update once.
- [x] Write red heartbeat tests showing persisted pending workforce questions prevent adapter invocation despite forged resolved wake metadata; unrelated issue runs; insufficient/cancelled answers do not grant readiness; genuine answer resumes once.
- [x] Implement text normalization/storage/UI controls and explicitly confirmed fact sharing. Preserve resolved-interaction continuation policy and check DB state rather than trusting wake labels.
- [x] Export an explicit verified native-runtime support contract; unsupported generic HTTP/process/plugin runners retain ordinary use but reject workforce activation, and enrolled-agent adapter changes preserve compatibility.
- [x] Add `paperclipWorkforce` runtime context and adapter-neutral `renderWorkforcePrompt(value)`; invoke in every supported worker adapter prompt path. Label company sources/facts as data, separately from mandate/directives/agent memory. Include template version, objective/metrics, procedures/checks, knowledge revision and source refs. Full source content remains scoped API input.
- [x] Wire first-job start to ordinary heartbeat dispatch after persisted creation, with explicit new/existing result distinction and duplicate start/retry protection; then gate workforce pending questions at queued-run claim and suppress redundant wake dispatch. Creation cannot terminate an already-running adapter; prompts require stopping dependent work immediately after asking, and completion/readiness rejects pending inputs.
- [x] Update canonical default instructions and creator rendered prompt; CEO/CoS inert comments explain shared applicability. HTTP endpoints and card/comment fallback, no adapter-specific authority.
- [x] Run focused suites and actual adapter prompt-contract tests; commit/report/freeze for task review.

## Task 3: One template contract through every hiring experience

**Owned files:** proposal type/parser/replier and `agent-creator-from-proposal.ts`; shared team-card type/validator; `onboarding-v2.ts` plan generate/revise/confirm; ordinary agents routes; assistant gated hire input/pinned payload/tool fields. Tests cover each actual creation path. Read earlier task prompt comments; retain them.

**Interfaces:** optional `workforceTemplateId` is explicit in proposals/plans/ordinary create/hire/assistant prepare. Pin ID/version in assistant prepared handle, then confirm the pinned selection. Supported template assignment uses Task1 central enrollment; every adapter receives Task2 runtime role procedures regardless of custom instruction materialization. After the hiring transaction commits, call ensureSkillsInstalled using the real DB; failed installation remains visible/retryable and cannot be presented as ready. Role/display enum and authority remain independent.

- [x] Write red route/service tests for same selected catalog/version through all4 hire paths, no selection compatibility, unknown ID refusal, assistant pin/replay/isolation and custom instructions preservation.
- [x] Implement explicit template selection and catalog-aware proposal prompts. Legacy saved cards without the field still validate; ambiguous role requests remain custom/unselected rather than guessing permissions. Remove the single-creator hardcoded Claude choice using the actual company's configured adapter; preserve existing governance and capacity checks.
- [x] Ensure managed skill/instruction refresh cannot erase the runtime role layer; do not duplicate the canonical mandate into template files. Creation/readiness are distinct: workspace creation does not claim first-job acceptance.
- [x] Run each creation-path regression and targeted typecheck; commit/report/task review.

## Task 4: Company knowledge, role selection and first-job UI

**Owned files:** new UI API `workforce.ts`, reusable workforce panel/page and tests; company route/nav hooks; NewAgent payload/page/dialog; agent detail readiness panel; team plan card; CoS confirmation links; Home/Decisions owned-question rendering and badge math; company-scoped human proposal-list/review and enrollment-objective edit service/routes/shared contracts and focused tests. No bridge/billing behavior edits.

**Interfaces:** consume Task1 types/routes and Task3 hire fields. Proposed route `workforce` under existing company-prefix routing, with links from company setup, agent detail and hiring. It coordinates existing issues/inbox and does not create a second task executor.

- [ ] Write red component tests for selection→hire payload, company switch isolation, brief revision conflicts, opt-in company-wide source/fact saving, enrollment/start/retry and awaiting-review versus accepted readiness. Use real components with fake HTTP only.
  - Task4 is independently reviewed and complete; recorded assertion reds cover selection/owner/error/readiness and the states have passing component coverage. Complete historical red evidence for every listed state was not retained and is not retroactively claimed. See build evidence and review report.
- [x] Add human-only proposal list and explicit approve/reject review with revision/source guards and atomic publication/review audit; proposals must be visible without becoming company truth automatically.
- [x] Build a concise company brief editor with source refs and clear company-wide visibility, role/first-job enrollment controls, missing facts/needs-input state, and links to ordinary questions/issues/artifacts. Show failures visibly.
- [x] Allow explicit human edits to objective/declared metrics/optional same-company goal after hiring, preserving the pinned template and existing first-job DoD snapshot.
- [x] Render template/version/skills/output standards in hire and team plan previews; readiness appears separately from technical harness status. Display actual department objective/metrics; unavailable outcome measurements remain unknown.
- [x] Preserve NewAgentDialog session reset/stale-response fixes when integrating with the separate #821 correction later; note branch integration dependency.
- [x] Run UI tests/typecheck, inspect real browser on an isolated fixture/server, collect screenshots for review, commit/report/review.

## Task 5: API, MCP and human bridge parity

**Owned files:** existing MCP ordinary/assistant/human bridge transport definitions and tests; shared capability/schema contracts; necessary scoped server transport/prepare-confirm paths; dated human-facing surface inventory. No second task executor or laptop/connector authority expansion.

**Interfaces:** reuse Task4 company-scoped HTTP contracts and existing real human identity, grant/company pinning and confirmation mechanisms. Available means the human can discover, read and perform the same allowed workflow through each transport, not merely that a REST route exists. Agents do not impersonate the named human; sources/directives/templates grant no authority. Existing clients and tool counts/contracts need explicit compatibility handling.

- [ ] Map all human-facing launch pages/actions to HTTP, MCP and bridge. Audit the existing app surface and record uncovered operations explicitly; don't silently limit the founder's requirement to the new page.
- [ ] Expose catalog/current sources, proposals and human review, department objective/metrics/goals, enrollment/readiness/skills retry/start, and human pending questions/answer/cancel/replacement through MCP and human bridge using existing permission and confirmation infrastructure.
- [ ] Reads enforce company/source/owner visibility; writes retain human direction, named authenticated answer ownership, scoped grants, one-time confirmation/replay protection and activity logs. No arbitrary URL/request proxy or automatic capability widening.
- [ ] Test actual registered MCP calls and real HTTP/DB bridge actions, including original task resume once, opt-in sharing, owner recovery, downgrade/foreign company/replay/ungranted refusal and legacy behavior.
- [ ] Run targeted tests/typechecks, document screen/action-to-transport contracts, commit/report/task review.

### Sequential transport lanes (September29 design freeze)

Use existing browser-approved named-human CLI credentials for a distinct `/api/human-control` bridge and explicit local `human` MCP toolset. Canonical role/company checks apply on every operation and at confirmation. This trusted connection retains the user’s existing REST authority; it is not a confined delegated token. Existing OAuth assistant and MK machine bridge boundaries remain unchanged. Explicit target selection, pinned one-time readback confirmation, usable content/file transfer and real security-ceremony continuation are required. No shipped allowed page action is excluded.

- [x] **5a:** Identity, finite typed registry, durable confirmation handles, local human MCP, workforce/questions and owner recovery; additive legacy question projection. Commits `8185789b5` / `0fc627204`, independent scoped review clear.
- [x] **5b0a:** Canonical issue mutation/comment preflight, atomic revision-checked DB commit, then cancellation/wake effects; stale or refused input has no domain effect.
  - [x] **5b0a1:** Transaction-aware issue/comment/reference/activity and pure checkout building blocks.
  - [x] **5b0a2:** Standalone comment/reopen/interrupt composition.
  - [x] **5b0a3:** Route-complete issue PATCH composition.
  - [x] **5b0a4:** Verified credential provenance, exact live authority witnesses and canonical human source/destination project guards; preserve actual worker and named-admin membership semantics.
  - [x] **5b0a5:** Participating predicate writers and full concurrency/effect proof.
    - [x] **5b0a5a:** Explicit outer-commit activity ownership for current workforce/question/ownership and enrolled-hire consumers; postcommit instruction materialization.
    - [x] **5b0a5b:** Participating blocker/question/confirmation/minimal-hold/DoD/goal-default writers and composed two-backend concurrency/effect proof.
- [x] **5b2p:** Bounded workspace/source-issue writer ordering and same-company binding prerequisite; runtime realization stays outside DB locks. Commits `f456f3752` / `3258f5aae`, independent scoped review clear; final containing 514 tests. Human recovery remains mandatory later5b2. This does not complete full topology or broader5b2 page parity.
- [x] **5b0b:** Canonical compound tree-control snapshot/current-target authorization and atomic hold/status commit, then run/queue/wake effects. Named writer closure reviewed across5b0b1/2/3; broader transport/recovery/launch gates remain open.
  - [x] **5b0b1:** Central topology, bulk deletion and suggestion participation; tenant invariants and private-safe legacy-link refusal. Commit `21fe76e4a`, independent spec/quality review approved; final containing 407 tests.
  - [x] **5b0b2:** Routine and CLI merge writer acceptance, with runtime/storage outside locks. Commits `d08dda1ba` / `a21ea50a1`; initial 546 tests and final 61 covering tests, independent review and scoped pause-race correction approved.
  - [x] **5b0b3:** Exact fully authorized current/historical tree snapshot, atomic holds/statuses/eligible queues/audits, then truthful selected-run effects; final company-locked pause admission and private-safe legacy hold/history deletion refusal. Commits32d8b5455/a9a4bb41e; initial672/final152 overlapping tests, independent review and scoped correction clear.
- [ ] **5b1a:** Existing onboarding/question/ownership foundation current-authority prerequisite: verified original Request, protected read/prepare/execute/recovery, source visibility, and fresh authority at separate skill catalog/assignment/failure transactions. Curated files are authorized at unlocked dispatch; already dispatched I/O may finish after revocation. Preserve committed canonical first-job/question continuation and truthful partial/unknown outcomes.
  - [x] Original credential provenance checkpoint3c761c672: independent review clear;27 tests/server types/diff pass.
  - [x] Native readiness source tracking3532c562b: independent review clear;85 tests/server types/diff pass. It observes sources but does not enforce private404.
  - [x] Reusable actual-Request board identity/query seam808fe07c4: independent review clear;200 tests/server types/diff pass. The helper returns identity facts; callers still supply complete authorization.
  - [x] Current-source authority integration through protected read/prepare/confirm/recovery and native onboarding/question flows. Core4b2432633/fixbb306b91b independently reviewed; initial232/final85 overlapping tests.
  - [x] Native onboarding/question projection guards and guarded separate skill stages; bounded core concurrency/compatibility review clear. The parent remains incomplete pending the separate inactive-owner workflow.
  - [ ] Inactive pinned-owner recovery: safe current-owner metadata and confirmed cancellation receipt, existing canonical cancelled-question replacement, and same-task answer/resume through UI/API/MCP/bridge. A real PostgreSQL/HTTP characterization proves the current stranded state; it is an unresolved launch blocker, not a passing recovery test.
- [ ] **5b1:** Bounded canonical route-reuse helper, dashboard/activity/Shipped, issues/documents/work products/reviews; consumes reviewed5b1a foundation authority and current-request credential contracts.
- [ ] **5b2:** Projects/workspaces, team/agents/runs.
- [ ] **5s:** Encrypted human secret input/output substrate, before secret-producing5b3 and secret-bearing5c/5d adapters; no live credential at prepare or secret in generic confirmation JSON.
- [ ] **5b3:** Goals/decisions/routines/evaluation/costs.
- [ ] **5c:** Company settings/access/stewardships/portability, skills/instructions/budgets/billing/connections/environments/governance, onboarding/conversations/My Agent/inbox/guides.
- [ ] **5d:** Own profile/credentials and instance/bootstrap/plugin administration with current canonical authority.
- [ ] **5e:** Files/full content, public/static/trial/share/auth/claim/consent/plugin UI operations, and exhaustive page-action coverage assertions.

Each lane has its own brief, implementation, red/green evidence and independent task review. Identical canonical action contracts share one typed operation with explicit page aliases; local UI controls require usable data, not invented mutations. Unrelated API-only endpoints are recorded but not required solely because a client exports them. Later lanes consume reviewed registry contracts; they do not bypass permissions through a generic proxy. Full transport parity is pending until every required coverage row has usable API/MCP/bridge behavior and tests.

File/secret decisions are recorded in the [coverage ledger](2026-09-29-human-control-plane-transport-coverage.md#file-and-credential-contracts-frozen-for-future-implementation): canonical source authorization on both byte URLs, exact assigned-worker compatibility, explicit source/draft bindings, quarantined unclassified legacy assets, bounded immutable file transfers, encrypted secret staging and single-claim generated outputs. Schema-declared plugin secret fields also require encrypted final persistence; preparation alone is insufficient. These future contracts have no live migration or credential effects.

## Task 6: Launch checklist, composed proof and release handoff

**Owned files:** `doc/LAUNCH.md`, additive September24 MVL update, dated takeover/build evidence, new composed integration tests and two-company fixture/evaluation guide. Never mark live quality/provider gates passed by deterministic stubs.

- [x] Add named workforce must-have gate to launch checklist and link the spec/build evidence. Existing infrastructure/security/claim/paid/retirement gates remain. WF-1 through WF-8 stay unchecked until their required proof is complete.
- [ ] Compose onboarding→enrollment→firstjob→textquestion→humananswer→exacttaskresume→artifact→neutralpassedverdict→acceptedreadiness with real local DB/routes. Test second job and another company/newhire reading only approved shared answers; reject cross-company/private leakage and duplicate actions.
- [ ] Include inactive question-owner recovery in the composed proof: the original named owner leaves while a required keyless question is pending; the new current accountable human discovers safe recovery metadata even when readiness returns404, explicitly cancels and replaces it, supplies a genuine answer, and resumes the same task once through UI/API/MCP/bridge. Reject private-answer exposure, owner reactivation or accountability changes during confirmation, and replay after unknown acknowledgment. A passing diagnostic that demonstrates the stuck state is not recovery evidence.
- [ ] Include workspace uncertainty in the composed launch proof: original outcome survives later runs; automatic retry is suspended; a current authorized human inspects/remediates/resolves the exact original through API/MCP/bridge; the intended task resumes after resolution without duplicating accepted setup. Consume reviewed5b2 recovery contracts and prove unrelated work remains usable.
- [x] Define the role-specific output review and trial protocol in [workforce outcome evaluation](2026-09-29-workforce-outcome-evaluation.md), with fresh fixtures, recorded full costs and fair ordinary-assistant comparison. Actual intended-model/customer trials and measured numeric acceptance targets remain pending; WF-6 is unchecked.
- [ ] Run full typecheck, test:run, build; resolve introduced failures, isolate inherited CLI/PG failures accurately. No optional rerun loops once evidence is sufficient.
- [ ] Final independent whole-branch review with diff/report/ledger; fix structural/security findings; prepare reviewable branch and PR-template handoff. No merge/deploy/publication or live3199 change.
