# AgentDash × ExecOS Two-Track Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` (or `superpowers:subagent-driven-development` when splitting independent tasks), follow `superpowers:test-driven-development`, and run `superpowers:verification-before-completion` before every completion claim.

**Goal:** Prove one real, read-only KiddoQuest question can be recorded once in AgentDash, executed by a user-owned Claude Code runner in a newly owned pane inside tmux session `execos-0`, and returned to the AgentDash issue as an attributable answer or explicit cannot-answer result with durable evidence and lifecycle audit.

**Architecture:** AgentDash remains the durable system of record and uses its existing issue → assignment wakeup → heartbeat run → run event/log → attributed issue comment lifecycle. ExecOS adds a portable normalized request/event/evidence contract, an AgentDash API client that maps exactly one request to exactly one issue, and an external AgentDash adapter plugin that forwards the request to a separately running local service. The local service owns tmux discovery and per-run pane creation; it uses the CEO's existing local Claude subscription without transmitting credentials to AgentDash. ExecOS owns interpretation and approval classification. AgentDash owns project/work records. The adapter and runner own transport only.

**Tech stack:** Node.js 24, TypeScript, Node test runner, AgentDash Express API and external adapter plugin contract, tmux CLI, Claude Code CLI.

## Fixed boundaries

- `KiddoQuest` / normalized project key `kiddoquest` is the only live acceptance project.
- The exact configured tmux session is `execos-0` (tmux session id `$0`). Discovery output, not a hard-coded historical alias, is authoritative.
- Observed Claude pane `%0` in window `@0` is metadata-only and must never receive keys, commands, interrupts, respawns, captures of sensitive scrollback, or ownership claims.
- Every execution creates a new, explicitly owned pane; the existing owned shell `%1` may supervise the runner service but is not a per-request execution pane.
- Only `routine_read_only` requests auto-run. `destructive`, `credentialed`, `external`, `high_impact`, and `unknown` return `blocked_pending_approval`; this pilot does not execute them even if an approval field is present.
- AgentDash authentication is its own board/agent bearer-token boundary. Claude authentication stays in the user's local Claude installation and is never returned by the runner or adapter.
- No `agentdash_mk` company/profile check is introduced. Existing profile-gated fact/bridge primitives are not used by this slice.
- Hermes and direct control of an already-running Claude/Codex session remain explicitly unsupported.

## Two-track dependency order

1. Define and test the normalized request/event/evidence/audit contract in ExecOS.
2. Implement and test the local tmux Claude runner against a fake tmux/process boundary.
3. Implement and test the external AgentDash adapter plugin as an HTTP-only transport client to that runner.
4. Implement and test the ExecOS AgentDash API client that creates or resolves the single durable issue and reads back its audit.
5. Run the offline end-to-end acceptance harness.
6. Only after all offline gates pass, run one live local KiddoQuest proof against the configured AgentDash instance and `execos-0`.

---

### Task 1: Normalize request, lifecycle event, evidence, and audit shapes

**Files:**

- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/src/integrations/execution-contract.ts`
- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/test/execution-contract.test.ts`
- Modify: `/Volumes/mac_studio_ssd/Projects/agent_bus/docs/adapter-contract.md`

**Step 1: Write the failing contract tests**

Cover:

- a valid `routine_read_only` KiddoQuest request;
- rejection of non-KiddoQuest live requests in pilot mode;
- mandatory actor, correlation, scope, timestamps, adapter/runtime identity, and evidence method;
- terminal statuses `completed`, `cannot_answer`, `blocked_pending_approval`, `failed`, `unsupported`;
- unsupported capability rows for Hermes direct-session control and observed-pane control;
- deterministic serialization for embedding the request in an AgentDash issue description.

Run:

```sh
node --test test/execution-contract.test.ts
```

Expected: FAIL because the contract module does not exist.

**Step 2: Implement the minimal contract**

Define and validate:

```ts
type ExecutionTrack = "agentdash" | "local_claude";
type ExecutionStatus =
  | "accepted"
  | "started"
  | "completed"
  | "cannot_answer"
  | "blocked_pending_approval"
  | "failed"
  | "unsupported";

interface ExecutionRequest {
  id: string;
  correlationId: string;
  project: "kiddoquest";
  question: string;
  expectedOutput: "direct_answer_with_evidence";
  classification: "routine_read_only" | "destructive" | "credentialed" | "external" | "high_impact" | "unknown";
  scope: { readOnly: boolean; paths: string[]; repos: string[] };
  requestedBy: { actorType: "ceo" | "execos" | "agentdash_agent"; actorId: string };
  createdAt: string;
}
```

Add `ExecutionEvent`, `EvidenceRecord`, `ExecutionAudit`, validation helpers, an AgentDash description marker, and parse/serialize helpers. Keep the module dependency-free.

**Step 3: Run the targeted test and typecheck**

```sh
node --test test/execution-contract.test.ts
npm run typecheck
```

Expected: PASS.

**Step 4: Commit**

```text
Make cross-runtime evidence comparable before adding transport

Constraint: AgentDash and the local Claude runner must keep ownership and credentials separate.
Rejected: Runtime-specific request payloads | they would make audit semantics diverge across tracks.
Confidence: high
Scope-risk: narrow
Directive: Add new execution tracks by implementing this contract; do not fork its lifecycle vocabulary.
Tested: node --test test/execution-contract.test.ts; npm run typecheck
Not-tested: No runtime transport is exercised in this commit.
```

---

### Task 2: Build the local tmux Claude runner criteria-first

**Files:**

- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/src/runners/tmux-claude/tmux.ts`
- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/src/runners/tmux-claude/runner.ts`
- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/src/runners/tmux-claude/server.ts`
- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/src/runners/tmux-claude/main.ts`
- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/test/tmux-claude-runner.test.ts`
- Modify: `/Volumes/mac_studio_ssd/Projects/agent_bus/package.json`

**Step 1: Write failing safety and lifecycle tests**

Use injected fake tmux/process/filesystem boundaries. Prove:

- session discovery accepts configured name `execos-0` and records tmux id `$0`;
- `%0` / `@0` is classified `observed_external` and every attempted write target is rejected;
- each accepted request calls `new-window` and receives a fresh exact window/pane identity;
- no `send-keys` path exists for observed or owned panes;
- non-read-only requests stop at `blocked_pending_approval` before tmux or Claude invocation;
- missing session, missing Claude command, timeout, malformed output, and runner failure become attributable `cannot_answer` or `failed` audits rather than invented answers;
- answer evidence records command family, cwd, pane identity, timestamps, byte count, SHA-256, truncation, and `read`/`reported` method without secrets.

Run:

```sh
node --test test/tmux-claude-runner.test.ts
```

Expected: FAIL because the runner modules do not exist.

**Step 2: Implement tmux discovery and protected-pane policy**

Use structured `spawn` calls for discovery and window creation. Accept exact configured session/pane identities. Never infer ownership from the active pane. Reject any command whose target identity equals protected pane `%0` or protected window `@0`.

**Step 3: Implement the per-request owned-pane lifecycle**

- Create a private temporary run directory.
- Write the scoped prompt and a generated wrapper script there.
- Launch the wrapper as the initial command of a new detached tmux window; do not type into any existing pane.
- Run `claude --print` using the user's existing local login, with no API key copied into request payloads or evidence.
- Persist bounded stdout/stderr/result/sentinel files locally.
- Poll only the sentinel and pane metadata with a finite timeout.
- Return a normalized `ExecutionAudit`; retain exact pane identity in every event/evidence record.

**Step 4: Add the localhost-only runner service**

Expose:

- `GET /health` — session and capability declaration, with `%0` explicitly protected;
- `POST /v1/executions` — one normalized request plus AgentDash run identity;
- `GET /v1/executions/:runId` — normalized audit only.

Bind to `127.0.0.1` by default. Do not expose Claude credentials, environment variables, arbitrary shell commands, or a generic pane-control API.

**Step 5: Run targeted tests and typecheck**

```sh
node --test test/tmux-claude-runner.test.ts
npm run typecheck
```

Expected: PASS.

**Step 6: Commit**

```text
Keep subscription-backed execution inside an owned local runner

Constraint: The live Claude pane %0 is external and must never be controlled.
Rejected: Typing into an existing terminal pane | ownership and attribution cannot be proven safely.
Confidence: high
Scope-risk: moderate
Directive: All future local execution must create a fresh owned pane and emit normalized evidence.
Tested: node --test test/tmux-claude-runner.test.ts; npm run typecheck
Not-tested: Live Claude subscription execution is deferred to the gated acceptance step.
```

---

### Task 3: Add the external AgentDash adapter plugin

**Files:**

- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/packages/agentdash-execos-adapter/package.json`
- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/packages/agentdash-execos-adapter/src/index.ts`
- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/test/agentdash-execos-adapter.test.ts`
- Modify: `/Volumes/mac_studio_ssd/Projects/agent_bus/tsconfig.json`

**Step 1: Write the failing adapter contract tests**

Prove `createServerAdapter()` returns every required AgentDash adapter field, parses only the normalized request marker from `context.paperclipIssue.description`, forwards no AgentDash or Claude credential to the local runner, streams normalized lifecycle evidence through `onLog`, and returns `resultJson.summary` plus the complete normalized audit so AgentDash automatically writes an attributed run comment.

Run:

```sh
node --test test/agentdash-execos-adapter.test.ts
```

Expected: FAIL because the external package does not exist.

**Step 2: Implement the HTTP-only adapter**

Configuration fields:

- `runnerBaseUrl` (default `http://127.0.0.1:4781`);
- `requestTimeoutSec`;
- no Claude token, API key, tmux command, or arbitrary shell field.

`execute()` sends the normalized request, AgentDash `runId`, agent identity, and issue identity to the runner. It returns normalized terminal status/evidence in `resultJson`; `summary` is a direct answer or a plain cannot-answer/blocked statement containing request ID, actor, runtime, pane ID when allocated, and evidence references.

`testEnvironment()` checks only runner health and capability declarations. It must warn or fail when the configured session is absent, `%0` is not protected, or the runner advertises Hermes/direct-session control.

**Step 3: Run targeted tests and typecheck**

```sh
node --test test/agentdash-execos-adapter.test.ts
npm run typecheck
```

Expected: PASS.

**Step 4: Commit**

```text
Let AgentDash own lifecycle without inheriting Claude credentials

Constraint: The local Claude subscription must remain inside the user-owned runner.
Rejected: Launching Claude directly from the AgentDash server | that collapses the two ownership tracks.
Confidence: high
Scope-risk: narrow
Directive: Keep this adapter transport-only and preserve AgentDash run/comment attribution.
Tested: node --test test/agentdash-execos-adapter.test.ts; npm run typecheck
Not-tested: Plugin installation into a live AgentDash instance is deferred to acceptance.
```

---

### Task 4: Add the AgentDash system-of-record client

**Files:**

- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/src/integrations/agentdash-client.ts`
- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/test/agentdash-client.test.ts`

**Step 1: Write the failing API mapping tests**

With an in-process fake HTTP server, prove:

- the client first queries `GET /api/companies/:companyId/issues?originKind=execos_request&originId=:requestId`;
- an existing issue is reused and a second issue is never posted;
- a missing issue is created through `POST /api/companies/:companyId/issues` with `projectId`, `assigneeAgentId`, `originKind`, `originId`, normalized description, and routine-read-only execution policy;
- bearer credentials are sent only to AgentDash and never included in the issue, runner request, logs, evidence, or returned audit;
- `GET /api/issues/:id`, `GET /api/issues/:id/comments`, and the issue execution run identity compose a read-only audit view;
- responses that lack actor/run/evidence attribution remain explicit incomplete/unsupported results.

Run:

```sh
node --test test/agentdash-client.test.ts
```

Expected: FAIL because the client does not exist.

**Step 2: Implement the client**

Keep it a narrow REST client. Do not add an ExecOS reasoning table to AgentDash. Use AgentDash's existing issue origin fields for idempotent lookup, existing assignment wakeup for dispatch, heartbeat run/result/event records for execution audit, and attributed issue comments for the direct answer.

**Step 3: Run targeted tests and typecheck**

```sh
node --test test/agentdash-client.test.ts
npm run typecheck
```

Expected: PASS.

**Step 4: Commit**

```text
Make AgentDash the durable record for each ExecOS request

Constraint: One normalized request must map to one visible AgentDash issue.
Rejected: A parallel ExecOS work database | AgentDash already owns project and work state.
Confidence: high
Scope-risk: narrow
Directive: Keep interpretation in ExecOS and persist only requests, lifecycle, evidence, and answers in AgentDash.
Tested: node --test test/agentdash-client.test.ts; npm run typecheck
Not-tested: Concurrent duplicate submission across multiple ExecOS processes remains a documented limitation of this first slice.
```

---

### Task 5: Add offline two-track acceptance

**Files:**

- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/test/agentdash-tmux-acceptance.test.ts`
- Create: `/Volumes/mac_studio_ssd/Projects/agent_bus/scripts/agentdash-kiddoquest-proof.ts`
- Modify: `/Volumes/mac_studio_ssd/Projects/agent_bus/package.json`
- Create: `/Volumes/home/Projects_Hosted/agentdash/docs/execos-integration.md`

**Step 1: Write the failing end-to-end test**

Use a real local HTTP loop with an in-memory AgentDash API double and fake tmux/Claude boundary. Submit one request once, let assignment invoke the external adapter, return a direct answer, and assert the final AgentDash-shaped audit contains:

- one issue origin record;
- actor identity;
- AgentDash agent and heartbeat run identity;
- `agentdash` and `local_claude` tracks under the same request ID/correlation ID;
- exact configured tmux session and fresh pane identity;
- accepted → started → evidence_created → completed/cannot_answer transitions with timestamps;
- evidence summary, source ref, method, byte count, SHA-256, and truncation flag;
- one attributed result comment;
- explicit unsupported entries for Hermes and direct control of `%0`.

Run:

```sh
node --test test/agentdash-tmux-acceptance.test.ts
```

Expected: FAIL before wiring the two implementations together.

**Step 2: Implement the acceptance command and operations document**

The command accepts AgentDash base URL/company/project/assignee identifiers and optional AgentDash bearer token through environment variables. It submits this fixed read-only question:

> From the KiddoQuest project source available to you, what is the current repository commit and working-tree state? Give the direct answer and cite the exact read-only commands and source path used. If the project source is not available within the approved scope, say exactly that and do not infer.

The command prints stable AgentDash issue/run/comment URLs or IDs plus the normalized audit JSON. It never reads the KiddoQuest external tracker directly and never sends external messages.

The AgentDash document explains installation through Board → Adapter manager using the local package path, configuration, ownership boundaries, the visible issue/run/comment audit path, and unsupported capabilities. It must not mention `agentdash_mk` as a boundary.

**Step 3: Run the offline acceptance and full ExecOS verification**

```sh
node --test test/agentdash-tmux-acceptance.test.ts
npm test
npm run typecheck
```

Expected: PASS.

**Step 4: Commit each repository narrowly**

ExecOS commit:

```text
Prove the two execution tracks share one attributable audit

Constraint: KiddoQuest is the only real acceptance project.
Rejected: Seeded or fabricated answers | the proof must preserve an explicit cannot-answer outcome when source is unavailable.
Confidence: high
Scope-risk: moderate
Directive: Keep acceptance real-data-only and never weaken the %0 protection rule.
Tested: node --test test/agentdash-tmux-acceptance.test.ts; npm test; npm run typecheck
Not-tested: Live AgentDash and Claude execution remain gated to the next step.
```

AgentDash documentation commit:

```text
Document the owned boundary between AgentDash and ExecOS

Constraint: AgentDash is the system of record; ExecOS and local runtimes keep separate credentials and authority.
Rejected: Embedding ExecOS reasoning or Claude credentials in AgentDash | both violate the product boundary.
Confidence: high
Scope-risk: narrow
Directive: Preserve the external adapter and normalized audit contract when expanding runtime support.
Tested: Documentation paths and referenced APIs verified against the implementation.
Not-tested: No AgentDash production code changes are part of this commit.
```

---

### Task 6: Run the live local KiddoQuest proof

**Files:**

- Runtime artifacts only under the runner's private temporary directory and AgentDash's local database/run log store.
- No committed fixture may stand in for the final answer.

**Step 1: Verify prerequisites read-only**

```sh
tmux list-sessions -F '#{session_name} #{session_id}'
tmux list-panes -a -F '#{session_name} #{window_id} #{pane_id} #{pane_current_command} #{pane_current_path}'
curl -fsS http://127.0.0.1:3100/api/health
curl -fsS http://127.0.0.1:3101/api/health
command -v claude
```

Continue only when discovery confirms `execos-0` / `$0`, protected `%0` / `@0`, a reachable local AgentDash instance, and the Claude executable. Do not probe Claude by writing to `%0`.

**Step 2: Start the local runner in a newly owned tmux window**

Launch `npm run runner:tmux-claude` as the initial command of a new detached window in session `execos-0`; record its returned window and pane IDs. Do not send keys to any existing pane.

**Step 3: Install/configure the external adapter locally**

Use AgentDash's local adapter plugin manager with the package path `/Volumes/mac_studio_ssd/Projects/agent_bus/packages/agentdash-execos-adapter`. Configure a dedicated AgentDash agent with `runnerBaseUrl=http://127.0.0.1:4781`. This is a local configuration write, not a deployment or credential relay.

**Step 4: Submit exactly one request**

Run:

```sh
npm run proof:agentdash-kiddoquest
```

The client must resolve an existing issue by request ID before creating one. Save the request ID before submission so reruns cannot create another issue.

**Step 5: Verify the live audit read-only**

Read back the issue, comment, heartbeat run, run events, and runner audit. Verify exact actor IDs, adapter/runtime, tmux session/window/pane, timestamps, statuses, evidence hash/size/source, and direct answer or explicit cannot-answer. Confirm no writes or signals targeted `%0`.

**Step 6: Run final verification**

ExecOS:

```sh
npm test
npm run typecheck
```

AgentDash (because the committed change is documentation-only unless implementation evidence forces a narrower core fix):

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

## Acceptance criteria

- One stable normalized request ID maps to one AgentDash issue with `originKind=execos_request` and `originId=<requestId>`.
- The issue is assigned to an AgentDash agent using the external `execos_local` adapter, and a real heartbeat run is recorded.
- The external adapter calls only the localhost runner; Claude credentials never enter AgentDash config, issue text, request payload, logs, evidence, or audit.
- The runner creates a fresh pane under `execos-0`; its exact session id, window id, pane id, cwd, timestamps, and lifecycle status are recorded.
- `%0` / `@0` remains protected and receives no command, key, signal, respawn, or ownership action.
- AgentDash displays the request on the issue and the final direct answer or explicit cannot-answer as an agent-authored comment linked to the heartbeat run.
- The run result and normalized audit include actor identity, runtime/adapter, status transitions, evidence method/ref/hash/bytes/truncation, and timestamps.
- ExecOS can read the resulting issue/comment/run evidence and interpret it, but AgentDash remains authoritative for work state.
- Hermes execution and direct control of observed Claude/Codex sessions are shown as unsupported, not empty or simulated.
- All targeted tests, full ExecOS tests/typecheck, and AgentDash typecheck/test/build pass, or the exact pre-existing failure is recorded with evidence.

## Stop conditions

Stop before live dispatch and report the exact blocker if any of these holds:

- tmux discovery does not return configured session `execos-0` with id `$0`;
- protected pane `%0` / window `@0` cannot be identified unambiguously;
- any code path would need to type into, signal, respawn, or claim `%0`;
- the request is not `routine_read_only` or its project is not `kiddoquest`;
- execution requires an external tracker write, deployment, purchase, new paid credential, or external message;
- local AgentDash authentication/configuration is unavailable and cannot be established without credentials;
- the Claude executable or existing local subscription login is unavailable;
- the only way forward would fabricate an answer or evidence;
- a destructive cleanup or overwrite of user-owned work would be required.

Offline implementation and tests continue even when a live prerequisite is unavailable. The live result must be `cannot_answer` or a named blocker, never a guessed success.
