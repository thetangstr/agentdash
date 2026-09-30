---
title: Ross Private Host Readiness
summary: Offline, fail-closed readiness scorecard and inert draft artifacts for the dedicated Ross private-host deployment
---

This is the offline preparation package for the Ross private host (milestone 6 of the
Monica/Ross/AgentDash launch plan). It prepares and reviews evidence; it does not deploy,
and a passing scorecard here is a precondition review — not host acceptance.

Everything in this package is offline and read-only toward shared infrastructure:

- `scripts/ross/host-readiness.mjs` never accesses a remote host, never changes SSH trust,
  Tailscale/Funnel, launchd, power or service settings, and never reads credential values.
- Evidence is operator-collected receipts assembled into one JSON bundle. **Missing evidence
  is "unproven", never "pass"** — a launchd plist on disk or a loopback health check does
  not prove private-host readiness.
- `render-drafts` produces inert install/config/rollback drafts (mode 600, placeholder
  secrets, synthetic paths) for review. Drafts run nothing and install nothing.

## 1. The scorecard

```sh
node scripts/ross/host-readiness.mjs evaluate --evidence evidence.json --evidence-dir ./
node scripts/ross/host-readiness.mjs evaluate --evidence evidence.json --json
```

Exit code is 0 only when **every gate passes**. Any `unproven` or `fail` gate exits 1.

| Gate | Requires (all observed, none guessed) |
|---|---|
| `host_identity` | `host.expected.hostname` declared; `identity.observedAt`, `via` (trusted channel), observed `hostname` matching the selection, `trusted: true`, and at least one strong field (`hardwareUuid`, `tailscaleNodeId`, `hostKeyFingerprintSha256`). |
| `disk_headroom` | `disk.availableBytes` ≥ `--min-free-bytes` (default 32 GiB); `capacityPercent` ≤ 95 when present. |
| `private_listener` | `listener.allocated.{port,bind,allocatedBy}` — an *explicitly allocated* port, integer 1024–65535, not in the shared denylist (3100, 4777, 443, 8443 + `--shared-port`), not already in `observedListeners`, bound to loopback/tailnet/RFC1918 only, and `funnelExposed` not `true`. |
| `authenticated_reachability` | `issuer.{ok,url,observedAt,observedFrom}` and `client.{status=ok,deploymentMode=authenticated,deploymentExposure=private,authReady,bootstrapStatus=ready}` — both `observedFrom` a non-loopback vantage (e.g. `tailnet:<device>`). Loopback-only health is unproven. |
| `service_identity` | `serviceIdentity.{label,runsAs}`, `envFile.mode=600`, `envFile.secretsPresent` = names only. Evidence carrying secret *values* fails. |
| `filevault_volume_at_boot` | `boot.fileVaultEnabled=true`, `boot.volumeMountedAtBoot=true`. |
| `supervision_coldstart` | `supervision.{loaded,keepAlive,pid}` observed live **and** `coldStart.verified=true` from an actual cold-boot observation on the dedicated host. |
| `second_device_and_public_denial` | `secondDevice.{deviceId,authorizedAccess=true,publicDenial=true}` — a second private device got in *and* public/internet access was observed denied. |
| `pinned_artifact` | `artifact.targetSha` = exact 40-hex reviewed SHA and `artifact.checkoutSha` identical. |
| `backup_separation` | Two *distinct* backups: `agentdashDb` (engine `pg_dump`/`javascript`, sha256, `validatedBy`) and `rossPrivate` (sha256, `restoredToScratch=true`). Same artifact path fails. |

Print the full field skeleton with `node scripts/ross/host-readiness.mjs template`.

### Receipt references

`backups.agentdashDb.receiptPath` and `backups.rossPrivate.manifestPath` are resolved
relative to `--evidence-dir` and their structure is validated: the DB receipt must carry
`engine`/`sha256`/`validation.method` (the shape written by the generated
`agentdash-backup-db.sh` runner), and the Ross manifest must be `kind:
"ross-private-state-backup"`, `schemaVersion: 1`.

### Passive local observation

```sh
node scripts/ross/host-readiness.mjs observe-local --path /
```

Collects read-only local facts (hostname, `df`, `fdesetup status`, `pmset -g`, `uptime`,
`sw_vers`) for the operator to copy into the bundle. This is **not** trusted host-identity
proof — `observe-local` on a shared machine describes that shared machine.

## 2. Inert draft bundle

```sh
node scripts/ross/host-readiness.mjs render-drafts \
  --target-sha <40-hex-reviewed-sha> \
  --public-url http://<tailscale-host>:<allocated-port> \
  --label ai.agentdash.ross \
  --paperclip-port <allocated-port> \
  --out-dir ./drafts/ross-host
```

Renders the env file, supervisor, backup runner, readiness, update, rollback, plist and
runbook from `scripts/deploy/agentdash-mac-mini-source-launchd.mjs` into `--out-dir` as
mode-600 `*.draft` files plus a `draft-manifest.json` (sha256 per artifact). Secrets are
literal placeholders — no generated or live secret material is present. Re-running into the
same directory is idempotent; any divergent existing artifact aborts rather than silently
overwriting. The drafts' `planPaths` are synthetic; real install still goes through the
generator's own `--write` flow on the host under deployment authority.

## 3. Backup separation — two different things

- **Canonical AgentDash DB backup** — the generated `agentdash-backup-db.sh` /
  `packages/db/src/backup-lib.ts` (or a version-compatible `pg_dump`), validated by
  throwaway-database restore or `pg_restore --list`. This is the system-of-record backup
  and the update/rollback gate. Produce its receipt via the installed wrappers' `--check`
  and run modes, then record `engine`, `sha256`, `validatedBy` in the bundle.
- **Ross derived/session backup** — `scripts/ross/private-state-backup.py`, owner-private
  SQLite session/commitment state only. It restores into a *fresh* destination (an existing
  path is refused — re-running does not duplicate work) and revalidates
  scope/provenance/markers on restore. Exercise it against scratch targets:

  ```sh
  python3 scripts/ross/private-state-backup.test.py        # full negative/roundtrip suite
  python3 scripts/ross/private-state-backup.py backup <binding.json> <archive>
  python3 scripts/ross/private-state-backup.py restore <archive> <fresh-scratch-dir>
  ```

Neither backup substitutes for the other, and neither contains credentials, provider
settings or profiles by design.

## 4. Remaining observational gates (not covered by this package)

The scorecard can only confirm what is observed. Still open until real receipts exist:

- Trusted host identity for the selected Mini (the historical `mac-mini-x14` probe was
  refused at SSH host trust — resolve through the trusted channel, do not bypass).
- Deployed candidate on an explicitly allocated noncolliding private listener.
- Second private device authorized access **and** observed public denial (no public443
  Funnel exposure of the Ross service).
- Supervision and cold-start on the dedicated host — not inferred from the shared Studio.
- Authenticated issuer/client reachability from a non-loopback vantage.
- Canonical AgentDash DB backup receipt and Ross private backup/restore rehearsal on host.

Current shared-host disk (~98% full) is itself an unready signal for that volume — it is
input evidence, not license to clean anything.
