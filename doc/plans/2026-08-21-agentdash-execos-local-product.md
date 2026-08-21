# AgentDash × ExecOS Local Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one routine read-only KiddoQuest question runnable from ExecOS through AgentDash to a newly owned local Claude/tmux pane, then return a visibly attributable answer or cannot-answer result in AgentDash without touching `%0/@0`.

**Architecture:** AgentDash remains the durable work and audit system of record. ExecOS adds the CEO-facing read-only question tool, normalized request orchestration, and wait/readback client. The local runner uses an authenticated localhost transport, deterministic read-only evidence collection, a tool-disabled Claude interpretation pass, and exact request/run binding; it creates only a new owned tmux window in `execos-0`.

**Tech Stack:** Node.js 24, TypeScript, Node test runner, AgentDash Express/React/PGlite, external adapter plugins, tmux, Claude Code CLI.

---

## Boundaries and acceptance

- KiddoQuest is the only project accepted by this slice.
- The runner accepts only `routine_read_only` requests with the exact pilot scope `repos=["agent_bus"]` and `paths=["leads/kiddoquest"]`.
- Claude receives evidence collected by fixed `git` argv commands and runs with tools disabled. It does not receive arbitrary shell capability.
- AgentDash owns issue, heartbeat-run, result, comment, and audit persistence.
- ExecOS owns interpretation, routing, cannot-answer behavior, and readback.
- The runner owns localhost transport and the newly created tmux pane only.
- `%0` / `@0` is observed external state and must never receive keys, commands, signals, respawn, or ownership actions.
- Hermes and direct control of observed Claude/Codex sessions remain explicitly unsupported.
- The live step may use existing local Claude subscription authentication, but must not transmit or persist Claude credentials in AgentDash.

## Stop conditions

Stop before live execution if `execos-0/$0` or `%0/@0` is ambiguous, AgentDash requires shared/production state, the local Claude login is unavailable, the adapter cannot be installed without external credentials, any path would write to `%0`, or the evidence collector would need a command outside the fixed allowlist. Record an explicit blocker rather than fabricating an answer.

### Task 1: Enforce the runner's read-only evidence boundary

**Files:**
- Create: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/runners/tmux-claude/read-only-evidence.ts`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/runners/tmux-claude/runner.ts`
- Test: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/test/tmux-claude-runner.test.ts`

- [ ] **Step 1: Write failing scope and prompt tests**

Add tests proving that a request outside the exact KiddoQuest pilot scope is blocked before evidence collection/tmux, and that the Claude prompt contains request identity, actor, classification, approved paths/repos, fixed command evidence, the cannot-answer rule, and the `%0/@0` prohibition.

```ts
assert.match(prompt, /req_kq_1/);
assert.match(prompt, /routine_read_only/);
assert.match(prompt, /leads\/kiddoquest/);
assert.match(prompt, /git -C .* rev-parse HEAD/);
assert.match(prompt, /do not call tools/i);
```

- [ ] **Step 2: Run the runner test and verify RED**

Run: `node --test test/tmux-claude-runner.test.ts`

Expected: FAIL because the prompt is currently only `request.question` and no evidence collector exists.

- [ ] **Step 3: Implement fixed read-only evidence collection**

Create a collector that invokes only these argv arrays via `execFile`, with no shell:

```ts
["git", "-C", cwd, "rev-parse", "--show-toplevel"]
["git", "-C", cwd, "rev-parse", "HEAD"]
["git", "-C", cwd, "status", "--short", "--branch"]
```

Return command text, cwd, stdout, byte count, and SHA-256. Reject every scope except the exact pilot scope before invoking it.

- [ ] **Step 4: Render the full normalized runtime prompt**

Render the validated request plus captured evidence into `prompt.txt`. Require a direct answer based only on supplied evidence or an explicit cannot-answer. Change the wrapper command to:

```sh
claude --print --tools "" --no-session-persistence
```

Record the deterministic evidence as normalized audit evidence before the Claude stdout evidence.

- [ ] **Step 5: Run targeted and contract tests**

Run:

```sh
node --test test/tmux-claude-runner.test.ts test/execution-contract.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit with Lore**

Commit only the collector, runner, and tests with a Lore message explaining why arbitrary Claude tools were rejected for the local read-only pilot.

### Task 2: Authenticate, deduplicate, and correctly time the localhost transport

**Files:**
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/runners/tmux-claude/server.ts`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/runners/tmux-claude/main.ts`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/packages/agentdash-execos-adapter/src/index.ts`
- Test: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/test/tmux-claude-runner.test.ts`
- Test: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/test/agentdash-execos-adapter.test.ts`

- [ ] **Step 1: Write failing authentication/idempotency tests**

Add tests requiring `Authorization: Bearer <runner-token>` for health, POST, and audit lookup. Add a duplicate POST test proving the same `(request.id, agentdash.runId)` returns the same audit without invoking the runner twice, and a concurrent different request test returning `409 runner_busy`.

- [ ] **Step 2: Run transport tests and verify RED**

Run: `node --test test/tmux-claude-runner.test.ts test/agentdash-execos-adapter.test.ts`

Expected: FAIL because the server currently accepts unauthenticated, unbounded requests.

- [ ] **Step 3: Implement runner authentication and single-flight idempotency**

Require `EXECOS_RUNNER_TOKEN` of at least 32 characters at runner startup. Store completed audits by idempotency key and share the same in-flight promise for exact duplicates. Reject a different concurrent request with `409 runner_busy`. Catch all asynchronous route errors and return bounded JSON errors.

- [ ] **Step 4: Add authenticated adapter configuration**

Add required `runnerToken` to the adapter schema/config, send it only in the Authorization header, redact it from errors/logs, and keep Claude/API credential fields forbidden. Raise the adapter default timeout to 150 seconds while the runner remains 120 seconds. Include `executionTimeoutMs` in health and fail environment validation when the adapter timeout is not longer than runner execution timeout.

- [ ] **Step 5: Bind every returned audit to the dispatch**

Before accepting a valid audit, require exact equality for normalized request, AgentDash run id, AgentDash adapter/runtime ids, AgentDash actor, accepted timestamp, and source reference. Return nonzero without logging the mismatched audit.

- [ ] **Step 6: Run targeted tests and typecheck**

Run:

```sh
node --test test/agentdash-execos-adapter.test.ts test/tmux-claude-runner.test.ts
npm run typecheck
```

Expected: all pass and no token appears in serialized results.

- [ ] **Step 7: Commit with Lore**

Commit only transport/auth/binding changes and their tests.

### Task 3: Make ExecOS submit, wait, and read the authoritative AgentDash result

**Files:**
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/integrations/agentdash-client.ts`
- Create: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/integrations/agentdash-project-question.ts`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/scripts/agentdash-kiddoquest-proof.ts`
- Test: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/test/agentdash-client.test.ts`

- [ ] **Step 1: Write failing wait/readback tests**

Test the sequence issue-without-run → issue-with-run → running heartbeat → terminal heartbeat with normalized `resultJson.audit` and one comment whose `createdByRunId` matches. Test timeout, failed run, malformed audit, and unattributed-comment rejection.

- [ ] **Step 2: Run the client test and verify RED**

Run: `node --test test/agentdash-client.test.ts`

Expected: FAIL because `waitForResult` and heartbeat/event retrieval do not exist.

- [ ] **Step 3: Implement authoritative wait/readback**

Add `waitForResult(issueId, { timeoutMs, pollMs })` that polls `/api/issues/:issueId`, then reads `/api/heartbeat-runs/:runId`, `/events`, and `/comments`. Validate the normalized audit, request/run attribution, terminal status, and agent-authored comment before returning.

- [ ] **Step 4: Add the KiddoQuest project-question service**

Create a service that builds one normalized `routine_read_only` request, records it, waits for the AgentDash result, and formats the direct answer/cannot-answer with issue/run/comment IDs and evidence references. Keep AgentDash bearer authentication separate from Claude authentication.

- [ ] **Step 5: Upgrade the proof command**

Make `npm run proof:agentdash-kiddoquest` call the service and exit nonzero unless the terminal AgentDash audit is complete and attributable.

- [ ] **Step 6: Run targeted acceptance and typecheck**

Run:

```sh
node --test test/agentdash-client.test.ts test/agentdash-tmux-acceptance.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit with Lore**

Commit only AgentDash client/service/proof changes and tests.

### Task 4: Expose the question through the shared ExecOS tool surface

**Files:**
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/cos/toolset.ts`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/cos/interface.ts`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/cos/server.ts`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/cos/main.ts`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/src/mcp/server.ts`
- Test: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/test/agentdash-project-question-tool.test.ts`
- Test: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/test/mcp.test.ts`

- [ ] **Step 1: Write failing shared-surface tests**

Require an `ask_project_lead` tool on text, voice, and MCP surfaces with byte-identical definition. Restrict `project` to `kiddoquest`; route it through an injected service; fail plainly when local AgentDash is unconfigured.

- [ ] **Step 2: Run the tool tests and verify RED**

Run: `node --test test/agentdash-project-question-tool.test.ts test/mcp.test.ts`

Expected: FAIL because the tool does not exist.

- [ ] **Step 3: Implement one shared tool**

Add the definition and dispatcher to `ExecToolset`, inject the service through `ExecutiveInterface`/`CosServer`, and construct it from explicit AgentDash environment variables in `cos/main.ts`. Add the tool to the MCP routine-read-only annotation set while documenting that AgentDash writes only operational audit records.

- [ ] **Step 4: Verify every surface**

Run:

```sh
node --test test/agentdash-project-question-tool.test.ts test/voice.test.ts test/mcp.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit with Lore**

Commit only the shared ExecOS tool-surface changes and tests.

### Task 5: Add minimal visible ExecOS audit presentation in AgentDash

**Files:**
- Create: `/Users/Kailor/.config/superpowers/worktrees/agentdash/codex-agentdash-execos-local-product/ui/src/lib/execos-audit.ts`
- Create: `/Users/Kailor/.config/superpowers/worktrees/agentdash/codex-agentdash-execos-local-product/ui/src/lib/execos-audit.test.ts`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agentdash/codex-agentdash-execos-local-product/ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Write failing audit-projection tests**

Test a valid `resultJson.audit` projection and malformed/missing audit rejection. The projection must include request id, status, direct answer/cannot-answer, actor, runtime, pane id, evidence refs/hashes/bytes, timestamps, and unsupported capabilities.

- [ ] **Step 2: Run the UI test and verify RED**

Run: `pnpm exec vitest run ui/src/lib/execos-audit.test.ts`

Expected: FAIL because the projection does not exist.

- [ ] **Step 3: Implement the parser and issue card**

Add a compact `ExecOS Audit` card to the issue activity tab when `originKind === "execos_request"` and a linked run contains a valid audit. Render a pending state before the run arrives and keep generic raw-run details available.

- [ ] **Step 4: Run UI tests and typecheck**

Run:

```sh
pnpm exec vitest run ui/src/lib/execos-audit.test.ts
pnpm --filter @paperclipai/ui typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit with Lore**

Commit only the audit projection/card and tests.

### Task 6: Make local startup and acceptance deterministic

**Files:**
- Create: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/scripts/agentdash-execos-preflight.ts`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/package.json`
- Modify: `/Users/Kailor/.config/superpowers/worktrees/agentdash/codex-agentdash-execos-local-product/docs/execos-integration.md`
- Test: `/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos/test/agentdash-execos-preflight.test.ts`

- [ ] **Step 1: Write failing preflight tests**

Test explicit pass/fail results for AgentDash health, adapter package path, runner health/auth, `execos-0/$0`, protected `%0/@0`, Claude executable, exact cwd, and unsupported Hermes/direct-session capabilities. Preflight must perform no writes and create no tmux pane.

- [ ] **Step 2: Run the preflight test and verify RED**

Run: `node --test test/agentdash-execos-preflight.test.ts`

Expected: FAIL because no preflight command exists.

- [ ] **Step 3: Implement preflight and correct package paths**

Add `npm run preflight:agentdash-execos`. Update the runbook to use the actual landed checkout or an explicit `EXECOS_ADAPTER_PACKAGE_PATH`; never silently point at a missing directory.

- [ ] **Step 4: Run all offline verification**

Run:

```sh
npm test
npm run typecheck
pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/db typecheck
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/ui typecheck
pnpm test:run
pnpm build
```

Expected: all integration-specific tests pass; any unrelated repository failure is recorded precisely.

- [ ] **Step 5: Commit with Lore**

Commit preflight/runbook changes in their owning repositories.

### Task 7: Run the gated real local KiddoQuest acceptance

**Runtime artifacts only:** disposable AgentDash PGlite state, generated local runner token, and a newly owned tmux window/pane.

- [ ] **Step 1: Run read-only preflight**

Verify AgentDash local health, adapter registration, dedicated `execos_local` agent, Claude executable/login availability, `execos-0/$0`, and `%0/@0` protection. Do not probe Claude through `%0`.

- [ ] **Step 2: Start isolated local services**

Start AgentDash with disposable local PGlite data. Start the authenticated runner as the initial command of a newly owned tmux window in `execos-0`; record window/pane identifiers.

- [ ] **Step 3: Install/configure the adapter locally**

Register the exact local package path, create one dedicated KiddoQuest `execos_local` agent, set `runnerBaseUrl=http://127.0.0.1:4781`, and store only the generated runner token in adapter configuration.

- [ ] **Step 4: Submit exactly one fixed question**

Run `npm run proof:agentdash-kiddoquest`. Reuse the stable origin id if repeated so one request maps to one issue.

- [ ] **Step 5: Verify the visible audit**

Confirm the AgentDash issue, heartbeat run, comment, `resultJson.audit`, actor, runtime, exact tmux session/window/pane, transitions, evidence command/ref/hash/bytes, direct answer/cannot-answer, and unsupported capabilities. Confirm `%0/@0` received no action.

- [ ] **Step 6: Stop disposable services safely**

Stop only processes/windows created by this acceptance. Preserve AgentDash evidence until the CEO has inspected it; do not delete shared or production data.

## Completion criteria

The local product is complete only when the CEO-facing ExecOS tool can submit the KiddoQuest question, AgentDash records exactly one issue and one real heartbeat run, a newly owned Claude pane returns a direct evidence-backed answer or cannot-answer, AgentDash visibly presents the audit, ExecOS reads the same authoritative result back, and `%0/@0` remains untouched.
