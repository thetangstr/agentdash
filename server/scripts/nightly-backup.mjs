/**
 * Nightly backup, run by launchd.
 *
 * Uses the repository's own `runDatabaseBackup` rather than shelling out to
 * `pg_dump`, because the embedded Postgres this stack runs on ships only
 * `initdb`, `pg_ctl` and `postgres` — there is no `pg_dump` on the machine at
 * all. A backup script that assumed one failed on the first real run, which is
 * the kind of thing you discover either now or on the night you needed the
 * backup. `backupEngine: "auto"` picks the JavaScript engine when the binary is
 * absent, so this has no external dependency.
 *
 * Not `paperclipai db-backup`: that command prints a banner and uses
 * interactive prompts, and a backup that can block on a prompt is not a backup.
 */
import { runDatabaseBackup } from "@paperclipai/db";

const instance = process.env.AGENTDASH_INSTANCE ?? "mkboard";
const connectionString = process.env.DATABASE_URL?.trim();
const backupDir =
  process.env.AGENTDASH_BACKUP_DIR ?? `${process.env.HOME}/.paperclip/backups/${instance}`;

if (!connectionString) {
  console.error("backup: DATABASE_URL is not set");
  process.exit(78); // EX_CONFIG
}

const result = await runDatabaseBackup({
  connectionString,
  backupDir,
  filenamePrefix: instance,
  backupEngine: "auto",
  retention: {
    dailyDays: Number(process.env.AGENTDASH_BACKUP_DAILY_DAYS ?? 14),
    weeklyWeeks: Number(process.env.AGENTDASH_BACKUP_WEEKLY_WEEKS ?? 8),
    monthlyMonths: Number(process.env.AGENTDASH_BACKUP_MONTHLY_MONTHS ?? 12),
  },
});

// An empty or near-empty file is a failed backup that looks like a successful
// one. Fail loudly here rather than let the retention sweep age out the last
// good copy behind it.
if (result.sizeBytes < 1024) {
  console.error(`backup: ${result.backupFile} is only ${result.sizeBytes}B — treating as failed`);
  process.exit(1);
}

console.log(
  `backup: ${new Date().toISOString()} wrote ${result.backupFile} `
  + `(${result.sizeBytes} bytes, pruned ${result.prunedCount})`,
);
