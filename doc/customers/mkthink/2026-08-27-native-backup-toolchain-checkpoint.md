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

Regression file: `scripts/deploy/agentdash-native-backup.test.mjs` (Node test runner; the live case starts a real
embedded PostgreSQL 18 from this checkout's `@embedded-postgres/darwin-arm64@18.1.0-beta.16`, bounds PATH to
node/pnpm/system utilities plus a fake embedded `bin` holding only `initdb`/`pg_ctl`/`postgres`, and seeds a
synthetic schema — enum, FK, index, `drizzle.__drizzle_migrations`, 423 rows).

Run against the unmodified generator (`origin/main` `e1b16cdf`), captured to
`/Users/Kailor/.config/superpowers/worktrees/agentdash/claude-native-pg-backup.red.log`:

- ✖ rendered backup contract prefers compatible pg_dump but falls back to the repository engine — no
  `--check`, no repository engine, no version validation, URL passed on the pg_dump command line.
- ✖ update wrapper probes backup readiness before pending state and records the verified backup — the
  wrapper writes `pending.json` first, then calls the backup, and the receipt has no backup digest.
- ✖ readiness proves database connectivity through the repository, not psql — readiness still shells out
  to `psql` when present and has no backup-capability probe.
- ✖ native backup contract against a tool-less embedded PostgreSQL (4 sub-cases):
  - the wrapper fails before producing a valid backup: even with its PATH rewritten to the client's tool-less
    PATH, the fixed absolute-path list finds `/opt/homebrew/bin/pg_dump` 14.17 on this host and exits 1 with
    `pg_dump: error: server version: 18.1; pg_dump version: 14.17 (Homebrew) … aborting because of server
    version mismatch`; no readiness JSON, no valid archive. On the client, with no binary at any fixed path,
    `command -v pg_dump` fails silently and the wrapper exits 1 with no message at all.
  - an incompatible `pg_dump` is not rejected — no probe exists;
  - a compatible `pg_dump` is not validated with `pg_restore --list` — no probe exists;
  - no engine at all does not fail with an actionable message — stderr names neither `PG_DUMP_BIN`, nor the
    searched PATH, nor the repository engine.
- ✔ every rendered operational shell parses under the macOS system bash (unchanged).
- (harness fix, not a product finding: the platform package exports no entry point, so the test locates it
  through the pnpm store.)

The observed client failure ("no pg_dump/pg_restore/psql; embedded distribution has only initdb, pg_ctl,
postgres; generated backup wrapper exits 1 under `set -euo pipefail` before creating or validating a backup")
is therefore reproduced for its exact reason, and the additional latent failure (incompatible host `pg_dump`
accepted without validation) is recorded.

## GREEN evidence

Implementation (release-control only; application payload untouched):

- `scripts/deploy/agentdash-mac-mini-source-launchd.mjs`
  - `agentdash-backup-db.sh` becomes a thin launcher; the contract lives in a rendered Node runner
    `agentdash-backup-db.mjs` executed through the installed checkout's own `tsx`
    (`pnpm --silent --filter @paperclipai/db exec tsx`), exactly like the nightly launchd backup.
  - The runner resolves the database the way the application and `packages/db/src/backup.ts` do
    (`DATABASE_URL` → instance `config.json` under `PAPERCLIP_HOME`/`PAPERCLIP_INSTANCE_ID` → embedded port),
    reads `server_version_num` through the checkout's PostgreSQL driver, and never prints the URL.
  - Engine selection: compatible `pg_dump`/`pg_restore` pair (explicit reviewed `PG_DUMP_BIN`/`PG_RESTORE_BIN`
    or on the wrapper PATH; pg_dump major ≥ server major; pg_restore major == pg_dump major) → custom-format
    dump validated by `pg_restore --list`; otherwise the repository engine
    (`packages/db/src/backup-lib.ts`, `backupEngine: "javascript"`) → gzipped SQL archive validated by a
    genuine `runDatabaseRestore` into a throwaway database on the same server with per-table row counts
    compared against the counts recorded in the archive, then `DROP DATABASE … WITH (FORCE)`.
    `AGENTDASH_BACKUP_ENGINE=pg_dump|javascript` requires an engine. No credential is placed on a command
    line (libpq environment variables are used).
  - `--check` is read-only and prints one JSON readiness record (engine, server major, connection source,
    pg tool verdicts, searched locations, repository-engine availability, running heartbeat runs, backup dir
    writability, remediation). Failure exits 2 with the searched locations and supported remediations.
  - The repository engine refuses while heartbeat runs are `running` (it reads tables sequentially).
  - Each archive gets `<archive>.receipt.json` (mode 600: path, mode, size, SHA-256, engine, server,
    validation) and `deployments/last-backup.json` (mode 600) for the updater.
  - `agentdash-source-update.sh` runs `--check` before writing `pending.json`, creates/validates the backup
    before `git fetch`/checkout, refuses to continue without the verified archive, and writes
    `backupSha256`/`backupEngine`/`backupReceiptPath` into the deployment receipt. `/tmp` is no longer used.
  - `agentdash-readiness.sh` proves database connectivity and backup capability through the same probe
    (no `psql`), never printing the URL.
  - RUNBOOK documents the probe, engines, overrides and receipts.
- `scripts/deploy/agentdash-native-backup.test.mjs` (new) and `agentdash-mac-mini-source-launchd.test.mjs`
  (updated assertions); `package.json` adds the new file to `test:launch-signoff`.

GREEN run (same host, unmodified test cases): `node --test scripts/deploy/agentdash-native-backup.test.mjs`
→ 10/10 passed, including the live tool-less embedded PostgreSQL 18 case: repository-engine archive
(`predeploy-<utc>.sql.gz`, mode 600, ≥ 1 KiB, SHA-256 recorded), throwaway-database restore validated
5 tables / 423 rows with no leftover database, receipts and `last-backup.json` written without secrets;
incompatible `pg_dump` 14 rejected with a reason naming server major 18; compatible `pg_dump` 18 path
validated by `pg_restore --list`; no engine → exit 2 naming `PG_DUMP_BIN`, the searched PATH and the
repository-engine remediation with no archive left behind. `agentdash-mac-mini-source-launchd.test.mjs`
→ 9/9 passed.

## Release / rehearsal log

_pending_
