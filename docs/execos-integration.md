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

## Local product lifecycle

Use the ExecOS lifecycle command instead of manually reconstructing the runner
and AgentDash launch commands. It reuses healthy localhost services, creates
only missing services in fresh owned tmux windows, and stores only the exact
owned window/pane identities. A newly started runner receives its token through
a mode-`0600` one-shot FIFO; the token never enters process/tmux argv, the
lifecycle state, command output, logs, or on-disk file content.

For the currently proven local instance:

```sh
cd "$EXECOS_CHECKOUT"
export AGENTDASH_CHECKOUT=/Users/Kailor/.config/superpowers/worktrees/agentdash/codex-agentdash-execos-local-product
export PAPERCLIP_CONFIG=/tmp/agentdash-execos-final.pOFD9Y/config.json
export PAPERCLIP_HOME=/tmp/agentdash-execos-final.pOFD9Y/home
export PAPERCLIP_INSTANCE_ID=acceptance-final
export AGENTDASH_BASE_URL=http://127.0.0.1:3199
export EXECOS_RUNNER_BASE_URL=http://127.0.0.1:4781
export EXECOS_TMUX_CWD=/Volumes/mac_studio_ssd/Projects/agent_bus
export EXECOS_RUNNER_TOKEN='<the existing local runner token>'

npm run local:up
npm run local:status
```

`local:up` is idempotent. A healthy runner or AgentDash instance is reported as
`existing` unless it was created by this lifecycle controller. `local:down`
stops only exact windows recorded as `owned`; it preserves healthy unowned
services and refuses any state that names protected `%0/@0`.

After `local:status` is green, use the existing explicit KiddoQuest proof:

```sh
export AGENTDASH_KIDDOQUEST_PROOF=1
export AGENTDASH_COMPANY_ID='<KiddoQuest company id>'
export AGENTDASH_PROJECT_ID='<KiddoQuest project id>'
export AGENTDASH_ASSIGNEE_AGENT_ID='<dedicated execos_local agent id>'
npm run proof:agentdash-kiddoquest
```

To stop only lifecycle-owned local windows:

```sh
npm run local:down
```

## Visible audit path

For a live proof, AgentDash should visibly contain:

1. One KiddoQuest issue whose description embeds the normalized request and whose origin fields provide idempotent identity.
2. The issue assignment and heartbeat run for the dedicated `execos_local` agent.
3. Run logs containing bounded normalized lifecycle/evidence summaries.
4. An agent-authored result comment linked to the heartbeat run, containing the direct answer or explicit cannot-answer response.
5. The normalized result audit with actor identity, AgentDash run ID, runtime/adapter IDs, exact tmux session/window/pane identity, timestamps, status transitions, evidence source/method/hash/byte size/truncation, and unsupported capability rows.

ExecOS may read and interpret those records, but AgentDash remains authoritative for the persisted work and audit state.

## Android LiveKit voice bridge acceptance

The Android LiveKit bridge has a one-command offline proof in the ExecOS checkout:

```sh
cd "$EXECOS_CHECKOUT"
npm run acceptance:android-livekit:offline
```

That command starts only ephemeral `127.0.0.1` HTTP servers and a temporary canonical `DeviceAuthStore` directory. It proves broker admin pairing, Android-style pairing exchange, authenticated session creation, explicit LiveKit agent dispatch before token minting, microphone-only/data-disabled grant shape, the shared `ask_project_lead` tool path, one normalized AgentDash request/run/result comment, and one correlated `VoiceTurnAuditV1` sidecar comment through the real AgentDash voice-audit sink. The JSON output is intentionally redacted: it contains pass/fail, pseudonymous request/correlation/issue/run/comment/voice IDs, statuses, and exact boundary counters only. It does not print pairing codes, participant tokens, credential values, raw HTTP bodies, hostnames, or raw audio.

This offline proof is not a live phone or LiveKit proof. It uses fake LiveKit control and fake in-process AgentDash transport behind the real ExecOS client/sink contracts. A live run remains gated on operator authorization and the stop conditions below.

Local broker and pairing commands:

```sh
cd "$EXECOS_CHECKOUT"
export EXECOS_VOICE_DEVICE_STATE_DIR='<local canonical state dir>'
export EXECOS_VOICE_PUBLIC_BASE_URL='<Tailscale HTTPS broker origin for phone use>'
export EXECOS_VOICE_EXECOS_BASE_URL='http://127.0.0.1:<cos-port>'
export LIVEKIT_URL='<wss LiveKit URL>'
export LIVEKIT_API_KEY='<set in shell only>'
export LIVEKIT_API_SECRET='<set in shell only>'
npm run voice:broker

npm run voice:pair
```

Android build commands use the SDK at `/Users/Kailor/Library/Android`:

```sh
cd "$EXECOS_CHECKOUT/android"
export ANDROID_HOME=/Users/Kailor/Library/Android
export ANDROID_SDK_ROOT=/Users/Kailor/Library/Android
./gradlew testDebugUnitTest
./gradlew lintDebug
./gradlew assembleDebug assembleRelease
```

The Android contract is explicit-start only. Permission alone must not open the microphone. Hard mute disables the local microphone track before any disconnect. Reconnect and transcript handling must dedupe final transcript callbacks so one spoken KiddoQuest question creates one ExecOS request. Session cleanup must end the broker session and remove the LiveKit dispatch/room artifacts; participant tokens are in-memory session values, not persisted credentials.

If Tailscale HTTPS is used, expose only:

- `/health`
- `/v1/pairings/exchange`
- `/v1/voice/sessions`
- `/v1/voice/sessions/:sessionId`
- `/v1/voice/sessions/:sessionId/end`

Do not expose `/admin`, `/voice/tool`, `/voice/audit`, AgentDash, ExecOS internals, tmux, or any direct runner route through the reverse proxy.

Credential variables by name only:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `EXECOS_VOICE_TOKEN`
- `EXECOS_VOICE_DEVICE_STATE_DIR`
- `EXECOS_VOICE_PUBLIC_BASE_URL`
- `EXECOS_VOICE_EXECOS_BASE_URL`
- `AGENTDASH_BASE_URL`
- `AGENTDASH_COMPANY_ID`
- `AGENTDASH_PROJECT_ID`
- `AGENTDASH_ASSIGNEE_AGENT_ID`
- `AGENTDASH_BEARER_TOKEN`

Live preflight and acceptance must stop before mutating anything if credentials are absent, the broker is not loopback/private, Tailscale would expose routes outside the allowlist, Android TLS cannot be verified, the `execos-voice` worker cannot be explicitly dispatched, LiveKit grants include data publishing, AgentDash does not produce exactly one attributable request/run/result comment, the voice sidecar cannot be appended with the same run/agent provenance, or any path attempts tmux mutation, Hermes/direct existing-session control, raw-audio persistence, external fetches outside the approved services, or consequential/destructive actions.

AgentDash inspection after a live run should show one `originKind=execos_request` issue for the KiddoQuest question, one succeeded heartbeat run, one agent-authored result comment linked to that run, and one marked voice-audit sidecar comment whose request ID, correlation ID, issue ID, run ID, result comment ID, and terminal status match the normalized execution audit.

## Honest verification state

The offline acceptance proof uses real in-process HTTP boundaries and the production client/adapter/runner code, with injected fake AgentDash persistence and fake tmux/Claude process boundaries. It proves consistent serialization, dispatch, attribution, lifecycle, evidence, and one-record idempotency without starting Claude, changing tmux, or writing to an AgentDash instance.

On 2026-08-21, the complete local path was proven against a disposable AgentDash instance bound only to `127.0.0.1:3199`, with a fresh embedded PostgreSQL database under an isolated `PAPERCLIP_HOME`. The external adapter was loaded from the explicit ExecOS worktree path and assigned to a dedicated KiddoQuest agent. The authenticated runner remained bound to localhost in owned pane `%2/@2`; it launched the single question in a new owned Claude pane `%5/@5`, then that per-request pane closed normally. The observed Claude pane `%0/@0` and the existing `%1/@1` shell were not targeted.

The real AgentDash API contains exactly one request issue, one heartbeat run, and one attributable result comment for the stable request identity:

- issue `KID-1` (`328ef47c-e4bf-4ee0-b4af-316396d83a11`), `originKind=execos_request`, `originId=req_kiddoquest_repo_state`, terminal status `done`;
- succeeded heartbeat run `e0202f51-6ced-423c-8728-81d0528d02ec`, adapter `execos_local`;
- agent-authored comment `55adec1c-9ed9-41d5-8939-b7844a420e4c`, linked by `createdByRunId` to that heartbeat run;
- local runtime `execos-0/$0`, window `@5`, pane `%5`, represented as `$0:@5:%5`;
- five normalized transitions and five evidence records, including SHA-256, byte count, method, source reference, and observation time.

The direct response correctly declined to infer an unproven KiddoQuest source path. It reported only what the fixed read-only evidence established for `/Volumes/mac_studio_ssd/Projects/agent_bus`: commit `abcea4968880d4fb0299fe15986453dd64f98b03`, branch `main`, no tracked-file changes, and untracked `.claude/`. The evidence came from only the three documented `git -C` argv commands. A repeat of the proof reused the same issue, run, and comment without opening another pane.

The AgentDash issue activity tab was loaded through the real local UI and visibly rendered the completed ExecOS audit, answer, request/correlation IDs, actor, runtime and pane, timestamps, transitions, evidence hashes and sizes, and unsupported capability rows. The disposable AgentDash instance, database, and localhost runner are intentionally preserved for CEO inspection; they are local acceptance artifacts, not shared or production state.

## Explicitly unsupported

- Always-listening audio.
- Wake word activation.
- Android chat bubble, overlay, or background microphone capture.
- Hermes execution or direct Hermes session control.
- Direct control of an already-running Claude or Codex session.
- Any command, key, signal, respawn, scrollback capture, or ownership action targeting `%0` / `@0`.
- Claude credential relay through AgentDash.
- A generic shell or tmux-control API.
- Consequential, destructive, credentialed, external, or high-impact actions from voice.
- Non-KiddoQuest live acceptance data.
- Claims of a visible AgentDash result based only on the offline in-process proof.
- Claims that the local acceptance artifacts are production deployment, durable shared state, or support for an arbitrary project/question scope.
