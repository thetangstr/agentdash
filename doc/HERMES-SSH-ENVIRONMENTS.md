# Hermes agents over SSH environments

A `hermes_local` agent normally runs Hermes on the AgentDash server, as the
server's own OS user. With this feature on, an admin can pin a Hermes agent to
an **SSH environment**, and every run of that agent launches Hermes over SSH
**as a different OS user** (for example `ac-provider@127.0.0.1`), with that
user's own home, Hermes install, Hermes config and provider keys.

It is **off by default**. With it off, an SSH environment is refused for Hermes
agents with the same 422 as before, and an agent that was pinned while it was on
is **refused at run time** with a clear error. Its run never falls back to
running Hermes on the server host.

AgentDash does **not** create OS users, install Hermes, or manage keys on the
far side. That is the operator's job, described below.

## 1. Turn it on (instance config)

Two environment variables on the AgentDash server, then restart it:

```sh
AGENTDASH_HERMES_SSH_ENABLED=true
AGENTDASH_HERMES_SSH_ALLOWLIST='{
  "ac-provider@127.0.0.1": {
    "companies": ["<company id>"],
    "identityFile": "/etc/agentdash/ssh/ac-provider_ed25519",
    "knownHostsFile": "/etc/agentdash/ssh/known_hosts",
    "port": 22
  }
}'
```

- `AGENTDASH_HERMES_SSH_ENABLED`: only the exact value `true` turns it on.
- `AGENTDASH_HERMES_SSH_ALLOWLIST`: a JSON object. Each key is one SSH account,
  `user@host`. Each value says which companies may use it and **how AgentDash
  connects to it**:
  - `companies` (required): the company ids whose Hermes agents may run as that
    account.
  - `identityFile` (required): absolute path, on the AgentDash server, of the
    dedicated ed25519 private key for this account.
  - `knownHostsFile` (required): absolute path of the pinned known_hosts file.
  - `port` (optional, default 22): the only SSH port allowed for this account.

  To add another account (say `ac-prov-b`), add another key and restart. No code
  change.

  `user` must be a lowercase POSIX login name (`[a-z_][a-z0-9_-]*`, at most 32
  characters); `host` an IPv4 address or a DNS name, with no port in it. An entry
  that doesn't fit (or is missing a path) is skipped and allows nothing. Invalid
  JSON allows nothing.

**Key paths, known_hosts and the port live only here, in operator config.** A
company's SSH environment can only *name* an allowlisted `user@host` and port;
it never supplies a key or known_hosts path (the environment form and API
reject those fields), and any private key, inline known_hosts or relaxed
host-key setting stored on the environment is ignored for Hermes runs.

Anything not on the list is refused with a plain message (403), when an agent is
pinned and again before every run.

## 2. Prepare the target account (operator, on the target machine)

For each `user@host` on the allowlist:

1. **Create the OS user** (for example `ac-provider`) with its own home
   directory. On macOS, use System Settings > Users & Groups or `sysadminctl
   -addUser`; on Linux, `useradd -m`. Turn on SSH (macOS: System Settings >
   General > Sharing > Remote Login, allowed for that user).
2. **Install Hermes for that user** and configure it as that user (its
   `~/.hermes`, provider and API key). AgentDash runs `hermes` found on that
   user's login-shell `PATH`, or the agent's `hermesCommand` if you set one to a
   path on that machine.
3. **Create the workspace directory** the environment will use (for example
   `/Users/ac-provider/agentdash`), owned by that user.

## 3. Key and host pinning (operator, on the AgentDash server)

1. **A dedicated ed25519 key**, readable **only** by the OS user the AgentDash
   server runs as (mode 600, directory 700, owned by that user):

   ```sh
   install -d -m 700 /etc/agentdash/ssh
   ssh-keygen -t ed25519 -N "" -C "agentdash -> ac-provider" -f /etc/agentdash/ssh/ac-provider_ed25519
   chmod 600 /etc/agentdash/ssh/ac-provider_ed25519
   ```

   Keep the `.pub` file next to the key: AgentDash reads it before each run to
   confirm the key is ed25519. AgentDash never reads the private key itself;
   only `ssh` uses it.

   > **Residual risk you must plan for.** Every agent that runs *locally* on the
   > AgentDash server (claude_local, codex_local, a local hermes_local, in any
   > company) runs as that same server user and has shell tools. File
   > permissions cannot keep the key from them: any of them could run
   > `ssh -i /etc/agentdash/ssh/ac-provider_ed25519 ac-provider@127.0.0.1`
   > itself. The forced command below limits what that key can do on the far
   > side; it does not hide the key. If that is not acceptable, don't run local
   > agents on this server, or put the key behind a root-owned helper the server
   > user can call but not read.

2. **Authorize it on the target, restricted to the launcher.** Append the public
   key to the target user's `~/.ssh/authorized_keys` (file 600, `~/.ssh` 700)
   with `restrict` (no agent, port or X11 forwarding, no PTY), `from=` (only
   this server) and a forced `command=` that only lets through the command
   shapes AgentDash sends:

   ```
   restrict,from="127.0.0.1",command="/usr/local/bin/agentdash-hermes-gate" ssh-ed25519 AAAA... agentdash -> ac-provider
   ```

   An example gate (owned by root, mode 755). It allows the five things
   AgentDash does over this key, all inside the workspace: create and enter the
   workspace, check the API is reachable, stage the run's env file, run Hermes,
   and remove the env file. Everything else is refused and logged.

   ```sh
   #!/bin/sh
   # /usr/local/bin/agentdash-hermes-gate
   WS=/Users/ac-provider/agentdash
   cmd=${SSH_ORIGINAL_COMMAND:-}
   case "$cmd" in
     "sh -lc 'mkdir -p '\"'\"'$WS'\"'\"' && cd "*) ;;                 # lease: make + enter workspace
     "sh -lc 'mkdir -p '\"'\"'$WS/.paperclip-runenv/"*) ;;           # stage the run env file (tar on stdin)
     "rm -rf '$WS/.paperclip-runenv/"*) ;;                            # remove the run env dir
     "sh -lc 'if [ -f \"\$HOME/.profile\" ]"*"cd '\"'\"'$WS'\"'\"' && exec '\"'\"'sh'\"'\"' '\"'\"'-c'\"'\"'"*"'\"'\"'hermes'\"'\"' '\"'\"'chat'\"'\"'"*) ;;  # run hermes
     "sh -lc "*"curl"*|"sh -lc "*"command -v "*) ;;                   # API reachability probe / hermes check
     *) logger -t agentdash-hermes-gate "refused: $cmd"; echo "refused" >&2; exit 1 ;;
   esac
   exec /bin/sh -c "$cmd"
   ```

   Treat this as a starting point, not a sandbox: tighten the patterns to your
   paths, and test them with the manual check in step 4. AgentDash cannot
   enforce what the far side allows. Setting this up is the operator's
   responsibility.

3. **Pin the host key** in a known_hosts file of its own:

   ```sh
   ssh-keyscan -p 22 -t ed25519 127.0.0.1 > /etc/agentdash/ssh/known_hosts
   ssh-keygen -lf /etc/agentdash/ssh/known_hosts      # compare with the fingerprint below
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   # run on the target machine
   ```

   Only continue when the two fingerprints match.
4. **Check it by hand**, with the same options AgentDash uses:

   ```sh
   ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes \
       -o UserKnownHostsFile=/etc/agentdash/ssh/known_hosts -o GlobalKnownHostsFile=/dev/null \
       -i /etc/agentdash/ssh/ac-provider_ed25519 -o IdentitiesOnly=yes \
       -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes \
       -o ControlMaster=no -o ControlPath=none -o PermitLocalCommand=no \
       -p 22 ac-provider@127.0.0.1 "sh -lc 'command -v hermes'"
   ```

## 4. Create the environment and pin the agent

Create an SSH environment in the company (UI or API) that names the allowlisted
account and port. It carries no key material and no paths:

```json
{
  "name": "ac-provider (local)",
  "driver": "ssh",
  "config": {
    "host": "127.0.0.1",
    "port": 22,
    "username": "ac-provider",
    "remoteWorkspacePath": "/Users/ac-provider/agentdash"
  }
}
```

Then set the Hermes agent's default environment to it (`PATCH /api/agents/:id`
with `defaultEnvironmentId`, the hire or create request, or the agent's
configuration page). Only a company owner, an instance admin, or a person with
the `agents:create` permission can do this; **agents never can**, not even a CEO
or agent-creator agent. Pinning is refused (4xx, in plain words) when the flag
is off, when `user@host` isn't on the allowlist, when it isn't allowed for this
company, when the port differs from the allowlist's, or when the environment
belongs to another company. Each successful pin is audit-logged.

### Issue and project environment settings

Issues and projects can choose an execution environment, and normally that
choice wins over the agent's default. **For Hermes agents it doesn't**, and this
is enforced before every run:

- an issue or project can't put a Hermes run on an SSH environment (only the
  agent's own admin-set pin can); and
- an issue or project can't move a Hermes agent that is pinned to SSH onto any
  other environment, the server's local one included.

Either case refuses the run with a clear message and an `agent.ssh_run_refused`
audit entry. Nothing is run. Hermes agents are also refused on sandbox and
plugin environments rather than being run on the server host.

## 5. What a run does

- Before connecting, AgentDash re-checks the flag, the allowlist (company and
  port), that the environment is the agent's own pin, and the operator's key and
  known_hosts files. Any failure refuses the run before any SSH connection.
- `ssh` is spawned with an argument array (never a shell string), using only
  the operator's values: `-F /dev/null` (the server user's `~/.ssh/config` is
  ignored), `BatchMode=yes`, `StrictHostKeyChecking=yes`, the pinned
  `UserKnownHostsFile` (global known_hosts ignored), the dedicated key with
  `IdentitiesOnly=yes`, `ForwardAgent=no`, `ForwardX11=no`,
  `ClearAllForwardings=yes`, `ControlMaster=no`, `ControlPath=none`,
  `PermitLocalCommand=no`, and `-p <allowlisted port>`.
- The run's environment (the run token, the agent's configured env such as a
  provider key) is **not** put on the remote command line. It is written to a
  0600 file, sent over the SSH connection's stdin into
  `<workspace>/.paperclip-runenv/<run id>/`, read by a small wrapper that
  deletes it, and the directory is removed after the run. The server's own
  environment (database URL, auth secrets) is never sent.
- Hermes runs in the environment's workspace directory, as the target user.

Not available over SSH yet: managed per-agent Hermes profiles (the remote
user's own Hermes home is used), Hermes' structured `stream-json` transcript
(text mode is used), and token metering (the session ledger lives with the
remote user; runs are recorded as `unmetered_no_ledger`). The prompt is passed
as a `hermes chat -q` argument, as it is for local runs, so other users on the
target host can see it in the process list.

## 6. Turning it off (rollback)

Unset `AGENTDASH_HERMES_SSH_ENABLED` (or set it to anything but `true`) and
restart. New SSH pins are refused with the usual 422. Agents that are already
pinned stay pinned but every run is refused before any connection, with
"Hermes over SSH is turned off on this server", and an `agent.ssh_run_refused`
entry. Nothing runs locally in their place. Clear the pin (or switch the
agent's environment to local) to run them on the server again.

## 7. Audit trail

All are company-scoped activity-log entries carrying the `user@host` and ids
only (never key material, key paths or env values):

- `agent.ssh_environment_pinned`: a Hermes agent was pinned to an SSH
  environment (create, hire, or update).
- `agent.ssh_run_launched`: a Hermes run was launched over SSH.
- `agent.ssh_run_refused`: a Hermes run was refused before launch, with the
  reason.
