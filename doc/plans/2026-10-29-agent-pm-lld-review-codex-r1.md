# Codex review, round 1: Agent Performance Management LLD (revision 1)

Reviewer: Codex CLI 0.162.1, model `gpt-6-astra`, reasoning effort `ultra`, read-only sandbox, October 29, 2026.
Reviewed: revision 1 of the overview and access LLDs (before the evaluation LLD was split out).
The working tree was compared before and after the run; Codex changed no files.
Dispositions: [overview LLD §11](2026-10-29-agent-performance-management-lld.md). Codex output follows verbatim.

---

**Verdict:** **Not ready for owner sign-off.** The product direction honors the confirmed decisions, but the proposed enforcement coverage remains bypassable, profile application can exceed existing authority and leave mixed configurations, and several evaluation rules would produce misleading attribution or acceptance. These require design changes before implementation. This was a read-only review of the current checkout; no files were changed and no tests, builds, installs, servers or migrations were run.

**Findings**

1. **[BLOCKER] Project access restrictions do not cover runtime delivery or exports**

   **Where:** Access LLD §4. Checked [heartbeat.ts:6608](server/src/services/heartbeat.ts:6608), `heartbeat.ts:6638–6651,6723–6732,6793–6798`, [companies.ts:186](server/src/routes/companies.ts:186), and `company-portability.ts:3259,3274–3277`.

   **Problem:** The proposed `visibility.ts` check covers API reads. Heartbeat separately loads issue descriptions, comments and continuation documents using company/issue identity and injects them into runtime context. Queued work can therefore disclose material after access is narrowed **(inferred)**. CEO agents can also export company data; portability reads issues without the requesting actor’s visibility constraints. Updating `visibility.ts` alone leaves that route open **(inferred)**.

   **Fix:** Require target-agent resource authorization before context hydration and dispatch, including queued and resumed work. Pass actor/policy context through export preview and execution. Validate interaction-wake provenance against stored records rather than trusting caller-selected wake reasons.

2. **[BLOCKER] New ledger ingestion would bypass private-feedback and source visibility boundaries**

   **Where:** Main LLD §§5.7, 5.10 and 6. Checked [evaluation.ts:68](server/src/routes/evaluation.ts:68), `evaluation.ts:94–100`, and [work-evaluations.ts:89](server/src/services/work-evaluations.ts:89).

   **Problem:** Ledger list/detail routes require only company access. Harness evaluation deliberately publishes only receipt metadata to company activity (`work-evaluations.ts:96–100`), while receipt history checks the pairing and represented user (`:113–120`). The LLD imports assessment outcomes and human corrections into that ledger but adds protection only to agent cards and selected burden fields. Private feedback and restricted-work evidence could consequently become company-readable **(inferred)**. Agent visibility is not permission to read every source contributing to that agent’s card.

   **Fix:** Specify source-derived authorization for events, cards, cases, exports and generated review items. Retain private receipt content behind its existing access boundary; expose only explicitly authorized projections. Apply authorization before aggregation and drill-down.

3. **[BLOCKER] Profile approval grants broader configuration authority than the existing Settings path**

   **Where:** Main LLD §§4.1–4.2. Checked [agents.ts:1085](server/src/routes/agents.ts:1085), `routes/agents.ts:1120–1132`, and `services/agents.ts:346–367,418–423`.

   **Problem:** The LLD lets a steward/accountable user approve a profile that changes adapter/model and runtime configuration, then calls `agentService.update` directly. Existing route guards reserve adapter/runtime configuration, adapter type and environment selection for administrators; stewardship does not authorize them. The service update does not reproduce caller authorization. This creates a privilege expansion through profile approval **(inferred)**.

   **Fix:** Authorize the concrete diff field by field using existing configuration authority. Recheck authority at application, including emergency override. Explicitly map `runtime.environmentId` to the governed environment-selection path; it currently disappears from the application steps.

4. **[HIGH] Application lacks a serialized, recoverable activation contract**

   **Where:** Main LLD §§3.2, 4.2 and 6. Checked [approvals.ts:136](server/src/services/approvals.ts:136), [approval-decision-effects.ts:215](server/src/services/approval-decision-effects.ts:215), `services/agents.ts:418–423`, and `heartbeat.ts:6585–6600`.

   **Problem:** Three related gaps remain:

   - `(approvalId, step)` idempotency does not serialize two approvals based on the same active revision. Existing approval concurrency checks protect one approval, not the agent.
   - Access, runtime and routines change before the active-profile pointer. Runs can consume mixed versions, and refresh can restore the old block between steps 5 and 7 **(inferred)**.
   - Approval replay sets `applied:false`; `afterApprove` then skips effects. No retry/reconciliation operation is specified, so retrying approval cannot recover a failed application through the existing path.

   **Fix:** Specify per-agent application serialization; compare approved profile/config/governance bases before effects; reject or rebase stale proposals. Add durable application/step states and recovery independent of approval replay. Stage resources until activation is coherent with dispatch, and record the component versions actually consumed by each run.

5. **[HIGH] Assignment and contact restrictions miss existing alternative paths**

   **Where:** Access LLD §§4–5. Checked [issue-mutation-actions.ts:338](server/src/services/issue-mutation-actions.ts:338), [issues.ts:472](server/src/routes/issues.ts:472), `company-portability.ts:4849–4863`, and `services/bridge.ts:416–432,467–508`.

   **Problem:** Ordinary comments wake an existing assignee without an `@mention`. The inbound enforcement row covers assignment despite the model promising inbound mention control. Assignment authorization falls back to CEO authority after `tasks:assign` fails. Import creates assigned issues directly through the service. Agent-authored bridge tasks also have no proposed V2 recipient/endpoint check. These paths bypass the listed enforcement points **(inferred)**.

   **Fix:** Make effective-policy denial dominate legacy role/grant allowances. Check outgoing and inbound contact policy after recipient normalization at shared dispatch boundaries, including comments, reopen, person-to-agent routing, imports and bridge tasks. Define bridge endpoint/represented-person scope. Preserve forbidden-wake comments without dispatching them.

6. **[HIGH] Restricting self-added skills does not restrict effective runtime skills**

   **Where:** Access LLD §4, `do.skills`/`do.selfEdit`, and §5. Checked [heartbeat.ts:537](server/src/services/heartbeat.ts:537), `heartbeat.ts:7026–7038`, and [agents.ts:2413](server/src/routes/agents.ts:2413).

   **Problem:** Heartbeat resolves skills mentioned in issue titles, descriptions and comments, then adds them to runtime configuration. These never pass the proposed self-sync check. Skill sync also permits authorized peer agents, while the design checks only self-add. Removing `capabilities` from the self-patch list leaves it in the peer-patch list (`agents.ts:1343–1347`).

   **Fix:** Enforce the target agent’s policy after all runtime skill additions and on every persistent writer. Define mandatory platform skills separately. Protect profile-managed fields through both self and peer mutation paths.

7. **[HIGH] Generalizing MK governance is not automatically an additive restriction**

   **Where:** Access LLD §§3.1 and 4. Checked [agent-governance.ts:692](server/src/services/agent-governance.ts:692), [connectors.ts:524](server/src/services/connectors.ts:524), `bridge.ts:501–508`, and `approval-authority.ts:210–227`.

   **Problem:** A non-null governance policy currently also means “MK behavior applies.” Connector resolution uses it to enable the steward’s private non-document credential fallback. Bridge execution uses null versus non-null policy to select approval behavior. Making that resolver company-wide can grant access rather than only narrow it **(inferred)**.

   Separately, the proposed `auto → execute` rule does not reconcile with HubSpot’s current mandatory `connector_send` approval. `minimumApproval: "none"` currently changes who may approve; it does not eliminate approval.

   **Fix:** Separate legacy profile eligibility from V2 restriction evaluation. Define one precedence table combining credential eligibility, connection autonomy, destructive-action rules, provider approval requirements and V2 modes. Existing required approval must dominate `auto` unless the owner explicitly approves changing that behavior.

8. **[HIGH] Legacy policy writers can erase V2 restrictions and invalidate profile history**

   **Where:** Access LLD §§3.1, 7, 8 and 11. Checked [agent-governance.ts:28](packages/shared/src/validators/agent-governance.ts:28), `types/agent-governance.ts:291–299`, and `services/agent-governance.ts:238–241,275–280,553–575`.

   **Problem:** Current policy writes replace an entire policy side; the normalizer reconstructs only six V1 fields. Under “missing V2 dimension means unrestricted,” an older client’s replacement write can remove restrictions **(inferred)**. Existing direct ceiling/request/harness writers also remain outside the proposed “every access change is an approved profile revision” history.

   **Fix:** Distinguish an old stored row from omitted fields in an update. Preserve V2 fields on explicitly supported legacy partial writes, or reject old replacement formats against V2 rows. Specify how authorized harness narrowing updates history and prevents a previously approved profile from restoring broader access.

9. **[HIGH] Reusing P-metrics contradicts the proposed treatment of refusals and human approval**

   **Where:** Access LLD §4; Main LLD §5.8. Checked [metrics.ts:986](server/src/services/evaluation/scoring/metrics.ts:986), `metrics.ts:938–943,637–665`, and [confidence.ts:52](server/src/services/evaluation/scoring/confidence.ts:52).

   **Problem:** P6 converts every agent `authz.refused`, except `EVALUATOR_READ_ONLY`, into an immediate E3 authority breach. The access design expressly says an ordinary refusal is not misconduct. P1 also counts human completion as intervention and raises E8 without distinguishing required sign-off from corrective rescue. Confidence calls different source tiers “independent,” although tier diversity does not establish independent assessors.

   **Fix:** Define separate semantics for attempted/refused actions, repeated attempts and demonstrated unauthorized execution. Distinguish expected human approval from corrective intervention using the approved contract. Track evidence lineage and judge independence separately from source tier. Update formulas, exceptions and versions together.

10. **[HIGH] The denominator still omits work never issued**

   **Where:** Main LLD §§3.1, 4.2 and 5.5. Checked [deliverable-runs.ts:410](server/src/services/deliverable-runs.ts:410), `deliverable-runs.ts:616–645`, [routines.ts:52](packages/db/src/schema/routines.ts:52), and `services/routines.ts:1648–1683`.

   **Problem:** A deliverable becomes owed only when its run opens. Periods whose scheduler never opened a run vanish. Classifying “no run created” as a platform block then excludes unexplained absence from delivery performance. Cron/timezone/enablement belong to mutable **routine triggers**, and existing run receipts do not identify the intended scheduled occurrence. The profile also lacks typed trigger configuration despite application promising to create/update triggers.

   **Fix:** Generate owed occurrences independently of execution records from versioned definitions. Specify occurrence identity, deadlines, timezone, pause/enable history, catch-up/coalescing and cancellations. Require evidence for blocker attribution; otherwise report `not_started` or `cause_unknown`. Either define typed scheduling changes or restrict v1 to binding existing routines.

11. **[HIGH] Attribution confuses current assignee, producer, reviewer and feedback recipient**

   **Where:** Main LLD §§5.4, 5.6–5.8. Checked [card.ts:101](server/src/services/evaluation/scoring/card.ts:101), [work-evaluations.ts:89](server/src/services/work-evaluations.ts:89), and `scoring/independence.ts:56–103`.

   **Problem:** “Today’s finishing-assignee rule” is false: O1 credits the **last snapshot assignee**. Reassignment after completion can move credit. Harness corrections target the requester’s paired agent, which may not have produced the assessed work. Existing contributor detection includes activity useful for excluding self-review, not necessarily delivery contribution. A unique `issue_id` responsibility mapping cannot represent multiple contributing agents/responsibilities, and end-of-window leadership omits earlier ownership.

   **Fix:** Model temporal responsibility ownership and distinct producer, contributor, reviewer, requester and feedback-recipient roles. Preserve mapping/transfer history. Bind judgments to the assessed subject and work version; never derive that subject from the current assignee alone.

12. **[HIGH] Judgments are not bound to the approved criteria they supposedly evaluate**

   **Where:** Main LLD §§5.2–5.3, 5.7 and 5.9. Checked [work-evaluation.ts:4](packages/shared/src/validators/work-evaluation.ts:4), `work-evaluation.ts:20,33–36`, [evidence.ts:355](server/src/services/evaluation/scoring/evidence.ts:355), and `contract.ts:157–159`.

   **Problem:** Harness checks contain free-text criteria. “Accepted” means all supplied checks passed, not that all approved criteria were assessed. Outcome/check-count ingestion cannot produce criterion-level agreement or disagreement.

   Rule 17 also does not establish the promised freshness boundary: human attestations match criterion ID, optional issue ID and attester, without contract/check hash or subject scope. Old attestations can satisfy another subject’s same-named criterion or a changed check **(inferred)**.

   **Fix:** Bind judgments to company, subject, responsibility, approved contract/criterion-check identity and assessed work version. Require explicit occurrence/item scope; missing criteria remain unknown. Treat legacy receipts as unbound automated observations and retain the distinction between supplied evidence references and independently verified evidence.

13. **[HIGH] Broadening an evidence class can make shipped business work satisfy `pr.merged`**

   **Where:** Main LLD §5.3. Checked [evidence.ts:340](server/src/services/evaluation/scoring/evidence.ts:340) and `evidence.ts:267–276`.

   **Problem:** `pr.merged` currently resolves to the generic `delivery_ref` class. Adding shipped deliverables to that class can therefore satisfy an engineering merge criterion **(inferred)**, contradicting “engineering checks stay.” Existing delivery evidence already accepts a reviewer handoff naming a PR, which is weaker than independently verified merge state.

   **Fix:** Separate typed check predicates from coverage classes. `pr.merged`, `deliverable.shipped`, independent checks and recorded use must inspect their own facts, versions and provenance.

14. **[MEDIUM] Replay is underspecified once time and stored roll-up cards become inputs**

   **Where:** Main LLD §§5.5–5.8. Checked [replay.ts:67](server/src/services/evaluation/replay.ts:67), [scorecards.ts:80](server/src/services/evaluation/scorecards.ts:80), and `scoring/timeline.ts:344–348`.

   **Problem:** Obligations become overdue without new ledger events. “Latest milestone card” depends on stored projections outside the agent’s ledger cut. Citing its ID/version/hash is useful, but the replay interface does not specify those dependencies. Polling mutable definitions also cannot recover changes missed between polls. Existing verification reports `formula_changed`; it does not retain old formula implementations.

   **Fix:** Pin observation time, window bounds, ledger cut and roll-up dependency versions as explicit replay inputs. Recompute dependencies from the same cut or use immutable pinned cards. Define late-arrival, historical-coverage and formula-upgrade behavior.

15. **[MEDIUM] Several access controls are advertised without executable semantics**

   **Where:** Access LLD §§3–4, 7–8 and 12. Checked [issues.ts:2544](server/src/routes/issues.ts:2544), `routes/agents.ts:1322–1327,1367–1384`, and `services/agent-governance.ts:268–280`.

   **Problem:** No enforcement row implements `do.issueActions` or the `name/title/icon` self-edit booleans. `ConnectionGrant` promises read autonomy in its comment but has no such field. Contact-mode ranking is not a complete set-intersection algorithm; dynamic `reports_chain` resolution is not reconciled with stored effective JSON. In shadow mode, “Granted” also risks describing an unenforced intended restriction as actual reach **(inferred)**.

   **Fix:** Add a complete field-to-enforcement/default matrix. Define contact predicates, graph inputs, `via` intersection, empty/omitted values and target matching. Distinguish intended policy from enforced access in every state and preview. Resolve assignment-scope semantics in the design rather than deferring them to implementation.

16. **[MEDIUM] M1 is neither supported by the current ledger nor automatically behavior-free**

   **Where:** Main LLD §§5.8 and 10; handoff §7; discovery §11. Checked [sources.ts:1145](server/src/services/evaluation/sources.ts:1145), [scorecards.ts:44](server/src/services/evaluation/scorecards.ts:44), and [schedule.ts:91](server/src/services/evaluation/schedule.ts:91).

   **Problem:** M1 promises routine obligations over the current ledger, but routine ingestion arrives in M3. Reused snapshots append findings and normally synchronize review issues; they are not pure reads. The proposed offline walkthrough occurs after M3, although the handoff requires scenario/setup/measure alignment before implementation. Deferring brief intake to M5 also changes the discovery draft’s proposed first slice.

   **Fix:** Move the scenario walkthrough before implementation. Make M1 an explicitly side-effect-free inventory/projection with unavailable history marked unknown, or move its necessary ingestion earlier. Ask the owner to approve the changed first-slice order explicitly.

**Factual corrections**

- Main §3.3: responsibilities/KPIs are not available only as prose. They exist as arrays in [cards.ts:65](packages/shared/src/cards.ts:65) and confirmed plan payloads at `routes/onboarding-v2.ts:231–251`. What is missing is executable obligation/criterion structure.
- Main §5.5: goals have no target-date field in [goals.ts:23](packages/db/src/schema/goals.ts:23). Define the deadline in an approved contract or propose the necessary schema change.
- Main §§5.3/5.8: goal snapshots omit `currentValue`/`lastUpdatedAt` (`evaluation/sources.ts:1117–1124`); agent snapshots omit adapter/model (`:998–1019`). Neither historical measurement nor actual runtime identity follows from the current payloads.
- Main §5.6: scheduled evaluation snapshots cover open projects, not goals; see [schedule.ts:78](server/src/services/evaluation/schedule.ts:78). Goal cards cannot be assumed to exist.
- Main §3.4 and Access §5: refresh is best effort, respects suppression and may skip unsupported/external bundles. Heartbeat continues after refresh failure (`heartbeat.ts:6585–6600`). Refresh invocation is not proof of delivered instructions.
- Access §2: document connectors have a stricter, profile-independent current-steward credential rule, not generic own/workspace-visible resolution; see [connectors.ts:455](server/src/services/connectors.ts:455).
- Access §2: the three-round handoff cap is feature-flagged and explicitly race-prone, not unconditional; see [agent-handoffs.ts:25](server/src/services/agent-handoffs.ts:25).
- Access §1: `api_request` belongs to the control-plane agent MCP toolset; endpoint/setup/assistant credential surfaces differ (`packages/mcp-server/src/index.ts:82–110`). The server-enforcement conclusion remains correct.

**What the design gets right**

- Agent-as-subject evaluation with separate accountable results and delivered work, without inventing causal percentages.
- Human ownership of criteria/access, with manager proposals separated from decisions and application receipts.
- Explicit separation of automated assessment, human acceptance, use and business outcome.
- Reusing the evaluator and adding side tables instead of replacing upstream issue/agent models. The approval and scorecard discriminator columns really are text.
- Honest host-boundary limitations, One UX, and updating both agent prompt surfaces.

**Questions for the owner**

1. Must a human-authored profile always have a different human approver? “Never the proposer” adds a two-person requirement that was not among the confirmed decisions.
2. When enforcement is enabled, should agents without an approved access definition retain existing access indefinitely, or enter a time-bounded review/hold process?
3. Which real responsibility, existing agent and accountable human should anchor the pre-implementation walkthrough and determine the smallest first slice?