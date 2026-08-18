import { statfsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, count, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * O4 (2026-08-16): the checks that let /api/health go DEGRADED instead of
 * reporting "ok" while backups silently stopped three days ago.
 *
 * One implementation, two consumers: the health route (when polled) and the
 * watchdog loop (periodically, emitting signals). A health check that only
 * runs when somebody polls it is half a health check.
 */

const DISK_LOW_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB
const BACKUP_STALE_HOURS = 26; // nightly + one hour of slack
const RUN_STUCK_HOURS = 2;

export interface HealthChecks {
  status: "ok" | "degraded";
  db: { ok: true; latencyMs: number };
  disk: { ok: boolean; freeBytes: number };
  backup: { ok: boolean; latestAt: string | null; ageHours: number | null } | null;
  runs: { ok: boolean; stuck: number };
}

function backupDirForInstance(): string | null {
  const instance = process.env.PAPERCLIP_INSTANCE_ID?.trim();
  if (!instance) return null;
  const dir = path.join(os.homedir(), ".paperclip", "backups", instance);
  try {
    statSync(dir);
    return dir;
  } catch {
    return null;
  }
}

function newestBackup(dir: string): { at: Date } | null {
  let newest: Date | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sql.gz")) continue;
    const mtime = statSync(path.join(dir, name)).mtime;
    if (!newest || mtime > newest) newest = mtime;
  }
  return newest ? { at: newest } : null;
}

export async function computeHealthChecks(db: Db): Promise<HealthChecks> {
  const dbStart = performance.now();
  await db.execute(sql`SELECT 1`);
  const latencyMs = Math.round((performance.now() - dbStart) * 10) / 10;

  const fs = statfsSync("/");
  const freeBytes = fs.bavail * fs.bsize;
  const diskOk = freeBytes > DISK_LOW_BYTES;

  // Backup freshness only where a backup directory exists at all — dev and
  // test instances without one are not "degraded", they are unbacked by
  // design and the roadmap says so out loud.
  let backup: HealthChecks["backup"] = null;
  const dir = backupDirForInstance();
  if (dir) {
    const newest = newestBackup(dir);
    if (!newest) {
      backup = { ok: false, latestAt: null, ageHours: null };
    } else {
      const ageHours = (Date.now() - newest.at.getTime()) / 3_600_000;
      backup = {
        ok: ageHours < BACKUP_STALE_HOURS,
        latestAt: newest.at.toISOString(),
        ageHours: Math.round(ageHours * 10) / 10,
      };
    }
  }

  const stuckBefore = new Date(Date.now() - RUN_STUCK_HOURS * 3_600_000);
  const stuck = await db
    .select({ count: count() })
    .from(heartbeatRuns)
    .where(
      and(
        inArray(heartbeatRuns.status, ["queued", "running"]),
        lt(heartbeatRuns.updatedAt, stuckBefore),
      ),
    )
    .then((rows) => Number(rows[0]?.count ?? 0));

  const runsOk = stuck === 0;
  const status: HealthChecks["status"] =
    diskOk && runsOk && (backup === null || backup.ok) ? "ok" : "degraded";

  return {
    status,
    db: { ok: true, latencyMs },
    disk: { ok: diskOk, freeBytes },
    backup,
    runs: { ok: runsOk, stuck },
  };
}
