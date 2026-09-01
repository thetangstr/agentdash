# Company governance mode — Steward vs Autonomous

**Status: DESIGN ONLY. Not implemented, not deployed. Do not build until the semantics below are reviewed.**
Branch: `ota/integration-mkthink` (staging). Date: 2026-09-01.

---

## 1. Why this is new work, not a mapping

Upstream `main` (`2c8a4a10`) has **no company-level mode**. What it has is `agents.autonomy`
(`stewarded` | `autonomous`, migration `0120_agent_autonomy.sql`) — a **per-agent** column
answering *"who is accountable for this one agent"*. Stewardship and governance are both
agent-scoped routes (`/companies/:id/agents/:agentId/stewardship`, `.../governance/ceiling`).

Evidence that this is exhaustive, not a missed search:
- `packages/db/src/schema/companies.ts` has no mode column (checked the full column list).
- No migration in 0096–0122 adds one.
- **0 of 11 open PRs** match steward/autonomous/company-mode/governance.
- Of 9 merged matches, eight are agent-level or MK surfaces. The ninth, **#429
  "autonomous-company first-run experience"**, is the Test Drive onboarding UX — a company
  that *builds itself* during trial. Its migration is `0090_trial_company_plan.sql`. It is
  marketing language, not a governance mode.

**These two axes must not be conflated**, and this design deliberately does not reuse the
agent vocabulary:

| | Unit | Question it answers | Values |
|---|---|---|---|
| `agents.autonomy` (upstream) | one agent | who is accountable for *this agent* | `stewarded` \| `autonomous` |
| `companies.governance_mode` (proposed) | one company | how is *this company* governed | `steward` \| `autonomous` |

A company in `autonomous` mode may still contain `stewarded` agents. They are orthogonal.

## 2. Data model — minimal and additive

```sql
-- Additive only. No DROP, no DELETE, no NOT NULL without default.
ALTER TABLE "companies"
  ADD COLUMN "governance_mode" text NOT NULL DEFAULT 'steward';

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_governance_mode_ck"
  CHECK ("governance_mode" IN ('steward','autonomous'));

-- Nullable: only meaningful in autonomous mode.
ALTER TABLE "companies"
  ADD COLUMN "accountable_operator_user_id" text;
```

**Default is `steward`, deliberately.** The safer mode is the one every existing row gets
without anyone deciding. MK Think therefore remains `steward` by doing nothing, which is the
requirement. Executive OS becomes `autonomous` by an explicit, recorded act.

## 3. Policy semantics

| | **Steward** | **Autonomous** |
|---|---|---|
| Accountability | multi-stakeholder governance; approvals may involve several people | exactly one accountable human operator |
| Approval routing | per the issue's `executionPolicy` stages, participants may be several users | stages may collapse to the single operator |
| Agent work bound by | the company's stakeholder policy | **that operator's policy** |
| `accountable_operator_user_id` | must be NULL | must be set — enforced |

`autonomous` does **not** mean "no oversight". It means oversight has exactly one named owner
instead of a committee. Nothing here widens what an agent may do, and this design adds **no
new dispatch path**.

### Where the permission research bears on this

Kept as a separate workstream, but two findings constrain what `autonomous` can mean:

1. **Approvals upstream are task-scoped, not per-turn or per-tool.** `docs/guides/execution-policy.md`
   defines per-issue `executionPolicy` with `review` and `approval` stages plus an always-on
   comment-required backstop. So "bounded by the operator's policy" must be expressed in issue
   execution policy, not in a per-invocation prompt that upstream has no concept of.
2. **`DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX = true`.** The codex-local adapter ships
   with approvals *and* sandbox bypassed by default. If `autonomous` is read as "fewer prompts",
   it risks compounding a default that is already permissive. This design therefore ties
   `autonomous` to **naming an accountable human**, never to relaxing a gate.

## 4. Setup UI

One control in company settings, visible not buried:

```
Governance
( ) Steward     multi-stakeholder governance. Approvals may involve several people.
(•) Autonomous  one accountable operator:  [ operator ▾ ]
                Agent work is bounded by this person's policy.
```

- Selecting `autonomous` **requires** choosing an operator before the form can be saved.
- Switching back to `steward` clears the operator and says so before saving.
- The current mode is shown on the company overview, not only in settings — a governance mode
  nobody can see is not a governance mode.

## 5. Migration and rollback

**Forward.** One additive migration. Every existing company becomes `steward` with a NULL
operator; no row is rewritten, nothing is dropped, and no read path changes until the UI ships.

**Rollback.** Two levels:
- *Config rollback* — set every company back to `steward` and NULL the operator. Pure UPDATE, no
  schema change, safe with the new code still deployed.
- *Schema rollback* — `DROP COLUMN governance_mode, accountable_operator_user_id`. Safe because
  nothing references them; a down-migration is written and rehearsed against a snapshot **before**
  the up-migration is run in anger.

**Survives migration/rollback** is an acceptance criterion, not an assumption: the test plan
asserts the mode persists across an up-migration, a restart, and a restore from backup.

## 6. Tests

| Test | Asserts |
|---|---|
| default on migrate | every pre-existing company is `steward`, operator NULL |
| MK Think unchanged | remains `steward` with no operator, without being touched |
| ExecOS set explicitly | becomes `autonomous` with a named operator, recorded as a deliberate act |
| constraint | any value other than `steward`/`autonomous` is rejected by the DB |
| autonomous invariant | `autonomous` with NULL operator is rejected |
| steward invariant | `steward` with a non-NULL operator is rejected |
| persistence | mode survives restart and a backup/restore round trip |
| rollback | down-migration restores the prior schema with all records intact |
| **orthogonality** | changing a company's mode does not alter any `agents.autonomy` value |
| **no new authority** | no code path gains a dispatch, schedule, or approval-skip because a company is `autonomous` |

The last two exist because they are the ways this feature would go wrong quietly.

## 7. Open questions — review before building

1. **Is `autonomous` an operator identity or an operator policy?** This design says identity; the
   policy stays the issue `executionPolicy`. If the intent is a distinct policy object, that is a
   larger change and should not ride an OTA.
2. **What happens to in-flight approvals when a company switches mode?** Proposed: leave them alone;
   mode governs new work. Needs confirmation.
3. **Should `governance_mode` be exposed in the API read surface** the ExecOS registry consumes? It
   would make governance visible to the CEO surface, which is probably desirable and is a scope
   decision.
4. **Naming.** `steward`/`autonomous` sit one letter from the agent-level `stewarded`/`autonomous`.
   Distinct enough to be correct, close enough to be misread in a log line. `governed`/`autonomous`
   or `board`/`operator` would be unambiguous, at the cost of not matching the CEO's words.
