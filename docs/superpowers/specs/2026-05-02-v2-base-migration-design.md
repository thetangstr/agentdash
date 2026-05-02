# v2 base migration — design spec

**Date:** 2026-05-02
**Status:** Approved-pending-review
**Target:** Repository `thetangstr/agentdash`

---

## 1. Goal

Cut over from AgentDash v1 (449 commits behind upstream, ~half stub or dead code per the 2026-05-02 inventory) to a clean rebuild on latest `upstream/master` of `paperclipai/paperclip`. Five subsystems get carried forward (UI redesign with Claude design, Assess + agent research, rescoped onboarding, billing, multi-human + CoS chat); everything else is dropped.

This spec covers **only the migration mechanics** — branch ops, what carries forward, what gets dropped, cutover criteria, rollback. The five subsystems each have their own specs.

---

## 2. Strategy

**Same repo. Branch rename + new main from upstream.** Decided in brainstorm Q1 (option A — clean rebuild).

```
Before:                          After cutover:
─────────                        ──────────────
agentdash-main  (default)        archive/agentdash-v1  (read-only)
master                           main             (default — branched from upstream/master)
upstream/master                  upstream/master
```

The `archive/agentdash-v1` branch is preserved indefinitely as a read-only reference. Git history of v1 is not lost; it's just not the trunk anymore.

---

## 3. What carries forward

### 3.1 Code — surgical ports (not bulk merge)

Each item below is a small, named bundle of code that gets ported as a fresh commit on the new `main` branch. **Not** cherry-picks — re-implemented or re-applied so the new commits live cleanly on the new base.

| Bundle | Source (v1) | Why we keep it |
|---|---|---|
| GH #70/#71/#72 onboarding fixes | [PR #74](https://github.com/thetangstr/agentdash/pull/74) | Critical correctness for agent creation |
| AGE-55 email-domain company derivation | `server/src/routes/companies.ts` (current) | Smooths first-company creation |
| AGE-60 free-mail block (Pro deployments) | `server/src/middleware/corp-email-signup-guard.ts` | Pro pricing gate |
| Default Chief of Staff bundle | `server/src/onboarding-assets/chief_of_staff/` | Consumed by onboarding subsystem |
| `assistant_conversations` + `assistant_messages` schema | `packages/db/src/schema/assistant.ts` (current) | Consumed by chat substrate subsystem |
| Skill files (slash commands) | `.claude/commands/{workon,pm,builder,tester,tpm,admin,upstream-digest}.md` | Team continues using MAW + digest |
| `scripts/upstream-digest.sh` | Just shipped in [PR #75](https://github.com/thetangstr/agentdash/pull/75) | Operationalizes UPSTREAM-POLICY |
| `doc/UPSTREAM-POLICY.md` | Same | Defines the new ground rules |

### 3.2 Subsystems — five sub-project specs

These do not port verbatim; each gets its own spec + plan:

| # | Subsystem | Plan |
|---|---|---|
| 1 | UI redesign with Claude design | `docs/superpowers/plans/2026-05-02-ui-claude-design-port.md` (port-only, no spec brainstorm) |
| 2 | Assess + agent research | `docs/superpowers/plans/2026-05-02-assess-port.md` (port-only) |
| 3 | Onboarding (rescoped) | `docs/superpowers/specs/2026-05-02-onboarding-design.md` ✅ done |
| 4 | Subscription + billing | `docs/superpowers/specs/2026-05-02-billing-design.md` (TBD this session) |
| 5 | Multi-human + CoS chat | `docs/superpowers/specs/2026-05-02-chat-substrate-design.md` (TBD this session) |

---

## 4. What gets dropped

These v1 systems do **not** make it to v2. Code stays in `archive/agentdash-v1` for reference; it does not move to `main`.

### 4.1 Dead / stub (no upside)
- **HubSpot bidirectional sync** — sync scheduler is a no-op stub (per inventory). 1.3k LOC.
- **AutoResearch** — well-shaped data layer with no engine, no UI consumer. 2.7k LOC.
- **Action Proposals + Policy Engine** — `evaluatePolicy` is never called from agent execution. 850 LOC.
- **Onboarding 5-step wizard** — already replaced by `WelcomePage.tsx` in v1; both go.

### 4.2 Working but not on the keep-list
- **CRM stack** — 4.3k LOC of CRUD, lifecycle hooks stubbed. User flagged as "not battle tested" in the inventory review.
- **Inbox + Operator Feed** — upstream Paperclip has its own inbox now (`Polish inbox nested issue UI #4959`); use upstream's instead of ours.
- **Skills Registry review workflow** — works but UI is buried, no version diff, no analytics. Drop until there's a use case.
- **Smart Model Routing** — `resolveModelTier` works in heartbeat but `verification` and `maxToolCalls` checks are stubbed. Revisit when there's pricing pressure.

### 4.3 ⚠️ Load-bearing in v1, dropped from v2 (flagged for explicit review)

These two were marked **LOAD-BEARING** in the inventory but are **not** on the user's keep-list. Confirming as drops; push back during review if either should stay.

| Subsystem | v1 LOC | Why it's load-bearing in v1 | Implication of dropping |
|---|---|---|---|
| **Pipeline Orchestrator** | 1.4k | Real DAG, conditional routing, invoked from issue completion, E2E tested | No multi-stage agent workflows in v2; agents run one task at a time. CoS has to coordinate sequencing in conversation if needed. |
| **Budget + Capacity** | 2.1k | Pauses agents/projects via `pauseReason="budget"`, math is real | No automated budget enforcement. Spending caps would have to be re-implemented or moved into the billing subsystem. |

**Recommendation:** keep both dropped for v2. The lean rationale dominates: in a 2–5-person team, you don't need DAG orchestration on day one (CoS-driven workflows are simpler), and you don't need automated budget cutoffs before you have a Pro subscription model in place. If/when these become real needs, they can be re-introduced as v2.1 features against a clean base.

### 4.4 Things upstream Paperclip now provides (don't carry our version)
- **Multi-user + invite flow** — upstream `b9a80dcf` ships this; our v1 stuff is superseded.
- **Inbox** — upstream has it now.
- **Live runs UI** — upstream has refined this.
- **Comment threading on issues** — upstream has refined this.

When in doubt, prefer upstream's implementation.

---

## 5. Cutover criteria

The new `main` becomes the default branch on `thetangstr/agentdash` once **all** of:

1. ✅ Branch ops complete (archive renamed, new main created from `upstream/master`).
2. ✅ Carry-forward bundles ported (Section 3.1).
3. ✅ All five subsystem plans implemented and merged onto new `main` (their own specs/plans).
4. ✅ `pnpm -r typecheck && pnpm test:run && pnpm build` clean on new main.
5. ✅ Manual smoke test passes: a fresh user can sign up, walk onboarding, hire an agent, invite a teammate, and see a heartbeat email — end-to-end.

Until all 5 are met, `agentdash-main` (renamed `archive/agentdash-v1`) stays as the live trunk. Production CI/CD continues pointing at it. Cutover happens by:
- Renaming `agentdash-main` → `archive/agentdash-v1` on origin.
- Renaming new `main` → `agentdash-main` (or just promoting `main` to default and deprecating the old name).
- Updating CI/CD targets, GitHub default branch, branch protection, deploy hooks.

---

## 6. Rollback plan

If something catastrophic surfaces post-cutover (unrecoverable schema bug, security issue in upstream, etc.):

1. Re-promote `archive/agentdash-v1` to default branch in 5 minutes (it's still there, untouched).
2. Roll back any DB migrations that landed in v2 if they're incompatible (most v1 migrations are also in v2 because the carries are surgical, but any net-new v2 migration would need its own down-migration).
3. Re-deploy from the v1 branch.

This is a one-button revert by design. The cutover is a default-branch flip, not a destructive operation.

---

## 7. Out of scope

| Item | Where it lives |
|---|---|
| Re-onboarding existing v1 users | A migration script lives with the chat-substrate spec (since the conversation table moves) |
| Migrating production data (companies, agents, issues) | A separate one-time migration plan, post-cutover. Not part of this spec. |
| GitHub Actions CI updates | Tracked alongside cutover, not in this spec |
| Domain / DNS changes | Out of scope |

---

## 8. Decision log

| Decision | Choice | Source |
|---|---|---|
| Repo strategy | Same repo (`thetangstr/agentdash`), branch ops only | Brainstorm confirmation |
| New trunk name | `main` (eventually renamed to `agentdash-main` at cutover) | Convention |
| Carry-forward style | Surgical re-application as fresh commits, not bulk merge | Brainstorm Q1 (option A) |
| Pipelines + Budget | Dropped from v2, archived in v1 branch | Flagged for explicit review in §4.3 |
| Five keep-list subsystems | Each gets its own spec/plan, not bundled | User direction |
