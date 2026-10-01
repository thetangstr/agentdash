// AgentDash (GH #733): off-box database backups for hosted boxes.
//
// Once a day per active box (from CLOUD_BACKUP_HOUR_UTC), the control plane:
//   1. claims the box's row for the UTC day in box_backups (the unique index
//      is the claim, so two replicas never back up the same box twice);
//   2. reads the box's AGENTDASH_BACKUP_TOKEN from Railway (in memory only;
//      a box that lacks one gets one with skipDeploys, live at its next deploy);
//   3. POSTs the box's /api/agentdash/backup-export on its Railway host (with
//      the edge secret, which the box enforces once the router is live) and
//      streams the gzipped dump straight into the envelope encryptor
//      (./envelope.ts), sealed to the OFFLINE backup key, into a temp file;
//   4. uploads the envelope to the S3-compatible store, records size and
//      SHA-256, and prunes to CLOUD_BACKUP_RETAIN_DAILY daily plus
//      CLOUD_BACKUP_RETAIN_WEEKLY weekly backups.
// A failure is recorded (redacted) and retried later the same day, up to
// CLOUD_BACKUP_MAX_ATTEMPTS. Every outcome is reported through `onEvent`, the
// hook the alerting work (SC-10) subscribes to; this module sends no alert.
//
// The control plane never holds a backup in plaintext at rest, and cannot
// decrypt one: the restore tool (./restore-tool.ts) runs offline with the
// backup secret key.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { decryptField, type DataKeyring } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { boxBackups, boxEvents, boxes, type BackupTrigger } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { redactString } from "../logger.js";
import { getProject, upsertVariables, variableValue } from "../railway/api.js";
import type { RailwayClient } from "../railway/client.js";
import { escrowKeyId } from "../railway/secrets.js";
import { createEncryptStream } from "./envelope.js";
import type { ObjectStore } from "./s3.js";

export const BACKUP_TOKEN_VAR = "AGENTDASH_BACKUP_TOKEN";
export const BACKUP_EXPORT_PATH = "/api/agentdash/backup-export";
export const EDGE_SECRET_HEADER = "x-agentdash-edge";
const LEASE_MS = 60 * 60_000;
const HEARTBEAT_MS = 5 * 60_000;
const RETRY_SPACING_MINUTES = 30;
const EXPORT_TIMEOUT_MS = 45 * 60_000;
const BACKUP_STATES_FOR_BOXES = ["active"] as const;

export type BoxRow = typeof boxes.$inferSelect;
export type BackupRow = typeof boxBackups.$inferSelect;

/** A box's AGENTDASH_BACKUP_TOKEN, read from (and if missing, installed on) the box's Railway variables. */
export interface BackupTokenSource {
  /** The token, or null when the box has none (the read itself succeeded). Throws on a failed read. */
  get(box: BoxRow, signal?: AbortSignal): Promise<string | null>;
  /** Set a new token with skipDeploys (live at the box's next deploy). */
  install(box: BoxRow, token: string, signal?: AbortSignal): Promise<void>;
}

export function newBackupToken(): string {
  return randomBytes(32).toString("hex");
}

export function railwayBackupTokenSource(client: RailwayClient, workspaceId: string): BackupTokenSource {
  const ids = (box: BoxRow) => {
    if (!box.projectId || !box.environmentId || !box.webServiceId) throw new Error(`box ${box.slug} has no recorded Railway service`);
    return [box.projectId, box.environmentId, box.webServiceId] as const;
  };
  return {
    async get(box, signal) {
      const [p, e, s] = ids(box);
      return await variableValue(client, p, e, s, BACKUP_TOKEN_VAR, { signal });
    },
    async install(box, token, signal) {
      const [p, e, s] = ids(box);
      const project = await getProject(client, p, { signal });
      if (project.workspaceId !== workspaceId) throw new Error("project is not in the boxes workspace");
      await upsertVariables(client, p, e, s, { [BACKUP_TOKEN_VAR]: token }, { signal });
    },
  };
}

/** What the alerting work (SC-10) subscribes to. Never carries a credential or data. */
export interface BackupEvent {
  kind: "backup_succeeded" | "backup_failed" | "backup_gave_up" | "backup_token_installed" | "backup_pruned";
  boxId: string;
  slug: string;
  backupId?: string;
  trigger?: BackupTrigger;
  attempt?: number;
  /** Machine-readable failure reason (see BackupFailure). */
  reason?: string;
  error?: string;
  sizeBytes?: number;
  prunedCount?: number;
  at: string;
}

export type BackupFailureReason =
  | "token_pending_deploy"
  | "token_rejected"
  | "export_unsupported"
  | "box_busy"
  | "box_unreachable"
  | "export_failed"
  | "upload_failed"
  | "not_eligible";

export class BackupFailure extends Error {
  readonly reason: BackupFailureReason;
  constructor(reason: BackupFailureReason, message: string) {
    super(message);
    this.name = "BackupFailure";
    this.reason = reason;
  }
}

export interface BackupServiceDeps {
  db: CloudDb;
  log: Logger;
  store: ObjectStore;
  publicKey: Uint8Array;
  tokens: BackupTokenSource;
  dataKeys: DataKeyring;
  retainDaily: number;
  retainWeekly: number;
  maxAttempts: number;
  concurrency: number;
  hourUtc: number;
  fetch?: typeof fetch;
  now?: () => Date;
  onEvent?: (e: BackupEvent) => void | Promise<void>;
  workerId?: string;
  /** "https" in production; tests use "http" against a local fake box. */
  boxScheme?: "https" | "http";
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO week key (e.g. 2026-W40) of a UTC day. */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Which succeeded backups to keep: the newest of each of the newest
 * `daily` days, plus the newest of each of the newest `weekly` ISO weeks.
 * Rows come newest first. Returns the ids to prune.
 */
export function selectPrunable(rows: Array<{ id: string; backupDay: string; finishedAt: Date | null }>, daily: number, weekly: number): string[] {
  const sorted = [...rows].sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0));
  const keep = new Set<string>();
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const r of sorted) {
    if (!days.has(r.backupDay) && days.size < daily) {
      days.add(r.backupDay);
      keep.add(r.id);
    }
    const w = isoWeek(r.backupDay);
    if (!weeks.has(w) && weeks.size < weekly) {
      weeks.add(w);
      keep.add(r.id);
    }
  }
  // The newest backup is always kept, whatever the settings.
  if (sorted[0]) keep.add(sorted[0].id);
  return sorted.filter((r) => !keep.has(r.id)).map((r) => r.id);
}

function describe(err: unknown): string {
  return redactString(err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

/** Counts a stream's bytes and SHA-256 on the way through. */
function measure(): Transform & { bytes: number; digest(): string } {
  const hash = createHash("sha256");
  const t = new Transform({
    transform(chunk: Buffer, _e, cb) {
      hash.update(chunk);
      (t as unknown as { bytes: number }).bytes += chunk.length;
      cb(null, chunk);
    },
  }) as Transform & { bytes: number; digest(): string };
  t.bytes = 0;
  t.digest = () => hash.digest("hex");
  return t;
}

export function backupService(deps: BackupServiceDeps) {
  const { db, log } = deps;
  const now = () => deps.now?.() ?? new Date();
  const doFetch = deps.fetch ?? fetch;
  const me = deps.workerId ?? `backup-${randomUUID().slice(0, 8)}`;
  const active = new Set<string>();

  const emit = async (e: Omit<BackupEvent, "at">) => {
    try {
      await deps.onEvent?.({ ...e, at: now().toISOString() });
    } catch (err) {
      log.error("backup event hook failed", { err, eventKind: e.kind });
    }
  };

  /** Atomically claim today's scheduled row for a box. Null when someone else has it, it succeeded, or attempts are spent. */
  async function claimScheduled(boxId: string, day: string): Promise<{ id: string; attempt: number } | null> {
    const rows = (await db.execute(sql`
      insert into box_backups (box_id, "trigger", backup_day, state, attempt, locked_by, locked_until)
      values (${boxId}, 'scheduled', ${day}, 'running', 1, ${me}, now() + make_interval(secs => ${LEASE_MS / 1000}))
      on conflict (box_id, backup_day) where "trigger" = 'scheduled' do update
        set state = 'running', attempt = box_backups.attempt + 1, locked_by = excluded.locked_by,
            locked_until = excluded.locked_until, error = null, started_at = now(), finished_at = null, updated_at = now()
        where (box_backups.state = 'failed' and box_backups.attempt < ${deps.maxAttempts}
               and box_backups.finished_at < now() - make_interval(mins => ${RETRY_SPACING_MINUTES}))
           or (box_backups.state = 'running' and box_backups.locked_until < now())
      returning id, attempt`)) as unknown as Array<{ id: string; attempt: number }>;
    return rows[0] ?? null;
  }

  async function finishRow(id: string, patch: Partial<typeof boxBackups.$inferInsert>): Promise<void> {
    await db
      .update(boxBackups)
      .set({ ...patch, lockedBy: null, lockedUntil: null, finishedAt: now(), updatedAt: now() })
      .where(and(eq(boxBackups.id, id), eq(boxBackups.lockedBy, me)));
  }

  /** Pull, encrypt and upload one backup for a claimed row. */
  async function perform(box: BoxRow, row: { id: string; trigger: BackupTrigger; attempt: number; day: string }): Promise<BackupRow | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("backup timed out")), EXPORT_TIMEOUT_MS);
    timer.unref();
    const beat = setInterval(() => {
      void db
        .update(boxBackups)
        .set({ lockedUntil: new Date(now().getTime() + LEASE_MS), updatedAt: now() })
        .where(and(eq(boxBackups.id, row.id), eq(boxBackups.lockedBy, me)))
        .catch((err: unknown) => log.warn("backup lease renewal failed", { err }));
    }, HEARTBEAT_MS);
    beat.unref();
    let dir: string | null = null;
    try {
      if (!box.upstreamHost) throw new BackupFailure("not_eligible", `box ${box.slug} has no Railway host yet`);
      let token = await deps.tokens.get(box, controller.signal);
      if (!token) {
        token = newBackupToken();
        await deps.tokens.install(box, token, controller.signal);
        await db.insert(boxEvents).values({ boxId: box.id, kind: "backup_token_installed", actor: "backups", detail: { takesEffect: "next deploy" } });
        await emit({ kind: "backup_token_installed", boxId: box.id, slug: box.slug, backupId: row.id });
        throw new BackupFailure("token_pending_deploy", `${BACKUP_TOKEN_VAR} was missing; it was set and takes effect at the box's next deploy`);
      }
      const edge = box.edgeSecretEnc ? decryptField(deps.dataKeys, box.edgeSecretEnc, "boxes.edge_secret_enc") : null;
      let res: Response;
      try {
        res = await doFetch(`${deps.boxScheme ?? "https"}://${box.upstreamHost}${BACKUP_EXPORT_PATH}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, ...(edge ? { [EDGE_SECRET_HEADER]: edge } : {}) },
          signal: controller.signal,
        });
      } catch (err) {
        throw new BackupFailure("box_unreachable", `could not reach the box: ${err instanceof Error ? (err.cause as { code?: string } | undefined)?.code ?? err.name : "error"}`);
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        if (res.status === 401) throw new BackupFailure("token_rejected", "the box refused the backup token (a rotated token takes effect at the next deploy)");
        if (res.status === 404) throw new BackupFailure("export_unsupported", "the box has no backup export (release older than GH #733, or its token is not live yet)");
        if (res.status === 409) throw new BackupFailure("box_busy", "the box is already running an export");
        if (res.status === 403) throw new BackupFailure("token_rejected", "the box's edge gate refused the request (edge secret mismatch)");
        throw new BackupFailure("export_failed", `the box answered HTTP ${res.status}`);
      }
      let counts: Record<string, number | null> = {};
      try {
        const raw = res.headers.get("x-agentdash-backup-counts");
        if (raw) counts = JSON.parse(raw) as Record<string, number | null>;
      } catch {
        counts = {};
      }
      // A box with no migrations applied is not a real export: storing it would push good dailies out of retention.
      if (!(typeof counts.migrations === "number" && counts.migrations > 0)) {
        await res.body.cancel().catch(() => {});
        throw new BackupFailure("export_failed", "the export reports no applied migrations; refusing to store it as a backup");
      }
      const format = res.headers.get("x-agentdash-backup-format") ?? "unknown";
      const release = res.headers.get("x-agentdash-backup-release");
      const created = now();
      const objectPath = `${box.slug}/${box.id}/${row.day}/${created.toISOString().replace(/[:.]/g, "-")}-${row.id}.adbk`;

      dir = await mkdtemp(join(tmpdir(), "agentdash-backup-"));
      const file = join(dir, "backup.adbk");
      const plain = measure();
      const cipher = measure();
      const encrypt = await createEncryptStream(deps.publicKey, {
        backupId: row.id,
        boxId: box.id,
        slug: box.slug,
        createdAt: created.toISOString(),
        format,
        release,
        counts,
      });
      try {
        await pipeline(Readable.fromWeb(res.body as never), plain, encrypt, cipher, createWriteStream(file, { mode: 0o600 }), { signal: controller.signal });
      } catch (err) {
        throw new BackupFailure("export_failed", `the export stream failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (plain.bytes === 0) throw new BackupFailure("export_failed", "the box sent an empty export");
      const sha256 = cipher.digest();
      const { size } = await stat(file);
      try {
        await deps.store.put(objectPath, file, { size, sha256 }, { signal: controller.signal });
      } catch (err) {
        throw new BackupFailure("upload_failed", err instanceof Error ? err.message : String(err));
      }
      await finishRow(row.id, {
        state: "succeeded",
        objectPath,
        sizeBytes: size,
        sha256,
        plainBytes: plain.bytes,
        sealedTo: escrowKeyId(deps.publicKey),
        format,
        counts,
        release,
        error: null,
      });
      await db.insert(boxEvents).values({ boxId: box.id, kind: "backup_succeeded", actor: "backups", detail: { backupId: row.id, trigger: row.trigger, sizeBytes: size } });
      await emit({ kind: "backup_succeeded", boxId: box.id, slug: box.slug, backupId: row.id, trigger: row.trigger, attempt: row.attempt, sizeBytes: size });
      try {
        await prune(box);
      } catch (err) {
        log.warn("backup prune failed", { slug: box.slug, error: describe(err) });
      }
      const [done] = await db.select().from(boxBackups).where(eq(boxBackups.id, row.id));
      return done ?? null;
    } catch (err) {
      const reason: BackupFailureReason = err instanceof BackupFailure ? err.reason : "export_failed";
      const error = describe(err);
      await finishRow(row.id, { state: "failed", error: `${reason}: ${error}` });
      log.warn("off-box backup failed", { slug: box.slug, reason, attempt: row.attempt, error });
      const finalAttempt = row.trigger === "manual" || row.attempt >= deps.maxAttempts;
      await db.insert(boxEvents).values({ boxId: box.id, kind: "backup_failed", actor: "backups", detail: { backupId: row.id, reason, attempt: row.attempt, final: finalAttempt } });
      await emit({ kind: finalAttempt ? "backup_gave_up" : "backup_failed", boxId: box.id, slug: box.slug, backupId: row.id, trigger: row.trigger, attempt: row.attempt, reason, error });
      return null;
    } finally {
      clearTimeout(timer);
      clearInterval(beat);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Apply retention to a box's succeeded backups: delete the objects, mark the rows pruned. */
  async function prune(box: Pick<BoxRow, "id" | "slug">): Promise<number> {
    const rows = await db
      .select({ id: boxBackups.id, backupDay: boxBackups.backupDay, finishedAt: boxBackups.finishedAt, objectPath: boxBackups.objectPath })
      .from(boxBackups)
      .where(and(eq(boxBackups.boxId, box.id), eq(boxBackups.state, "succeeded")));
    const doomed = new Set(selectPrunable(rows, deps.retainDaily, deps.retainWeekly));
    let pruned = 0;
    for (const r of rows) {
      if (!doomed.has(r.id)) continue;
      if (r.objectPath) await deps.store.delete(r.objectPath);
      await db
        .update(boxBackups)
        .set({ state: "pruned", prunedAt: now(), updatedAt: now() })
        .where(and(eq(boxBackups.id, r.id), eq(boxBackups.state, "succeeded")));
      pruned++;
    }
    if (pruned) await emit({ kind: "backup_pruned", boxId: box.id, slug: box.slug, prunedCount: pruned });
    return pruned;
  }

  /**
   * One scheduler pass: claim and run today's backup for due boxes, up to the
   * concurrency limit. Resolves when the started backups finish.
   */
  async function runDue(): Promise<{ started: string[] }> {
    const t = now();
    if (t.getUTCHours() < deps.hourUtc) return { started: [] };
    const day = utcDay(t);
    const candidates = (await db.execute(sql`
      select b.id from boxes b
       where b.state in ('active') and b.upstream_host is not null
         and not exists (
           select 1 from box_backups x
            where x.box_id = b.id and x."trigger" = 'scheduled' and x.backup_day = ${day}
              and (x.state in ('succeeded', 'pruned')
                   or (x.state = 'running' and x.locked_until >= now())
                   or (x.state = 'failed' and (x.attempt >= ${deps.maxAttempts}
                       or x.finished_at >= now() - make_interval(mins => ${RETRY_SPACING_MINUTES})))))
       order by b.slug
       limit 200`)) as unknown as Array<{ id: string }>;
    const started: string[] = [];
    const runs: Promise<unknown>[] = [];
    for (const c of candidates) {
      if (active.size >= deps.concurrency) break;
      if (active.has(c.id)) continue;
      const claim = await claimScheduled(c.id, day);
      if (!claim) continue;
      const [box] = await db.select().from(boxes).where(eq(boxes.id, c.id));
      if (!box) continue;
      active.add(box.id);
      started.push(box.slug);
      runs.push(perform(box, { id: claim.id, trigger: "scheduled", attempt: claim.attempt, day }).finally(() => active.delete(box.id)));
    }
    await Promise.allSettled(runs);
    return { started };
  }

  /** An operator's backup of one box now (any time of day; not limited to one per day). */
  async function runManual(slug: string, opts: { wait?: boolean } = {}): Promise<{ backupId: string; done: Promise<BackupRow | null> }> {
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, slug));
    if (!box) throw new BackupFailure("not_eligible", `no box ${slug}`);
    if (!["active", "suspended", "awaiting_claim"].includes(box.state)) throw new BackupFailure("not_eligible", `box ${slug} is ${box.state}`);
    if (active.has(box.id)) throw new BackupFailure("box_busy", `a backup of ${slug} is already running here`);
    const day = utcDay(now());
    const [row] = await db
      .insert(boxBackups)
      .values({ boxId: box.id, trigger: "manual", backupDay: day, state: "running", lockedBy: me, lockedUntil: new Date(now().getTime() + LEASE_MS) })
      .returning({ id: boxBackups.id });
    active.add(box.id);
    const done = perform(box, { id: row!.id, trigger: "manual", attempt: 1, day }).finally(() => active.delete(box.id));
    if (opts.wait) await done;
    return { backupId: row!.id, done };
  }

  return { runDue, runManual, prune, claimScheduled, perform, get activeCount() { return active.size; } };
}

export type BackupService = ReturnType<typeof backupService>;

// ---- Status (the fleet view and the SC-10 alert hook) --------------------

export interface BoxBackupStatus {
  boxId: string;
  slug: string;
  state: string;
  lastSuccessAt: string | null;
  lastSuccessBytes: number | null;
  ageHours: number | null;
  lastAttemptAt: string | null;
  lastAttemptState: string | null;
  lastError: string | null;
  /** An active box with no good backup newer than `staleHours`. */
  stale: boolean;
}

/** Backup status for every live box. For `admin backups status` and SC-10's monitoring. */
export async function fleetBackupStatus(db: CloudDb, opts: { staleHours: number; now?: Date }): Promise<BoxBackupStatus[]> {
  const t = opts.now ?? new Date();
  const live = await db
    .select({ id: boxes.id, slug: boxes.slug, state: boxes.state, claimedAt: boxes.claimedAt, createdAt: boxes.createdAt })
    .from(boxes)
    .where(inArray(boxes.state, ["awaiting_claim", "active", "suspended"]))
    .orderBy(boxes.slug);
  const out: BoxBackupStatus[] = [];
  for (const b of live) {
    const [ok] = await db
      .select({ finishedAt: boxBackups.finishedAt, sizeBytes: boxBackups.sizeBytes })
      .from(boxBackups)
      .where(and(eq(boxBackups.boxId, b.id), eq(boxBackups.state, "succeeded")))
      .orderBy(desc(boxBackups.finishedAt))
      .limit(1);
    const [last] = await db
      .select({ startedAt: boxBackups.startedAt, state: boxBackups.state, error: boxBackups.error })
      .from(boxBackups)
      .where(eq(boxBackups.boxId, b.id))
      .orderBy(desc(boxBackups.startedAt))
      .limit(1);
    const ageHours = ok?.finishedAt ? Math.round(((t.getTime() - ok.finishedAt.getTime()) / 3_600_000) * 10) / 10 : null;
    // A box is expected to have a backup once it has been active for a full stale window.
    const since = b.claimedAt ?? b.createdAt;
    const graceOver = t.getTime() - since.getTime() > opts.staleHours * 3_600_000;
    const stale = (BACKUP_STATES_FOR_BOXES as readonly string[]).includes(b.state) && graceOver && (ageHours === null || ageHours > opts.staleHours);
    out.push({
      boxId: b.id,
      slug: b.slug,
      state: b.state,
      lastSuccessAt: ok?.finishedAt?.toISOString() ?? null,
      lastSuccessBytes: ok?.sizeBytes ?? null,
      ageHours,
      lastAttemptAt: last?.startedAt.toISOString() ?? null,
      lastAttemptState: last?.state ?? null,
      lastError: last?.state === "failed" ? last.error : null,
      stale,
    });
  }
  return out;
}

/** The boxes SC-10 should alert on: active, past their grace period, and without a recent good backup. */
export async function staleBackups(db: CloudDb, opts: { staleHours: number; now?: Date }): Promise<BoxBackupStatus[]> {
  return (await fleetBackupStatus(db, opts)).filter((s) => s.stale);
}
