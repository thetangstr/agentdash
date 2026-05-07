# Manual production test — Goals/Eval/HITL layer

This is a step-by-step recipe to exercise the full Goals → DoD → CoS verdict → human-taste-gate → closing-verdict loop against a running AgentDash instance with real data. Use this when the automated `tests/e2e/goals-eval-hitl.spec.ts` can't run in your environment, or when you need to confirm behavior end-to-end with eyes on the UI.

**Estimated time:** 25–40 minutes.
**Risk:** writes new rows to `goals`, `projects`, `issues`, `verdicts`, `approvals`, `activity_log`. Reversible — no destructive operations on existing data.

---

## 0. Pre-flight

### 0.1 Confirm the build is on this branch

```sh
cd ~/Documents/Projects/agentdash
git status
git log -1 --oneline
```

Expect to be on `claude/agitated-stonebraker-e72042` (or whatever branch this work landed on after merge). If on `main` post-merge, that's fine.

### 0.2 Apply the migration

```sh
pnpm install
pnpm db:migrate
```

Confirm the migration applied:

```sh
psql "$DATABASE_URL" -c "SELECT id, status FROM verdicts LIMIT 1;" \
  || echo "Migration not applied — run 'pnpm db:migrate' or check DATABASE_URL"

psql "$DATABASE_URL" -c "\d verdicts" | head -30
psql "$DATABASE_URL" -c "\d cos_reviewer_assignments" | head -20
psql "$DATABASE_URL" -c "\d issue_review_queue_state" | head -20
psql "$DATABASE_URL" -c "\d feature_flags" | head -10
```

If you're on the embedded dev DB and don't have `psql` configured, replace with whatever your team uses to inspect the embedded PG (e.g., `pnpm --filter @paperclipai/db db:psql` if that helper exists; otherwise read the migration applied successfully in the dev server logs).

Verify the SQL view exists:

```sh
psql "$DATABASE_URL" -c "\d issue_review_timeline_v"
```

### 0.3 Start the server + UI

```sh
pnpm dev
```

Watch the logs for:

- `verdictApprovalBridge: watcher started` (or similar — the bootstrap line in [server/src/index.ts](../../server/src/index.ts) prints this when [verdict-approval-bridge.ts](../../server/src/services/verdict-approval-bridge.ts) starts)
- No errors mentioning `verdicts`, `feature_flags`, `cos_reviewer_assignments`, `issue_review_queue_state`

If a `/local-bootstrap` flow created a default workspace + CoS agent, note the company id in the logs (`bootstrap: provisioned workspace <uuid>` or similar). You'll need it.

### 0.4 Set up identifiers you'll reuse

Open a separate terminal to run curl from. Grab the following from the dev server:

```sh
# Replace with values from your dev session.
export AGENTDASH_BASE=http://localhost:3100
export COMPANY_ID=<uuid from bootstrap or /api/companies>
export BOARD_USER_TOKEN=<your auth token / cookie / however the local dev session authenticates>
```

If you're running in `local_trusted` mode without a sign-up flow ([CLAUDE.md](../../CLAUDE.md) "Local development bootstrap"), the synthetic `local-board` actor handles auth automatically — you may not need a token; cookies from the browser session are enough.

For curl convenience, capture the auth header / cookie:

```sh
# Open the UI in browser, log in (if applicable), then in browser DevTools → Application → Cookies
# copy the auth cookie name and value:
export AUTH="-H 'Cookie: <name>=<value>'"
```

### 0.5 Enable the DoD guard for this company

The DoD-guard is opt-in per-company via the `feature_flags` table (Phase A multi-tenant rollout — Architect-required revision).

```sh
curl -X PUT "$AGENTDASH_BASE/api/companies/$COMPANY_ID/feature-flags/dod_guard_enabled" \
  -H 'Content-Type: application/json' \
  $AUTH \
  -d '{"enabled": true}'
```

Verify:

```sh
curl "$AGENTDASH_BASE/api/companies/$COMPANY_ID/feature-flags/dod_guard_enabled" $AUTH
# expect: {"companyId":"...","flagKey":"dod_guard_enabled","enabled":true,...}
```

---

## 1. Create a Goal with a measurable metric

### 1.1 Create the Goal (UI)

1. Open `http://localhost:3100/goals` in the browser.
2. Click **+ New Goal**.
3. Title: `Q3 ARR Target`.
4. Status: `planned`.
5. Save.

Capture the new goal id from the URL (`/goals/<uuid>`):

```sh
export GOAL_ID=<uuid from URL>
```

### 1.2 Set the Goal's metric definition

Open the Goal detail page. You should see the **GoalMetricTile** in an empty state with an "Edit metric" button (added in Phase F).

Click **Edit metric**, fill:

- **Target:** `1000000`
- **Unit:** `USD`
- **Source:** `internal-finance-dashboard.example/q3`
- **Baseline:** `400000`
- **Current value:** `420000`

Save.

**Expected:**
- Tile updates to show `420,000 / 1,000,000 USD` (or similar formatted display) with `last updated` timestamp.
- A row appears in `activity_log` with action `metric_updated`. Verify:

```sh
psql "$DATABASE_URL" -c "
  SELECT action, entity_type, entity_id, created_at
  FROM activity_log
  WHERE entity_type = 'goal' AND entity_id = '$GOAL_ID' AND action = 'metric_updated'
  ORDER BY created_at DESC LIMIT 1;
"
```

### 1.3 Verify the API directly (sanity)

```sh
curl "$AGENTDASH_BASE/api/companies/$COMPANY_ID/goals/$GOAL_ID" $AUTH | jq .metricDefinition
# expect: {"target":1000000,"unit":"USD","source":"...","baseline":400000,"currentValue":420000,"lastUpdatedAt":"..."}
```

---

## 2. Create a Project with DoD under the Goal

### 2.1 Create the Project (UI)

1. From the Goal detail page, click **+ New Project**.
2. Title: `Land 5 enterprise pilots`.
3. Save.

Capture the project id:

```sh
export PROJECT_ID=<uuid from URL>
```

### 2.2 Set the Project DoD

On the Project detail page, open the **Configuration** tab. You should see a `ProjectDoDSection` with a `DefinitionOfDoneEditor` (added in Phase F).

Fill:

- **Summary:** `Five signed pilot agreements with $200K+ ACV each`
- **Criteria** (add 3):
  - `5 signed pilot agreements` — unchecked
  - `Each pilot >= $200K ACV` — unchecked
  - `Pilot launch dates within Q3` — unchecked
- **Goal metric link:** `Q3 ARR Target` (or paste `$GOAL_ID`)

Save.

**Expected:**
- `dod_set` row in `activity_log` for this project.

```sh
psql "$DATABASE_URL" -c "
  SELECT action, created_at FROM activity_log
  WHERE entity_type = 'project' AND entity_id = '$PROJECT_ID' AND action = 'dod_set'
  ORDER BY created_at DESC LIMIT 1;
"
```

### 2.3 Verify the API

```sh
curl "$AGENTDASH_BASE/api/companies/$COMPANY_ID/projects/$PROJECT_ID" $AUTH | jq .definitionOfDone
```

---

## 3. Create an Issue assigned to an agent (NOT the user — needed for neutrality)

### 3.1 Identify a candidate assignee agent

You need an agent that is **NOT** the CoS (CoS will be the reviewer). List agents:

```sh
curl "$AGENTDASH_BASE/api/companies/$COMPANY_ID/agents" $AUTH \
  | jq '.[] | {id, name, kind, archetype}' | head -40
```

Pick a non-CoS agent — note its id:

```sh
export ASSIGNEE_AGENT_ID=<uuid of a non-CoS agent>
```

If the only agent in the company is CoS (fresh bootstrap), hire one first. The simplest path for testing: use the existing `hire_agent` approval flow from the UI, or directly insert via psql for a manual test:

```sh
# Manual fast path for test only — do not use in prod data flows.
psql "$DATABASE_URL" <<SQL
  INSERT INTO agents (id, company_id, name, kind, archetype, status, created_at, updated_at)
  VALUES (gen_random_uuid(), '$COMPANY_ID', 'Test Builder', 'claude_local', 'builder', 'active', now(), now())
  RETURNING id;
SQL
```

Use the returned id as `ASSIGNEE_AGENT_ID`.

### 3.2 Create the Issue (UI)

1. From the Project page, click **+ New Issue**.
2. Title: `Outreach: Acme Corp pilot`.
3. Assignee: pick the agent from 3.1 (the non-CoS one).
4. Save.

Capture the issue id:

```sh
export ISSUE_ID=<uuid from URL>
```

### 3.3 Set the Issue DoD

The issue detail page should show a new **Reviews** tab (added in Phase F). Open it — you should see the `DefinitionOfDoneEditor` and an empty `VerdictTimeline`.

Fill the DoD:

- **Summary:** `First-meeting booked + LOI sent`
- **Criteria:**
  - `Discovery call scheduled with VP+ attendee` — unchecked
  - `LOI shared via DocSend` — unchecked

Save.

**Expected:**
- `dod_set` activity_log row for this issue.

### 3.4 Confirm the DoD-guard kicks in if you skip the DoD

To regression-test the guard: try transitioning a *different* issue (without DoD) from `backlog` to `todo`. The transition should fail with HTTP 422 and error code `DOD_REQUIRED`.

```sh
# Using API directly:
export NO_DOD_ISSUE_ID=<id of a backlog issue with no DoD>
curl -X PATCH "$AGENTDASH_BASE/api/companies/$COMPANY_ID/issues/$NO_DOD_ISSUE_ID" \
  -H 'Content-Type: application/json' $AUTH \
  -d '{"status":"todo"}'
# expect HTTP 422, body: {"code":"DOD_REQUIRED","message":"...","details":{"entityType":"issue","entityId":"..."}}
```

If you get HTTP 200, either the issue had a DoD already, or the feature flag is off — re-check step 0.5.

---

## 4. Transition the Issue to `in_review`

### 4.1 Move the issue forward

In the UI, change the issue status: `backlog → todo → in_progress → in_review`. Or via API:

```sh
for status in todo in_progress in_review; do
  curl -X PATCH "$AGENTDASH_BASE/api/companies/$COMPANY_ID/issues/$ISSUE_ID" \
    -H 'Content-Type: application/json' $AUTH \
    -d "{\"status\":\"$status\"}"
  echo
done
```

Each transition out of `backlog` is gated by the DoD-guard; since we set the DoD in step 3.3, all should succeed.

### 4.2 Confirm the orchestrator enqueued the issue for review

The `in_review` transition should fire `cosVerdictOrchestrator.onIssueStatusChanged(...)` (wired in Phase D in [server/src/routes/issues.ts](../../server/src/routes/issues.ts)). That should:

- Insert a row into `issue_review_queue_state`
- Pick an `assignedReviewerAgentId` (CoS or a CoS-hired reviewer)
- Possibly trigger `cosReviewerAutoHire.evaluateAndHireIfNeeded(...)` if no reviewer is available

```sh
psql "$DATABASE_URL" -c "
  SELECT issue_id, enqueued_at, escalate_after, assigned_reviewer_agent_id
  FROM issue_review_queue_state
  WHERE issue_id = '$ISSUE_ID';
"
```

**Expected:** one row with `enqueued_at` ≈ now and `escalate_after` ≈ now + 24h (or whatever `AGENTDASH_VERDICT_ESCALATE_AFTER_MS` overrides).

If `assigned_reviewer_agent_id` is NULL: a hire was likely triggered. Check:

```sh
psql "$DATABASE_URL" -c "
  SELECT id, reviewer_agent_id, hired_at, retired_at, queue_depth_at_spawn
  FROM cos_reviewer_assignments
  WHERE company_id = '$COMPANY_ID' AND retired_at IS NULL
  ORDER BY hired_at DESC;
"
```

And the audit trail:

```sh
psql "$DATABASE_URL" -c "
  SELECT action, details, created_at FROM activity_log
  WHERE company_id = '$COMPANY_ID' AND action = 'reviewer_hired'
  ORDER BY created_at DESC LIMIT 3;
"
```

---

## 5. Test path A — CoS writes a `passed` verdict

This is the happy path: CoS reviews, agrees with the work, writes a closing verdict.

### 5.1 Manually post the verdict via API

In a real run, the CoS adapter does this on its own when invoked. For a manual production test, write the verdict directly via the verdict route (added in Phase D):

```sh
curl -X POST "$AGENTDASH_BASE/api/companies/$COMPANY_ID/verdicts" \
  -H 'Content-Type: application/json' $AUTH \
  -d "{
    \"companyId\": \"$COMPANY_ID\",
    \"entityType\": \"issue\",
    \"issueId\": \"$ISSUE_ID\",
    \"reviewerAgentId\": \"<CoS or another non-assignee agent id>\",
    \"outcome\": \"passed\",
    \"rubricScores\": { \"completeness\": 5, \"quality\": 4 },
    \"justification\": \"Discovery call booked with VP Eng at Acme; LOI shared. DoD met.\"
  }"
```

**Critical:** `reviewerAgentId` must NOT equal `ASSIGNEE_AGENT_ID`. The neutral-validator guard (in [server/src/services/verdicts.ts](../../server/src/services/verdicts.ts)) rejects self-review with code `NEUTRAL_VALIDATOR_VIOLATION`.

**Test the guard:** try the same call with `reviewerAgentId: $ASSIGNEE_AGENT_ID`. Expected HTTP 422, code `NEUTRAL_VALIDATOR_VIOLATION`.

### 5.2 Verify the verdict landed

```sh
curl "$AGENTDASH_BASE/api/companies/$COMPANY_ID/verdicts?entityType=issue&entityId=$ISSUE_ID" $AUTH \
  | jq '.[] | {outcome, reviewerAgentId, justification, createdAt}'
```

**Expected:** one row, `outcome: "passed"`.

### 5.3 Verify activity_log

```sh
psql "$DATABASE_URL" -c "
  SELECT action, details->>'outcome' AS outcome, created_at FROM activity_log
  WHERE entity_type = 'issue' AND entity_id = '$ISSUE_ID'
  ORDER BY created_at DESC;
"
```

**Expected (most recent first):**
- `verdict_recorded` with `outcome=passed`
- earlier: `dod_set`
- earlier: status-change rows (existing convention)

### 5.4 Verify the Issue review timeline UI

In the browser, refresh the issue detail page → **Reviews** tab. The `VerdictTimeline` should now show one row: `passed` with the justification text and the reviewer agent name.

---

## 6. Test path B — Escalate to human, then human approves

This tests the bridge — the most architecturally sensitive piece.

### 6.1 Create a second issue and walk it to `in_review`

Repeat steps 3 and 4 with a new issue: `Outreach: Beta Inc pilot`. Capture as `$ESCALATE_ISSUE_ID`.

### 6.2 CoS writes an `escalated_to_human` verdict

```sh
curl -X POST "$AGENTDASH_BASE/api/companies/$COMPANY_ID/verdicts" \
  -H 'Content-Type: application/json' $AUTH \
  -d "{
    \"companyId\": \"$COMPANY_ID\",
    \"entityType\": \"issue\",
    \"issueId\": \"$ESCALATE_ISSUE_ID\",
    \"reviewerAgentId\": \"<CoS agent id>\",
    \"outcome\": \"escalated_to_human\",
    \"justification\": \"Brand-voice review needed — outreach copy is taste-critical and outside CoS confidence.\"
  }"
```

This should ALSO create an `approval` row (the orchestrator's `escalateToHuman` path does this when called via `runReviewCycle`; if you POST the verdict directly the bridge / route may not auto-create the approval — verify):

```sh
psql "$DATABASE_URL" -c "
  SELECT a.id, a.type, a.status, a.payload->>'verdictId' AS verdict_id, ia.issue_id
  FROM approvals a
  LEFT JOIN issue_approvals ia ON ia.approval_id = a.id
  WHERE a.payload->>'type' = 'verdict_escalation'
    AND ia.issue_id = '$ESCALATE_ISSUE_ID'
  ORDER BY a.created_at DESC LIMIT 1;
"
```

**If no approval row exists:** the production code path that creates the approval is in `cos-verdict-orchestrator.ts` `escalateToHuman`. The direct verdict-POST endpoint may not call it — that's a known gap. For this manual test, create the approval directly:

```sh
# Find the verdict id you just created
export VERDICT_ID=<from step 6.2 response>

# Create the matching approval
curl -X POST "$AGENTDASH_BASE/api/companies/$COMPANY_ID/approvals" \
  -H 'Content-Type: application/json' $AUTH \
  -d "{
    \"type\": \"verdict_escalation\",
    \"requestedByAgentId\": \"<CoS agent id>\",
    \"payload\": {
      \"type\": \"verdict_escalation\",
      \"verdictId\": \"$VERDICT_ID\",
      \"issueId\": \"$ESCALATE_ISSUE_ID\",
      \"justification\": \"Brand-voice review needed\"
    }
  }"
# capture approval id:
export APPROVAL_ID=<id from response>

# Link to the issue
curl -X POST "$AGENTDASH_BASE/api/companies/$COMPANY_ID/issue-approvals" \
  -H 'Content-Type: application/json' $AUTH \
  -d "{\"issueId\": \"$ESCALATE_ISSUE_ID\", \"approvalId\": \"$APPROVAL_ID\"}"
```

### 6.3 Surface in approvals inbox

Open the approvals inbox in the UI — the new escalation should appear with the issue context. Confirm it renders.

If the CoS chat substrate is rendering `human_taste_gate` cards (Phase E), the escalation should also surface in the assistant conversation thread tied to this issue, with the `human_taste_gate` cardKind. Verify by inspecting the conversation:

```sh
curl "$AGENTDASH_BASE/api/companies/$COMPANY_ID/assistant-conversations" $AUTH \
  | jq '.[].messages[] | select(.cardKind == "human_taste_gate")'
```

(The exact route name depends on the existing assistant-conversations API; adjust as needed.)

### 6.4 Approve the approval as a human

In the UI, click **Approve** on the approval. Or via API:

```sh
curl -X POST "$AGENTDASH_BASE/api/companies/$COMPANY_ID/approvals/$APPROVAL_ID/approve" \
  -H 'Content-Type: application/json' $AUTH \
  -d '{"decisionNote":"Outreach copy approved — voice is on-brand."}'
```

### 6.5 Wait for the bridge to write the closing verdict

The bridge ([server/src/services/verdict-approval-bridge.ts](../../server/src/services/verdict-approval-bridge.ts)) listens via the LiveEvent bus by default; if you're using the polling fallback (`AGENTDASH_APPROVAL_POLL_MS` set), wait that interval. Default poll fallback is 5s; LiveEvent should fire within ~1s.

Wait 10 seconds, then verify a NEW verdict landed:

```sh
sleep 10
curl "$AGENTDASH_BASE/api/companies/$COMPANY_ID/verdicts?entityType=issue&entityId=$ESCALATE_ISSUE_ID" $AUTH \
  | jq '.[] | {outcome, reviewerUserId, justification, createdAt}'
```

**Expected:** TWO rows now. The original `escalated_to_human` and a NEW closing verdict with `outcome: "passed"` and `reviewerUserId` = your user id (the human who decided), `justification` = the decision note.

### 6.6 Verify the loop-closing audit row

```sh
psql "$DATABASE_URL" -c "
  SELECT action, details->>'outcome' AS outcome, details->>'approvalId' AS approval_id, created_at
  FROM activity_log
  WHERE entity_type = 'issue' AND entity_id = '$ESCALATE_ISSUE_ID'
    AND action IN ('verdict_recorded','escalated_to_human','human_decision_recorded')
  ORDER BY created_at ASC;
"
```

**Expected sequence:**
1. `verdict_recorded` (outcome=escalated_to_human) — when CoS escalated
2. `human_decision_recorded` — when bridge fired after the human approved
3. `verdict_recorded` (outcome=passed) — the closing verdict

### 6.7 Confirm the bridge did NOT modify approvals.ts

This is the architectural crown jewel:

```sh
git diff main -- server/src/services/approvals.ts | wc -l
# expect: 0
```

If this is non-zero, something went wrong — the bridge is supposed to be caller-only.

---

## 7. Verify the traceability coverage tile

### 7.1 Hit the API

```sh
curl "$AGENTDASH_BASE/api/companies/$COMPANY_ID/coverage" $AUTH | jq .
# expect: {"totalInFlight":N,"coveredInFlight":M,"coverageRatio":0.XX}
```

`coveredInFlight` counts issues that have a Goal link AND a non-null DoD AND ≥1 closing verdict. After steps 3–6, the two issues you created should both count toward `coveredInFlight`.

### 7.2 With breakdown

```sh
curl "$AGENTDASH_BASE/api/companies/$COMPANY_ID/coverage?breakdown=true" $AUTH | jq '.byProject'
```

### 7.3 Visually

Open the dashboard. The **TraceabilityCoverageTile** should show `XX%` with `M/N` underneath. Click "view breakdown" → per-project bars.

---

## 8. Test the neutrality-conflict auto-hire path

This exercises the scenario where CoS would be both the assignee AND the only available reviewer.

1. Create an issue assigned to the CoS agent itself (`assigneeAgentId = <CoS id>`).
2. Set DoD.
3. Walk to `in_review`.
4. Verify a hire is triggered EVEN IF queue depth is below threshold:

```sh
psql "$DATABASE_URL" -c "
  SELECT action, details->>'reason' AS reason, details->>'reviewerAgentId' AS reviewer_id
  FROM activity_log
  WHERE company_id = '$COMPANY_ID' AND action = 'reviewer_hired'
  ORDER BY created_at DESC LIMIT 5;
"
```

**Expected:** at least one row with `reason = neutrality_conflict`.

If no row appears, either:
- The orchestrator's neutrality-conflict path isn't firing on enqueue (only on `runReviewCycle` tick, which Phase D7 deferred). In that case, this test is pending the per-company tick wiring — flag as a known follow-up.
- Or the queue had an active reviewer already — verify with `cos_reviewer_assignments`.

---

## 9. Cleanup (optional)

If this was a test on a real production DB and you want to remove the test data:

```sh
psql "$DATABASE_URL" <<SQL
  -- Verdicts cascade-delete on entity drop, but we delete them explicitly for clarity.
  DELETE FROM verdicts WHERE company_id = '$COMPANY_ID' AND issue_id IN ('$ISSUE_ID', '$ESCALATE_ISSUE_ID');
  DELETE FROM issue_review_queue_state WHERE issue_id IN ('$ISSUE_ID', '$ESCALATE_ISSUE_ID');
  DELETE FROM issue_approvals WHERE issue_id IN ('$ISSUE_ID', '$ESCALATE_ISSUE_ID');
  DELETE FROM approvals WHERE id = '$APPROVAL_ID';
  DELETE FROM issues WHERE id IN ('$ISSUE_ID', '$ESCALATE_ISSUE_ID');
  DELETE FROM projects WHERE id = '$PROJECT_ID';
  DELETE FROM goals WHERE id = '$GOAL_ID';
  -- activity_log is append-only — leave the audit trail for analysis.
SQL
```

Or just rely on the next dev DB reset (`rm -rf ~/.paperclip/instances/default/db`).

---

## What "passing" looks like

A successful run produces:

- ✅ Migration 0080 applied without error
- ✅ DoD-guard rejects `backlog → todo` transitions on issues without DoD when feature flag is on
- ✅ Goal metric definition is editable, shows on tile, writes `metric_updated` audit row
- ✅ Project + Issue DoD editor saves via `PUT` route, writes `dod_set` audit rows
- ✅ Issue → `in_review` enqueues into `issue_review_queue_state`
- ✅ Verdict POST with self-reviewer is rejected with `NEUTRAL_VALIDATOR_VIOLATION`
- ✅ Verdict POST with neutral reviewer succeeds, writes `verdict_recorded` audit row
- ✅ `escalated_to_human` verdict + matching approval surface in approvals inbox
- ✅ Human approval triggers bridge → closing verdict written within poll interval
- ✅ Three-row audit sequence: `verdict_recorded`(escalated) → `human_decision_recorded` → `verdict_recorded`(passed)
- ✅ `git diff main -- server/src/services/approvals.ts | wc -l` = 0 (architectural invariant)
- ✅ Traceability coverage tile shows accurate `M/N` count with breakdown
- ✅ Neutrality-conflict auto-hire path fires (if Phase D7 tick is wired; otherwise: deferred)

## Known gaps to expect

These are surfaced from the build report; flag if they trip you up:

1. **Per-company `runReviewCycle` tick** ([Phase D7](../../.omc/plans/agentdash-goals-eval-hitl.md)) is deferred. SLA escalation (items past `escalate_after`) won't auto-fire without it. The bridge still handles human-decision close-loop in real time via LiveEvents.
2. **Direct verdict POST does not auto-create approvals.** Only the orchestrator's `escalateToHuman` path does. For a manual escalate flow you create the approval explicitly (step 6.2). Real CoS-driven escalations route through the orchestrator, not the bare POST.
3. **UI structural type-casts** for `metricDefinition` / `definitionOfDone` — `packages/shared/src/types/{goal,project,issue}.ts` weren't extended. Visible in TS strict-mode but runtime behavior is unaffected.
4. **`pnpm-lock.yaml`** in this branch may have unrelated drift (`adapter-openclaw-gateway` removed, `hermes-paperclip-adapter` 0.2 → 0.3). Revert before merge if those are not intentional.

## If something fails

| Symptom | Likely cause | Fix |
|---|---|---|
| `PUT /metric-definition` returns 404 | Route not wired in `app.ts` | Check `git grep -n "verdictRoutes\\|featureFlagRoutes" server/src/app.ts` |
| `POST /verdicts` returns 422 `NEUTRAL_VALIDATOR_VIOLATION` unexpectedly | reviewerAgentId == assigneeAgentId for the issue | Use a different agent |
| Approval created but no closing verdict appears | Bridge watcher not started | Check server logs for `verdictApprovalBridge: watcher started` |
| Closing verdict appears but `human_decision_recorded` is missing | Bridge wrote verdict but skipped audit | Check `verdict-approval-bridge.ts` `onApprovalResolved` for the second `logActivity` call |
| `coverage` returns 0 / 0 with non-zero issue count | Issues are missing Goal link OR DoD OR closing verdict | Check the SQL filter conditions in `coverage()` |
| DoD-guard does not block transition | Feature flag is off | `PUT .../feature-flags/dod_guard_enabled {"enabled":true}` |
| Migration 0080 fails to apply | Pre-existing journal mismatch | Check `meta/_journal.json` was updated; if not, run `pnpm db:generate` to reconcile |
