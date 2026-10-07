# Hermes agents over SSH environments

A `hermes_local` agent normally runs Hermes on the AgentDash server, as the
server's own OS user. With this feature on, a Hermes agent can instead be
pinned to an **SSH environment**, and every run of that agent launches Hermes
over SSH **as a different OS user** (for example `ac-provider@127.0.0.1`), with
that user's own home, Hermes install, Hermes config and provider keys.

It is **off by default**. With it off, nothing changes: an SSH environment is
refused for Hermes agents with the same 422 as before.

AgentDash does **not** create OS users, install Hermes, or manage keys on the
far side. That is the operator's job, described below.

## 1. Turn it on (instance config)

Two environment variables on the AgentDash server, then restart it:

```sh
AGENTDASH_HERMES_SSH_ENABLED=true
AGENTDASH_HERMES_SSH_ALLOWLIST='{"ac-provider@127.0.0.1":["<company id>"]}'
```

- `AGENTDASH_HERMES_SSH_ENABLED` — only the exact value `true` turns it on.
- `AGENTDASH_HERMES_SSH_ALLOWLIST` — a JSON object. Each key is one SSH
  account, `user@host`; each value is the list of company ids whose Hermes
  agents may run as that account. To add another account (say `ac-prov-b`),
  add another key and restart; no code change.

  ```json
  {
    "ac-provider@127.0.0.1": ["<company id>"],
    "ac-prov-b@127.0.0.1":   ["<company id>"],
    "ac-prov-c@mini.local":  ["<company id>", "<another company id>"]
  }
  ```

  `user` must be a lowercase POSIX login name (`[a-z_][a-z0-9_-]*`, at most 32
  characters); `host` an IPv4 address or a DNS name, with no port. Entries that
  don't fit are skipped (they allow nothing). Invalid JSON allows nothing.

Anything not on the list is refused with a plain message (403), both when an
agent is pinned and again when a run launches — a run is never quietly moved
back to the server host.

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

1. **A dedicated ed25519 key**, readable only by the user AgentDash runs as:

   ```sh
   install -d -m 700 /etc/agentdash/ssh
   ssh-keygen -t ed25519 -N "" -C "agentdash -> ac-provider" -f /etc/agentdash/ssh/ac-provider_ed25519
   ```

   Keep the `.pub` file next to the key: AgentDash reads it before each run to
   confirm the key is ed25519. The private key is never read by AgentDash; only
   `ssh` uses it.
2. **Authorize it on the target**: append the public key to the target user's
   `~/.ssh/authorized_keys` (mode 600, directory 700). Prefixing the line with
   `restrict` is recommended — it turns off agent, port and X11 forwarding and
   PTY allocation, none of which a run needs:

   ```
   restrict ssh-ed25519 AAAA... agentdash -> ac-provider
   ```
3. **Pin the host key** in a known_hosts file of its own:

   ```sh
   ssh-keyscan -t ed25519 127.0.0.1 > /etc/agentdash/ssh/known_hosts
   ssh-keygen -lf /etc/agentdash/ssh/known_hosts      # compare with the fingerprint below
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   # run on the target machine
   ```

   Only continue when the two fingerprints match.
4. **Check it by hand**, with the same options AgentDash uses:

   ```sh
   ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
       -o UserKnownHostsFile=/etc/agentdash/ssh/known_hosts -o GlobalKnownHostsFile=/dev/null \
       -i /etc/agentdash/ssh/ac-provider_ed25519 -o IdentitiesOnly=yes \
       -o ForwardAgent=no -o ClearAllForwardings=yes \
       ac-provider@127.0.0.1 'command -v hermes'
   ```

## 4. Create the environment and pin the agent

Create an SSH environment in the company (UI or API) whose config names the
two files by absolute path, with strict host key checking left on:

```json
{
  "name": "ac-provider (local)",
  "driver": "ssh",
  "config": {
    "host": "127.0.0.1",
    "port": 22,
    "username": "ac-provider",
    "remoteWorkspacePath": "/Users/ac-provider/agentdash",
    "identityFile": "/etc/agentdash/ssh/ac-provider_ed25519",
    "knownHostsFile": "/etc/agentdash/ssh/known_hosts",
    "strictHostKeyChecking": true
  }
}
```

Then set the Hermes agent's default environment to it
(`PATCH /api/agents/:id` with `defaultEnvironmentId`, or the agent's
configuration page). Pinning is refused (4xx, in plain words) when the flag is
off, when `user@host` isn't on the allowlist, when it isn't allowed for this
company, when the environment belongs to another company, or when either path
is missing or relative.

## 5. What a run does

- `ssh` is spawned with an argument array (never a shell string):
  `BatchMode=yes`, `StrictHostKeyChecking=yes`, the pinned `UserKnownHostsFile`
  (global known_hosts ignored), the dedicated key with `IdentitiesOnly=yes`,
  `ForwardAgent=no` and `ClearAllForwardings=yes`.
- The run's environment (the run token, the agent's configured env such as a
  provider key) is **not** put on the remote command line. It is written to a
  0600 file, sent over the SSH connection's stdin into
  `<workspace>/.paperclip-runenv/<run id>/`, read by a small wrapper that
  deletes it, and the directory is removed after the run. The server's own
  environment (database URL, auth secrets) is never sent.
- Hermes runs in the environment's workspace directory, as the target user.
- Before each run AgentDash re-checks the allowlist and the key and known_hosts
  files, and refuses before connecting if anything is off.

Not available over SSH yet: managed per-agent Hermes profiles (the remote
user's own Hermes home is used), Hermes' structured `stream-json` transcript
(text mode is used), and token metering (the session ledger lives with the
remote user; runs are recorded as `unmetered_no_ledger`).

## 6. Audit trail

Both are company-scoped activity-log entries carrying the `user@host` and ids
only (never key material or env values):

- `agent.ssh_environment_pinned` — a Hermes agent was pinned to an SSH
  environment (create, hire, or update).
- `agent.ssh_run_launched` — a Hermes run was launched over SSH.
