# Target Mac Mini Audit

**Date:** 2026-05-27  
**Target:** `maxiaoer@192.168.86.48` (`mac-mini.lan`)  
**Purpose:** Post-cutover evidence for the first MSP design-partner launch path.

## Summary

The target Mac mini is reachable over SSH and has been cut over to the launchd production candidate from the PR branch. The service is healthy on `http://192.168.86.48:3100`, authenticated/private mode is active, the readiness script has no P0 failures, and Hermes has completed both CoS-chat and assigned-issue agent-write smoke tests.

Remaining launch work is outside the code/host preflight: prove login from the actual partner device or tailnet path, rotate any historical target GitHub token, and fill in named partner operating owners.

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
  - clean checkout on branch `codex/msp-mac-mini-launch`
  - CI/browser-suite proof commit `fdbb150dfb76736d8a78b702e54d01259730ce23`
  - runtime-critical Hermes/launchd fix commit `f379ce25887fd69b64f347a3f027a3d1c2187d51`
- Target isolated build passed:
  - `pnpm install --frozen-lockfile`
  - `pnpm build`

## Current Runtime Posture

The process listening on `3100` is the launchd service `ai.agentdash.agent` from `/Users/maxiaoer/workspace/agentdash_msp_launch`.

Cutover evidence:

- Legacy dev-runner launch agents were disabled before loading the new service.
- `launchctl list | grep ai.agentdash.agent` shows the service loaded.
- Target checkout fast-forwarded cleanly on branch `codex/msp-mac-mini-launch`.
- The launchd plist exists at `~/Library/LaunchAgents/ai.agentdash.agent.plist`.
- The env file exists at `~/.config/agentdash/agentdash.env` with mode `600`.
- Health returns:
  - `{"status":"ok","deploymentMode":"authenticated","bootstrapStatus":"ready","bootstrapInviteActive":false}`
- PostgreSQL is running through Homebrew PostgreSQL 17 because Docker was unavailable for the target cutover.
- `PAPERCLIP_PUBLIC_URL=http://192.168.86.48:3100`.
- `AGENTDASH_DEFAULT_ADAPTER=hermes_local`.
- `AGENTDASH_HERMES_COMMAND=/Users/maxiaoer/.local/bin/hermes`.

## Readiness Script Result

Latest readiness was run from the launch checkout after cutover:

```sh
cd ~/workspace/agentdash_msp_launch
scripts/msp-mac-mini-readiness.sh --base-url http://192.168.86.48:3100
```

Result:

- `Summary: 24 pass, 9 warn, 0 fail`
- `Status: Code/host preflight passed.`

Remaining warnings:

- Tailscale is not available on PATH; current proof is private LAN.
- `PAPERCLIP_BIND=lan`; partner-device private access still needs direct proof.
- Hermes product proof is manual from the script's perspective; evidence is recorded below.
- local storage and secrets master key do not exist yet.
- Stripe is not configured; launch posture is managed design-partner pilot.
- Resend is not configured; launch posture is manual invites/password resets.

Manual backup evidence:

- `scripts/msp-mac-mini-readiness.sh --run-backup --base-url http://192.168.86.48:3100`
- Backup artifact: `/Users/maxiaoer/.agentdash/instances/default/data/backups/paperclip-20260527-125056.sql.gz`

## Hermes Product Proof

CoS chat proof:

- Bootstrap/signup/onboarding smoke created company `aa7be9e3-1e12-4845-b7ad-01ac009ba53b`.
- CoS agent `9022f20b-bac1-441f-91b3-aaeb26b5bda6` replied through `hermes_local`.
- Server log showed routing through `/Users/maxiaoer/.local/bin/hermes`.

Agent execution proof:

- Initial manual wakeup failed before the fix because launchd could not resolve `hermes` from PATH.
- Fixed in commit `f379ce25887fd69b64f347a3f027a3d1c2187d51` by aligning Hermes agent execution with `AGENTDASH_HERMES_COMMAND` and adding `~/.local/bin` to launchd PATH.
- Manual wakeup run `20e65705-8868-45bd-b72f-688e9c3672f0` succeeded with exit code `0` and Hermes session `20260527_130400_3d4eaf`.
- Assigned issue-write smoke run `75181d3f-655e-4939-b94d-a5fae645cb33` succeeded with liveness `completed`.
- Smoke issue `AGE-1` ended in status `done`.
- Hermes wrote comment `Hermes issue-write smoke completed` as agent `9022f20b-bac1-441f-91b3-aaeb26b5bda6`, tied to run `75181d3f-655e-4939-b94d-a5fae645cb33`.
- Temporary smoke board API key was revoked; post-revoke `/api/cli-auth/me` returned `401`.

## Security Note

One target checkout had a GitHub token embedded in its `origin` remote URL. The remote was sanitized to `https://github.com/thetangstr/agentdash.git`. Rotate any GitHub token that may have been stored in the target git config before partner use.

## Remaining Cutover Gates

P0:

- Prove private access and login from the actual partner machine or tailnet device.
- Confirm there is no unintended public unauthenticated access path.

P1:

- Rehearse rollback from a recorded deployed SHA during a maintenance window if rollback becomes necessary.
- Confirm target env file permissions and log secret hygiene.
- Confirm partner operator owner, issue channel, and week-one check-in cadence.
