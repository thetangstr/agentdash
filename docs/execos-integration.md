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

Both integration branches were merged into their `main` branches on
2026-08-21, so the durable checkouts carry the integration:

```sh
export EXECOS_CHECKOUT=/Volumes/mac_studio_ssd/Projects/agent_bus
export EXECOS_ADAPTER_PACKAGE_PATH="$EXECOS_CHECKOUT/packages/agentdash-execos-adapter"
```

The AgentDash checkout for the local product is
`/Volumes/home/Projects_Hosted/agentdash` on `main`. Install
`$EXECOS_ADAPTER_PACKAGE_PATH` through **Board → Adapter manager**, or let
`local:onboard` do it.

`npm run local:onboard` (or the `local:bootstrap` cold start below) performs the
adapter install and agent creation over the loopback API in `local_trusted`
mode, with find-or-create semantics. The manual Board path remains valid and
produces the same records.

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

## Persistent local home

All ExecOS-owned local state lives in one persistent home,
`~/.execos/agentdash-local` (override with `EXECOS_LOCAL_HOME`). It replaces the
disposable `/tmp` layout used for the 2026-08-21 acceptance:

```
~/.execos/agentdash-local/          mode 0700
  manifest.json                     non-secret: checkouts, URLs, instance id, ports, onboarded IDs
  runner-token                      mode 0600; the only ExecOS-owned on-disk copy of the local runner token
  lifecycle.json                    lifecycle ownership (exact owned window/pane identities only)
  voice-devices/                    EXECOS_VOICE_DEVICE_STATE_DIR default
  agentdash-home/                   isolated PAPERCLIP_HOME
    instances/execos-local/         PAPERCLIP_INSTANCE_ID=execos-local
      config.json                   PAPERCLIP_CONFIG: local_trusted, loopback 127.0.0.1:3199, embedded Postgres 55440
      db/ logs/ secrets/ data/storage/ data/backups/
```

`PAPERCLIP_HOME` is deliberately isolated from `~/.paperclip`: AgentDash keeps
`adapter-plugins/` at the home level, so sharing it would install the
`execos_local` adapter into the CEO's real `default` instance (`:3100`). The
persistent instance's ports (`3199`, Postgres `55440`) do not collide with that
instance (`3100`, Postgres `54329`).

Explicit environment variables always win; the home only fills in what is not
set. `npm run local:init` creates only what is missing (directories, manifest,
`config.json`, runner token) and refuses a manifest that disagrees with the
flags it is given. It never overwrites an existing file.

The runner token is generated once into `runner-token` (mode `0600`, 48
characters). It still never enters process/tmux argv, lifecycle state, command
output, logs, or the manifest; a newly started runner receives it through the
existing mode-`0600` one-shot FIFO. As in the disposable instance, AgentDash
also holds the token as the dedicated agent's `adapterConfig.runnerToken`
inside the persistent instance database (and therefore in its automatic
backups under `data/backups/`), and returns it to loopback board requests on
`GET /api/companies/:id/agents`; the `0700` home is the only protection for
those copies. Rotating the token means replacing the file and updating the
dedicated agent's adapter config; `local:onboard` reports a mismatch but never
edits an existing agent.

`local:onboard` and `local:bootstrap` require the manifest and refuse any
AgentDash URL that is not an HTTP loopback origin; they never fall back to the
default AgentDash port `3100`.

## One-command cold start

From a machine that has both checkouts, Node 24, tmux session `execos-0`, and
the `claude` executable:

```sh
cd "$EXECOS_CHECKOUT"
npm run local:init -- --agentdash-checkout /Volumes/home/Projects_Hosted/agentdash
npm run local:bootstrap
```

`local:init` accepts `--agentdash-port` (default `3199`), `--runner-port`
(default `4781`), `--postgres-port` (default `55440`), `--tmux-cwd` (default
`/Volumes/mac_studio_ssd/Projects/agent_bus`), and `--instance-id` (default
`execos-local`). Once the manifest exists, no flags or environment variables
are needed again.

The manifest pins the ExecOS checkout `init` ran from, and the `execos_local`
adapter is installed into the persistent instance from that path; `init` warns
when it is pinning a linked git worktree. To move a home to a different
checkout, delete `manifest.json` and re-run `init` from the new checkout (the
AgentDash instance, database, and token are untouched by that); if the
persistent instance already holds the adapter from the old path, `onboard`
refuses until it is reinstalled from the new path through **Board → Adapter
manager**.

`local:bootstrap` runs, in order, and prints one JSON document:

1. `init` — idempotent home creation.
2. Identity guard — if AgentDash on the configured port is healthy, the
   persistent instance's `db/postmaster.pid` must name that exact data
   directory and Postgres port with a live pid, and once onboarded the
   server's company list must contain the manifest's company id. Otherwise
   another instance owns the port (for example the preserved 2026-08-21
   disposable instance); the command refuses and explains. It never adopts a
   foreign instance. The guard runs for both `onboard` and `bootstrap`.
3. `up` — reuses healthy services, creates only missing ones in fresh owned
   tmux windows, and refuses to create a service on any port that already
   answers HTTP (a `401` from a runner started with a different token is a
   refusal, not a retry).
4. `onboard` — over the `local_trusted` loopback API: install the
   `execos_local` adapter from `packages/agentdash-execos-adapter` if absent,
   then find-or-create the company (`KiddoQuest Local Product`), the project
   (`KiddoQuest`), and the dedicated agent (`KiddoQuest ExecOS Local Lead`,
   adapter config `runnerBaseUrl`, `runnerToken`, `requestTimeoutSec=150`).
   IDs are recorded in `manifest.json`. Existing records are adopted, never
   edited; an adapter installed from a different path, more than one company
   without `AGENTDASH_COMPANY_ID`, or an agent whose runner URL/token differs
   produces `ok=false` with remediation text.
5. `preflight` — the read-only integration preflight.

Re-running `local:bootstrap` on a healthy, onboarded machine changes nothing.
`local:status`, `local:up`, and `local:down` keep their contracts and now read
the home when the environment is unset.

The KiddoQuest proof keeps its explicit gate and now needs only that gate:

```sh
AGENTDASH_KIDDOQUEST_PROOF=1 npm run proof:agentdash-kiddoquest
```

To stop only lifecycle-owned local windows:

```sh
npm run local:down
```

`down` preserves healthy unowned services and refuses any state that names the
protected `%0/@0` pane.

### Migrating the disposable acceptance instance

The 2026-08-21 disposable instance (`/tmp/agentdash-execos-final.pOFD9Y`) was
migrated into the persistent home on 2026-08-21 after the CEO's "merge it and
continue": its owned `agentdash-local`/`execos-runner` windows were stopped,
embedded Postgres shut down cleanly within one second, and `db/`,
`data/run-logs`, and `workspaces/` were copied (not moved) into the persistent
instance root. The persistent instance now serves the same `KID-1` issue, run,
and result comment on `127.0.0.1:3199`; the `/tmp` original is untouched and
disposable. Migration is not automated because the data directory can only be
copied while the source instance is stopped. The general procedure:

1. From the environment that started it, run `npm run local:down` (or stop its
   owned `agentdash-local` window) and confirm `/api/health` on `:3199` no
   longer answers.
2. Run `npm run local:init` so the persistent instance root exists, then copy
   `/tmp/agentdash-execos-final.pOFD9Y/db` to
   `~/.execos/agentdash-local/agentdash-home/instances/execos-local/db` before
   the persistent instance has ever started (its `db/` must not exist yet).
3. Run `npm run local:bootstrap`; `onboard` adopts the existing company,
   project, and agent. The copied agent's adapter config still holds the old
   runner token, so either copy the old token into `runner-token` (mode
   `0600`) before bootstrapping or update the agent's adapter config
   afterwards.

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
npm --silent run acceptance:android-livekit:offline
```

That command starts only ephemeral `127.0.0.1` HTTP servers and a temporary canonical `DeviceAuthStore` directory. It proves broker admin pairing, Android-style pairing exchange, authenticated session creation, explicit LiveKit agent dispatch before token minting, microphone-only/data-disabled grant shape, the shared `ask_project_lead` tool path, one normalized AgentDash request/run/result comment, and one correlated `VoiceTurnAuditV1` sidecar comment through the real AgentDash voice-audit sink. The `--silent` form writes exactly one redacted JSON document plus a trailing newline to stdout: pass/fail, stable role aliases for request/correlation/issue/run/comment/voice IDs, statuses, and exact boundary counters only. It does not print pairing codes, participant tokens, credential values, raw HTTP bodies, hostnames, or raw audio.

This offline proof is not a live phone, real LiveKit, or real AgentDash API proof. It uses injected fake LiveKit control, a loopback fake readiness server, and fake in-process AgentDash persistence behind the real ExecOS broker, `DeviceAuthStore`, shared `ask_project_lead` toolset, `VoiceTurnCoordinator`, AgentDash client contract, and AgentDash voice-audit sink. Real AgentDash API visibility is covered by the existing local-product proof/runbook below, not by this Android offline script. A live run remains gated on operator authorization and the stop conditions below.

Local broker and pairing commands:

```sh
cd "$EXECOS_CHECKOUT"
export EXECOS_VOICE_DEVICE_STATE_DIR="$HOME/.execos/agentdash-local/voice-devices"
export EXECOS_VOICE_BROKER_PUBLIC_BASE_URL='<Tailscale HTTPS broker origin for phone use>'
export EXECOS_VOICE_READINESS_URL='http://127.0.0.1:<cos-port>'
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
- `EXECOS_VOICE_DEVICE_LABEL`
- `EXECOS_VOICE_READINESS_URL`
- `EXECOS_VOICE_BROKER_PUBLIC_BASE_URL`
- `EXECOS_VOICE_BROKER_HOST`
- `EXECOS_VOICE_BROKER_PORT`
- `EXECOS_VOICE_ALLOW_LOCAL_LIVEKIT`
- `EXECOS_VOICE_ALLOW_INSECURE_DEV_PUBLIC_BASE_URL`
- `EXECOS_LIVEKIT_ROOM`
- `EXECOS_LIVEKIT_TOKEN_TTL`
- `EXECOS_LIVEKIT_AGENT_NAME`
- `EXECOS_LIVEKIT_WORKER_ID`
- `AGENTDASH_BASE_URL`
- `AGENTDASH_COMPANY_ID`
- `AGENTDASH_PROJECT_ID`
- `AGENTDASH_ASSIGNEE_AGENT_ID`
- `AGENTDASH_BEARER_TOKEN`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `EXECOS_REALTIME_MODEL`
- `EXECOS_REALTIME_VOICE`
- `EXECOS_STT_MODEL`
- `EXECOS_LLM_MODEL`
- `EXECOS_TTS_MODEL`
- `EXECOS_TTS_VOICE`
- `EXECOS_RUNNER_TOKEN`
- `EXECOS_RUNNER_TOKEN_PIPE`
- `EXECOS_MCP_TOKEN`
- `TAILSCALE_AUTHKEY`
- `TS_AUTHKEY`

Live preflight and acceptance must stop before mutating anything if credentials are absent, the broker is not loopback/private, Tailscale would expose routes outside the allowlist, Android TLS cannot be verified, the `execos-voice` worker cannot be explicitly dispatched, LiveKit grants include data publishing, AgentDash does not produce exactly one attributable request/run/result comment, the voice sidecar cannot be appended with the same run/agent provenance, or any path attempts tmux mutation, Hermes/direct existing-session control, raw-audio persistence, external fetches outside the approved services, or consequential/destructive actions.

AgentDash inspection after a live run should show one `originKind=execos_request` issue for the KiddoQuest question, one succeeded heartbeat run, one agent-authored result comment linked to that run, and one marked voice-audit sidecar comment whose request ID, correlation ID, issue ID, run ID, result comment ID, and terminal status match the normalized execution audit.

## Honest verification state

The Android offline acceptance proof uses real in-process HTTP boundaries for the broker plus the real ExecOS broker/auth/tool/coordinator/client/sink contracts. It deliberately uses fake in-process AgentDash persistence, fake loopback readiness, and injected fake LiveKit control. It proves consistent serialization, dispatch metadata, attribution, lifecycle, redacted evidence, network/env/import/tool/raw-audio guards, and one-record idempotency without starting Claude, changing tmux, contacting LiveKit, exposing Tailscale, installing an APK, or writing to a real AgentDash instance.

On 2026-08-21, the complete local path was proven against a disposable AgentDash instance bound only to `127.0.0.1:3199`, with a fresh embedded PostgreSQL database under an isolated `PAPERCLIP_HOME`. The external adapter was loaded from the explicit ExecOS worktree path and assigned to a dedicated KiddoQuest agent. The authenticated runner remained bound to localhost in owned pane `%2/@2`; it launched the single question in a new owned Claude pane `%5/@5`, then that per-request pane closed normally. The observed Claude pane `%0/@0` and the existing `%1/@1` shell were not targeted.

The real AgentDash API contains exactly one request issue, one heartbeat run, and one attributable result comment for the stable request identity:

- issue `KID-1` (`328ef47c-e4bf-4ee0-b4af-316396d83a11`), `originKind=execos_request`, `originId=req_kiddoquest_repo_state`, terminal status `done`;
- succeeded heartbeat run `e0202f51-6ced-423c-8728-81d0528d02ec`, adapter `execos_local`;
- agent-authored comment `55adec1c-9ed9-41d5-8939-b7844a420e4c`, linked by `createdByRunId` to that heartbeat run;
- local runtime `execos-0/$0`, window `@5`, pane `%5`, represented as `$0:@5:%5`;
- five normalized transitions and five evidence records, including SHA-256, byte count, method, source reference, and observation time.

The direct response correctly declined to infer an unproven KiddoQuest source path. It reported only what the fixed read-only evidence established for `/Volumes/mac_studio_ssd/Projects/agent_bus`: commit `abcea4968880d4fb0299fe15986453dd64f98b03`, branch `main`, no tracked-file changes, and untracked `.claude/`. The evidence came from only the three documented `git -C` argv commands. A repeat of the proof reused the same issue, run, and comment without opening another pane.

The AgentDash issue activity tab was loaded through the real local UI and visibly rendered the completed ExecOS audit, answer, request/correlation IDs, actor, runtime and pane, timestamps, transitions, evidence hashes and sizes, and unsupported capability rows. The disposable AgentDash instance, database, and localhost runner are intentionally preserved for CEO inspection; they are local acceptance artifacts, not shared or production state.

After both branches were merged into `main` on 2026-08-21, the persistent home was re-initialized from the durable checkouts (`/Volumes/mac_studio_ssd/Projects/agent_bus`, `/Volumes/home/Projects_Hosted/agentdash`), the migrated database was started by `local:bootstrap` in owned windows `@12` (runner) and `@13` (AgentDash), the `execos_local` adapter was installed from the durable ExecOS path, and onboarding adopted the original company, project, and agent (`350bcdd2…`, `f870a357…`, `092bc018…`). The migrated agent's adapter config was updated once to the persistent home's runner token, after which `local:bootstrap` and `local:status` were green and the runner token appeared in no output or state file.

Later on 2026-08-21, the persistent home and one-command cold start were exercised against an empty scratch home on unused ports (`3299`, runner `4791`, Postgres `55441`) while the disposable instance kept running. `npm run local:bootstrap` created exactly two owned windows in `execos-0` (`@8` runner, `@9` AgentDash), installed the `execos_local` adapter into the isolated `agentdash-home`, created the company, project, and dedicated agent, recorded their IDs in `manifest.json`, and returned an all-green preflight. A second run reported every item `existing` with no new windows. `npm run local:down` stopped only `@8` and `@9`. Against the default home, `local:bootstrap` refused to adopt the disposable instance on `:3199` and created no window. The generated runner token appeared nowhere in command output, lifecycle state, the manifest, `config.json`, or the runner's argv. The KiddoQuest proof was not run against the scratch instance, and the disposable database was not migrated.

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
