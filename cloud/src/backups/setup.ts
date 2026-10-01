// AgentDash (GH #733): wiring for the off-box backups (config → store →
// service → scheduler), kept out of index.ts and app.ts so those stay small.
import type { DataKeyring } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { RailwayClient } from "../railway/client.js";
import { loadBackupConfig, type BackupConfig } from "./config.js";
import type { BackupRouteDeps } from "./routes.js";
import { backupService, railwayBackupTokenSource, type BackupEvent, type BackupService } from "./service.js";
import { S3Store } from "./s3.js";

/** How often the scheduler looks for due boxes. */
export const BACKUP_PASS_MS = 5 * 60_000;

export interface Backups {
  config: BackupConfig;
  store: S3Store;
  /** Null without a Railway token (the box's backup token is read from Railway). */
  service: BackupService | null;
  routeDeps: BackupRouteDeps;
}

/** Null when off-box backups are not configured. Throws ConfigError on a partial configuration. */
export function setupBackups(opts: {
  db: CloudDb;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  dataKeys: DataKeyring;
  railway: { client: RailwayClient; workspaceId: string } | null;
  onEvent?: (e: BackupEvent) => void | Promise<void>;
}): Backups | null {
  const config = loadBackupConfig(opts.env ?? process.env);
  if (!config) return null;
  const store = new S3Store({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    prefix: config.prefix,
    virtualHosted: config.virtualHosted,
  });
  const service = opts.railway
    ? backupService({
        db: opts.db,
        log: opts.log.child({ component: "backups" }),
        store,
        publicKey: config.publicKey,
        tokens: railwayBackupTokenSource(opts.railway.client, opts.railway.workspaceId),
        dataKeys: opts.dataKeys,
        retainDaily: config.retainDaily,
        retainWeekly: config.retainWeekly,
        maxAttempts: config.maxAttempts,
        concurrency: config.concurrency,
        hourUtc: config.hourUtc,
        onEvent: opts.onEvent,
      })
    : null;
  return {
    config,
    store,
    service,
    routeDeps: {
      service: service ?? undefined,
      store,
      staleHours: config.staleHours,
      describe: {
        store: store.describe(),
        sealedTo: config.publicKeyId,
        retention: { daily: config.retainDaily, weekly: config.retainWeekly },
        hourUtc: config.hourUtc,
      },
    },
  };
}

/** Run the scheduler pass every BACKUP_PASS_MS; returns a stop function. */
export function startBackupScheduler(service: BackupService, log: Logger): () => void {
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    void service
      .runDue()
      .then((r) => {
        if (r.started.length) log.info("off-box backup pass", { boxes: r.started.length });
      })
      .catch((err: unknown) => log.error("off-box backup pass failed", { err }))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(pass, BACKUP_PASS_MS);
  timer.unref();
  pass();
  return () => clearInterval(timer);
}
