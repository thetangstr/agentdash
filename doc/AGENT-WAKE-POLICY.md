# Agent wake policy, run-window audit, and instance identity

Three pieces an external harness (for example the Track C pairing harness) uses to run one agent under strict control and prove, afterwards, that nothing else happened. All three are generic: one behaviour for every company, with no per-company branching.

## 1. Wake policy: `board_assignment_only`

### What it means

An agent whose `runtimeConfig.wakePolicy` is `"board_assignment_only"` starts a run only when a person assigns it an issue using a board API key. Every other wake is refused and recorded. In owner words: "Only start runs when a board member assigns an issue."

Absent, or `"default"`, means today's behaviour. Agents without the policy are not affected in any way.

Legacy alias: `metadata.travelPairing === true` (set by the Track C provisioner before this policy existed) turns on the same policy. Only the boolean `true` counts. New setups should use `runtimeConfig.wakePolicy`.

### Enabling it

Only a board user can set, change or clear it. An agent key gets 403, including when it drops the field by omission from a `runtimeConfig` it resends.

```sh
curl -X PATCH "$BASE/api/agents/$AGENT_ID" \
  -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  -d '{"runtimeConfig": {"wakePolicy": "board_assignment_only", "heartbeat": {"enabled": false, "wakeOnDemand": true}}}'
```

`PATCH /agents/:id` replaces `runtimeConfig` wholesale, so send the agent's whole current `runtimeConfig` with `wakePolicy` added. Switching the policy on (by PATCH, or by a config rollback that restores it) also refuses the agent's already queued or scheduled-retry runs that would not qualify. Each one is cancelled before it starts, and its wake becomes a standard refused row. A queued board-key issue assignment is kept. The validator accepts only `"default"` and `"board_assignment_only"`. The agent also needs `defaultEnvironmentId` pinned to a non-`local` environment of its company (see rule d). Turn the heartbeat timer off: timer wakes are refused anyway, but each refusal is a recorded row.

To start a run, create (or reassign) an issue with a board API key: `POST /api/companies/:companyId/issues` with `status: "todo"` and `assigneeAgentId`.

### The rule (first match wins)

Checked in `heartbeat.enqueueWakeup` after the invokable-state and budget checks, and before heartbeat policy, the token ceiling, tree holds and coalescing:

| Order | Refusal code (`reason` on the skipped wake row) | When |
|---|---|---|
| a | `travel_pairing.wake_source` | the wake source is not `assignment`: timers, comments and mentions, manual invokes, approvals, routines, automation, every retry |
| b | `travel_pairing.not_issue_assignment` | an `assignment` wake whose reason is not `issue_assigned` (checkout, tree restore, execution stage); also, checked after c, an `issue_assigned` wake whose issue is missing, in another company, or not currently assigned to this agent (so `POST /agents/:id/wakeup` cannot forge an assignment) |
| c | `travel_pairing.not_board_key` | the requester is not a person using a board API key: browser session, assistant grant, bridge endpoint, agent key, or any internal path with no request |
| d | `travel_pairing.no_environment` | no `defaultEnvironmentId`, the pinned environment is missing or in another company, or its driver is `local` |

A fifth code, `travel_pairing.environment_mismatch`, is used only at run start (see below).

The `travel_pairing.` prefix is historical: the policy began as the travel-pairing guard. External harnesses match on these strings, so they are stable and must never be renamed. They are exported as `AGENT_WAKE_POLICY_REFUSAL_CODES` from `@paperclipai/shared`.

The credential (rule c) is read from the authenticated request (`req.actor.source`, through `lib/request-actor-source.ts`), never from the caller's payload. For a policy agent, the server writes it into the wake payload as `requestedVia` (the credential kind, or `null`), on refusals and accepted wakes alike, replacing anything a caller put under that key. Other agents' payloads are left untouched.

### Lanes that bypass `enqueueWakeup`

These lanes create runs directly, so each one checks the policy itself:

- **Missing-comment retry, process-loss retry, bounded scheduled retry, immediate issue recovery.** Each writes one skipped wake row with `reason: "travel_pairing.wake_source"`, `source: "automation"`, `status: "skipped"`, `runId: null` and `payload: { refusedReason, requestedVia: null, retryOfRunId, issueId? }`. `refusedReason` is the lane's own reason (`missing_issue_comment`, `process_lost_retry`, `transient_failure_retry` (or the caller's wake reason), `issue_assignment_recovery`, or `issue_continuation_needed`). No run is created.
- **Deferred-wake promotion.** The deferred row is re-checked against its original source, the `wakeReason` in its context and its recorded `requestedVia`. A refused row becomes the skipped record with the matching code.
- **Task-recovery permit (human-control remediate).** Refused with 409 before anything is written. Reassign the issue instead.
- **Recovery sweeps.** Every recovery-service wake skips policy agents before it is requested, so no wake row is written. The sweeps also leave a policy agent's work alone:
  - the stranded-issue sweep skips their issues entirely (no wake, comment, re-block or escalation);
  - the silent-run scan never opens an evaluation, blocks the source issue or comments for their runs;
  - the issue-graph liveness sweep never blocks, comments on or escalates their issues, and never picks a policy agent as an escalation owner;
  - the orphan-blocker sweep never assigns a blocker back to a policy agent that created it;
  - immediate issue recovery releases the issue without the block-and-comment branch;
  - stale-run and stranded-issue escalations never choose a policy agent as their owner.
- **Run healer.** The scan excludes policy agents, and `executeHealFix` refuses them (`actionTaken: "wake_policy_refused"`).

### Run-start recheck

When a run that passed the front door starts:

1. **Before any lease or workspace exists:** the run's origin is re-checked against the wake that created it. Rules a, b and c are applied with that wake's source, reason (a promoted deferred wake's original `wakeReason`), actor type and recorded `requestedVia`. The issue must still be assigned to this agent, and rule d is applied to the re-read pin. So a timer, comment or retry run queued or scheduled before the policy was switched on never starts under it, and neither does a run whose issue was reassigned in the meantime. Finally, the resolved execution environment must equal the pin, or the run is refused with `travel_pairing.environment_mismatch`. Project policy, issue settings or a reused execution workspace can resolve a different environment.
2. **After lease acquisition:** if the acquired environment or lease differs from the pin, or the pin turned `local`, the lease is released first and the run is refused.

A run refused at start never executes: no adapter process is started, and a lease taken at checkpoint 2 is released. The run row stays as `cancelled` with `errorCode` set to the code. Its wake is marked `skipped` with the same code and its `runId` cleared to `null`, last, once everything has settled. The run-start auto-checkout is undone, so the issue returns to its prior status, and the execution lock is released. A cancelled run is never auto-recovered.

### Stable contract for verifiers

External verifiers count a refused wake, not foreign work, as any wake row with:

- `status: "skipped"` and `runId: null`;
- `reason` in exactly this set (`AGENT_WAKE_POLICY_REFUSAL_CODES`; `agent-wake-policy-codes.test.ts` fails if the set changes): `travel_pairing.wake_source`, `travel_pairing.not_issue_assignment`, `travel_pairing.not_board_key`, `travel_pairing.no_environment`, `travel_pairing.environment_mismatch`.

These fields are stable on such rows and may be disclosed:

| Field | Meaning |
|---|---|
| `reason` | the refusal code |
| `source` | front-door refusals keep the source the caller asked for; lane refusals are `automation` |
| `payload.refusedReason` | present on lane refusals: the internal lane that was refused (`missing_issue_comment`, `process_lost_retry`, `transient_failure_retry`, `issue_assignment_recovery`, `issue_continuation_needed`) |
| `payload.requestedVia` | the credential kind the request authenticated with (`board_key`, `session`, `agent_key`, …), or `null` for internal lanes; absent only on a wake recorded before the agent was under the policy (a pre-existing run refused at start or at switch-on) |

Every refusal path writes this shape and starts no run. That covers the front door, the bypass lanes, deferred promotion, both run-start checkpoints, and switching the policy on. The only other artifact is the `cancelled` run row left by a run-start or switch-on refusal. That row has `errorCode` equal to the same code and never executed.

### What still writes rows for a policy agent

The policy decides whether a run starts. It does not hide refused requests: every refused wake is recorded, so the ledger stays complete. Other guards that sit before the policy check are unchanged. A budget hard-stop still writes `budget.blocked`. Workspace-persistence and workforce-dispatch holds return without a row.

### Known limitations

- **Accepted proposals count as board assignments.** Accepting a CoS chat proposal, an issue interaction, first-run, or a steward-inbox assignment queues an `issue_assigned` wake with `requestedByActorType: "user"`. When the accepting person is on a board key, the assignment passes, even though an agent suggested the assignee. A person using a board key did make the assignment, so this is treated as a board assignment. A harness that wants only its own explicit assignments should not accept proposals on that agent.
- **Assignment race.** The front door reads the assignee outside the transaction that inserts the run. A reassignment in between can still queue one run, but the run-start check re-reads the assignee and refuses it (`travel_pairing.not_issue_assignment`) before it executes.
- **Deferred merge.** A board-key wake that coalesces into a deferred row created before the policy was on inherits that row's original source, and is refused at promotion. Re-assigning the issue starts it.
- **Escalation issues.** Recovery never assigns new escalation work to a policy agent. Escalation issues created for other agents may still reference a policy agent's issue in their description.

## 2. `GET /api/agents/:id/run-window?from=&to=`

A read-only audit of one agent over a closed interval.

- **Auth:** board actors only (an agent key gets 403). The caller needs `agents:create` in the agent's company, the same permission as `runtime-state` and `task-sessions`; a local-trusted board actor or an instance admin also passes. Another company gets 403. An agent the caller cannot see (owner-only visibility) gets 404.
- **Project visibility:** the same restricted-project rule as every other run list (A5, GH #830). For a caller who is not on a restricted project's access list, runs whose context issue, wakes whose `payload.issueId`, and comments whose issue sit in that project are left out. Company admins, instance admins and local-trusted callers see everything.
- **Query:** `from` and `to` are ISO-8601 timestamps with a timezone, for example `2026-10-07T12:00:00Z`. `from` must be before `to`, and the span may be at most 7 days. Anything else gets 400.
- **Response:**

```jsonc
{
  "agentId": "…", "companyId": "…",
  "from": "<from.toISOString()>", "to": "<to.toISOString()>",
  "runs":  [{ "id", "status", "invocationSource", "triggerDetail", "error", "errorCode",
              "wakeupRequestId", "issueId", "taskId", "startedAt", "finishedAt",
              "createdAt", "logSha256", "logBytes" }],
  "wakes": [{ "id", "source", "triggerDetail", "reason", "status", "payload",
              "requestedByActorType", "requestedByActorId", "runId",
              "requestedAt", "finishedAt", "error" }],
  "comments": [{ "id", "issueId", "authorAgentId", "authorUserId", "createdByRunId",
                 "body", "createdAt" }],
  "truncated": false
}
```

- **Runs:** lifetime overlap: `createdAt <= to` and (`finishedAt` is null or `finishedAt >= from`). `issueId` and `taskId` come from the run's context.
- **Wakes:** lifetime overlap on `requestedAt` / `finishedAt`, including skipped refusals. Secret-looking payload keys are redacted.
- **Comments:** comments created in `[from, to]` on issues currently assigned to the agent, on issues the agent was ever woken for, authored by the agent, or written by one of its runs. Each comment appears once.
- **Truncation:** each list is capped at 2000 rows, ordered oldest first. `truncated` is `true` when any list hit the cap. A harness should then fail instead of treating the window as complete.

Every query is scoped to the agent's company.

## 3. `/api/health` instance identity

Every response shape (public, full, no-db, and the 503 `database_unreachable` shape) carries these fields:

| Field | Value |
|---|---|
| `instanceId` | `AGENTDASH_INSTANCE_LABEL` when it is set to a slug (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`), otherwise the real `PAPERCLIP_INSTANCE_ID` (default `default`). Omitted if that id is malformed. The label is health-only: it never changes the data dir, JWTs or cookies. |
| `dataDirName` | the basename of the instance home dir (`PAPERCLIP_HOME`, default `~/.paperclip`), for example `.paperclip`. Never a full path. |
| `signUpDisabled` | `true` exactly when sign-up is disabled by `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` or `auth.disableSignUp` in config. A box gated only by shared invite codes (`AGENTDASH_INVITE_CODES`) reports `false`: that gate still lets anyone holding a code sign up. A harness that requires a closed box should require `true`. |
| `trialAnonymousEnabled` | whether `POST /api/trial/session` can mint an anonymous trial company. Always `false` on a hosted box, and `false` when `AGENTDASH_TRIAL_ANONYMOUS=false`. Uses the same function as the trial router's own gate. |

The health endpoint reports the instance's real identity. A harness that pins an identity should accept the instance it was pointed at, for example HQ's `instanceId` and `dataDirName`. It should not expect a fixed name.

## Agent prompts

No agent-facing behaviour changed: agents still receive the same wakes and prompts, and refused wakes simply never start a run. The four prompt surfaces in AGENTS.md are untouched (`[no-prompt-update]`).
