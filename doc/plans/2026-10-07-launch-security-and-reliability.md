# AgentDash launch security and reliability implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement each bounded task, followed by independent review. Steps use checkbox syntax for tracking.

**Goal:** Finish the authorized marketing publish, close the identified access/SSH/reliability defects, publish the existing docs work, and reconcile the already-merged onboarding foundation with fresh verification.

**Architecture:** Preserve existing company, project, actor, approval and budget contracts. Reuse the existing authorization predicates, private SSH staging, Hermes usage normalization and cooperative redaction. Writers use separate worktrees; the coordinator integrates and lands reviewed changes sequentially.

**Tech Stack:** TypeScript, Express, React/Vite, Drizzle/PostgreSQL, Vitest, Playwright, pnpm and GitHub Actions.

**Spec:** `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, `doc/DATABASE.md`; GitHub issues #1053, #1054, #1057, #1062–1065; PR #928 and merged #881–883; the original handoff plus the founder's current instruction to create a plan and do the remaining work.

## Current status — 2026-10-07

This status supplements the original task checklists below; their planning steps remain historical.

| Task | Landed source |
| --- | --- |
| 1 — generic marketing publication | #1072, `0efe570ea46e5204f8ea1b5297ee8908f9f3916e` |
| 2 — access security | #1074, `c557176cf807c370c0463f75811bc316a4cc7806` |
| 3 — Hermes SSH safeguards | #1075, `b71d558e0da807cf216d2257f8d03430d5f06c6c` |
| 4 — lock-order observation reliability | #1073, `052acc60edb022d77e874386a593ca51e33dfb9e` |
| 5 — cooperative log sanitization | #1077, `8bc372e647bf70a92cea47a5a4f931949a6d8ce0` |
| 6 — public documentation and Paperclip credit | #1076, `4ddbcb9c4d920d5acb9f88a1bd1ca12c141c5a4e` |

Tasks 1–6 are source-complete and landed. Marketing, public docs and visible Paperclip credit are also **live**, with actual desktop/mobile public verification recorded in `.omc/qa/2026-10-07-whats-new-public.md` and `.omc/qa/2026-10-07-docs-public/verified-public.md`. Those public-site results do not imply an HQ application source deployment: HQ still runs `89fc504dbe87e6abbd16911b8377b778859794c7`; `/api/health` reports `signUpDisabled=true`, `trialAnonymousEnabled=false`, `instanceId=default` and `dataDirName=.paperclip`. The approved flags were applied after 17:40 PT while the broker was idle (evidence: `.omc/qa/2026-10-07-hq-access-closure`). SSH/Q3 changes remain source-only.

Task 7's foundation audit is complete; superseded #859 and #928 are closed with their branches preserved. Additional inactive-question-owner recovery in #1078 remains source-current but pending final CI and landing. Its reviewed behavior retains private-question visibility, explicit human cancellation/replacement/answer and exactly-one continuation of the original task. Broader workforce quality and customer acceptance remain held. The coordinator's full composed gate passed typecheck, all Vitest suites and build on frozen `ffa268e2e2c940f3afb3a75fe978f08f06d39731`, including 372 production assets with 0 unexplained private-content matches. Final recovery source matches that tested composition; the exact recovery PR still requires hosted CI and landing. These source gates do not establish a new HQ deployment or the held broader acceptance.

## Global constraints

- MKThink production: zero contact. Never print/copy credentials, provider config, existing transcripts or process environments.
- Preserve the stale main checkout and its existing untracked `company`. Source starts at `89fc504dbe87e6abbd16911b8377b778859794c7`; work under `.claude/worktrees/`, fetch locally with `--no-tags`.
- No shared-service restart, real provider/SSH execution, new company/target enablement, migration or dependency addition as part of implementation. Disposable test DBs must exclude54329; HTTP tests avoid3100,3120,3199,3300.
- User has authorized executing this plan and publishing the linked, reviewed marketing preview. Launch video remains paused and apex DNS remains founder-owned; neither is silently expanded into this engineering plan.
- Independent review before every merge, and security re-review after fixes. Merge exact frozen heads only after audit, drift, check, verify, policy and dependency-audit pass.
- Keep API/shared/UI contracts synchronized. Unavailable spend is unknown, never zero. Rejected mutations produce no agent, approval, environment update or success audit row.
- Update both active prompt surfaces (`onboarding-assets/default/AGENTS.md` and `agent-creator-from-proposal.ts`) for agent-facing changes. All roles, including CEO/CoS, now load the unified default bundle; removed unused role bundles must not be resurrected.
- Lore commit trailers and complete PR template are mandatory. No inherited npm publications. New HQ application publication/deployment, if needed, receives its own concrete release candidate and broker-idle gate; the completed1007.1 deployment is not restarted during implementation.

## Execution and acceptance

Each task ends with committed code/evidence, a diff package, independent spec/quality review, and required CI. Use focused regressions first; run the full typecheck/test/build gate before PR-ready handoff. Record red/green evidence, limitations, exact revisions, review findings and fixes in the plan's SDD ledger. Parallel implementation is permitted only in independent worktrees; shared-file changes integrate sequentially and are reverified.

### Task 1: Publish the approved generic marketing preview

**Files:** Existing PR #1072 at `602e2a2966f9c21d8c7490485d0b46a9b44ca435`; `ui/src/marketing/**`, routing reservations, `vercel.json`, browser journeys and `doc/qa/2026-10-07-whats-new.md` already implemented.

**Interfaces:** Consumes the linked Vercel preview and independent review in `.omc/handoff/codex-review-whats-new.md`. Produces public `/whats-new` and `/whats-new/launch-week` containing generic teams/transcript/log/security improvements, with Travel MVP highlights excluded.

- [x] Re-read frozen PR head, review and all six required checks; validate the existing PR body with `node scripts/ci/check-pr-process.mjs --body-file`.
- [x] Record that the founder's instruction to do these items follows presentation of this exact preview and authorizes this publish. Mark PR ready, then `gh pr merge 1072 --squash --match-head-commit 602e2a2966f9c21d8c7490485d0b46a9b44ca435` using correctly separated CLI arguments.
- [x] Observe the production Vercel deployment; verify public index/article, mobile navigation, manual illustrations and exclusion of Travel MVP copy. Use browser-harness and persist the actual result; do not equate merge with deployed proof.

Actual publication: #1072 merged0efe570ea46e5204f8ea1b5297ee8908f9f3916e; Vercel production succeeded. Fresh public index/article, desktop/mobile navigation, transcript controls and Travel MVP exclusion verified; evidence `.omc/qa/2026-10-07-whats-new-public.md`.

### Task 2: Close access-security defects (#1053, #1054, #1057) and operation-log visibility

**Files:** `server/src/routes/agents.ts`, `approvals.ts`, `companies.ts`, `costs.ts`, `activity.ts`, `execution-workspaces.ts`, `visibility.ts`; `server/src/services/approval-authority.ts`, `workspace-operations.ts`; impacted shared types/UI clients and Dashboard/ApprovalDetail; existing route/security tests and both active prompt surfaces.

**Interfaces:** Reuse `assertCanCreateAgentsForCompany`, `canReadCompanySpend(db, req, companyId)`, `assertRunVisible` and `assertWorkspaceIdsVisible`. REST decision provenance is web unless a separately authenticated server-owned assistant path supplies assistant; connector/internal callers retain their server-selected channel. Operation visibility must honor both linked workspace and run.

- [ ] Add real route regressions for agent create/hire privilege escalation, including ordinary creator agents, CEO callers, `role: ceo`, `role: chief_of_staff`, `permissions.canCreateAgents: true`, and combined inputs. Assert403 and no rows; board controls remain successful; ordinary agent hires remain supported.

```ts
expect(response.status).toBe(403);
expect(await db.select().from(agents).where(eq(agents.name, attackName))).toEqual([]);
expect(await db.select().from(approvals).where(eq(approvals.companyId, company.id))).toEqual([]);
```

- [ ] Confirm these regressions fail on the baseline, then add one small actor-specific creation guard before either route performs work. Check inherited/default authority as well as explicit permissions; do not weaken board approval, adapter-config or company checks.
- [ ] Add REST approve/reject/override spoof tests for telegram, teams, whatsapp and bridge_inbox, plus assistant-grant and genuine connector controls. Refuse forged REST provenance or derive web at the REST boundary; do not globally force trusted internal connector calls to web. Preserve revision, idempotency and existing assistant authority checks.

```ts
expect(decidedApproval.decisionChannel).toBe("web");
// Or assert403 and unchanged approval when refusing the forged body.
```

- [ ] Cover all spend surfaces named by #1057: company list/stats, agent list/detail, budget overview, cost activity and budget links. Hide financial values for unprivileged members through the existing predicate; retain admin/authorized-agent values, company/project visibility and nonfinancial functionality. Synchronize nullable/omitted shared/UI contracts; show unavailable rather than0.

```ts
expect(memberCompany.spentMonthlyCents == null).toBe(true);
expect(memberAgent.budgetMonthlyCents == null).toBe(true);
expect(memberBudgetOverview.status).toBe(403);
expect(memberActivity.some(row => JSON.stringify(row.details).includes(seedCost.toString()))).toBe(false);
```

- [ ] Before operation-log reads, check company scope plus both workspace/run links. Deny off-project members with404 before reading storage. Include workspace-only/run-only/both/cross-company/unknown/orphan cases; preserve documented orphan policy. Filter related operation lists consistently where an operation's other linked entity is restricted; do not add redundant guards to already-visible sibling routes.
- [ ] Update active prompt blocks for refusal/recovery behavior, run the changed route/UI tests, shared/server/UI typechecks, then full gate and architecture checks. Commit each security issue as a separable Lore decision; root reviews every changed boundary and requests security re-review after fixes.

### Task 3: Harden generic Hermes SSH (#1062–1064)

**Files:** `packages/adapter-utils/src/execution-target.ts`, `patches/hermes-paperclip-adapter@0.3.0.patch`, supported patch-hash update in `pnpm-lock.yaml`, `server/src/routes/environments.ts`, `server/src/routes/agents.ts`, `server/src/services/hermes-ssh-policy.ts`, `server/src/adapters/registry.ts`, `hermes-usage.ts`, new `hermes-usage-remote.ts`, fake SSH/environment/usage tests, `doc/HERMES-SSH-ENVIRONMENTS.md`, active prompts.

**Interfaces:** Existing staged private environment helper and operator-pinned `runSshCommand` spec; usage feeds existing `summarizeHermesUsageRows`/`applyHermesSessionUsage` with cumulative semantics intact. Planning details: `/tmp/agentdash-20261007-ssh-plan.md`.

- [ ] Extend fake-SSH tests with a distinctive multiline/Unicode/shell-character prompt; assert it never appears in any SSH or Hermes argv and reaches the fake runtime unchanged through a0600 query file. Cover launch/staging/timeout failures and private directory cleanup; preserve local adapter invocation and existing secret isolation.

```ts
expect(remoteArgv.join(" ")).not.toContain(distinctivePrompt);
expect(fakeHermesReadQueryFile).toBe(distinctivePrompt);
expect(promptFileMode & 0o777).toBe(0o600);
```

- [ ] Stage the query beside runenv and invoke `hermes chat --query-file <private-file>`. Official Hermes source reads the query directly in-process: https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/main.py . Installed target version is deliberately unverified. Unsupported query-file must fail closed with an actionable upgrade error; never fall back to `-q` or command substitution. Reject conflicting extra query args that defeat transport.
- [ ] Share the existing pin authority between pinning and environment retargeting. For company-scoped pinned Hermes agents, compare normalized effective user/host/port and relevant driver transitions before persisting config/secrets; require board pin authority, rerun allowlist, and audit `agent.ssh_environment_pinned` for every affected agent, including port. Unrelated metadata/same-target edits and unpinned environments retain their existing rules. Cover forbidden creator/CEO agents and manage-only users, allowed board roles, default-port/case/partial merge, disallowed targets and driver changes.
- [ ] Read only the completed session's remote ledger over the exact operator-pinned SSH spec, resolving the remote user's invocation home/profile rather than server HOME. Use read-only SQLite and parameterized session id; emit bounded validated usage-only JSON. Feed existing metering normalization; missing ledger/session, timeout, malformed data or uncertain attribution remain explicitly unmetered, never a local ledger fallback.

```ts
expect(meteredResult.meteringStatus).toBe("metered");
expect(missingLedgerResult.meteringStatus).toBe("unmetered_no_ledger");
expect(localLedgerReads).toBe(0);
```

- [ ] Test cost/tokens/cache/tool turns, hostile session input, profiles/custom homes, strict-host/key options and resumed cumulative delta behavior. Use synthetic stubs only. Update docs/prompt runtime limits honestly; run focused tests then full gate. No schema migration, remote capability probe, feature enablement or target change.

### Task 4: Repair lock-order observation races (#1065)

**Files:** `server/src/__tests__/helpers/` small polling helper and its tests; premature-sampling writer suites including `issue-topology-writers`, `execution-workspace-writer-order`, `worktree-routine-writer-order`, `issue-tree-acceptance-http`, `routine-writer-http`, `issue-tree-pause-admission`; inspect sibling suites before inclusion.

**Interfaces:** Poll blocker observations until the same observed waiter has both the expected owner blocker and expected company-lock query. Reuse the accumulation precedent in `issue-predicate-writers.test.ts`; no production lock changes. Detail: `/tmp/agentdash-20261007-reliability-plan.md`.

- [ ] Add deterministic sampling regressions: stale SET LOCAL + true blocker followed by company lock succeeds; unrelated first row then matching row succeeds; wrong-query-only and early-settled contender fail with sampled diagnostics. Preserve timeout, finally release and promise-drain behavior.

```ts
const samples = [staleSetLocalWithOwnerBlocker, companyLockWithOwnerBlocker];
expect(await observeExpectedWaiter(nextSample, ownerPid, expectedLock)).toMatchObject({ pid: waiterPid });
```

- [ ] Run baseline failure, implement the smallest test-only helper, replace only affected sampling seams, then run focused helper and actual disposable-PostgreSQL writer suites. Tests claiming company-first order must still require company-lock query evidence; blocker-only acceptance tests remain distinct.
- [ ] Commit the test-only repair and independently review assertion strength before CI; no timeout increases, blind rerun loops or empty commits.

### Task 5: Make residual log sanitization cooperative

**Files:** `server/src/services/feedback.ts`, `server/src/services/feedback-redaction.ts`, `server/src/services/recovery/service.ts`, `workspace-operations.ts`, existing `run-log-redaction.ts` utilities and relevant tests; docs/prompt applicability comments as needed.

**Interfaces:** Preserve runtime known-secret and feedback-specific PII policies, structured JSON, raw-byte offsets, trusted-persistence/epoch semantics and truncation. Existing feedback/recovery already redact: the defect is synchronous heavy work, including the second whole-log feedback sanitizer after reading.

- [ ] Add synthetic legacy-log/escaped-credential/long multiline regression fixtures and event-loop heartbeat evidence. Compare sanitized outputs/privacy counts to current policy; assert intact parseable lines, no secret, raw paging reconstruction and trusted epoch invalidation. Tail-start-midline cases are explicit.

```ts
let yielded = false;
setImmediate(() => { yielded = true; });
const output = await sanitizeLargeSyntheticLog(input);
expect(yielded).toBe(true);
expect(output).not.toContain(seedSecret);
expect(() => output.trim().split("\n").map(line => JSON.parse(line))).not.toThrow();
```

- [ ] Implement async sanitization using safe bounded units; do not split a secret pattern across chunks or remove feedback PII processing. Use the cooperative serve path for workspace logs and the appropriate async privacy path for bundle/recovery output, avoiding a second blocking whole-string pass. Propagate cancellation where existing request/read contracts support it.
- [ ] Run focused redaction/feedback/recovery/workspace tests, inspect large-line behavior and output equivalence, then full gate. State yielding boundaries and oversized-line limitations honestly; no invented hard millisecond bound.

### Task 6: Finish existing public docs go-live (#928)

**Files:** Existing eight-file change: `vercel.json`, `cloud/src/__tests__/vercel-rewrites.test.ts`, `ui/src/marketing/MarketingFooter.tsx`, `ui/src/marketing/content/site.ts`, `ui/src/pages/Guides.tsx`, `McpPage.tsx`, `McpPage.test.tsx`, `guides-routes.test.tsx`.

**Interfaces:** Current docs implementation and already-merged prerequisite #925; public Docs links/redirect allowlist must coexist with Task1's What's new routes and preserve app routes.

- [ ] Freeze #928 original branch/diff and audit its body; replay its minimal go-live intent in an isolated current-main worktree, preserving any foreign changes rather than resetting their checkout. Resolve current marketing/footer/router differences after Task1 is landed.
- [ ] Before exposure, inspect public bundles/redirects for client briefs and private release-note material (including `ui/src/components/UnprefixedBoardRedirect.tsx` and the docs release-note loader). Remove public entry points to private customer prose; preserve canonical historical source files. Add privacy assertions using synthetic labels, without contacting any customer.
- [ ] Verify anonymous public `/docs` discovery, deep-link refresh, navigation/footer links and Guides/MCP integration with existing unit tests plus browser coverage; workspace app navigation and company selection stay unchanged. Add a regression only for a real uncovered behavior.
- [ ] Independently review final diff and all required CI, then land/publish the authorized docs go-live and verify the actual public deployment. Preserve source attribution, redirects and existing operator/private-doc exclusions.

Task4 frozen dcb14e4c6:146 focused tests pass; independent review approved/no findings; PR1073 is running required CI. Task2 review found a residual budget-approval amount disclosure; repair/re-review is required before landing.

### Task 7: Reconcile and verify the workforce/human-control foundation

**Files:** Current merged workforce/human-control code and tests, PR #859 metadata, verification notes/transport ledger. Historical #859's split successors #881, #882 and #883 are all merged; do not merge the superseded draft or rebuild their implementations.

**Interfaces:** Approved existing company/workforce/authority contracts in current source; held architecture choices #934/#936 are not silently decided. Detail: launch audit report `/tmp/agentdash-20261007-launch-plan.md`.

- [x] Read the three merged PR acceptance criteria and current transport ledger, identify remaining executable checks, and run relevant human-control auth/source-authority/workforce readiness/runtime tests against synthetic local data.
- [x] Correct stale draft status: reference the actual merged successors and close #859 as superseded after preserving its evidence/branch. Record fresh source-tested behavior separately from unrun customer/quality/cost acceptance; do not invent numeric targets or launch claims.
- [ ] Prepare any missing, approved-contract verification fixes as a separately reviewed PR. If a remaining path depends on #934/#936 or unapproved quality targets, document exact dependency, concrete options and evidence in the final decision packet while continuing independent tasks.

## Final completion gate

- [ ] Every changed task has independent spec+quality review; security fix rounds are re-reviewed.
- [ ] Required CI green for exact landed heads; final integrated typecheck/test/build and targeted browser/security checks pass, with any external acceptance limits named.
- [ ] Marketing/docs public deployment verified; source fixes do not imply a new HQ deployment. Preserve live Track C pilot and report any release/deploy step separately.
- [ ] Update handoff and SDD ledger with commits, PRs, before/after defects, validation, actual publication status and remaining founder-held decisions. Never report an open/blocked task as completed.
