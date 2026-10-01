// AgentDash (GH #733): the box side of the off-box backup export: a fresh
// dump for routes/agentdash-backup-export.ts. Kept apart from the route so the
// route has no database imports (the cloud control plane's round-trip test
// drives the route itself against a real dump).
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { runDatabaseBackup, type Db } from "@paperclipai/db";
import { collectBackupCounts, type BackupExportService } from "./agentdash-backup-export.js";

/** Tag every connection of one export (pg_dump's and backup-lib's own), so a timeout can end exactly those. */
export function withApplicationName(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", name);
  return url.toString();
}

/**
 * The box's export: a fresh dump through the same backup library the hourly
 * on-volume backup uses (pg_dump when present, else its JavaScript engine), in
 * a temporary directory outside the instance's backup directory. `abort()`
 * terminates the export's own database sessions (same role, so no extra
 * privilege), which makes the running dump fail and settle: the route's hard
 * timeout is a real upper bound, not just an early answer.
 */
export function createBackupExportService(opts: { db: Db; connectionString: () => string }): BackupExportService {
  let current: string | null = null;
  const query = async (text: string) => (await opts.db.execute(sql.raw(text))) as unknown as Array<Record<string, unknown>>;
  return {
    async run() {
      const appName = `agentdash_offbox_export_${randomBytes(6).toString("hex")}`;
      current = appName;
      const counts = await collectBackupCounts(query);
      const dir = await mkdtemp(join(tmpdir(), "agentdash-offbox-export-"));
      const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
      try {
        const result = await runDatabaseBackup({
          connectionString: withApplicationName(opts.connectionString(), appName),
          backupDir: dir,
          retention: { dailyDays: 1, weeklyWeeks: 0, monthlyMonths: 0 },
          filenamePrefix: "offbox-export",
        });
        return { file: result.backupFile, counts, cleanup };
      } catch (err) {
        await cleanup();
        throw err;
      } finally {
        if (current === appName) current = null;
      }
    },
    async abort() {
      const appName = current;
      if (!appName || !/^agentdash_offbox_export_[0-9a-f]{12}$/.test(appName)) return;
      await opts.db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${appName} and pid <> pg_backend_pid()`);
    },
  };
}
