# Mac Mini Deployment

This is the first design-partner launch path for a customer-local Mac mini behind Tailscale or another private network. It mirrors the VPS pinned-image flow while using `launchd` to keep the Docker Compose instance running.

## Production Shape

- Private access only for week one: Tailscale/private URL, no public exposure.
- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`.
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`.
- `AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=true` so saved agents need passing preflight evidence before launch-mode runs start.
- Docker Compose runs Postgres 17 and the AgentDash server from a pinned GHCR SHA image.
- `launchd` runs a supervisor with `RunAtLoad` and `KeepAlive`.
- Runtime env file mode is `600`.
- Updates use `scripts/deploy/agentdash-ota-update.mjs`; no local source build or manual rsync.
- Each update runs a database backup, health check, readiness proof, and writes a deploy receipt.

## Week-One Agent Harness Policy

Codex local agents must prove they can call the AgentDash control-plane API before customer work is assigned. The required passing preflight evidence is:

- `codex_hello_probe_passed`
- `codex_control_plane_api_reachable`
- saved harness preflight metadata with the current contract version

For the first Mac mini launch, run Codex local agents in trusted-local mode only on the private Mac mini:

```json
{
  "command": "codex",
  "cwd": "/opt/agentdash/workspaces/<agent-or-repo>",
  "env": {
    "PAPERCLIP_API_URL": {
      "type": "plain",
      "value": "http://<tailnet-host-or-ip>:3100"
    }
  },
  "dangerouslyBypassApprovalsAndSandbox": true,
  "extraArgs": []
}
```

Do not combine `dangerouslyBypassApprovalsAndSandbox=true` with `--full-auto`; Codex rejects that combination. This trusted-local setting is acceptable only with private-network access, human-reviewed outputs, and no direct PSA/RMM writes. Before the second customer, replace or supplement this with a callback bridge so Codex can remain sandboxed while still reaching AgentDash APIs.

## Install

From a reviewed checkout on the Mac mini:

```sh
sudo mkdir -p /opt/agentdash
sudo chown -R "$USER":staff /opt/agentdash

node scripts/deploy/agentdash-mac-mini-launchd.mjs \
  --target-image ghcr.io/<owner>/<repo>:sha-<commit> \
  --image-repo ghcr.io/<owner>/<repo> \
  --public-url http://<tailnet-host-or-ip>:3100 \
  --install-dir /opt/agentdash \
  --write
```

Review the generated files:

```sh
ls -la /opt/agentdash
stat -f '%Lp %N' /opt/agentdash/agentdash.env
sed -n '1,220p' /opt/agentdash/RUNBOOK.md
```

Start the service:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.agentdash.agent.plist
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
```

The compatibility wrapper at `docker/launchd/install.sh` delegates to this installer. Do not use the old source-build launchd path for production.

## Source-Checkout Fallback

Use the Docker/pinned-image package above when Docker is available. If the design-partner Mac mini cannot run Docker yet, the supported fallback is a source-checkout launchd package pinned to a reviewed git SHA. This matches the current field shape while still enforcing production controls.

Dry-run the package from the reviewed checkout:

```sh
node scripts/deploy/agentdash-mac-mini-source-launchd.mjs \
  --repo-dir /Users/<operator>/workspace/agentdash_msp_launch \
  --target-sha <reviewed-commit-sha> \
  --public-url http://<tailnet-host-or-ip>:3100 \
  --runtime-env-file /Users/<operator>/.config/agentdash/agentdash.env
```

Write files after reviewing the dry run:

```sh
node scripts/deploy/agentdash-mac-mini-source-launchd.mjs \
  --repo-dir /Users/<operator>/workspace/agentdash_msp_launch \
  --target-sha <reviewed-commit-sha> \
  --public-url http://<tailnet-host-or-ip>:3100 \
  --runtime-env-file /Users/<operator>/.config/agentdash/agentdash.env \
  --write
```

The source-checkout package writes:

- `~/.config/agentdash/agentdash.env` with required launch env merged in and mode `600`.
- `AGENTDASH_SOURCE_SHA=<reviewed-commit-sha>` in the env file so readiness can prove the source runtime is pinned.
- `~/.agentdash/bin/agentdash-source-supervisor.sh`, which refuses to start if the checkout is not at the expected SHA.
- backup, readiness, source-update, and source-rollback wrappers under `~/.agentdash/bin`.
- `~/.agentdash/RUNBOOK.md`.
- `~/Library/LaunchAgents/ai.agentdash.agent.plist`.

The source fallback is allowed for the first design partner only if the readiness proof still reports `0 fail`, harness smoke passes, and updates happen by reviewed SHA through `agentdash-source-update.sh`. The source update wrapper advances `AGENTDASH_SOURCE_SHA` before restarting launchd so the supervisor and readiness proof both enforce the reviewed SHA. Move to the Docker/pinned-image package once Docker is available or before the second customer.

## Generated Files

- `/opt/agentdash/docker-compose.yml`
- `/opt/agentdash/agentdash.env`
- `/opt/agentdash/bin/agentdash-compose-supervisor.sh`
- `/opt/agentdash/bin/agentdash-backup-db.sh`
- `/opt/agentdash/bin/agentdash-readiness.sh`
- `/opt/agentdash/bin/agentdash-update.sh`
- `/opt/agentdash/bin/agentdash-rollback.sh`
- `/opt/agentdash/bin/agentdash-ota-update.mjs`
- `/opt/agentdash/RUNBOOK.md`
- `~/Library/LaunchAgents/ai.agentdash.agent.plist`

## Readiness Proof

Before partner handoff:

```sh
/opt/agentdash/bin/agentdash-readiness.sh
curl -fsS http://<tailnet-host-or-ip>:3100/api/health
launchctl print gui/$(id -u)/ai.agentdash.agent
```

Then run the existing launch-readiness scripts when available:

```sh
export AGENTDASH_READINESS_AUTH_HEADER='Bearer <operator-or-readiness-token>'
scripts/msp-mac-mini-readiness.sh \
  --base-url http://<tailnet-host-or-ip>:3100 \
  --expected-company-id <agentdash-company-id> \
  --auth-header-env AGENTDASH_READINESS_AUTH_HEADER \
  --env-file /opt/agentdash/agentdash.env \
  --run-backup \
  --backup-command /opt/agentdash/bin/agentdash-backup-db.sh \
  --run-instance-backup \
  --instance-backup-command 'tar -czf /opt/agentdash/backups/instance-$(date -u +%Y%m%dT%H%M%SZ).tgz --exclude /opt/agentdash/backups --exclude /opt/agentdash/deployments /opt/agentdash' \
  --run-agent-harness-smoke \
  --agent-harness-command 'scripts/agent-harness-smoke.sh --base-url http://<tailnet-host-or-ip>:3100 --company-id <company-id> --cookie-jar <authenticated-cookie-jar>'
```

The readiness script must report `0 fail`. The embedded agent-harness smoke is required launch evidence, not a nice-to-have smoke.

Then prove partner access from the partner path:

```sh
scripts/msp-partner-access-proof.sh \
  --base-url http://<tailnet-host-or-ip>:3100 \
  --expected-company "AgentDash MSP Demo"
```

If those scripts are not present in the deployed checkout, record that as a launch blocker until they are restored or replaced by equivalent evidence.
For credential-based partner proof, set `AGENTDASH_PROOF_EMAIL` and `AGENTDASH_PROOF_PASSWORD` in the shell that runs the proof, or pass `--cookie-jar` from an already-authenticated partner browser session.

Run the first-run agent harness smoke for every configured launch agent before handoff. Warnings fail by default because a warning still means the first customer-created work may fail or behave differently than expected.
Each saved launch agent must also show passing harness preflight evidence in its Agent detail page. If the panel says preflight is required, run the saved-agent preflight action before assigning customer work. For `codex_local`, the smoke fails unless the adapter result includes `codex_control_plane_api_reachable`.

```sh
scripts/agent-harness-smoke.sh \
  --base-url http://<tailnet-host-or-ip>:3100 \
  --company-id <company-id> \
  --cookie-jar <authenticated-cookie-jar>
```

Use `--adapter <type>` or `--agent-id <id>` for a focused rerun after fixing a single adapter. Use `--dry-run` only to verify selection; it is not launch evidence.

## OTA Update

Dry-run in the repo checkout first:

```sh
node scripts/deploy/agentdash-ota-update.mjs \
  --target-sha <commit-sha> \
  --image-repo ghcr.io/<owner>/<repo> \
  --compose-file /opt/agentdash/docker-compose.yml \
  --runtime-env-file /opt/agentdash/agentdash.env \
  --state-dir /opt/agentdash/deployments \
  --base-url http://<tailnet-host-or-ip>:3100 \
  --backup-command /opt/agentdash/bin/agentdash-backup-db.sh \
  --readiness-command /opt/agentdash/bin/agentdash-readiness.sh \
  --dry-run
```

Apply through the generated wrapper:

```sh
/opt/agentdash/bin/agentdash-update.sh <commit-sha>
```

## Rollback Rehearsal

Rollback uses the previous image pointer from `/opt/agentdash/deployments/state.json`.

```sh
/opt/agentdash/bin/agentdash-rollback.sh
```

Do not restore a database backup unless the failed release caused a destructive data problem and a human launch owner approves the restore.

## Launch Evidence

Collect these before the design partner starts using the system:

- `/api/health` JSON from the tailnet URL.
- `launchctl print gui/$(id -u)/ai.agentdash.agent` output.
- `stat -f '%Lp %N' /opt/agentdash/agentdash.env` showing mode `600`.
- Current `AGENTDASH_IMAGE` or `AGENTDASH_SOURCE_SHA` from the runtime env file.
- Latest backup path from `/opt/agentdash/backups`.
- Latest deploy receipt from `/opt/agentdash/deployments/receipts`.
- Partner login proof from the partner device.
- One real assigned agent run that produces a concrete response.
- `agent-harness-smoke.sh` output showing every launch agent passes, including Codex control-plane reachability.
- Confirmation that failed agent runs show a classified harness error and recovery action.
