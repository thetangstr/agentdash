# AgentDash × ExecOS integration

AgentDash is the durable system of record for project/work state, heartbeat runs, comments, and audit records. ExecOS owns interpretation, routing, recommendations, escalation, and CEO approval policy. Runtime adapters own transport. The first local runtime adapter uses a user-owned Claude Code subscription without relaying Claude credentials into AgentDash.

This integration is runtime-neutral at the audit boundary: the AgentDash track and local Claude track use one normalized request/event/evidence contract while keeping execution ownership and credentials separate. It is not limited to an `agentdash_mk` company profile.

## First proof boundary

- Project: KiddoQuest only (`kiddoquest` in the normalized contract).
- Auto-runnable classification: `routine_read_only` with `scope.readOnly=true` only.
- AgentDash request identity: one issue with `originKind=execos_request` and `originId=<normalized request id>`.
- Local runner target: configured tmux session `execos-0`, discovered as tmux id `$0`.
- Protected observed runtime: pane `%0` in window `@0`. The integration must never type into, signal, respawn, capture sensitive scrollback from, or claim ownership of it.
- Per-request execution: a newly created, explicitly owned tmux window/pane.

Destructive, credentialed, external, high-impact, and unknown actions stop at `blocked_pending_approval`. This first slice does not execute those actions after approval; widening that behavior is a separate product decision.

## Local installation and configuration

Set the adapter path explicitly to the checkout that actually contains the
integration. Until the ExecOS branch is landed into the primary checkout, the
current local product path is:

```sh
export EXECOS_CHECKOUT=/Users/Kailor/.config/superpowers/worktrees/agent_bus/codex-agentdash-execos
export EXECOS_ADAPTER_PACKAGE_PATH="$EXECOS_CHECKOUT/packages/agentdash-execos-adapter"
```

Do not point AgentDash at
`/Volumes/mac_studio_ssd/Projects/agent_bus/packages/agentdash-execos-adapter`
until that path really exists. Install `$EXECOS_ADAPTER_PACKAGE_PATH` through
**Board → Adapter manager**.

Create a dedicated AgentDash agent using adapter type `execos_local`. Its adapter config contains only:

- `runnerBaseUrl` (default `http://127.0.0.1:4781`)
- `runnerToken` (a generated local runner secret of at least 32 characters)
- `requestTimeoutSec` (use `150`; it must exceed the runner's `120` second execution timeout)

Do not put Claude tokens, API keys, arbitrary environment variables, shell commands, or tmux commands in this adapter configuration. AgentDash authentication remains at the AgentDash API boundary. Claude authentication remains inside the CEO-owned local Claude installation.

Start the runner only as the initial command of a newly owned window in `execos-0`; never reuse `%0`. Before dispatch, its read-only health response must identify the discovered session, protected pane/window IDs, localhost binding, owned-pane execution capabilities, credential-relay exclusion, and unsupported capabilities.

## Deterministic local preflight

The preflight is read-only. It checks AgentDash health, the exact adapter
package path, the exact KiddoQuest cwd, the Claude executable, tmux session
`execos-0/$0`, protected pane `@0/%0`, authenticated runner health, and the
explicit unsupported declarations. It lists tmux state but never creates a
window, sends keys, captures scrollback, or submits a Claude prompt.

```sh
cd "$EXECOS_CHECKOUT"
export EXECOS_TMUX_CWD=/Volumes/mac_studio_ssd/Projects/agent_bus
export EXECOS_RUNNER_BASE_URL=http://127.0.0.1:4781
export EXECOS_RUNNER_TOKEN='<generated local value, at least 32 characters>'
npm run preflight:agentdash-execos
```

Before the runner exists, the command should fail only the runner-dependent
checks and report those gates explicitly. After starting the runner in a newly
owned tmux window, rerun it and require every check to pass.

The runner's owned startup window can be created with `tmux new-window -d -P`
using `$EXECOS_CHECKOUT` as its process cwd and
`EXECOS_TMUX_CWD=/Volumes/mac_studio_ssd/Projects/agent_bus` as its scoped
evidence cwd. Record the returned window and pane IDs. Never target `@0`,
`%0`, or the existing `@1/%1` pane.

To expose the same path through the ExecOS Chief of Staff process, configure:

- `AGENTDASH_BASE_URL=http://127.0.0.1:3100`
- `AGENTDASH_COMPANY_ID`
- `AGENTDASH_PROJECT_ID` (KiddoQuest)
- `AGENTDASH_ASSIGNEE_AGENT_ID` (the dedicated `execos_local` agent)
- optional `AGENTDASH_BEARER_TOKEN` for AgentDash API authentication

If the three AgentDash IDs are absent, `ask_project_lead` remains present but
returns an explicit unsupported response. A partial configuration is rejected
at startup.

## Visible audit path

For a live proof, AgentDash should visibly contain:

1. One KiddoQuest issue whose description embeds the normalized request and whose origin fields provide idempotent identity.
2. The issue assignment and heartbeat run for the dedicated `execos_local` agent.
3. Run logs containing bounded normalized lifecycle/evidence summaries.
4. An agent-authored result comment linked to the heartbeat run, containing the direct answer or explicit cannot-answer response.
5. The normalized result audit with actor identity, AgentDash run ID, runtime/adapter IDs, exact tmux session/window/pane identity, timestamps, status transitions, evidence source/method/hash/byte size/truncation, and unsupported capability rows.

ExecOS may read and interpret those records, but AgentDash remains authoritative for the persisted work and audit state.

## Honest verification state

The offline acceptance proof uses real in-process HTTP boundaries and the production client/adapter/runner code, with injected fake AgentDash persistence and fake tmux/Claude process boundaries. It proves consistent serialization, dispatch, attribution, lifecycle, evidence, and one-record idempotency without starting Claude, changing tmux, or writing to an AgentDash instance.

On 2026-08-21, the AgentDash-visible record gate was separately proven against a disposable local instance bound only to `127.0.0.1:3199`, with a fresh embedded PostgreSQL database under an isolated `PAPERCLIP_HOME`. Telemetry and the heartbeat scheduler were disabled, no credentials were present, no adapter plugin loaded, and the issue had no assignee. The real API created KiddoQuest issue `KID-1` (`185b6667-7afb-437c-9533-0ad8052916ca`) with `originKind=execos_request` and `originId=req_kiddoquest_repo_state`. Reading the stored description back through the API and parsing it with the ExecOS contract parser reproduced the exact normalized request, including correlation ID, CEO actor, read-only scope, fixed question, and timestamp.

The same proof retrieved exactly one origin match, one explicit local-board audit comment (`87c0d6e9-9234-4731-8c1f-454471f8c41d`), and the `issue.created` plus `issue.comment_added` activity rows. A second create returned `409 EXECOS_REQUEST_ALREADY_RECORDED`. The issue had `assigneeAgentId=null`, `executionRunId=null`, and zero run rows, which is the intended evidence that runtime dispatch stayed disabled. The checkout had no built UI artifact (`ui/dist/index.html`), so the server reported API-only mode and UI visibility was not claimed. After retrieval, the server and embedded database were stopped, both loopback listeners were verified closed, and the disposable instance directory was moved to Trash.

This proves a real AgentDash API-visible system-of-record entry and audit retrieval; it does **not** prove the full execution result path. The remaining live execution gate is explicit: installation of the external adapter, a dedicated assigned agent, a newly owned runner pane, the existing local Claude login, a real heartbeat run, and an agent-authored direct answer or explicit cannot-answer comment with tmux/evidence attribution. Those steps start real tmux/Claude processes and remain separately gated.

## Explicitly unsupported

- Hermes execution or direct Hermes session control.
- Direct control of an already-running Claude or Codex session.
- Any command, key, signal, respawn, scrollback capture, or ownership action targeting `%0` / `@0`.
- Claude credential relay through AgentDash.
- A generic shell or tmux-control API.
- Non-KiddoQuest live acceptance data.
- Claims of a visible AgentDash result based only on the offline in-process proof.
- Claims that the disposable API-only record proves a Claude/tmux execution, heartbeat run, or agent-authored answer.
