# Target Mac Mini Audit

**Date:** 2026-05-27  
**Target:** `maxiaoer@192.168.86.48` (`mac-mini.lan`)  
**Purpose:** Pre-cutover evidence for the first MSP design-partner launch path.

## Summary

The target Mac mini is reachable over SSH, the current service on port `3100` is healthy, and the launch PR branch builds in an isolated checkout on the target. The target is not ready for design-partner use yet because the live service is still a dev-runner process from an existing checkout, not the launchd production install, and the production env/Hermes/network/backup posture has not been cut over.

## Evidence Collected

- SSH reachability confirmed for `maxiaoer@192.168.86.48`.
- Target host reported `mac-mini.lan` and macOS `26.5`.
- Local health endpoint returned healthy authenticated-mode JSON:
  - `{"status":"ok","deploymentMode":"authenticated","bootstrapStatus":"ready","bootstrapInviteActive":false}`
- Hermes is installed but not on the login shell PATH:
  - usable absolute command: `/Users/maxiaoer/.local/bin/hermes`
  - `hermes --help` reports the expected `chat`, `slack`, `gateway`, `mcp`, `doctor`, and related subcommands.
- Isolated launch checkout created at:
  - `/Users/maxiaoer/workspace/agentdash_msp_launch`
  - branch `codex/msp-mac-mini-launch`
  - commit `93ad33590a21ed7fdd2d4355735298e250fea23f`
- Target isolated build passed:
  - `pnpm install --frozen-lockfile`
  - `pnpm build`

## Current Runtime Posture

The process currently listening on `3100` is a Node dev-runner from `/Users/maxiaoer/agentdash`, backed by the existing embedded Postgres process. It is not the launchd production candidate created by `./docker/launchd/install.sh --with-postgres`.

Current target service gaps:

- `launchctl list | grep ai.agentdash.agent` found no loaded `ai.agentdash.agent` service.
- `~/Library/LaunchAgents/ai.agentdash.agent.plist` is missing.
- `~/.config/agentdash/agentdash.env` is missing.
- `~/.agentdash/logs/agentdash.log` and `~/.agentdash/logs/agentdash.err` are not present for the launchd service.

Do not stop or replace the current `3100` runtime without explicit cutover timing, because it is the active local instance.

## Readiness Script Result

Read-only readiness was run from the isolated launch checkout:

```sh
cd ~/workspace/agentdash_msp_launch
scripts/msp-mac-mini-readiness.sh
```

Result:

- `Summary: 5 pass, 10 warn, 13 fail`
- `Status: NOT READY for design-partner use.`

Expected P0 failures before cutover:

- launchd plist missing
- launchd service not loaded
- env file missing
- `PAPERCLIP_DEPLOYMENT_MODE` unset
- `PAPERCLIP_DEPLOYMENT_EXPOSURE` unset
- `NODE_ENV` unset
- `PAPERCLIP_MIGRATION_AUTO_APPLY` unset
- `AGENTDASH_DEFAULT_ADAPTER` unset
- `BETTER_AUTH_SECRET` unset
- `PAPERCLIP_AGENT_JWT_SECRET` unset
- `DATABASE_URL` unset
- `AGENTDASH_HERMES_COMMAND` unset
- `PAPERCLIP_PUBLIC_URL` unset

Expected P1 warnings before cutover:

- Tailscale is not available on PATH.
- backup directory does not exist yet
- local storage and secrets master key do not exist yet
- Stripe is not configured
- Resend is not configured

## Security Note

One target checkout had a GitHub token embedded in its `origin` remote URL. The remote was sanitized to `https://github.com/thetangstr/agentdash.git`. Rotate any GitHub token that may have been stored in the target git config before partner use.

## Remaining Cutover Gates

P0:

- Choose the cutover window for replacing the current dev-runner on `3100`.
- Run `./docker/launchd/install.sh --with-postgres` from the intended production checkout.
- Populate `~/.config/agentdash/agentdash.env` with `authenticated/private` settings.
- Set `AGENTDASH_DEFAULT_ADAPTER=hermes_local`.
- Set `AGENTDASH_HERMES_COMMAND=/Users/maxiaoer/.local/bin/hermes`.
- Configure the partner-visible private URL and bind posture.
- Run `scripts/msp-mac-mini-readiness.sh` until P0 failures are gone.
- Prove one Hermes-backed CoS reply.
- Prove one `hermes_local` agent task or wakeup with transcript evidence.

P1:

- Run `scripts/msp-mac-mini-readiness.sh --run-backup` and record the backup artifact.
- Rehearse rollback from a recorded deployed SHA.
- Decide managed-pilot billing posture versus Stripe test/live setup.
- Decide manual email posture versus Resend setup.
- Confirm target env file permissions and log secret hygiene.
- Confirm partner operator owner, issue channel, and week-one check-in cadence.
