# MKThink native backup toolchain — release-repair checkpoint

Date: 2026-08-27 UTC
Owner lane: release-control repair for the next native macOS patch (expected `v2026.827.3`)
Production boundary: **the MKThink client is not contacted or mutated by this task** — no SSH, no client
commands, no client backups/migrations/restarts/checkout changes, no DNS/TLS/IAM/secret changes, no client
communication, no OTA installation. Client installation remains a separate, explicitly authorized task.

## Exact working state

- Canonical repository: `/Volumes/home/Projects_Hosted/agentdash` (local `main` at `b19bf176`, diverged
  from `origin/main`; left untouched).
- Isolated worktree for this lane: `/Users/Kailor/.config/superpowers/worktrees/agentdash/claude-native-pg-backup`
- Branch: `claude/native-pg-backup-toolchain`
- Base: `origin/main` = `e1b16cdfa35c5d225181f18ce2aa0fee8c743b80` ("Keep native OTA failures recoverable and
  private" — the `v2026.827.2` release-control SHA).
- Dependencies installed with `pnpm install --frozen-lockfile`; workspace packages built.

## Published state being corrected

- Stable application release: `v2026.827.2` (<https://github.com/thetangstr/agentdash/releases/tag/v2026.827.2>)
  - application payload (tag target): `f552df77417143fd6a949eff8553b98578317f5e` — **unchanged by this lane**
  - release-control SHA: `e1b16cdfa35c5d225181f18ce2aa0fee8c743b80`
  - assets: `agentdash-mac-mini-source-launchd-v2026.827.2.mjs`, `.sha256`, `agentdash-release-control-v2026.827.2.json`
- `agentdash-connect@0.1.5` is correctly published and **not implicated**; it is not republished by this lane.
- Client (MKThink Mac mini): installed source remains `a02aaaa4d5aab889799cc6d1c6e69fdfb44f0ed5`.
  The `v2026.827.2` preflight **failed closed before any mutation** — correct behaviour.
- Client evidence directory (client-side only, not locally accessible):
  `/Users/yang/agentdash-upgrade-evidence-20260827-080500/`

## Observed blocker (first stop condition)

The native MKThink installation has no `pg_dump`, `pg_restore`, or `psql`:

- not on `PATH`; no Homebrew libpq/PostgreSQL; no Postgres.app; not in `node_modules`;
- the embedded PostgreSQL distribution (`@embedded-postgres/darwin-arm64@18.1.0-beta.16`, the same
  version pinned at `a02aaaa4` and at `f552df77`) ships only `initdb`, `pg_ctl`, and `postgres`.

The generated `agentdash-backup-db.sh` (rendered by `scripts/deploy/agentdash-mac-mini-source-launchd.mjs`
→ `renderSourceBackupScript`) hard-requires a `pg_dump` executable found through a fixed absolute-path list
plus `command -v pg_dump`, and exits 1 under its own `set -euo pipefail` before it ever looks at the
database. It therefore cannot create or validate the mandatory pre-upgrade backup, and the update wrapper
(`agentdash-source-update.sh`) stops. Release artifacts, tag, source SHA, manifest, checksum, node syntax,
and the no-write plan all verified correctly; the defect is the native backup/rollback delivery contract.

Root-cause facts established from source (no client access):

- `packages/db/src/backup-lib.ts` already provides a repository-supported backup engine that needs no
  PostgreSQL client binaries (`backupEngine: "javascript"`), and `runDatabaseRestore` has a Node-only
  restore path (`restoreCopyBlock`) written for exactly this embedded deployment. The file is
  byte-identical between `a02aaaa4` (installed on the client) and `origin/main`.
- MKThink's nightly launchd backup (`deploy/agentdash-backup.sh` → `server/scripts/nightly-backup.mjs`,
  `deploy/launchdaemons/com.agentdash.mkboard.backup.plist`) already uses that engine with
  `backupEngine: "auto"`.
- The release asset is a verbatim copy of `scripts/deploy/agentdash-mac-mini-source-launchd.mjs`
  (`scripts/build-release-control-assets.mjs`), so the correction is release-control only and the
  application payload stays `f552df77`.
- A host that *does* have Homebrew `pg_dump` older than the embedded server (this Mac Studio:
  `/opt/homebrew/bin/pg_dump` 14.17 vs embedded PostgreSQL 18) fails the same wrapper for a second reason
  — server-version mismatch — because executable compatibility is never validated.

## Second stop condition — UNKNOWN (required before publication)

The client reported that installing would require accepting **two** stop conditions. The previous
transcript and every local checkpoint (`2026-08-26-ota-rehearsal-checkpoint.md`,
`2026-08-27-supervisor-release-checkpoint.md`, `2026-08-27-agentdash-release-staging-final.md`,
`2026-08-27-client-upgrade-operator-handoff.md`) contain only the database-tooling blocker. The client
evidence directory is not locally accessible and the client must not be contacted.

**Gate:** `v2026.827.3` must not be finalized or published until the complete second-blocker section is
pasted by the CEO and either addressed or explicitly recorded as out of scope for this patch.

Candidate causes noted from source inspection only (not assumed):

- the release-notes duplicate preflight for migration `0122` is written as a `psql` query, which the
  client also cannot run;
- the generated readiness/update wrappers address `gui/<uid>/<label>`, whereas the client is supervised
  by system launchd daemons;
- the generated readiness step requires `DATABASE_URL` or `PAPERCLIP_EMBEDDED_POSTGRES_PORT` in the
  runtime env.

## First failing regression

Recorded in this document once the RED run is captured (see "RED evidence" below).

## Intended patch

- Version: `v2026.827.3` (stable slot for UTC date 2026-08-27; pass `stable_date=2026-08-27` to the
  canonical workflow if publication crosses UTC midnight).
- `source_ref`: `f552df77417143fd6a949eff8553b98578317f5e` (unchanged application payload).
- Release-control change: make the generated native backup contract portable — resolve the running
  server major without exposing credentials, prefer compatible `pg_dump`/`pg_restore` (explicit reviewed
  overrides honoured and validated), otherwise use the repository's own backup engine from the installed
  checkout; validate the archive with a genuine restore into a throwaway database (or `pg_restore --list`
  for custom-format dumps); record path/mode/size/SHA-256 without secrets; probe all of this in a
  read-only `--check` before pending state, checkout, config, or service mutation; never declare rollback
  ready without a verified recoverable backup.
- Publication path: PR → required hosted checks → merge → canonical stable workflow dry-run → live run →
  independent asset verification → isolated native staging rehearsal from `a02aaaa4`.

## RED evidence

_pending_

## GREEN evidence

_pending_

## Release / rehearsal log

_pending_
