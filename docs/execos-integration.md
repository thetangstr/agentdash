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

Install the external adapter through **Board → Adapter manager** from:

`/Volumes/mac_studio_ssd/Projects/agent_bus/packages/agentdash-execos-adapter`

Create a dedicated AgentDash agent using adapter type `execos_local`. Its adapter config contains only:

- `runnerBaseUrl` (default `http://127.0.0.1:4781`)
- `requestTimeoutSec`

Do not put Claude tokens, API keys, arbitrary environment variables, shell commands, or tmux commands in this adapter configuration. AgentDash authentication remains at the AgentDash API boundary. Claude authentication remains inside the CEO-owned local Claude installation.

Start the runner only as the initial command of a newly owned window in `execos-0`; never reuse `%0`. Before dispatch, its read-only health response must identify the discovered session, protected pane/window IDs, localhost binding, owned-pane execution capabilities, credential-relay exclusion, and unsupported capabilities.

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

That green offline proof is **not** a visible AgentDash record. During the completion audit on 2026-08-20, no AgentDash process was reachable at `127.0.0.1:3100` or `127.0.0.1:3101`, so no existing live KiddoQuest issue/comment/run could be verified read-only. No local AgentDash data was created or modified during that audit.

The residual live gate is explicit: a reachable local AgentDash instance, its local authentication/configuration, installation of the external adapter, a dedicated assigned agent, a newly owned runner pane, and the existing local Claude login are all required. Those steps write local AgentDash configuration/data and start real tmux/Claude processes, so they must be run only when that live acceptance is authorized and the prerequisites pass read-only discovery.

## Explicitly unsupported

- Hermes execution or direct Hermes session control.
- Direct control of an already-running Claude or Codex session.
- Any command, key, signal, respawn, scrollback capture, or ownership action targeting `%0` / `@0`.
- Claude credential relay through AgentDash.
- A generic shell or tmux-control API.
- Non-KiddoQuest live acceptance data.
- Claims of a visible AgentDash result based only on the offline in-process proof.
