/**
 * Native macOS backup contract for the source-checkout OTA path.
 *
 * These regressions reproduce the environment of a customer Mac mini that runs
 * AgentDash on the embedded PostgreSQL distribution: the only PostgreSQL
 * executables on the machine are `initdb`, `pg_ctl` and `postgres`. There is no
 * `pg_dump`, `pg_restore` or `psql` anywhere — not on PATH, not from Homebrew,
 * not from Postgres.app, not in node_modules.
 *
 * The generated backup wrapper must still create and validate a recoverable
 * backup before the updater mutates anything, and it must never print the
 * database URL or password.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildMacMiniSourceLaunchdPlan,
  renderSourceBackupRunner,
  renderSourceBackupScript,
  renderSourceReadinessScript,
  renderSourceRollbackScript,
  renderSourceUpdateScript,
  runMacMiniSourceLaunchdInstall,
} from "./agentdash-mac-mini-source-launchd.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbPackageRequire = createRequire(path.join(repoRoot, "packages/db/package.json"));

const DB_USER = "paperclip";
const DB_PASSWORD = "paperclip";
const DB_NAME = "paperclip";
const SECRET_MARKERS = [`${DB_USER}:${DB_PASSWORD}@`, "PGPASSWORD=", `password=${DB_PASSWORD}`];

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function fileMode(filePath) {
  return statSync(filePath).mode & 0o777;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const POSTGRES_CLIENT_TOOLS = new Set(["pg_dump", "pg_dumpall", "pg_restore", "psql"]);

/**
 * A PATH with the tools a launchd wrapper genuinely needs (node, pnpm, the
 * system utilities) and no PostgreSQL client tool at all. The system bin
 * directories are mirrored into one private directory *minus* pg_dump,
 * pg_dumpall, pg_restore and psql, so the fixture is literally the client's
 * situation on every platform — including CI runners whose /usr/bin carries a
 * distribution pg_dump.
 */
function makeToolPath(tmp) {
  const bin = path.join(tmp, "tool-bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, path.join(bin, "node"));
  // An exec wrapper rather than a symlink: pnpm may be a $0-relative shim
  // (corepack, pnpm/action-setup) that breaks when symlinked elsewhere.
  const pnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\nexec ${JSON.stringify(pnpm)} "$@"\n`, { mode: 0o755 });
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (POSTGRES_CLIENT_TOOLS.has(name) || existsSync(path.join(bin, name))) continue;
      try {
        symlinkSync(path.join(dir, name), path.join(bin, name));
      } catch {
        // unreadable or racing entries are irrelevant to the wrapper
      }
    }
  }
  const embeddedBin = path.join(tmp, "embedded-postgres-bin");
  mkdirSync(embeddedBin, { recursive: true });
  for (const tool of ["initdb", "pg_ctl", "postgres"]) {
    writeFileSync(path.join(embeddedBin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const toolPath = `${bin}:${embeddedBin}`;
  const found = spawnSync("/bin/sh", ["-c", "command -v pg_dump pg_restore psql"], { encoding: "utf8", env: { PATH: toolPath } });
  assert.notEqual(found.status, 0, `the fixture PATH must not resolve any PostgreSQL client tool: ${found.stdout}`);
  return toolPath;
}

function writeFakePgTools(dir, version) {
  mkdirSync(dir, { recursive: true });
  const pgDump = path.join(dir, "pg_dump");
  writeFileSync(
    pgDump,
    `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  echo "pg_dump (PostgreSQL) ${version}"
  exit 0
fi
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file=*) out="\${1#--file=}" ;;
    -f) shift; out="$1" ;;
  esac
  shift
done
[[ -n "$out" ]] || { echo "fake pg_dump: no output file" >&2; exit 2; }
[[ -n "\${PGPASSWORD:-}" ]] || { echo "fake pg_dump: PGPASSWORD missing" >&2; exit 3; }
{ printf 'PGDMP'; head -c 4096 /dev/zero | tr '\\0' 'x'; } > "$out"
`,
    { mode: 0o755 },
  );
  const pgRestore = path.join(dir, "pg_restore");
  writeFileSync(
    pgRestore,
    `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  echo "pg_restore (PostgreSQL) ${version}"
  exit 0
fi
if [[ "\${1:-}" == "--list" || "\${1:-}" == "-l" ]]; then
  head -c 5 "$2" | grep -q PGDMP || { echo "fake pg_restore: not an archive" >&2; exit 1; }
  echo ";"
  echo "; Archive created at fake"
  echo "215; 1259 16385 TABLE public companies ${DB_USER}"
  echo "216; 1259 16390 TABLE public issues ${DB_USER}"
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  return { pgDump, pgRestore };
}

async function loadPostgresDriver() {
  const mod = await import(pathToFileURL(dbPackageRequire.resolve("postgres")).href);
  return mod.default ?? mod;
}

async function startEmbeddedPostgres(tmp) {
  const mod = await import(pathToFileURL(dbPackageRequire.resolve("embedded-postgres")).href);
  const EmbeddedPostgres = mod.default ?? mod;
  const port = await freePort();
  const databaseDir = path.join(tmp, "pgdata");
  const instance = new EmbeddedPostgres({
    databaseDir,
    user: DB_USER,
    password: DB_PASSWORD,
    port,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog() {},
    onError() {},
  });
  await instance.initialise();
  await instance.start();
  const postgres = await loadPostgresDriver();
  const adminUrl = `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${port}/postgres`;
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
  await admin.end();
  const connectionString = `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${port}/${DB_NAME}`;
  return {
    port,
    connectionString,
    adminUrl,
    postgres,
    async stop() {
      await instance.stop();
    },
  };
}

async function seedDatabase(postgres, connectionString) {
  const sql = postgres(connectionString, { max: 1 });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await sql.unsafe(`CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    await sql.unsafe(`CREATE TYPE issue_status AS ENUM ('todo', 'in_progress', 'done')`);
    await sql.unsafe(`CREATE TABLE companies (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await sql.unsafe(`CREATE TABLE issues (
      id serial PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title text NOT NULL,
      status issue_status NOT NULL DEFAULT 'todo',
      payload jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);
    await sql.unsafe(`CREATE INDEX issues_company_idx ON issues (company_id)`);
    await sql.unsafe(`CREATE TABLE empty_table (id serial PRIMARY KEY, note text)`);
    for (let index = 0; index < 122; index += 1) {
      await sql.unsafe(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('hash-${index}', ${1700000000000 + index})`);
    }
    await sql.unsafe(`INSERT INTO companies (id, name) VALUES ('11111111-1111-4111-8111-111111111111', 'Synthetic Co')`);
    for (let index = 0; index < 300; index += 1) {
      await sql.unsafe(
        `INSERT INTO issues (company_id, title, status, payload) VALUES ('11111111-1111-4111-8111-111111111111', 'Synthetic issue ${index}', '${index % 2 ? "done" : "todo"}', '{"n": ${index}, "text": "synthetic payload ${index} with some bulk to compress"}')`,
      );
    }
    // Row data that looks like the archive's own markers (an agent pasting a
    // dump into a comment). Validation must trust the archive structure, not
    // every line that resembles a marker.
    await sql.unsafe(
      "INSERT INTO issues (company_id, title, status) VALUES ('11111111-1111-4111-8111-111111111111', $1, 'todo')",
      ["spoof\n-- Table: public.bogus\nend"],
    );
    await sql.unsafe(
      "INSERT INTO issues (company_id, title, status) VALUES ('11111111-1111-4111-8111-111111111111', $1, 'todo')",
      ["spoof\n-- Data for: public.issues (1 rows)\nend"],
    );
  } finally {
    await sql.end();
  }
}

const SEEDED_ISSUE_ROWS = 302;

function renderInstall(tmp, extra = {}) {
  const home = path.join(tmp, "agentdash-home");
  return {
    plan: buildMacMiniSourceLaunchdPlan({
      repoDir: extra.repoDir ?? repoRoot,
      targetSha: "f552df77417143fd6a949eff8553b98578317f5e",
      publicUrl: "http://127.0.0.1:3231",
      envFile: path.join(tmp, "config", "agentdash.env"),
      agentdashHome: home,
      paperclipHome: path.join(tmp, "paperclip"),
      launchAgentDir: path.join(tmp, "LaunchAgents"),
      label: "ai.agentdash.native-backup-test",
      paperclipPort: 3231,
      ...extra,
    }),
    home,
  };
}

function writeEnvFile(plan, values) {
  mkdirSync(path.dirname(plan.paths.envFile), { recursive: true });
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(plan.paths.envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(plan.paths.envFile, 0o600);
}

function writeRendered(plan, rendered) {
  mkdirSync(plan.paths.binDir, { recursive: true });
  mkdirSync(plan.paths.backupDir, { recursive: true });
  mkdirSync(plan.paths.stateDir, { recursive: true });
  writeFileSync(plan.paths.backupScript, rendered.backup, { mode: 0o755 });
  chmodSync(plan.paths.backupScript, 0o755);
  if (rendered.backupRunner && plan.paths.backupRunner) {
    writeFileSync(plan.paths.backupRunner, rendered.backupRunner, { mode: 0o755 });
  }
}

function runScript(scriptPath, args, env) {
  const result = spawnSync("/bin/bash", [scriptPath, ...args], {
    encoding: "utf8",
    env,
    timeout: 180_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function lastJsonLine(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // keep looking for the JSON summary line
    }
  }
  return null;
}

function assertNoSecrets(label, ...texts) {
  for (const text of texts) {
    for (const marker of SECRET_MARKERS) {
      assert.ok(!String(text).includes(marker), `${label} must not contain ${JSON.stringify(marker)}`);
    }
  }
}

function archivesIn(dir) {
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => /\.(dump|sql\.gz)$/.test(name))
    : [];
}

function embeddedPostgresNativeDir() {
  // The platform packages export no entry point, so locate the one installed
  // for this host through the pnpm store rather than through module resolution.
  const platform = `${process.platform}-${process.arch}`;
  const store = path.join(repoRoot, "node_modules", ".pnpm");
  const entry = readdirSync(store).find((name) => name.startsWith(`@embedded-postgres+${platform}@`));
  assert.ok(entry, `the ${platform} embedded PostgreSQL package must be installed`);
  return { platform, dir: path.join(store, entry, "node_modules", "@embedded-postgres", platform) };
}

test("the embedded PostgreSQL distribution pinned by this checkout ships no client tools", () => {
  const { platform, dir } = embeddedPostgresNativeDir();
  const tools = readdirSync(path.join(dir, "native", "bin")).sort();
  for (const required of ["initdb", "pg_ctl", "postgres"]) {
    assert.ok(tools.includes(required), `${platform} embedded bin must ship ${required}`);
  }
  for (const absent of ["pg_dump", "pg_restore", "psql"]) {
    assert.ok(!tools.includes(absent), `${platform} embedded bin must not ship ${absent}`);
  }
  if (platform === "darwin-arm64") {
    // The customer's exact platform: nothing but the server itself.
    assert.deepEqual(tools, ["initdb", "pg_ctl", "postgres"]);
  }
  const pinned = JSON.parse(readFileSync(path.join(repoRoot, "packages/db/package.json"), "utf8"));
  assert.match(pinned.dependencies["embedded-postgres"], /18\.1\.0/);
});

test("rendered backup contract prefers compatible pg_dump but falls back to the repository engine", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-native-backup-contract-"));
  try {
    const { plan } = renderInstall(tmp);
    const launcher = renderSourceBackupScript(plan);
    const runner = renderSourceBackupRunner(plan);
    // The launcher forwards every argument to the runner, which owns the contract.
    assert.match(launcher, /"\$RUNNER" "\$@"/);
    assert.match(launcher, /packages\/db\/package\.json/);
    const backup = `${launcher}\n${runner}`;

    // A backup capability probe that runs before any mutation.
    assert.match(backup, /--check/);
    // The repository engine is the supported path when no compatible pg_dump exists.
    assert.match(backup, /backup-lib|runDatabaseBackup/);
    // Explicit, reviewed executable overrides remain honoured.
    assert.match(backup, /PG_DUMP_BIN/);
    assert.match(backup, /PG_RESTORE_BIN/);
    // Executable identity/version compatibility is validated, not assumed.
    assert.match(backup, /--version/);
    assert.match(backup, /server_version_num/);
    // Restore validation is mandatory for both engines.
    assert.match(backup, /pg_restore.*--list|--list/);
    assert.match(backup, /runDatabaseRestore/);
    // Receipts carry integrity without secrets.
    assert.match(backup, /sha256/);
    // No credential on a command line: the URL must not be passed as an argument to pg_dump.
    assert.doesNotMatch(backup, /"\$PG_DUMP" "\$DATABASE_URL"/);
    assert.ok(plan.paths.backupRunner, "plan must name the backup runner module");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("update wrapper probes backup readiness before pending state and records the verified backup", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-native-backup-update-"));
  try {
    const { plan } = renderInstall(tmp);
    const update = renderSourceUpdateScript(plan);
    const probeIndex = update.indexOf("--check");
    const backupRunIndex = update.indexOf(`"${plan.paths.backupScript}" 1>&2`);
    const pendingIndex = update.indexOf("pending.json");
    const checkoutIndex = update.indexOf('git checkout --detach "$TARGET_SHA"');
    assert.ok(probeIndex >= 0, "update must probe backup readiness");
    assert.ok(backupRunIndex >= 0, "update must create the backup through the wrapper");
    assert.ok(probeIndex < backupRunIndex, "backup readiness must be proven before the backup runs");
    assert.ok(backupRunIndex < pendingIndex, "no deployment state may be written before a validated backup exists");
    assert.ok(pendingIndex < checkoutIndex, "pending rollback state must exist before checkout");
    assert.match(update.slice(pendingIndex, checkoutIndex), /"backupSha256": "\$backup_sha256"/);
    assert.match(update, /backupSha256/);
    assert.match(update, /last-backup\.json/);
    assert.doesNotMatch(update, /\/tmp\/agentdash-last-backup-path\.txt/);

    const rollback = renderSourceRollbackScript(plan);
    assert.match(rollback, /updateScript|agentdash-source-update\.sh/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readiness proves database connectivity through the repository, not psql", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-native-backup-readiness-"));
  try {
    const { plan } = renderInstall(tmp);
    const readiness = renderSourceReadinessScript(plan);
    assert.doesNotMatch(readiness, /\bpsql\b/);
    assert.match(readiness, /--check/);
    assert.doesNotMatch(readiness, /echo .*\$DATABASE_URL/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("native backup contract against a tool-less embedded PostgreSQL", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-native-backup-live-"));
  const toolPath = makeToolPath(tmp);
  const pg = await startEmbeddedPostgres(tmp);
  try {
    await seedDatabase(pg.postgres, pg.connectionString);

    // HOME stays real so pnpm/corepack use their existing store instead of
    // re-downloading; the runner never consults HOME when DATABASE_URL is set.
    const baseEnv = {
      HOME: process.env.HOME,
      PATH: toolPath,
      LANG: "C",
      DATABASE_URL: pg.connectionString,
    };

    await t.test("with no pg_dump anywhere the wrapper proves readiness, then backs up through the repository engine", async () => {
      const caseDir = path.join(tmp, "case-absent");
      const { plan } = renderInstall(caseDir, { toolPath });
      writeEnvFile(plan, { DATABASE_URL: pg.connectionString });
      const install = await runMacMiniSourceLaunchdInstall({
        repoDir: repoRoot,
        targetSha: plan.targetSha,
        publicUrl: "http://127.0.0.1:3231",
        envFile: plan.paths.envFile,
        agentdashHome: plan.paths.agentdashHome,
        paperclipHome: path.join(caseDir, "paperclip"),
        launchAgentDir: path.join(caseDir, "LaunchAgents"),
        label: plan.label,
        paperclipPort: 3231,
        toolPath,
        write: false,
      });
      // Reproduce the client's PATH exactly: whatever PATH the wrapper exports,
      // there is no pg_dump on it. A decoy psql IS on it, so the test measures
      // (rather than assumes) that restore validation never shells out to psql
      // — the application library would hand psql the credential-bearing URL.
      const decoyDir = path.join(caseDir, "decoy-psql");
      const decoyLog = path.join(caseDir, "psql-invoked.log");
      mkdirSync(decoyDir, { recursive: true });
      writeFileSync(path.join(decoyDir, "psql"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(decoyLog)}\nexit 1\n`, { mode: 0o755 });
      const casePath = `${decoyDir}:${toolPath}`;
      const backupScript = install.rendered.backup.replace(/^export PATH=.*$/m, `export PATH="${casePath}"`);
      writeRendered(plan, { ...install.rendered, backup: backupScript });
      const caseEnv = { ...baseEnv, PATH: casePath };

      const check = runScript(plan.paths.backupScript, ["--check"], caseEnv);
      assertNoSecrets("backup --check output", check.stdout, check.stderr);
      const probe = lastJsonLine(check.stdout);
      assert.ok(probe, `--check must print a JSON readiness record; got ${JSON.stringify(check)}`);
      assert.equal(probe.ok, true);
      assert.equal(probe.engine, "javascript");
      assert.equal(probe.server.major, 18);
      assert.equal(probe.pgDump, null);
      assert.ok(Array.isArray(probe.searched) && probe.searched.length > 0, "probe must list searched locations");
      assert.equal(probe.repositoryEngine.available, true);
      // pnpm exec prepends the workspace bin directories; the wrapper PATH must be the tail.
      assert.ok(probe.toolPath.endsWith(casePath), `probe must report the wrapper PATH it ran under; got ${probe.toolPath}`);
      for (const tool of ["node", "pnpm", "git", "curl", "lsof"]) {
        assert.ok(probe.tools[tool], `probe must resolve ${tool} on the wrapper PATH`);
      }
      assert.equal(archivesIn(plan.paths.backupDir).length, 0, "--check must not write an archive");

      const run = runScript(plan.paths.backupScript, [], caseEnv);
      assert.ok(!existsSync(decoyLog), "restore validation must never invoke psql, even when one is on PATH");
      assertNoSecrets("backup run output", run.stdout, run.stderr);
      assert.equal(run.status, 0, `backup must succeed through the repository engine: ${run.stderr}`);
      const summary = lastJsonLine(run.stdout);
      assert.ok(summary, "backup must print a JSON summary");
      assert.equal(summary.ok, true);
      assert.equal(summary.engine, "javascript");
      assert.match(summary.backupPath, /predeploy-.*\.sql\.gz$/);
      assert.ok(existsSync(summary.backupPath));
      assert.ok(summary.sizeBytes >= 1024, "archive must be non-trivial");
      assert.equal(statSync(summary.backupPath).size, summary.sizeBytes);
      assert.equal(fileMode(summary.backupPath), 0o600);
      assert.equal(summary.sha256, sha256(summary.backupPath));
      assert.equal(summary.mode, "600");
      assert.equal(summary.server.major, 18);
      assert.equal(summary.validation.method, "throwaway-database-restore");
      assert.equal(summary.validation.restore, "node", "validation must use the repository's Node restore path, never psql");
      assert.ok(summary.validation.tables >= 4, "validation must compare every table");
      assert.equal(summary.validation.rows, 122 + 1 + SEEDED_ISSUE_ROWS);

      const receipt = JSON.parse(readFileSync(summary.receiptPath, "utf8"));
      assert.equal(fileMode(summary.receiptPath), 0o600);
      assert.equal(receipt.sha256, summary.sha256);
      assert.equal(receipt.sizeBytes, summary.sizeBytes);
      assert.equal(receipt.mode, "600");
      assert.equal(receipt.engine, "javascript");
      assertNoSecrets("backup receipt", readFileSync(summary.receiptPath, "utf8"));

      const lastBackupPath = path.join(plan.paths.stateDir, "last-backup.json");
      assert.ok(existsSync(lastBackupPath), "the updater consumes last-backup.json from the state dir");
      assert.equal(fileMode(lastBackupPath), 0o600);
      const lastBackup = JSON.parse(readFileSync(lastBackupPath, "utf8"));
      assert.equal(lastBackup.backupPath, summary.backupPath);
      assert.equal(lastBackup.sha256, summary.sha256);
      assertNoSecrets("last-backup.json", readFileSync(lastBackupPath, "utf8"));

      const sql = pg.postgres(pg.adminUrl, { max: 1 });
      try {
        const leftovers = await sql.unsafe(`SELECT datname FROM pg_database WHERE datname LIKE 'agentdash_restore_check%'`);
        assert.equal(leftovers.length, 0, "throwaway validation databases must be dropped");
      } finally {
        await sql.end();
      }
    });

    await t.test("an incompatible pg_dump is rejected in favour of the repository engine", async () => {
      const caseDir = path.join(tmp, "case-incompatible");
      const { plan } = renderInstall(caseDir, { toolPath });
      writeEnvFile(plan, { DATABASE_URL: pg.connectionString });
      const fake = writeFakePgTools(path.join(caseDir, "fake-pg14"), "14.17");
      const install = await runMacMiniSourceLaunchdInstall({
        repoDir: repoRoot,
        targetSha: plan.targetSha,
        publicUrl: "http://127.0.0.1:3231",
        envFile: plan.paths.envFile,
        agentdashHome: plan.paths.agentdashHome,
        paperclipHome: path.join(caseDir, "paperclip"),
        launchAgentDir: path.join(caseDir, "LaunchAgents"),
        label: plan.label,
        paperclipPort: 3231,
        toolPath,
        write: false,
      });
      writeRendered(plan, install.rendered);

      const env = { ...baseEnv, PG_DUMP_BIN: fake.pgDump, PG_RESTORE_BIN: fake.pgRestore };
      const check = runScript(plan.paths.backupScript, ["--check"], env);
      assertNoSecrets("incompatible --check output", check.stdout, check.stderr);
      const probe = lastJsonLine(check.stdout);
      assert.ok(probe, "probe must print JSON");
      assert.equal(probe.ok, true);
      assert.equal(probe.engine, "javascript");
      assert.equal(probe.pgDump.compatible, false);
      assert.equal(probe.pgDump.major, 14);
      assert.match(probe.pgDump.reason, /18/);
    });

    await t.test("a compatible pg_dump produces a custom-format dump validated by pg_restore --list", async () => {
      const caseDir = path.join(tmp, "case-compatible");
      const { plan } = renderInstall(caseDir, { toolPath });
      writeEnvFile(plan, { DATABASE_URL: pg.connectionString });
      const fake = writeFakePgTools(path.join(caseDir, "fake-pg18"), "18.1");
      const install = await runMacMiniSourceLaunchdInstall({
        repoDir: repoRoot,
        targetSha: plan.targetSha,
        publicUrl: "http://127.0.0.1:3231",
        envFile: plan.paths.envFile,
        agentdashHome: plan.paths.agentdashHome,
        paperclipHome: path.join(caseDir, "paperclip"),
        launchAgentDir: path.join(caseDir, "LaunchAgents"),
        label: plan.label,
        paperclipPort: 3231,
        toolPath,
        write: false,
      });
      writeRendered(plan, install.rendered);

      const env = { ...baseEnv, PG_DUMP_BIN: fake.pgDump, PG_RESTORE_BIN: fake.pgRestore };
      const check = runScript(plan.paths.backupScript, ["--check"], env);
      const probe = lastJsonLine(check.stdout);
      assert.ok(probe, "probe must print JSON");
      assert.equal(probe.ok, true);
      assert.equal(probe.engine, "pg_dump");
      assert.equal(probe.pgDump.compatible, true);
      assert.equal(probe.pgDump.major, 18);
      assert.equal(probe.pgRestore.major, 18);

      const run = runScript(plan.paths.backupScript, [], env);
      assertNoSecrets("pg_dump run output", run.stdout, run.stderr);
      assert.equal(run.status, 0, `pg_dump engine must succeed: ${run.stderr}`);
      const summary = lastJsonLine(run.stdout);
      assert.equal(summary.engine, "pg_dump");
      assert.match(summary.backupPath, /predeploy-.*\.dump$/);
      assert.equal(fileMode(summary.backupPath), 0o600);
      assert.equal(summary.sha256, sha256(summary.backupPath));
      assert.equal(summary.validation.method, "pg_restore --list");
      assert.ok(summary.validation.entries >= 2);
      const receipt = JSON.parse(readFileSync(summary.receiptPath, "utf8"));
      assert.equal(receipt.engine, "pg_dump");
      assert.equal(receipt.pgDump.version, "18.1");
    });

    await t.test("no compatible pg_dump and no repository engine fails closed with an actionable message", async () => {
      const caseDir = path.join(tmp, "case-nothing");
      const emptyRepo = path.join(caseDir, "empty-repo");
      mkdirSync(emptyRepo, { recursive: true });
      const { plan } = renderInstall(caseDir, { toolPath, repoDir: emptyRepo });
      writeEnvFile(plan, { DATABASE_URL: pg.connectionString });
      const install = await runMacMiniSourceLaunchdInstall({
        repoDir: emptyRepo,
        targetSha: plan.targetSha,
        publicUrl: "http://127.0.0.1:3231",
        envFile: plan.paths.envFile,
        agentdashHome: plan.paths.agentdashHome,
        paperclipHome: path.join(caseDir, "paperclip"),
        launchAgentDir: path.join(caseDir, "LaunchAgents"),
        label: plan.label,
        paperclipPort: 3231,
        toolPath,
        write: false,
      });
      const backupScript = install.rendered.backup.replace(/^export PATH=.*$/m, `export PATH="${toolPath}"`);
      writeRendered(plan, { ...install.rendered, backup: backupScript });

      const check = runScript(plan.paths.backupScript, ["--check"], baseEnv);
      assertNoSecrets("fail-closed --check output", check.stdout, check.stderr);
      assert.notEqual(check.status, 0, "missing backup capability must fail the probe");
      assert.match(check.stderr, /PG_DUMP_BIN/, "the error must name the supported override");
      assert.match(check.stderr, /PATH/, "the error must list the searched locations");
      assert.match(check.stderr, /packages\/db|repository/i, "the error must name the repository engine remediation");
      assert.equal(archivesIn(plan.paths.backupDir).length, 0, "nothing may be written when readiness fails");

      const run = runScript(plan.paths.backupScript, [], baseEnv);
      assert.notEqual(run.status, 0);
      assert.equal(archivesIn(plan.paths.backupDir).length, 0, "no archive — not even an empty one — may be left behind");
      assertNoSecrets("fail-closed run output", run.stdout, run.stderr);
    });
  } finally {
    await pg.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * The shells embed Node programs as heredocs. `bash -n` cannot see inside them,
 * and a template-literal escape mistake in the generator renders a syntax error
 * that only surfaces on the customer machine (measured: an unescaped
 * `split(/\r?\n/)` became literal CR/LF and readiness failed after restart).
 */
function embeddedNodePrograms(script) {
  const programs = [];
  const pattern = /node -(?: [^\n]*)? <<'NODE'\n([\s\S]*?)\nNODE\n/g;
  let match;
  while ((match = pattern.exec(script)) !== null) programs.push(match[1]);
  return programs;
}

test("every embedded node heredoc in the rendered shells is valid JavaScript", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-native-backup-heredoc-"));
  try {
    const { plan } = renderInstall(tmp);
    const rendered = {
      readiness: renderSourceReadinessScript(plan),
      update: renderSourceUpdateScript(plan),
      rollback: renderSourceRollbackScript(plan),
    };
    let checked = 0;
    for (const [name, script] of Object.entries(rendered)) {
      for (const [index, program] of embeddedNodePrograms(script).entries()) {
        const file = path.join(tmp, `${name}-${index}.cjs`);
        writeFileSync(file, program);
        assert.doesNotThrow(
          () => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }),
          `${name} heredoc #${index} must parse`,
        );
        checked += 1;
      }
    }
    assert.ok(checked >= 2, "readiness and update must embed node programs");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("every rendered operational shell parses under the macOS system bash", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-native-backup-syntax-"));
  try {
    const { plan } = renderInstall(tmp);
    const install = await runMacMiniSourceLaunchdInstall({
      repoDir: repoRoot,
      targetSha: plan.targetSha,
      publicUrl: "http://127.0.0.1:3231",
      envFile: plan.paths.envFile,
      agentdashHome: plan.paths.agentdashHome,
      paperclipHome: path.join(tmp, "paperclip"),
      launchAgentDir: path.join(tmp, "LaunchAgents"),
      label: plan.label,
      paperclipPort: 3231,
      write: false,
    });
    for (const [name, content] of Object.entries(install.rendered)) {
      if (!String(content).startsWith("#!/bin/bash")) continue;
      const scriptPath = path.join(tmp, `${name}.sh`);
      writeFileSync(scriptPath, content);
      assert.doesNotThrow(() => execFileSync("/bin/bash", ["-n", scriptPath], { stdio: "pipe" }), `${name} must parse`);
    }
    if (install.rendered.backupRunner) {
      const runnerPath = path.join(tmp, "backup-runner.mjs");
      writeFileSync(runnerPath, install.rendered.backupRunner);
      assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", runnerPath], { stdio: "pipe" }));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
