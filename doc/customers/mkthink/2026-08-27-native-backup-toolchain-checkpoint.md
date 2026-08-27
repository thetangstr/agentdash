# MKThink native backup toolchain — release-repair checkpoint

Date: 2026-08-27 UTC
Owner lane: release-control repair for the next native macOS patch (expected `v2026.827.3`)
Production boundary: **the MKThink client is not contacted or mutated by this task** — no SSH, no client
commands, no client backups/migrations/restarts/checkout changes, no DNS/TLS/IAM/secret changes, no client
communication, no OTA installation. Client installation remains a separate, explicitly authorized task.

## Exact working state

- Canonical repository: `/Volumes/home/Projects_Hosted/agentdash` (local `main` at `b19bf176`, diverged
  from `origin/main`; left untouched).
- Isolated worktree for this lane: `~/.config/superpowers/worktrees/agentdash/claude-native-pg-backup` (linked
  worktree of the canonical repository)
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

Run against the unmodified generator (`origin/main` `e1b16cdf`), captured beside the worktree as
`~/.config/superpowers/worktrees/agentdash/claude-native-pg-backup.red.log`:

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

### Pre-publish rehearsal (branch generator, isolated staging, read-only for the instance)

Staging identity (unchanged from the `v2026.827.2` lane): root
`~/.paperclip-worktrees/instances/mkthink-ota-rehearsal.qOYDXY`, checkout at `a02aaaa4`, launchd label
`ai.agentdash.mkthink-ota-rehearsal-qoydxy` running under the gui domain, application loopback `:3231`,
isolated Docker PostgreSQL 16.15 on loopback `:55432`, synthetic data only. Evidence directory (mode 700):
`<staging root>/evidence/v2026.827.3-prepublish/`.

The client's tool-less environment was reproduced without touching the instance: a copy of the staging env
with the rehearsal-only `PG_DUMP_BIN` override removed, and `--tool-path` set to a directory holding only
`node` and `pnpm` plus the macOS system directories (no `pg_dump` resolvable). Wrappers were rendered into
a separate agentdash home under the evidence directory with the installed SHA pinned.

- no-write plan and `--write` (wrappers only): 5 shells pass `/bin/bash -n`; runner passes `node --check`.
- `agentdash-backup-db.sh --check`: `ok:true`, engine `javascript`, server major 16, connection source
  `DATABASE_URL`, `pgDump:null`, tools node/pnpm/git/curl/lsof resolved on the wrapper PATH, 0 running
  heartbeat runs, repository engine available. Password absent from every output.
- `agentdash-backup-db.sh` (live synthetic database): `predeploy-20260827T155020Z.sql.gz`, 155241 bytes,
  mode 600, SHA-256 `0802e46c68ebf7b4b51310e548bd800a88c7ac810b59292b5f62238b4ba74a27`, validated by a
  throwaway-database restore of 170 tables / 629 rows in ~3 s; throwaway database dropped (none left on the
  server); receipt and `last-backup.json` written mode 600 without secrets.
- `agentdash-readiness.sh` (read-only): health, launchd identity, source pin and env posture passed, then the
  embedded backup-probe parser **failed with a JavaScript syntax error** — the generator emitted
  `split(/\r?\n/)` through a template literal, rendering literal CR/LF. Readiness therefore failed closed
  (correct direction, wrong reason). Fixed by escaping the regex in the generator and adding a regression
  that runs `node --check` on every embedded Node heredoc of the rendered shells.
- Wrappers re-rendered with the fix; `agentdash-readiness.sh` then passed all eight gates against the live
  instance: health, launchd identity, source pin, env posture, `PostgreSQL responds (server major 16,
  connection from DATABASE_URL)`, `Database backup tooling is ready (engine=javascript,
  validation=throwaway-database-restore)`, listener ancestry, "Source-checkout readiness passed." No
  password in any output.

The staging instance itself (checkout, database, env, launchd service) was not modified by the pre-publish
rehearsal; the full upgrade/rollback rehearsal runs after publication with the public `v2026.827.3` asset.

### Gate results on the branch (worktree, before PR)

- `node --test scripts/deploy/agentdash-native-backup.test.mjs scripts/deploy/agentdash-mac-mini-source-launchd.test.mjs` — 20/20.
- `pnpm run test:launch-signoff` — 86/86 (now including the native backup regression).
- `node --test scripts/release-control-contract.test.mjs` — 10/10; `pnpm run test:release-registry` — 4/4.
- `pnpm typecheck` — passed; `pnpm build` — passed (existing Vite chunk-size advisory only).
- `pnpm test:run` — exit 0: main server phase 317 files passed / 1 skipped, 2,825 tests passed / 10 skipped;
  non-server projects and all 96 serialized suites passed.
- `pnpm check:tokens` — clean (after replacing two personal absolute paths in this document with `~`-relative
  ones); `pnpm audit:deps` — exit 0 (51 advisories in the repository baseline; 7 high / 1 critical under the
  configured ignores); `pnpm check:architecture` — 0 errors, 8 pre-existing branding warnings;
  `git diff --check` — clean.
- `/bin/bash -n` on all five rendered shells; `node --check` on the rendered runner and every embedded Node
  heredoc.
- PR body validated with `scripts/ci/check-pr-process.mjs`.

### Independent review (adversarial, against `ad32d0ae`)

Verdict **APPROVE-WITH-FIXES, zero blockers**. The reviewer could not refute: no updater path mutates
state without a validated backup; zero-byte/corrupt archives are never accepted; readiness aborts on probe
failure; no credential reaches stdout/stderr/JSON/receipts/argv; the rendered runner has no template
leakage and the asset stays self-contained; version parsing and the compatibility rule reject the
Homebrew-14-vs-18 case; throwaway restore handles zero-row tables, non-public schemas, enums and quoted
identifiers with no leftover database; connection resolution mirrors `packages/db/src/backup.ts`; scope is
release-control only.

Findings, all fixed in the follow-up commit:

1. Row data containing a marker-shaped line (`-- Table: …` / `-- Data for: …`) spoofed archive
   validation into a spurious fail-closed (reproduced by the reviewer). Markers are now honoured only at
   the start of a statement-breakpoint-delimited chunk, and the seeded regression data includes both spoof
   shapes.
2. `pending.json` was written before the backup; it is now written only after the validated archive
   exists (and names it), so a backup failure leaves deployment state untouched.
3. `pnpm --silent` hid the fatal error when `tsx` was missing; the launcher now checks for
   `packages/db/node_modules/.bin/tsx` with a remediation message and no longer silences pnpm.
4. The application restore library prefers a `psql` on PATH and passes the URL as an argument; the runner
   now pins `PAPERCLIP_PSQL_PATH` to a non-existent path so validation always uses the Node restore path
   (`validation.restore: "node"`). A proper `PGPASSWORD` fix in the library is a separate application change.
5. A throwaway database could survive abnormal termination; stale `agentdash_restore_check_%` databases are
   now dropped before creating a new one, and SIGINT/SIGTERM drop the current one best-effort.
6. Plaintext SQL and archives were briefly world-readable; the runner now sets `umask 077` and the wrapper
   sets the backup/state directories to mode 700.
7. Rollback depends on the current checkout being able to run its backup library; documented in the
   RUNBOOK with the supported remediation (no skip flag).
