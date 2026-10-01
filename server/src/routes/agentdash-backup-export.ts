// AgentDash (GH #733): the hosted box's off-box backup export.
//
// The self-serve control plane (cloud/src/backups/) calls this once a day per
// box, encrypts what it gets to the offline backup public key and stores it in
// object storage. The box itself holds no storage credentials and no
// encryption key: it only produces a fresh dump for a caller that presents
// AGENTDASH_BACKUP_TOKEN.
//
//   POST /api/agentdash/backup-export
//   Authorization: Bearer <AGENTDASH_BACKUP_TOKEN>
//
// Rules:
//   - with AGENTDASH_BACKUP_TOKEN unset (or shorter than 32 characters) the
//     route does not exist: local, on-prem and self-hosted installs are
//     unchanged;
//   - the token is compared in constant time (fixed-length digests); a wrong
//     or missing one answers 401 without running anything;
//   - one export at a time (409 while one runs), so a retrying caller cannot
//     stack dumps on the box;
//   - the dump is written to a fresh temporary directory, streamed, and
//     removed whether or not the transfer finished. It never joins the
//     on-volume backup directory or its retention;
//   - row counts of the core tables travel in a header (counts only, never
//     data) so a restore can be checked against what was exported.
// Behind the edge router the request still needs X-AgentDash-Edge (the edge
// gate runs first); the control plane holds that secret and sends it.
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { RequestHandler } from "express";

export const BACKUP_EXPORT_PATH = "/api/agentdash/backup-export";
export const BACKUP_EXPORT_FORMAT = "paperclip-sql-gz-v1";
export const BACKUP_COUNTS_HEADER = "x-agentdash-backup-counts";
export const BACKUP_FORMAT_HEADER = "x-agentdash-backup-format";
export const BACKUP_RELEASE_HEADER = "x-agentdash-backup-release";
export const MIN_BACKUP_TOKEN_LENGTH = 32;
export const DEFAULT_EXPORT_TIMEOUT_MS = 30 * 60_000;

export type BackupCounts = Record<string, number | null>;

export interface BackupExport {
  /** The gzipped SQL dump (packages/db backup-lib format). */
  file: string;
  counts: BackupCounts;
  /** Removes the dump and its directory. Must not throw. */
  cleanup(): Promise<void>;
}

export interface BackupExportService {
  run(): Promise<BackupExport>;
  /** Stop the running dump (called on the hard timeout); it must then settle soon. */
  abort?(): Promise<void>;
}

/** The configured export token, or null when the export is off (unset or too short). */
export function configuredBackupToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.AGENTDASH_BACKUP_TOKEN ?? "").trim();
  return v.length >= MIN_BACKUP_TOKEN_LENGTH ? v : null;
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function backupTokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const presented = m?.[1] ?? "";
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(token, "utf8").digest();
  return timingSafeEqual(a, b) && presented.length === token.length;
}

/**
 * Core-table row counts for the restore check. Tables that do not exist (an
 * older schema) report null rather than failing the export.
 */
export const BACKUP_COUNT_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["companies", "public.companies"],
  ["users", 'public."user"'],
  ["agents", "public.agents"],
  ["issues", "public.issues"],
  ["memberships", "public.company_memberships"],
  ["migrations", "drizzle.__drizzle_migrations"],
];

export async function collectBackupCounts(query: (text: string) => Promise<Array<Record<string, unknown>>>): Promise<BackupCounts> {
  const out: BackupCounts = {};
  for (const [name, table] of BACKUP_COUNT_TABLES) {
    const [exists] = await query(`select to_regclass('${table.replace(/'/g, "''")}') is not null as present`);
    if (!exists?.present) {
      out[name] = null;
      continue;
    }
    const [row] = await query(`select count(*)::int as n from ${table}`);
    out[name] = Number(row?.n ?? 0);
  }
  return out;
}

export function backupExportRoutes(opts: {
  token: string | null;
  service?: BackupExportService;
  release?: string | null;
  log?: { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
  /** Hard cap on producing the dump (default 30 minutes); the dump is then aborted. */
  timeoutMs?: number;
  /** How long an aborted dump may take to settle before its slot is given up (default 60 s). */
  abortGraceMs?: number;
}): RequestHandler {
  let inFlight = false;
  return (req, res, next) => {
    const path = (req.originalUrl ?? req.url).split("?")[0]!.replace(/\/+$/, "");
    if (path !== BACKUP_EXPORT_PATH || !opts.token || !opts.service) return next();
    if (req.method !== "POST") {
      res.status(405).set("allow", "POST").json({ error: "method not allowed" });
      return;
    }
    if (!backupTokenMatches(req.headers.authorization, opts.token)) {
      res.status(401).json({ error: "backup token required" });
      return;
    }
    // The token must never reach a later handler or a log line.
    delete req.headers.authorization;
    if (inFlight) {
      res.status(409).json({ error: "a backup export is already running" });
      return;
    }
    inFlight = true;
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
    // The slot is freed, and the dump removed, only once BOTH the dump has
    // settled (or timed out) AND the response is closed, whichever comes
    // last: a caller that hangs up mid-dump neither leaks the temp file nor
    // leaves the next export stuck on 409 (security review of #899).
    let exported: BackupExport | null = null;
    let runSettled = false;
    let timedOut = false;
    let responseClosed = false;
    let released = false;
    let stream: ReturnType<typeof createReadStream> | null = null;
    let outcome = "aborted";
    const cleanupExport = () => {
      const e = exported;
      exported = null;
      if (e) void e.cleanup().catch(() => {});
    };
    // After a timeout the dump is aborted (its database sessions terminated)
    // and the slot stays taken until it actually settles, so dumps never stack;
    // only if it has not settled within the grace period is the slot given up.
    let abandoned = false;
    const maybeRelease = () => {
      if (released || !responseClosed || !(runSettled || abandoned)) return;
      released = true;
      if (runSettled) cleanupExport();
      inFlight = false;
      opts.log?.info({ outcome, durationMs: Date.now() - started }, "off-box backup export finished");
    };
    // Registered BEFORE the dump starts, so a disconnect during it is seen.
    res.on("close", () => {
      responseClosed = true;
      stream?.destroy();
      if (res.writableFinished && outcome === "streaming") outcome = "sent";
      maybeRelease();
    });

    const run = opts.service!.run();
    run.then(
      (e) => {
        exported = e;
        runSettled = true;
        // Nobody will stream it: the caller left, or the timeout already answered.
        if (timedOut || responseClosed || req.destroyed || res.destroyed) cleanupExport();
        maybeRelease();
      },
      () => {
        runSettled = true;
        maybeRelease();
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    });

    void (async () => {
      try {
        const first = await Promise.race([run, deadline]);
        if (first === "timeout") {
          timedOut = true;
          outcome = "timeout";
          opts.log?.error({ timeoutMs }, "off-box backup export timed out");
          if (!res.headersSent && !res.destroyed) res.status(504).json({ error: "backup export timed out" });
          else res.destroy();
          void opts.service!.abort?.().catch((err: unknown) => opts.log?.error({ err }, "off-box backup export abort failed"));
          const grace = setTimeout(() => {
            abandoned = true;
            maybeRelease();
          }, opts.abortGraceMs ?? 60_000);
          grace.unref?.();
          maybeRelease();
          return;
        }
        if (responseClosed || req.destroyed || res.destroyed || !exported) return;
        const current: BackupExport = exported;
        const { size } = await stat(current.file);
        if (responseClosed || res.destroyed) return;
        outcome = "streaming";
        res.status(200);
        res.setHeader("content-type", "application/gzip");
        res.setHeader("content-length", String(size));
        res.setHeader("cache-control", "no-store");
        res.setHeader(BACKUP_FORMAT_HEADER, BACKUP_EXPORT_FORMAT);
        res.setHeader(BACKUP_COUNTS_HEADER, JSON.stringify(current.counts));
        if (opts.release) res.setHeader(BACKUP_RELEASE_HEADER, opts.release);
        stream = createReadStream(current.file);
        stream.on("error", (err) => {
          opts.log?.error({ err }, "off-box backup export stream failed");
          res.destroy(err);
        });
        stream.pipe(res);
      } catch (err) {
        outcome = "failed";
        opts.log?.error({ err }, "off-box backup export failed");
        if (!res.headersSent && !res.destroyed) res.status(500).json({ error: "backup export failed" });
        else res.destroy();
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
  };
}
