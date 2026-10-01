// AgentDash (GH #733): the box side of the off-box backup export: a fresh
// dump for routes/agentdash-backup-export.ts. Kept apart from the route so the
// route has no database imports (the cloud control plane's round-trip test
// drives the route itself against a real dump).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { runDatabaseBackup, type Db } from "@paperclipai/db";
import { collectBackupCounts, type BackupExportService } from "./agentdash-backup-export.js";

/**
 * The box's export: a fresh dump through the same backup library the hourly
 * on-volume backup uses (pg_dump when present, else its JavaScript engine), in
 * a temporary directory outside the instance's backup directory.
 */
export function createBackupExportService(opts: { db: Db; connectionString: () => string }): BackupExportService {
  return {
    async run() {
      const query = async (text: string) => (await opts.db.execute(sql.raw(text))) as unknown as Array<Record<string, unknown>>;
      const counts = await collectBackupCounts(query);
      const dir = await mkdtemp(join(tmpdir(), "agentdash-offbox-export-"));
      const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
      try {
        const result = await runDatabaseBackup({
          connectionString: opts.connectionString(),
          backupDir: dir,
          retention: { dailyDays: 1, weeklyWeeks: 0, monthlyMonths: 0 },
          filenamePrefix: "offbox-export",
        });
        return { file: result.backupFile, counts, cleanup };
      } catch (err) {
        await cleanup();
        throw err;
      }
    },
  };
}
