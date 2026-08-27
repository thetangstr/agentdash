#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_LABEL = "ai.agentdash.agent";
const DEFAULT_PORT = 3100;
/**
 * launchd starts wrappers with a minimal PATH, so every generated shell pins the
 * directories that hold node, pnpm and the macOS system utilities. Nothing on
 * this PATH is assumed to provide PostgreSQL client tools; the backup runner
 * validates whatever it finds and falls back to the repository's own engine.
 */
const DEFAULT_TOOL_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function abs(value) {
  return path.resolve(process.cwd(), expandHome(value));
}

function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function assertGitSha(targetSha) {
  if (typeof targetSha !== "string" || !/^[0-9a-f]{7,40}$/i.test(targetSha.trim())) {
    throw new Error("targetSha is required and must be a pinned 7-40 character git SHA.");
  }
}

function readEnvValue(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*(.*)\\s*$`);
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    return match[1]?.replace(/^['"]|['"]$/g, "") ?? "";
  }
  return null;
}

function setEnvValue(content, key, value) {
  const line = `${key}=${value}`;
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*=`);
  let replaced = false;
  const next = lines.map((existing) => {
    if (pattern.test(existing)) {
      replaced = true;
      return line;
    }
    return existing;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== "") next.push("");
    next.push(line);
  }
  return `${next.join("\n").replace(/\n+$/, "")}\n`;
}

export function buildMacMiniSourceLaunchdPlan(input = {}) {
  const repoDir = abs(input.repoDir ?? "~/workspace/agentdash_msp_launch");
  const targetSha = String(input.targetSha ?? "").trim();
  assertGitSha(targetSha);
  const publicUrl = input.publicUrl ?? input.baseUrl;
  if (!publicUrl) {
    throw new Error("publicUrl is required. Use the Tailscale/private URL operators will open in the browser.");
  }

  const label = input.label ?? DEFAULT_LABEL;
  const launchdDomain = String(input.launchdDomain ?? "gui").trim();
  if (launchdDomain !== "gui" && launchdDomain !== "system") {
    throw new Error("launchdDomain must be \"gui\" (per-user LaunchAgent) or \"system\" (LaunchDaemon).");
  }
  const agentdashHome = abs(input.agentdashHome ?? "~/.agentdash");
  const configDir = abs(input.configDir ?? "~/.config/agentdash");
  const launchAgentDir = abs(input.launchAgentDir ?? path.join(os.homedir(), "Library", "LaunchAgents"));
  const envFile = input.envFile ? abs(input.envFile) : path.join(configDir, "agentdash.env");
  const binDir = path.join(agentdashHome, "bin");
  const logDir = input.logDir ? abs(input.logDir) : path.join(agentdashHome, "logs");
  const backupDir = input.backupDir ? abs(input.backupDir) : path.join(agentdashHome, "backups");
  const stateDir = input.stateDir ? abs(input.stateDir) : path.join(agentdashHome, "deployments");
  const port = String(input.paperclipPort ?? DEFAULT_PORT);

  const paths = {
    repoDir,
    agentdashHome,
    envFile,
    binDir,
    logDir,
    backupDir,
    stateDir,
    // A system LaunchDaemon's plist lives in a root-owned directory. The
    // generator never writes there: for the system domain the plist is rendered
    // under the agentdash home for review and explicit installation with sudo.
    plist: launchdDomain === "system"
      ? path.join(agentdashHome, "launchd", `${label}.plist`)
      : path.join(launchAgentDir, `${label}.plist`),
    supervisorScript: path.join(binDir, "agentdash-source-supervisor.sh"),
    launchdLib: path.join(binDir, "agentdash-launchd-lib.sh"),
    backupScript: path.join(binDir, "agentdash-backup-db.sh"),
    backupRunner: path.join(binDir, "agentdash-backup-db.mjs"),
    lastBackupFile: path.join(stateDir, "last-backup.json"),
    readinessScript: path.join(binDir, "agentdash-readiness.sh"),
    updateScript: path.join(binDir, "agentdash-source-update.sh"),
    rollbackScript: path.join(binDir, "agentdash-source-rollback.sh"),
    runbook: path.join(agentdashHome, "RUNBOOK.md"),
  };

  return {
    version: 1,
    mode: "source-checkout",
    label,
    launchdDomain,
    targetSha,
    remoteName: input.remoteName ?? "origin",
    toolPath: typeof input.toolPath === "string" && input.toolPath.trim() ? input.toolPath.trim() : DEFAULT_TOOL_PATH,
    paths,
    env: {
      NODE_ENV: "production",
      PORT: port,
      SERVE_UI: "true",
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      PAPERCLIP_PUBLIC_URL: publicUrl,
      PAPERCLIP_API_URL: input.paperclipApiUrl ?? `http://127.0.0.1:${port}`,
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
      AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT: "true",
      AGENTDASH_SOURCE_SHA: targetSha,
      PAPERCLIP_HOME: input.paperclipHome ? abs(input.paperclipHome) : abs("~/.paperclip"),
      BETTER_AUTH_SECRET: input.betterAuthSecret ?? randomSecret(32),
      PAPERCLIP_AGENT_JWT_SECRET: input.agentJwtSecret ?? randomSecret(32),
    },
  };
}

export function mergeSourceEnv(existingContent, plan) {
  let content = String(existingContent ?? "");
  for (const [key, value] of Object.entries(plan.env)) {
    if ((key === "BETTER_AUTH_SECRET" || key === "PAPERCLIP_AGENT_JWT_SECRET") && readEnvValue(content, key)) {
      continue;
    }
    content = setEnvValue(content, key, value);
  }
  return content;
}

/**
 * launchd helpers shared by the readiness and update wrappers.
 *
 * A customer may supervise AgentDash with a system LaunchDaemon rather than a
 * per-user LaunchAgent. Every launchctl address therefore goes through
 * LAUNCHD_TARGET. `launchctl kickstart` needs root in the system domain; the
 * service runs KeepAlive, so the supported non-root restart terminates the
 * launchd-tracked process (and the listener it owns) and waits for launchd to
 * respawn it from the updated checkout.
 */
export function renderSourceLaunchdLibScript(plan) {
  return `#!/bin/bash
# AgentDash launchd helpers (generated). Source after setting LABEL, LAUNCHD_DOMAIN and PORT.

if [[ "\${LAUNCHD_DOMAIN:-gui}" == "system" ]]; then
  LAUNCHD_TARGET="system/$LABEL"
else
  LAUNCHD_TARGET="gui/$(id -u)/$LABEL"
fi

service_pid() {
  local state
  state="$(launchctl print "$LAUNCHD_TARGET" 2>/dev/null)" || return 1
  printf '%s\\n' "$state" | awk '$1 == "pid" && $2 == "=" { print $3; exit }'
}

pid_has_ancestor() {
  local pid="$1"
  local ancestor="$2"
  local parent

  while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" ]]; do
    if [[ "$pid" == "$ancestor" ]]; then
      return 0
    fi
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    [[ -n "$parent" && "$parent" != "$pid" ]] || return 1
    pid="$parent"
  done
  return 1
}

# Listener pids on PORT that descend from the given launchd pid. Never returns
# a process the service does not own.
listener_pids_owned_by() {
  local pid
  for pid in $(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u); do
    if pid_has_ancestor "$pid" "$1"; then
      printf '%s\\n' "$pid"
    fi
  done
}

restart_service() {
  local before after attempt victims
  before="$(service_pid || true)"
  if launchctl kickstart -k "$LAUNCHD_TARGET" 2>/dev/null; then
    echo "Restarted $LAUNCHD_TARGET with launchctl kickstart." >&2
  else
    if [[ ! "$before" =~ ^[0-9]+$ ]]; then
      echo "launchctl kickstart was refused and $LAUNCHD_TARGET has no live pid. Run: sudo launchctl kickstart -k $LAUNCHD_TARGET" >&2
      return 1
    fi
    victims="$(listener_pids_owned_by "$before" || true)"
    echo "launchctl kickstart was refused (root is required in the $LAUNCHD_DOMAIN domain); sending SIGTERM to launchd pid $before\${victims:+ and its listener(s) $(printf '%s ' $victims | sed 's/ $//')} so KeepAlive respawns the service from the updated checkout." >&2
    # shellcheck disable=SC2086
    if ! kill -TERM $victims "$before" 2>/dev/null; then
      echo "Could not signal the service processes (owned by another user?). Run: sudo launchctl kickstart -k $LAUNCHD_TARGET" >&2
      return 1
    fi
  fi
  for attempt in $(seq 1 60); do
    after="$(service_pid || true)"
    if [[ "$after" =~ ^[0-9]+$ && "$after" != "$before" ]]; then
      echo "$LAUNCHD_TARGET is running again as pid $after." >&2
      return 0
    fi
    sleep 2
  done
  echo "$LAUNCHD_TARGET did not respawn within 120 seconds; inspect launchctl print $LAUNCHD_TARGET and the service logs." >&2
  return 1
}
`;
}

export function renderSourceSupervisorScript(plan) {
  return `#!/bin/bash
set -euo pipefail

export PATH="${plan.toolPath}"
REPO_DIR="${plan.paths.repoDir}"
ENV_FILE="${plan.paths.envFile}"

mkdir -p "${plan.paths.logDir}" "${plan.paths.backupDir}" "${plan.paths.stateDir}"
set -a
. "$ENV_FILE"
set +a
EXPECTED_SHA="\${AGENTDASH_SOURCE_SHA:-${plan.targetSha}}"

cd "$REPO_DIR"
actual_sha="$(git rev-parse HEAD)"
case "$actual_sha" in
  "$EXPECTED_SHA"*) ;;
  *)
    echo "Refusing to start AgentDash from unexpected SHA $actual_sha; expected $EXPECTED_SHA" >&2
    exit 1
    ;;
esac

exec pnpm --filter @paperclipai/server exec tsx src/index.ts
`;
}

/**
 * The backup wrapper is a thin launcher. The decision logic lives in the
 * rendered Node runner (`agentdash-backup-db.mjs`) because a customer Mac mini
 * running the embedded PostgreSQL distribution has no `pg_dump`, `pg_restore`
 * or `psql` at all — the embedded package ships only `initdb`, `pg_ctl` and
 * `postgres`. The runner therefore:
 *
 * - resolves the database the same way the application and the repository's
 *   backup CLI do (DATABASE_URL, then the instance config, then the embedded
 *   port) and never prints the credential-bearing URL;
 * - reads the running server's major version through the checkout's own
 *   PostgreSQL driver;
 * - uses `pg_dump`/`pg_restore` only when a compatible pair is found (an
 *   explicit `PG_DUMP_BIN`/`PG_RESTORE_BIN` override, or on PATH) and validates
 *   the custom-format dump with `pg_restore --list`;
 * - otherwise uses the repository's own backup engine
 *   (`packages/db/src/backup-lib.ts`, the same code the nightly launchd backup
 *   runs) and validates the archive by restoring it into a throwaway database
 *   on the same server and comparing every table's row count with the counts
 *   recorded in the archive;
 * - records path, mode, size and SHA-256 in a mode-600 receipt and in
 *   `deployments/last-backup.json` for the updater;
 * - answers `--check` read-only so the updater and readiness can prove backup
 *   capability before any pending state, checkout, config or service mutation.
 */
export function renderSourceBackupScript(plan) {
  return `#!/bin/bash
set -euo pipefail

export PATH="${plan.toolPath}"
REPO_DIR="${plan.paths.repoDir}"
ENV_FILE="${plan.paths.envFile}"
BACKUP_DIR="${plan.paths.backupDir}"
STATE_DIR="${plan.paths.stateDir}"
RUNNER="${plan.paths.backupRunner}"
mkdir -p "$BACKUP_DIR" "$STATE_DIR"
chmod 700 "$BACKUP_DIR" "$STATE_DIR"
set -a
. "$ENV_FILE"
set +a
export AGENTDASH_BACKUP_REPO_DIR="$REPO_DIR"
export AGENTDASH_BACKUP_DIR="$BACKUP_DIR"
export AGENTDASH_BACKUP_STATE_DIR="$STATE_DIR"

if [[ ! -f "$RUNNER" ]]; then
  echo "Backup runner is missing: $RUNNER (re-run the release control script with --write)." >&2
  exit 2
fi

# node and pnpm must be on the wrapper PATH before anything runs; a keg-only
# Homebrew node keeps them out of the default PATH on some machines.
for required_tool in node pnpm; do
  if ! command -v "$required_tool" >/dev/null 2>&1; then
    echo "$required_tool is not on the wrapper PATH ($PATH). Re-run the release control script with --tool-path naming the directory that holds node and pnpm (for example a keg-only Homebrew node@24 bin directory), then --write to refresh the wrappers." >&2
    exit 2
  fi
done

# The runner loads the installed checkout's own backup library
# (packages/db/src/backup-lib.ts, exercised by runDatabaseBackup / runDatabaseRestore)
# through the checkout's tsx, exactly as the nightly launchd backup does. When
# the checkout is not a usable workspace the runner still runs under plain node
# so it can report which pg_dump / PG_DUMP_BIN / repository locations it
# searched and fail closed.
if [[ -f "$REPO_DIR/packages/db/package.json" ]]; then
  if [[ ! -x "$REPO_DIR/packages/db/node_modules/.bin/tsx" ]]; then
    echo "The installed checkout cannot run its backup library: $REPO_DIR/packages/db/node_modules/.bin/tsx is missing. Run pnpm install --frozen-lockfile in $REPO_DIR (this also restores the PostgreSQL driver) and retry." >&2
    exit 2
  fi
  cd "$REPO_DIR"
  exec pnpm --filter @paperclipai/db exec tsx "$RUNNER" "$@"
fi
exec node "$RUNNER" "$@"
`;
}

export function renderSourceBackupRunner() {
  return SOURCE_BACKUP_RUNNER;
}

const SOURCE_BACKUP_RUNNER = String.raw`#!/usr/bin/env node
// AgentDash native database backup runner (generated by agentdash-mac-mini-source-launchd.mjs).
//
// Runs as:  agentdash-backup-db.sh --check   (read-only readiness probe, prints JSON)
//           agentdash-backup-db.sh           (create + validate a backup, prints JSON)
//
// Environment (set by the generated wrapper): AGENTDASH_BACKUP_REPO_DIR,
// AGENTDASH_BACKUP_DIR, AGENTDASH_BACKUP_STATE_DIR. Optional operator inputs:
// DATABASE_URL, PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID, PAPERCLIP_EMBEDDED_POSTGRES_PORT,
// POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, PG_DUMP_BIN, PG_RESTORE_BIN,
// AGENTDASH_BACKUP_ENGINE (auto | pg_dump | javascript).
//
// This runner never prints the database URL or password.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const MIN_ARCHIVE_BYTES = 1024;
const ENGINES = ["auto", "pg_dump", "javascript"];
const env = process.env;
const action = process.argv.includes("--check") ? "check" : "run";
// Everything this process creates — including the plaintext SQL the repository
// engine writes before compressing — must be private from birth.
process.umask(0o077);

function required(name) {
  const value = env[name];
  if (!value) {
    log(name + " is required; it is set by the generated agentdash-backup-db.sh wrapper.");
    process.exit(2);
  }
  return value;
}

function log(line) {
  process.stderr.write("[agentdash-backup-db] " + line + "\n");
}

function emit(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function scrub(message) {
  // Restore failures quote the failing statement; never echo row data.
  return String(message).replace(/\s*\[statement:[\s\S]*$/, "").split(/\r?\n/)[0].slice(0, 500);
}

function failClosed(code, record) {
  emit(Object.assign({ ok: false, action: action }, record));
  log("FAIL: " + record.error);
  for (const item of record.searched || []) log("  searched: " + item);
  for (const item of record.remediation || []) log("  remediation: " + item);
  process.exit(code);
}

const repoDir = required("AGENTDASH_BACKUP_REPO_DIR");
const backupDir = required("AGENTDASH_BACKUP_DIR");
const stateDir = required("AGENTDASH_BACKUP_STATE_DIR");
const dbPackageJson = path.join(repoDir, "packages", "db", "package.json");
const backupLibPath = path.join(repoDir, "packages", "db", "src", "backup-lib.ts");

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function resolveConnection() {
  const fromEnv = (env.DATABASE_URL || "").trim();
  if (fromEnv) return { url: fromEnv, source: "DATABASE_URL" };
  const home = env.PAPERCLIP_HOME ? path.resolve(expandHome(env.PAPERCLIP_HOME.trim())) : path.join(os.homedir(), ".paperclip");
  const instance = (env.PAPERCLIP_INSTANCE_ID || "default").trim();
  const configPath = path.join(home, "instances", instance, "config.json");
  const config = readJson(configPath);
  const database = config && config.database ? config.database : {};
  if (database.mode === "postgres" && typeof database.connectionString === "string" && database.connectionString.trim()) {
    return { url: database.connectionString.trim(), source: "config.database.connectionString (" + configPath + ")" };
  }
  const port = Number.parseInt(env.PAPERCLIP_EMBEDDED_POSTGRES_PORT || "", 10) || Number(database.embeddedPostgresPort) || 54329;
  const user = env.POSTGRES_USER || "paperclip";
  const password = env.POSTGRES_PASSWORD || "paperclip";
  const name = env.POSTGRES_DB || "paperclip";
  return {
    url: "postgres://" + encodeURIComponent(user) + ":" + encodeURIComponent(password) + "@127.0.0.1:" + port + "/" + encodeURIComponent(name),
    source: "embedded-postgres:" + port,
  };
}

function describeConnection(connection) {
  const url = new URL(connection.url);
  return {
    source: connection.source,
    host: url.hostname,
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
}

function libpqEnvironment(connectionUrl) {
  const url = new URL(connectionUrl);
  const pgEnv = Object.assign({}, env, {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
  });
  if (url.username) pgEnv.PGUSER = decodeURIComponent(url.username);
  if (url.password) pgEnv.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) pgEnv.PGSSLMODE = sslmode;
  const sslrootcert = url.searchParams.get("sslrootcert");
  if (sslrootcert) pgEnv.PGSSLROOTCERT = sslrootcert;
  return pgEnv;
}

async function loadDriver() {
  try {
    const resolved = createRequire(dbPackageJson).resolve("postgres");
    const mod = await import(pathToFileURL(resolved).href);
    return { postgres: mod.default || mod, path: resolved };
  } catch (error) {
    return { postgres: null, path: path.join(repoDir, "packages", "db", "node_modules", "postgres"), error: scrub(error && error.message ? error.message : error) };
  }
}

async function loadRepositoryEngine() {
  const base = { module: backupLibPath, restoreValidation: "throwaway-database-restore" };
  if (!fs.existsSync(backupLibPath)) {
    return Object.assign({ available: false, reason: "not present in the installed checkout" }, base);
  }
  try {
    const mod = await import(pathToFileURL(backupLibPath).href);
    if (typeof mod.runDatabaseBackup !== "function" || typeof mod.runDatabaseRestore !== "function") {
      return Object.assign({ available: false, reason: "runDatabaseBackup/runDatabaseRestore are not exported" }, base);
    }
    return Object.assign({ available: true, lib: mod }, base);
  } catch (error) {
    return Object.assign({ available: false, reason: "import failed: " + scrub(error && error.message ? error.message : error) }, base);
  }
}

async function probeServer(postgres, connectionUrl) {
  const sql = postgres(connectionUrl, { max: 1, connect_timeout: 10 });
  try {
    const rows = await sql.unsafe("SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS version");
    const versionNum = Number(rows[0].num);
    return { major: Math.floor(versionNum / 10000), versionNum: versionNum, version: String(rows[0].version) };
  } finally {
    await sql.end();
  }
}

// Read-only preflight for the v2026.827 payload: migration 0122 adds a unique
// index on onboarding_sessions(company_id, created_by_user_id) and would fail
// at startup if duplicates exist. Returns null when the table is absent or the
// index already exists, otherwise the duplicate group count.
async function countOnboardingSessionDuplicates(postgres, connectionUrl) {
  const sql = postgres(connectionUrl, { max: 1, connect_timeout: 10 });
  try {
    const table = await sql.unsafe("SELECT to_regclass('public.onboarding_sessions') AS rel");
    if (!table[0] || !table[0].rel) return null;
    const index = await sql.unsafe("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'onboarding_sessions_company_user_unique'");
    if (index[0].n > 0) return null;
    const rows = await sql.unsafe("SELECT count(*)::int AS n FROM (SELECT company_id, created_by_user_id FROM public.onboarding_sessions GROUP BY company_id, created_by_user_id HAVING count(*) > 1) AS dup");
    return rows[0].n;
  } finally {
    await sql.end();
  }
}

async function countRunningHeartbeatRuns(postgres, connectionUrl) {
  const sql = postgres(connectionUrl, { max: 1, connect_timeout: 10 });
  try {
    const exists = await sql.unsafe("SELECT to_regclass('public.heartbeat_runs') AS rel");
    if (!exists[0] || !exists[0].rel) return null;
    const rows = await sql.unsafe("SELECT count(*)::int AS n FROM public.heartbeat_runs WHERE status = 'running'");
    return rows[0].n;
  } finally {
    await sql.end();
  }
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function whichOnPath(name) {
  const result = spawnSync("/bin/sh", ["-c", "command -v " + name], { encoding: "utf8", env: env });
  const out = String(result.stdout || "").trim();
  return result.status === 0 && out ? out : null;
}

function toolVersion(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", env: env });
  if (result.status !== 0) return null;
  const match = String(result.stdout || "").match(/\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return { version: match[2] ? match[1] + "." + match[2] : match[1], major: Number(match[1]) };
}

function resolvePgTools(serverMajor) {
  const searched = [];
  let dumpPath = null;
  if (env.PG_DUMP_BIN) {
    searched.push("PG_DUMP_BIN=" + env.PG_DUMP_BIN);
    if (isExecutableFile(env.PG_DUMP_BIN)) {
      dumpPath = env.PG_DUMP_BIN;
    } else {
      return {
        pgDump: { path: env.PG_DUMP_BIN, version: null, major: null, compatible: false, reason: "PG_DUMP_BIN is set but is not an executable file" },
        pgRestore: null,
        searched: searched,
      };
    }
  } else {
    searched.push("PG_DUMP_BIN (unset)");
    searched.push("PATH=" + (env.PATH || ""));
    dumpPath = whichOnPath("pg_dump");
  }
  if (!dumpPath) return { pgDump: null, pgRestore: null, searched: searched };

  const dumpVersion = toolVersion(dumpPath);
  const pgDump = { path: dumpPath, version: dumpVersion ? dumpVersion.version : null, major: dumpVersion ? dumpVersion.major : null, compatible: false, reason: null };
  if (!dumpVersion) {
    pgDump.reason = "could not determine the pg_dump version";
    return { pgDump: pgDump, pgRestore: null, searched: searched };
  }
  if (serverMajor == null) {
    pgDump.reason = "server major version is unknown, so pg_dump compatibility cannot be validated";
    return { pgDump: pgDump, pgRestore: null, searched: searched };
  }
  if (dumpVersion.major < serverMajor) {
    pgDump.reason = "pg_dump " + dumpVersion.version + " cannot dump a PostgreSQL " + serverMajor + " server; a client at least as new as the server is required";
    return { pgDump: pgDump, pgRestore: null, searched: searched };
  }

  let restorePath = null;
  if (env.PG_RESTORE_BIN) {
    searched.push("PG_RESTORE_BIN=" + env.PG_RESTORE_BIN);
    if (isExecutableFile(env.PG_RESTORE_BIN)) restorePath = env.PG_RESTORE_BIN;
  } else {
    const sibling = path.join(path.dirname(dumpPath), "pg_restore");
    searched.push("pg_restore beside pg_dump: " + sibling);
    restorePath = isExecutableFile(sibling) ? sibling : whichOnPath("pg_restore");
  }
  if (!restorePath) {
    pgDump.reason = "pg_restore is required to validate a custom-format dump but was not found (set PG_RESTORE_BIN)";
    return { pgDump: pgDump, pgRestore: null, searched: searched };
  }
  const restoreVersion = toolVersion(restorePath);
  const pgRestore = { path: restorePath, version: restoreVersion ? restoreVersion.version : null, major: restoreVersion ? restoreVersion.major : null };
  if (!restoreVersion || restoreVersion.major !== dumpVersion.major) {
    pgDump.reason = "pg_restore major version must match pg_dump " + dumpVersion.version;
    return { pgDump: pgDump, pgRestore: pgRestore, searched: searched };
  }
  pgDump.compatible = true;
  return { pgDump: pgDump, pgRestore: pgRestore, searched: searched };
}

function selectEngine(requested, tools, repositoryEngine) {
  const pgDumpUsable = Boolean(tools.pgDump && tools.pgDump.compatible);
  if (requested === "pg_dump") return pgDumpUsable ? "pg_dump" : null;
  if (requested === "javascript") return repositoryEngine.available ? "javascript" : null;
  if (pgDumpUsable) return "pg_dump";
  if (repositoryEngine.available) return "javascript";
  return null;
}

function directoryWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function assessReadiness() {
  const requested = (env.AGENTDASH_BACKUP_ENGINE || "auto").trim();
  if (!ENGINES.includes(requested)) {
    failClosed(2, { error: "AGENTDASH_BACKUP_ENGINE must be one of " + ENGINES.join(", ") + "; got " + requested, remediation: ["Unset AGENTDASH_BACKUP_ENGINE or set it to auto, pg_dump, or javascript."] });
  }
  const connection = resolveConnection();
  const connectionInfo = describeConnection(connection);
  const driver = await loadDriver();
  const repositoryEngine = await loadRepositoryEngine();
  let server = null;
  let serverError = null;
  if (driver.postgres) {
    try {
      server = await probeServer(driver.postgres, connection.url);
    } catch (error) {
      serverError = scrub(error && error.message ? error.message : error);
    }
  }
  const tools = resolvePgTools(server ? server.major : null);
  const searched = tools.searched.concat(["repository engine: " + backupLibPath, "PostgreSQL driver: " + driver.path]);
  // The updater needs these on the wrapper PATH after the backup; prove them now.
  const requiredTools = {};
  for (const name of ["node", "pnpm", "git", "curl", "lsof"]) requiredTools[name] = whichOnPath(name);
  const missingTools = Object.keys(requiredTools).filter((name) => !requiredTools[name]);
  const runningRuns = driver.postgres && server ? await countRunningHeartbeatRuns(driver.postgres, connection.url) : null;
  let onboardingDuplicates = null;
  if (driver.postgres && server) {
    try {
      onboardingDuplicates = await countOnboardingSessionDuplicates(driver.postgres, connection.url);
    } catch (error) {
      log("warning: migration preflight could not run: " + scrub(error && error.message ? error.message : error));
    }
  }
  const writable = directoryWritable(backupDir);
  const engine = server ? selectEngine(requested, tools, repositoryEngine) : null;
  const remediation = [];
  let error = null;
  if (!driver.postgres) {
    error = "The installed checkout does not provide the PostgreSQL driver needed to probe the database (" + driver.error + ").";
    remediation.push("Install the checkout's dependencies: pnpm install --frozen-lockfile in " + repoDir + " (packages/db must resolve the postgres driver).");
  } else if (!server) {
    error = "PostgreSQL is not reachable through " + connectionInfo.source + " at " + connectionInfo.host + ":" + connectionInfo.port + "/" + connectionInfo.database + " (" + serverError + ").";
    remediation.push("Confirm the AgentDash service (and its embedded PostgreSQL) is running and that DATABASE_URL / PAPERCLIP_HOME / PAPERCLIP_INSTANCE_ID in the runtime env describe the installed instance.");
  } else if (!engine) {
    error = "No supported backup engine is available for PostgreSQL " + server.major + " (requested engine: " + requested + ").";
    if (tools.pgDump && tools.pgDump.reason) remediation.push("pg_dump at " + tools.pgDump.path + " was rejected: " + tools.pgDump.reason + ".");
    remediation.push("Set PG_DUMP_BIN and PG_RESTORE_BIN to reviewed PostgreSQL client tools whose major version is at least " + server.major + ".");
    remediation.push("Or make the repository engine available: the installed checkout must contain packages/db/src/backup-lib.ts with dependencies installed (pnpm install --frozen-lockfile in " + repoDir + ")" + (repositoryEngine.reason ? " — currently: " + repositoryEngine.reason : "") + ".");
    remediation.push("Or set AGENTDASH_BACKUP_ENGINE=pg_dump or =javascript to require a specific engine.");
  } else if (!writable) {
    error = "Backup directory is not writable: " + backupDir;
    remediation.push("Fix permissions on " + backupDir + " so the launchd user can write mode-600 archives.");
  } else if (missingTools.length > 0) {
    error = "Required tools are not on the wrapper PATH: " + missingTools.join(", ") + " (PATH=" + (env.PATH || "") + ").";
    remediation.push("Re-run the release control script with --tool-path naming the directories that hold " + missingTools.join(", ") + " (for example a keg-only Homebrew node@24 bin directory), then --write to refresh the wrappers.");
  } else if (onboardingDuplicates != null && onboardingDuplicates > 0) {
    error = "Migration preflight: " + onboardingDuplicates + " duplicate (company_id, created_by_user_id) group(s) in onboarding_sessions would make migration 0122's unique index fail at startup.";
    remediation.push("Resolve the duplicate onboarding_sessions rows with explicit operator approval before upgrading (keep the most recent row per company/user), then re-run --check.");
  }
  return {
    ok: error === null,
    action: action,
    engine: engine,
    engineRequested: requested,
    server: server,
    connection: connectionInfo,
    pgDump: tools.pgDump,
    pgRestore: tools.pgRestore,
    tools: requiredTools,
    toolPath: env.PATH || "",
    searched: searched,
    repositoryEngine: { available: repositoryEngine.available, module: repositoryEngine.module, reason: repositoryEngine.reason || null, restoreValidation: repositoryEngine.restoreValidation },
    runningHeartbeatRuns: runningRuns,
    runningHeartbeatRunsPolicy: "a backup run with the javascript engine refuses while this is greater than zero; --check only reports it",
    migrationPreflight: { onboardingSessionsDuplicateGroups: onboardingDuplicates },
    backupDir: backupDir,
    backupDirWritable: writable,
    remediation: remediation,
    error: error,
    _connection: connection,
    _driver: driver,
    _repositoryEngine: repositoryEngine,
  };
}

function publicView(readiness) {
  const view = {};
  for (const key of Object.keys(readiness)) {
    if (!key.startsWith("_")) view[key] = readiness[key];
  }
  return view;
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function removeIfExists(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // keep the original failure
  }
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function requireArchiveSize(file) {
  const size = fs.statSync(file).size;
  if (size < MIN_ARCHIVE_BYTES) {
    removeIfExists(file);
    failClosed(1, { error: "Backup archive is only " + size + " bytes; treating it as a failed backup.", remediation: ["Inspect the database and retry; an archive this small cannot contain the AgentDash schema."] });
  }
  return size;
}

function runPgDumpEngine(readiness, stamp) {
  const out = path.join(backupDir, "predeploy-" + stamp + ".dump");
  const pgEnv = libpqEnvironment(readiness._connection.url);
  const dump = spawnSync(readiness.pgDump.path, ["--format=custom", "--no-owner", "--no-privileges", "--file=" + out], { encoding: "utf8", env: pgEnv });
  if (dump.status !== 0) {
    removeIfExists(out);
    failClosed(1, { error: "pg_dump failed (exit " + dump.status + "): " + scrub(dump.stderr || dump.stdout || "no output"), remediation: ["Fix the reported pg_dump error or set AGENTDASH_BACKUP_ENGINE=javascript to use the repository engine."] });
  }
  fs.chmodSync(out, 0o600);
  const sizeBytes = requireArchiveSize(out);
  const list = spawnSync(readiness.pgRestore.path, ["--list", out], { encoding: "utf8", env: pgEnv });
  const entries = String(list.stdout || "").split(/\r?\n/).filter((line) => /^\d+;\s+\d+\s+\d+\s+/.test(line));
  if (list.status !== 0 || entries.length === 0) {
    removeIfExists(out);
    failClosed(1, { error: "pg_restore --list could not read the custom-format dump (exit " + list.status + "): " + scrub(list.stderr || "no table-of-contents entries"), remediation: ["The dump is not restorable; do not proceed with an upgrade until a validated backup exists."] });
  }
  return { backupPath: out, sizeBytes: sizeBytes, validation: { method: "pg_restore --list", entries: entries.length } };
}

// The repository engine separates every statement with this exact line, and
// its "-- Table:" / "-- Data for:" markers are always the first non-blank line
// after a breakpoint. Row data lives inside INSERT statements, so a value that
// happens to contain a marker-shaped line can never be at a chunk start.
const STATEMENT_BREAKPOINT = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";

async function readArchiveExpectations(file) {
  const expectedTables = new Set();
  const expectedRows = new Map();
  const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let atChunkStart = true;
  let sawBreakpoint = false;
  try {
    for await (const line of reader) {
      if (line === STATEMENT_BREAKPOINT) {
        atChunkStart = true;
        sawBreakpoint = true;
        continue;
      }
      if (line.trim().length === 0) continue;
      const chunkStart = atChunkStart;
      atChunkStart = false;
      if (!chunkStart) continue;
      let match = line.match(/^-- Table: (\S+)\.(\S+)$/);
      if (match) {
        expectedTables.add(match[1] + "." + match[2]);
        continue;
      }
      match = line.match(/^-- Data for: (\S+)\.(\S+) \((\d+) rows\)$/);
      if (match) expectedRows.set(match[1] + "." + match[2], Number(match[3]));
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  if (!sawBreakpoint) {
    throw new Error("the archive has no statement breakpoints; it was not written by the repository engine");
  }
  return { expectedTables: expectedTables, expectedRows: expectedRows };
}

function quoteIdentifier(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}

async function validateByThrowawayRestore(readiness, file, stamp) {
  const postgres = readiness._driver.postgres;
  const lib = readiness._repositoryEngine.lib;
  const expectations = await readArchiveExpectations(file);
  if (expectations.expectedTables.size === 0) {
    throw new Error("the archive lists no tables");
  }
  const name = "agentdash_restore_check_" + stamp.toLowerCase();
  const targetUrl = new URL(readiness._connection.url);
  targetUrl.pathname = "/" + name;
  // CREATE/DROP DATABASE are issued over the application database connection
  // so no separate maintenance database has to be reachable.
  const admin = postgres(readiness._connection.url, { max: 1, connect_timeout: 10 });
  let created = false;
  const dropThrowaway = async (databaseName) => {
    await admin.unsafe("DROP DATABASE IF EXISTS " + quoteIdentifier(databaseName) + " WITH (FORCE)");
  };
  const dropOnSignal = () => {
    if (!created) return;
    dropThrowaway(name).catch(() => {}).finally(() => process.exit(130));
  };
  try {
    // A throwaway database left by an interrupted earlier run holds a full copy
    // of the data; reclaim every one before creating another.
    const stale = await admin.unsafe("SELECT datname FROM pg_database WHERE datname LIKE 'agentdash_restore_check_%'");
    for (const row of stale) {
      log("dropping stale throwaway database " + row.datname);
      await dropThrowaway(row.datname);
    }
    await admin.unsafe("CREATE DATABASE " + quoteIdentifier(name));
    created = true;
    process.once("SIGINT", dropOnSignal);
    process.once("SIGTERM", dropOnSignal);
    // Force the repository restore path: the application library prefers a
    // psql on PATH and would hand it the credential-bearing URL as an argument.
    // The Node path is the only one a tool-less host has, so use it everywhere.
    process.env.PAPERCLIP_PSQL_PATH = path.join(stateDir, "no-psql-for-restore-validation");
    await lib.runDatabaseRestore({ connectionString: targetUrl.toString(), backupFile: file, connectTimeoutSeconds: 10 });
    const check = postgres(targetUrl.toString(), { max: 1, connect_timeout: 10 });
    const mismatches = [];
    let rows = 0;
    let tables = 0;
    try {
      for (const key of expectations.expectedTables) {
        const dot = key.indexOf(".");
        const schema = key.slice(0, dot);
        const table = key.slice(dot + 1);
        const expected = expectations.expectedRows.get(key) || 0;
        let actual = null;
        try {
          const counted = await check.unsafe("SELECT count(*)::text AS n FROM " + quoteIdentifier(schema) + "." + quoteIdentifier(table));
          actual = Number(counted[0].n);
        } catch (error) {
          mismatches.push(key + ": missing after restore (" + scrub(error && error.message ? error.message : error) + ")");
          continue;
        }
        tables += 1;
        rows += actual;
        if (actual !== expected) mismatches.push(key + ": expected " + expected + " rows, restored " + actual);
      }
    } finally {
      await check.end();
    }
    if (mismatches.length > 0) {
      throw new Error("restore validation mismatch: " + mismatches.slice(0, 5).join("; "));
    }
    return { method: "throwaway-database-restore", restore: "node", database: name, tables: tables, rows: rows };
  } finally {
    process.removeListener("SIGINT", dropOnSignal);
    process.removeListener("SIGTERM", dropOnSignal);
    if (created) {
      try {
        await dropThrowaway(name);
      } catch (error) {
        log("warning: could not drop throwaway database " + name + ": " + scrub(error && error.message ? error.message : error));
      }
    }
    await admin.end();
  }
}

async function runRepositoryEngine(readiness, stamp) {
  if (readiness.runningHeartbeatRuns != null && readiness.runningHeartbeatRuns > 0) {
    failClosed(1, {
      error: readiness.runningHeartbeatRuns + " heartbeat run(s) are running. The repository backup engine reads tables one at a time and needs a quiescent database.",
      remediation: ["Pause the agents (or wait for their runs to finish), confirm zero running heartbeat runs, then retry."],
    });
  }
  const lib = readiness._repositoryEngine.lib;
  let result;
  try {
    result = await lib.runDatabaseBackup({
      connectionString: readiness._connection.url,
      backupDir: backupDir,
      filenamePrefix: "predeploy",
      backupEngine: "javascript",
      connectTimeoutSeconds: 10,
      retention: { dailyDays: 36500, weeklyWeeks: 5200, monthlyMonths: 1200 },
    });
  } catch (error) {
    failClosed(1, { error: "Repository backup engine failed: " + scrub(error && error.message ? error.message : error), remediation: ["Inspect the database and retry; do not proceed with an upgrade until a validated backup exists."] });
  }
  const out = path.join(backupDir, "predeploy-" + stamp + ".sql.gz");
  fs.renameSync(result.backupFile, out);
  fs.chmodSync(out, 0o600);
  const sizeBytes = requireArchiveSize(out);
  let validation;
  try {
    validation = await validateByThrowawayRestore(readiness, out, stamp);
  } catch (error) {
    removeIfExists(out);
    failClosed(1, { error: "Backup restore validation failed: " + scrub(error && error.message ? error.message : error), remediation: ["The archive is not proven restorable; do not proceed with an upgrade until a validated backup exists."] });
  }
  return { backupPath: out, sizeBytes: sizeBytes, validation: validation };
}

async function main() {
  const readiness = await assessReadiness();
  if (action === "check" || !readiness.ok) {
    if (!readiness.ok) failClosed(2, publicView(readiness));
    emit(publicView(readiness));
    return;
  }

  const stamp = utcStamp();
  const produced = readiness.engine === "pg_dump" ? runPgDumpEngine(readiness, stamp) : await runRepositoryEngine(readiness, stamp);
  const sha256 = sha256File(produced.backupPath);
  const receiptPath = produced.backupPath + ".receipt.json";
  const receipt = {
    version: 1,
    createdAt: new Date().toISOString(),
    engine: readiness.engine,
    backupPath: produced.backupPath,
    sizeBytes: produced.sizeBytes,
    sha256: sha256,
    mode: "600",
    server: readiness.server,
    connection: readiness.connection,
    pgDump: readiness.engine === "pg_dump" ? { path: readiness.pgDump.path, version: readiness.pgDump.version, major: readiness.pgDump.major } : null,
    pgRestore: readiness.engine === "pg_dump" ? readiness.pgRestore : null,
    repositoryEngine: readiness.engine === "javascript" ? { module: readiness.repositoryEngine.module } : null,
    validation: produced.validation,
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(receiptPath, 0o600);
  fs.mkdirSync(stateDir, { recursive: true });
  const lastBackupPath = path.join(stateDir, "last-backup.json");
  fs.writeFileSync(lastBackupPath, JSON.stringify({
    backupPath: receipt.backupPath,
    sha256: receipt.sha256,
    sizeBytes: receipt.sizeBytes,
    engine: receipt.engine,
    receiptPath: receiptPath,
    createdAt: receipt.createdAt,
  }, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(lastBackupPath, 0o600);
  log("backup " + receipt.backupPath + " (" + receipt.sizeBytes + " bytes, sha256 " + receipt.sha256 + ", engine " + receipt.engine + ", validated by " + receipt.validation.method + ")");
  emit(Object.assign({ ok: true, action: action, receiptPath: receiptPath }, receipt));
}

main().catch((error) => {
  failClosed(1, { error: scrub(error && error.message ? error.message : error) });
});
`;

export function renderSourceReadinessScript(plan) {
  const baseUrl = plan.env.PAPERCLIP_PUBLIC_URL.replace(/\/+$/, "");
  return `#!/bin/bash
set -euo pipefail

export PATH="${plan.toolPath}"
REPO_DIR="${plan.paths.repoDir}"
ENV_FILE="${plan.paths.envFile}"
BASE_URL="${baseUrl}"
LABEL="${plan.label}"
LAUNCHD_DOMAIN="${plan.launchdDomain}"
PORT="${plan.env.PORT}"
. "${plan.paths.launchdLib}"

set -a
. "$ENV_FILE"
set +a
EXPECTED_SHA="\${AGENTDASH_SOURCE_SHA:-${plan.targetSha}}"

file_mode() {
  if stat -f %Lp "$1" >/dev/null 2>&1; then
    stat -f %Lp "$1"
  else
    stat -c %a "$1"
  fi
}

for attempt in $(seq 1 30); do
  if health_json="$(curl -fsS "$BASE_URL/api/health")"; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    echo "AgentDash health did not become ready at $BASE_URL/api/health after $attempt attempts." >&2
    exit 1
  fi
  sleep 2
done

node - "$health_json" <<'NODE'
const payload = JSON.parse(process.argv[2]);
if (payload.status !== "ok") throw new Error("Unexpected health status: " + payload.status);
if (payload.deploymentMode !== "authenticated") {
  throw new Error("Unexpected deployment mode: " + payload.deploymentMode);
}
if (payload.bootstrapStatus !== "ready") {
  throw new Error("Unexpected bootstrap status: " + payload.bootstrapStatus);
}
NODE
echo "[PASS] Authenticated application health is ready at $BASE_URL/api/health"

if ! launchd_state="$(launchctl print "$LAUNCHD_TARGET" 2>/dev/null)"; then
  echo "launchd service is not loaded: $LAUNCHD_TARGET" >&2
  exit 1
fi
launchd_pid="$(printf '%s\n' "$launchd_state" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
if [[ ! "$launchd_pid" =~ ^[0-9]+$ ]]; then
  echo "launchd service has no live PID: $LAUNCHD_TARGET" >&2
  exit 1
fi
echo "[PASS] launchd service is loaded: $LAUNCHD_TARGET"

actual_sha="$(git -C "$REPO_DIR" rev-parse HEAD)"
case "$actual_sha" in
  "$EXPECTED_SHA"*) ;;
  *)
    echo "Unexpected source SHA $actual_sha; expected $EXPECTED_SHA" >&2
    exit 1
    ;;
esac
echo "[PASS] Source SHA matches the configured deployment pin"

if [[ "$(file_mode "$ENV_FILE")" != "600" ]]; then
  echo "Runtime env file must have mode 600: $ENV_FILE" >&2
  exit 1
fi
[[ "\${PAPERCLIP_DEPLOYMENT_MODE:-}" == "authenticated" ]] || {
  echo "PAPERCLIP_DEPLOYMENT_MODE must be authenticated" >&2
  exit 1
}
[[ "\${PAPERCLIP_DEPLOYMENT_EXPOSURE:-}" == "private" ]] || {
  echo "PAPERCLIP_DEPLOYMENT_EXPOSURE must be private" >&2
  exit 1
}
for required_secret in BETTER_AUTH_SECRET PAPERCLIP_AGENT_JWT_SECRET; do
  if [[ -z "\${!required_secret:-}" ]]; then
    echo "$required_secret is required" >&2
    exit 1
  fi
done
echo "[PASS] Runtime env mode and private authenticated posture are valid"

# Database connectivity and backup capability are proven by the same read-only
# probe the updater runs before it mutates anything. It uses the checkout's own
# PostgreSQL driver, needs no PostgreSQL client binary, and never prints the URL.
backup_probe="$("${plan.paths.backupScript}" --check)"
node - "$backup_probe" <<'NODE'
const lines = String(process.argv[2]).trim().split(/\\r?\\n/).filter((line) => line.trim().length > 0);
let probe = null;
for (let index = lines.length - 1; index >= 0 && !probe; index -= 1) {
  try { probe = JSON.parse(lines[index]); } catch { probe = null; }
}
if (!probe || probe.ok !== true) throw new Error("Database backup readiness probe did not pass");
console.log("[PASS] PostgreSQL responds (server major " + probe.server.major + ", connection from " + probe.connection.source + ")");
console.log("[PASS] Database backup tooling is ready (engine=" + probe.engine + ", validation=" + (probe.engine === "pg_dump" ? "pg_restore --list" : probe.repositoryEngine.restoreValidation) + ")");
NODE

if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required to prove launchd owns configured PORT=$PORT" >&2
  exit 1
fi
listener_pids="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
if [[ -z "$listener_pids" ]]; then
  echo "No process is listening on configured PORT=$PORT" >&2
  exit 1
fi
listener_owned=false
while IFS= read -r listener_pid; do
  if [[ -n "$listener_pid" ]] && pid_has_ancestor "$listener_pid" "$launchd_pid"; then
    listener_owned=true
    break
  fi
done <<< "$listener_pids"
if [[ "$listener_owned" != "true" ]]; then
  echo "Configured PORT=$PORT is not owned by launchd service $LAUNCHD_TARGET" >&2
  exit 1
fi
echo "[PASS] listener process belongs to launchd service"

if [[ "\${AGENTDASH_READINESS_RUN_HARNESS_SMOKE:-}" == "true" ]]; then
  if [[ -z "\${AGENTDASH_READINESS_COMPANY_ID:-}" ]]; then
    echo "AGENTDASH_READINESS_COMPANY_ID is required when running harness smoke." >&2
    exit 1
  fi
  if [[ ! -x "$REPO_DIR/scripts/agent-harness-smoke.sh" ]]; then
    echo "Agent harness smoke script is unavailable in the pinned source checkout." >&2
    exit 1
  fi
  harness_args=(
    "$REPO_DIR/scripts/agent-harness-smoke.sh"
    --base-url "$BASE_URL"
    --company-id "$AGENTDASH_READINESS_COMPANY_ID"
  )
  if [[ -n "\${AGENTDASH_READINESS_AUTH_HEADER:-}" ]]; then
    case "$AGENTDASH_READINESS_AUTH_HEADER" in
      Bearer\\ *) harness_args+=(--bearer-token "\${AGENTDASH_READINESS_AUTH_HEADER#Bearer }") ;;
      *)
        echo "AGENTDASH_READINESS_AUTH_HEADER must use the Bearer scheme for harness smoke." >&2
        exit 2
        ;;
    esac
  fi
  "\${harness_args[@]}"
fi

echo "Source-checkout readiness passed."
`;
}

export function renderSourceUpdateScript(plan) {
  return `#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <commit-sha>" >&2
  exit 2
fi

export PATH="${plan.toolPath}"
REPO_DIR="${plan.paths.repoDir}"
ENV_FILE="${plan.paths.envFile}"
STATE_DIR="${plan.paths.stateDir}"
LABEL="${plan.label}"
LAUNCHD_DOMAIN="${plan.launchdDomain}"
PORT="${plan.env.PORT}"
TARGET_SHA="$1"
. "${plan.paths.launchdLib}"
mkdir -p "$STATE_DIR/receipts"

case "$TARGET_SHA" in
  [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*) ;;
  *)
    echo "Target must be a pinned git SHA." >&2
    exit 2
    ;;
esac

cd "$REPO_DIR"
previous_sha="$(git rev-parse HEAD)"
pending_previous_sha="\${AGENTDASH_PENDING_PREVIOUS_SHA:-$previous_sha}"

# Prove backup capability (database reachable, compatible engine, writable
# archive directory, required tools on PATH) before any state, checkout,
# config or service mutation. A failed probe stops here with the searched
# locations and remediation.
"${plan.paths.backupScript}" --check 1>&2

# Create and validate the pre-update backup. The runner records the verified
# archive in last-backup.json (mode 600); nothing below runs without it, and
# nothing has been written to deployment state yet.
"${plan.paths.backupScript}" 1>&2
LAST_BACKUP_FILE="${plan.paths.lastBackupFile}"
read_backup_field() {
  node -e 'const s = require(process.argv[1]); const v = s[process.argv[2]]; if (typeof v !== "string" || !v) process.exit(2); console.log(v)' "$LAST_BACKUP_FILE" "$1"
}
backup_path="$(read_backup_field backupPath)"
backup_sha256="$(read_backup_field sha256)"
backup_engine="$(read_backup_field engine)"
backup_receipt="$(read_backup_field receiptPath)"
if [[ ! -s "$backup_path" ]]; then
  echo "Verified backup is missing at $backup_path; refusing to continue." >&2
  exit 1
fi

# Only now — with a validated backup on disk — record the rollback target, so a
# failure anywhere below leaves a deterministic previous SHA for the rollback
# wrapper. This is the first write to deployment state.
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$STATE_DIR/pending.json" <<JSON
{
  "version": 1,
  "mode": "source-checkout",
  "previousSha": "$pending_previous_sha",
  "targetSha": "$TARGET_SHA",
  "startedAt": "$started_at",
  "backupPath": "$backup_path",
  "backupSha256": "$backup_sha256"
}
JSON
chmod 600 "$STATE_DIR/pending.json"
git fetch --all --tags --prune
git checkout --detach "$TARGET_SHA"
pnpm install --frozen-lockfile
pnpm run build
node - "$ENV_FILE" "$TARGET_SHA" <<'NODE'
const fs = require("node:fs");
const [file, sha] = process.argv.slice(2);
let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const line = "AGENTDASH_SOURCE_SHA=" + sha;
const pattern = /^\\s*AGENTDASH_SOURCE_SHA\\s*=.*$/m;
content = pattern.test(content)
  ? content.replace(pattern, line)
  : content.replace(/\\n*$/, "") + "\\n" + line + "\\n";
fs.writeFileSync(file, content, { mode: 0o600 });
fs.chmodSync(file, 0o600);
NODE
# Restart the service in its own launchd domain. In the system domain
# launchctl kickstart needs root; restart_service then terminates the tracked
# process so KeepAlive respawns it, and waits for a new pid before readiness.
restart_service
"${plan.paths.readinessScript}"

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
receipt="$STATE_DIR/receipts/$completed_at-source-update.json"
cat > "$STATE_DIR/state.json" <<JSON
{
  "version": 1,
  "mode": "source-checkout",
  "currentSha": "$TARGET_SHA",
  "previousSha": "$previous_sha",
  "updatedAt": "$completed_at",
  "lastReceiptPath": "$receipt"
}
JSON
cat > "$receipt" <<JSON
{
  "version": 1,
  "action": "source-update",
  "repoDir": "$REPO_DIR",
  "previousSha": "$previous_sha",
  "targetSha": "$TARGET_SHA",
  "backupPath": "$backup_path",
  "backupSha256": "$backup_sha256",
  "backupEngine": "$backup_engine",
  "backupReceiptPath": "$backup_receipt",
  "completedAt": "$completed_at"
}
JSON
chmod 600 "$STATE_DIR/state.json" "$receipt"
rm -f "$STATE_DIR/pending.json"
echo "$receipt"
`;
}

export function renderSourceRollbackScript(plan) {
  return `#!/bin/bash
set -euo pipefail

export PATH="${plan.toolPath}"
STATE_FILE="${path.join(plan.paths.stateDir, "state.json")}"
PENDING_FILE="${path.join(plan.paths.stateDir, "pending.json")}"
if [[ -f "$PENDING_FILE" ]]; then
  rollback_source="$PENDING_FILE"
elif [[ -f "$STATE_FILE" ]]; then
  rollback_source="$STATE_FILE"
else
  echo "No source deployment or pending rollback state found." >&2
  exit 1
fi
previous_sha="$(node -e "const s=require(process.argv[1]); if(!s.previousSha) process.exit(2); console.log(s.previousSha)" "$rollback_source")"
AGENTDASH_PENDING_PREVIOUS_SHA="$previous_sha" "${plan.paths.updateScript}" "$previous_sha"
`;
}

export function renderSourceLaunchdPlist(plan) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(plan.paths.supervisorScript)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(plan.paths.logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(plan.paths.logDir, "launchd.err.log"))}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(plan.paths.repoDir)}</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
</dict>
</plist>
`;
}

export function renderSourceRunbook(plan) {
  return `# AgentDash Mac Mini Source-Checkout Runbook

This host is configured for a private, authenticated AgentDash source-checkout deployment managed by launchd.

Use this mode when Docker is unavailable on the first design-partner Mac mini. It must still be pinned to a reviewed git SHA and must pass the same readiness gates as the Docker package.

## Paths

- Repository: \`${plan.paths.repoDir}\`
- Expected SHA prefix: \`${plan.targetSha}\`
- Env file: \`${plan.paths.envFile}\` (mode 600)
- Launchd plist: \`${plan.paths.plist}\`
- Logs: \`${plan.paths.logDir}\`
- Deploy receipts: \`${path.join(plan.paths.stateDir, "receipts")}\`
- Backups: \`${plan.paths.backupDir}\`

## Service

${plan.launchdDomain === "system" ? `This service is a **system LaunchDaemon** (\`system/${plan.label}\`). The rendered plist is written to \`${plan.paths.plist}\` for review only; the generator never writes into \`/Library/LaunchDaemons\`. Install or refresh it with root only if it differs from the installed one:

\`\`\`sh
sudo cp ${plan.paths.plist} /Library/LaunchDaemons/${plan.label}.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/${plan.label}.plist
sudo launchctl kickstart -k system/${plan.label}
launchctl print system/${plan.label}
tail -f ${path.join(plan.paths.logDir, "launchd.err.log")}
\`\`\`

The update wrapper restarts the service with \`launchctl kickstart -k system/${plan.label}\`; when that is refused for a non-root operator it terminates the launchd-tracked process and the listener it owns and waits for KeepAlive to respawn the service before running readiness.` : `\`\`\`sh
launchctl bootstrap gui/$(id -u) ${plan.paths.plist}
launchctl kickstart -k gui/$(id -u)/${plan.label}
launchctl bootout gui/$(id -u) ${plan.paths.plist}
tail -f ${path.join(plan.paths.logDir, "launchd.err.log")}
\`\`\``}

## Backup readiness and backups

\`\`\`sh
${plan.paths.backupScript} --check   # read-only: proves database reachability and backup capability
${plan.paths.backupScript}           # creates and validates a mode-600 backup, writes a receipt
\`\`\`

The probe prints one JSON line and never prints the database URL. It resolves the database the way the application does (\`DATABASE_URL\`, then the instance config under \`PAPERCLIP_HOME\`, then the embedded PostgreSQL port), reads the server major version through the checkout's own driver, and picks the backup engine:

- \`pg_dump\`/\`pg_restore\` when a compatible pair is available — an explicit reviewed \`PG_DUMP_BIN\`/\`PG_RESTORE_BIN\` override, or tools on the wrapper PATH whose major version is at least the server's. The custom-format dump is validated with \`pg_restore --list\`.
- Otherwise the repository's own engine (\`packages/db/src/backup-lib.ts\`, the same code the nightly launchd backup uses). The gzipped SQL archive is validated by restoring it into a throwaway database on the same server and comparing every table's row count with the counts recorded in the archive. This engine needs a quiescent database: it refuses while heartbeat runs are running.
- \`AGENTDASH_BACKUP_ENGINE=pg_dump\` or \`=javascript\` requires a specific engine.

Each backup gets a \`<archive>.receipt.json\` (mode 600) with path, mode, size, SHA-256, engine, server major and validation result, and \`${plan.paths.lastBackupFile}\` records the last verified archive for the updater.

Restoring a repository-engine archive (\`.sql.gz\`) is the operation validation performs: create an empty database on the same server and run the checkout's \`runDatabaseRestore\` from \`packages/db/src/backup-lib.ts\` against it. Restoring a custom-format dump (\`.dump\`) uses \`pg_restore\`. Restore only after explicit human approval.

The backup runner is executed through the *currently installed* checkout (\`${plan.paths.repoDir}/packages/db\` and its \`node_modules\`). A rollback therefore also depends on that checkout being able to run its own backup library; if a failed update left \`node_modules\` unusable, run \`pnpm install --frozen-lockfile\` in the checkout before invoking the rollback wrapper. There is no flag to skip the backup gate.

## Update

\`\`\`sh
${plan.paths.updateScript} <commit-sha>
\`\`\`

The update wrapper runs the backup readiness probe, creates and validates a database backup, writes pending rollback state naming that backup, fetches the reviewed SHA, checks it out detached, installs dependencies, builds, restarts launchd, runs readiness proof, and writes a deploy receipt that names the verified backup and its SHA-256. If backup readiness or the backup itself fails, no deployment state, checkout, config or service has been touched.

## Rollback rehearsal

\`\`\`sh
${plan.paths.rollbackScript}
\`\`\`

Rollback uses the previous SHA from deployment state. Restore a database backup only after explicit human approval.
`;
}

function writeFileMode(filePath, content, mode) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { mode });
  chmodSync(filePath, mode);
}

export async function runMacMiniSourceLaunchdInstall(input = {}) {
  const plan = buildMacMiniSourceLaunchdPlan(input);
  const rendered = {
    env: mergeSourceEnv(
      existsSync(plan.paths.envFile) ? readFileSync(plan.paths.envFile, "utf8") : "",
      plan,
    ),
    supervisor: renderSourceSupervisorScript(plan),
    launchdLib: renderSourceLaunchdLibScript(plan),
    backup: renderSourceBackupScript(plan),
    backupRunner: renderSourceBackupRunner(plan),
    readiness: renderSourceReadinessScript(plan),
    update: renderSourceUpdateScript(plan),
    rollback: renderSourceRollbackScript(plan),
    plist: renderSourceLaunchdPlist(plan),
    runbook: renderSourceRunbook(plan),
  };

  if (input.dryRun || !input.write) {
    return { dryRun: true, plan, rendered };
  }

  mkdirSync(plan.paths.binDir, { recursive: true });
  mkdirSync(plan.paths.logDir, { recursive: true });
  mkdirSync(plan.paths.backupDir, { recursive: true });
  mkdirSync(plan.paths.stateDir, { recursive: true });
  mkdirSync(path.dirname(plan.paths.plist), { recursive: true });
  mkdirSync(path.dirname(plan.paths.envFile), { recursive: true });

  writeFileMode(plan.paths.envFile, rendered.env, 0o600);
  writeFileMode(plan.paths.supervisorScript, rendered.supervisor, 0o755);
  writeFileMode(plan.paths.launchdLib, rendered.launchdLib, 0o755);
  writeFileMode(plan.paths.backupScript, rendered.backup, 0o755);
  writeFileMode(plan.paths.backupRunner, rendered.backupRunner, 0o755);
  writeFileMode(plan.paths.readinessScript, rendered.readiness, 0o755);
  writeFileMode(plan.paths.updateScript, rendered.update, 0o755);
  writeFileMode(plan.paths.rollbackScript, rendered.rollback, 0o755);
  writeFileMode(plan.paths.plist, rendered.plist, 0o644);
  writeFileMode(plan.paths.runbook, rendered.runbook, 0o644);

  return { dryRun: false, plan, rendered };
}

function printHelp() {
  console.log(`Usage:
  node scripts/deploy/agentdash-mac-mini-source-launchd.mjs --repo-dir <path> --target-sha <git-sha> --public-url http://<tailnet-host>:3100 [options]

Options:
  --repo-dir <path>             Source checkout directory.
  --target-sha <sha>            Required reviewed git SHA to run.
  --public-url <url>            Required private/Tailscale URL.
  --runtime-env-file <path>     Default: ~/.config/agentdash/agentdash.env.
  --agentdash-home <path>       Default: ~/.agentdash.
  --paperclip-home <path>       Default: ~/.paperclip.
  --launch-agent-dir <path>     Default: ~/Library/LaunchAgents.
  --label <label>               Default: ai.agentdash.agent.
  --launchd-domain <gui|system> Where the service lives: gui (per-user LaunchAgent, default) or
                                system (LaunchDaemon; plist rendered for review, never written
                                into /Library/LaunchDaemons; restart falls back to KeepAlive).
  --better-auth-secret <value>  Optional; generated when missing and env lacks one.
  --agent-jwt-secret <value>    Optional; generated when missing and env lacks one.
  --paperclip-port <port>       Default: 3100.
  --tool-path <PATH>            PATH exported by every generated wrapper; must hold node, pnpm, git,
                                curl and lsof. Default: ${DEFAULT_TOOL_PATH}
  --write                       Write files. Without this, prints a dry-run plan.
  --help                        Show help.
`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "repo-dir": { type: "string" },
      "target-sha": { type: "string" },
      "public-url": { type: "string" },
      "runtime-env-file": { type: "string" },
      "agentdash-home": { type: "string" },
      "paperclip-home": { type: "string" },
      "launch-agent-dir": { type: "string" },
      label: { type: "string" },
      "launchd-domain": { type: "string" },
      "better-auth-secret": { type: "string" },
      "agent-jwt-secret": { type: "string" },
      "paperclip-port": { type: "string" },
      "tool-path": { type: "string" },
      write: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const result = await runMacMiniSourceLaunchdInstall({
    repoDir: values["repo-dir"],
    targetSha: values["target-sha"],
    publicUrl: values["public-url"],
    envFile: values["runtime-env-file"],
    agentdashHome: values["agentdash-home"],
    paperclipHome: values["paperclip-home"],
    launchAgentDir: values["launch-agent-dir"],
    label: values.label,
    launchdDomain: values["launchd-domain"],
    betterAuthSecret: values["better-auth-secret"],
    agentJwtSecret: values["agent-jwt-secret"],
    paperclipPort: values["paperclip-port"],
    toolPath: values["tool-path"],
    write: values.write,
  });

  console.log(JSON.stringify({
    dryRun: result.dryRun,
    mode: result.plan.mode,
    label: result.plan.label,
    launchdDomain: result.plan.launchdDomain,
    targetSha: result.plan.targetSha,
    toolPath: result.plan.toolPath,
    paths: result.plan.paths,
    env: {
      PAPERCLIP_PUBLIC_URL: result.plan.env.PAPERCLIP_PUBLIC_URL,
      PAPERCLIP_DEPLOYMENT_MODE: result.plan.env.PAPERCLIP_DEPLOYMENT_MODE,
      PAPERCLIP_DEPLOYMENT_EXPOSURE: result.plan.env.PAPERCLIP_DEPLOYMENT_EXPOSURE,
      AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT: result.plan.env.AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT,
    },
    next: result.dryRun
      ? "Re-run with --write to create files, then review RUNBOOK.md before launchctl bootstrap/kickstart."
      : "Review RUNBOOK.md, then run launchctl bootstrap/kickstart when ready.",
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[agentdash-mac-mini-source-launchd] ${error.message}`);
    process.exitCode = 1;
  });
}
