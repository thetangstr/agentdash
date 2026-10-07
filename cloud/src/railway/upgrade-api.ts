// AgentDash: the Railway GraphQL operations the fleet upgrade uses (SC-12,
// GH #773), beside the provisioner's in ./api.ts. Same rules: fixed query
// strings, every value a variable, which the client never logs.
import type { DeploymentInfo } from "./api.js";
import type { RailwayClient } from "./client.js";
import type { Logger } from "../logger.js";

type Opt = { signal?: AbortSignal };

export interface DeploymentDetail extends DeploymentInfo {
  /** Railway's deployment metadata (JSON): what was deployed, e.g. the image reference or the commit. */
  meta: Record<string, unknown> | null;
}

/** One deployment by id, or null when Railway no longer knows it. */
export async function getDeployment(client: RailwayClient, id: string, o: Opt = {}): Promise<DeploymentDetail | null> {
  const d = await client.request<{ deployment: DeploymentDetail | null }>(
    "deployment",
    `query($id:String!){ deployment(id:$id){ id status createdAt meta } }`,
    { id },
    o,
  );
  if (!d.deployment) return null;
  const meta = d.deployment.meta;
  return { ...d.deployment, meta: meta && typeof meta === "object" && !Array.isArray(meta) ? meta : null };
}

/**
 * What a deployment actually runs, read from its metadata (not from anything
 * the job itself set): every image digest it names, and its commit.
 */
export function deployedArtifact(meta: Record<string, unknown> | null): { digests: string[]; commit: string | null } {
  if (!meta) return { digests: [], commit: null };
  const digests = [...new Set(JSON.stringify(meta).match(/sha256:[0-9a-f]{64}/g) ?? [])];
  const raw = meta.commitHash ?? meta.commitSha ?? null;
  return { digests, commit: typeof raw === "string" && /^[0-9a-f]{7,64}$/i.test(raw) ? raw.toLowerCase() : null };
}

/**
 * Roll the service back to an earlier deployment (Railway redeploys that
 * deployment's image and variables). The new deployment is read back with
 * latestDeployment.
 */
export async function rollbackDeployment(client: RailwayClient, id: string, o: Opt = {}): Promise<void> {
  await client.request("deploymentRollback", `mutation($id:String!){ deploymentRollback(id:$id) }`, { id }, o);
}

/** Take a snapshot (backup) of one volume instance now; returns Railway's workflow id. */
export async function createVolumeBackup(client: RailwayClient, volumeInstanceId: string, o: Opt = {}): Promise<string> {
  const d = await client.request<{ volumeInstanceBackupCreate: { workflowId: string | null } | null }>(
    "volumeInstanceBackupCreate",
    `mutation($v:String!){ volumeInstanceBackupCreate(volumeInstanceId:$v){ workflowId } }`,
    { v: volumeInstanceId },
    o,
  );
  return d.volumeInstanceBackupCreate?.workflowId ?? "requested";
}

// AgentDash: Railway caps a volume at 10 backups (plan limit). Scheduled
// backups expire on their own, but pre-upgrade snapshots are "Manual" backups
// that never expire, so the eleventh upgrade's snapshot was refused and the
// upgrade retried until it died (seen live 2026-10-05). Before each snapshot
// the upgrade frees exactly the slots the new snapshot needs, and only when
// the volume is at the limit. This deletes PRODUCTION backups, so it is
// deliberately narrow:
//   - it plans before it deletes: when too few backups are eligible to make
//     room, it fails without deleting anything;
//   - eligible = named "Manual", no expiry and no scheduleId (scheduled
//     backups carry both), not locked, and not among the newest
//     KEEP_MANUAL_BACKUPS manual ones;
//   - Railway runs one deletion per volume at a time, so after each delete it
//     polls the backup LIST until that backup is gone (never re-sending the
//     delete), inside one bounded window per volume.

export interface VolumeBackup {
  id: string;
  name: string | null;
  createdAt: string;
  expiresAt: string | null;
  /** The backup schedule that took it; null for a backup taken on demand. */
  scheduleId: string | null;
  /** True when Railway reports the backup locked (see backupLockField). Never pruned. */
  locked: boolean;
}

export const DEFAULT_VOLUME_BACKUP_LIMIT = 10;
/** The name Railway gives a backup taken through volumeInstanceBackupCreate without a name. */
export const MANUAL_BACKUP_NAME = "Manual";
/** The newest manual backups a prune will not touch. */
export const KEEP_MANUAL_BACKUPS = 2;
/** The smallest workable limit: the kept manual backups, one prunable, and the new snapshot. */
export const MIN_VOLUME_BACKUP_LIMIT = KEEP_MANUAL_BACKUPS + 2;
/** How long one volume's prune may wait on Railway's deletions in total. */
export const BACKUP_PRUNE_WAIT_MS = 5 * 60_000;

/** Too few backups can be pruned to free a slot. Nothing was deleted on the pass that decided this. Never retried. */
export class BackupPruneExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupPruneExhaustedError";
  }
}

/** Railway's deletion did not finish inside the prune window. Transient: the job retries. */
export class BackupPruneTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupPruneTimeoutError";
  }
}

// Railway's VolumeInstanceBackup type is not documented, and as introspected
// live on 2026-10-06 it has no lock field at all (createdAt creatorId expiresAt
// externalId id name referencedMB scheduleId usedMB volumeInstanceSizeMB). Rather than guess a
// lock field's name (selecting a field that does not exist fails the whole
// query), read the type once per client and select any scalar field whose
// name mentions "lock". Without one, Railway's own refusal ("locked") is the
// backstop, and that backup is skipped.
type IntrospectedType = { kind: string; ofType?: IntrospectedType | null } | null;
const lockFields = new WeakMap<RailwayClient, string | null>();

/** The name of VolumeInstanceBackup's lock field, or null when Railway exposes none (or the schema cannot be read). */
export async function backupLockField(client: RailwayClient, o: Opt & { log?: Logger } = {}): Promise<string | null> {
  if (lockFields.has(client)) return lockFields.get(client)!;
  try {
    const d = await client.request<{ __type: { fields: Array<{ name: string; type: IntrospectedType }> | null } | null }>(
      "backupSchema",
      `query{ __type(name:"VolumeInstanceBackup"){ fields{ name type{ kind ofType{ kind } } } } }`,
      {},
      o,
    );
    const scalar = (t: IntrospectedType) => t?.kind === "SCALAR" || (t?.kind === "NON_NULL" && t.ofType?.kind === "SCALAR");
    const field = (d.__type?.fields ?? []).find((f) => /lock/i.test(f.name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name) && scalar(f.type));
    const name = field?.name ?? null;
    lockFields.set(client, name);
    return name;
  } catch (err) {
    if (o.signal?.aborted) throw err;
    // Not cached: the next prune asks again.
    o.log?.warn("could not read Railway's backup schema; relying on Railway to refuse locked backups", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Every backup on one volume instance, manual and scheduled. */
export async function listVolumeBackups(client: RailwayClient, volumeInstanceId: string, o: Opt & { lockField?: string | null } = {}): Promise<VolumeBackup[]> {
  const lock = o.lockField && /^[A-Za-z_][A-Za-z0-9_]*$/.test(o.lockField) ? o.lockField : null;
  const d = await client.request<{ volumeInstanceBackupList: Array<Record<string, unknown>> | null }>(
    "volumeInstanceBackupList",
    `query($v:String!){ volumeInstanceBackupList(volumeInstanceId:$v){ id name createdAt expiresAt scheduleId${lock ? ` ${lock}` : ""} } }`,
    { v: volumeInstanceId },
    { signal: o.signal },
  );
  return (d.volumeInstanceBackupList ?? []).map((b) => {
    const l = lock ? b[lock] : undefined;
    return {
      id: String(b.id),
      name: typeof b.name === "string" ? b.name : null,
      createdAt: String(b.createdAt),
      expiresAt: typeof b.expiresAt === "string" ? b.expiresAt : null,
      // Anything but an explicit null counts as scheduled (never pruned).
      scheduleId: b.scheduleId === null || b.scheduleId === undefined ? null : String(b.scheduleId),
      // Anything but an explicit "not locked" counts as locked.
      locked: l !== undefined && l !== null && l !== false && l !== "",
    };
  });
}

/** Delete one backup from a volume instance; returns Railway's workflow id. */
export async function deleteVolumeBackup(client: RailwayClient, volumeInstanceId: string, backupId: string, o: Opt = {}): Promise<string> {
  const d = await client.request<{ volumeInstanceBackupDelete: { workflowId: string | null } | null }>(
    "volumeInstanceBackupDelete",
    `mutation($v:String!,$b:String!){ volumeInstanceBackupDelete(volumeInstanceId:$v, volumeInstanceBackupId:$b){ workflowId } }`,
    { v: volumeInstanceId, b: backupId },
    o,
  );
  return d.volumeInstanceBackupDelete?.workflowId ?? "requested";
}

export interface BackupPrunePlan {
  /** Backups that must go before one more fits (0 when the volume is under the limit). */
  need: number;
  /** Prunable backups, oldest first. */
  eligible: VolumeBackup[];
  manual: number;
  locked: number;
}

/** Decide, without touching Railway, how many backups must go and which may. */
export function planBackupPrune(backups: VolumeBackup[], o: { limit: number; keepManual: number; skip?: ReadonlySet<string> }): BackupPrunePlan {
  const need = Math.max(0, backups.length - (o.limit - 1));
  const byAge = (a: VolumeBackup, b: VolumeBackup) => Date.parse(a.createdAt) - Date.parse(b.createdAt);
  const manual = backups.filter((b) => b.name === MANUAL_BACKUP_NAME).sort(byAge);
  // The newest manual backups are kept whatever their lock state.
  const kept = new Set(manual.slice(Math.max(0, manual.length - o.keepManual)).map((b) => b.id));
  const eligible = manual.filter((b) => !kept.has(b.id) && b.expiresAt === null && b.scheduleId === null && !b.locked && !o.skip?.has(b.id));
  return { need, eligible, manual: manual.length, locked: backups.filter((b) => b.locked).length };
}

export interface PruneBackupOptions {
  signal?: AbortSignal;
  /** Railway's per-volume backup cap. */
  limit?: number;
  /** The newest manual backups never pruned. */
  keepManual?: number;
  /** Between list polls while a deletion runs. */
  pollMs?: number;
  /** The whole prune of this volume, including every wait, must finish inside this. */
  waitMs?: number;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Make room for one more backup on a volume instance. Under the limit it
 * deletes nothing. At the limit it deletes the oldest eligible manual
 * backups, one at a time, waiting (by listing) for each to disappear, and
 * re-plans from a fresh list before every delete. Returns the pruned ids.
 * Throws BackupPruneExhaustedError (before deleting anything on that pass)
 * when too few backups are eligible, and BackupPruneTimeoutError when
 * Railway's deletions outrun `waitMs`.
 */
export async function makeRoomForVolumeBackup(client: RailwayClient, volumeInstanceId: string, o: PruneBackupOptions = {}): Promise<string[]> {
  const limit = o.limit ?? DEFAULT_VOLUME_BACKUP_LIMIT;
  const keepManual = o.keepManual ?? KEEP_MANUAL_BACKUPS;
  if (!Number.isInteger(limit) || limit < keepManual + 2) {
    throw new BackupPruneExhaustedError(`backup limit ${limit} is too small: it must be at least ${keepManual + 2} (the ${keepManual} kept manual backups, one to prune, and the new snapshot)`);
  }
  const pollMs = o.pollMs ?? 10_000;
  const waitMs = o.waitMs ?? BACKUP_PRUNE_WAIT_MS;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + waitMs;
  const minutes = `${Math.round(waitMs / 6_000) / 10} min`;
  const lockField = await backupLockField(client, { signal: o.signal, log: o.log });
  const list = () => listVolumeBackups(client, volumeInstanceId, { signal: o.signal, lockField });
  const skipped = new Set<string>();
  const pruned: string[] = [];

  for (;;) {
    if (o.signal?.aborted) throw o.signal.reason;
    const backups = await list();
    const plan = planBackupPrune(backups, { limit, keepManual, skip: skipped });
    if (plan.need === 0) return pruned;
    if (plan.eligible.length < plan.need) {
      throw new BackupPruneExhaustedError(
        `volume instance ${volumeInstanceId} holds ${backups.length} backups at the ${limit}-backup limit; ${plan.need} must go but only ` +
          `${plan.eligible.length} can be pruned (${plan.manual} manual, the newest ${keepManual} always kept, ${plan.locked} locked, the rest scheduled), ` +
          `so none was deleted${pruned.length ? ` on this pass (${pruned.length} pruned earlier: ${pruned.join(", ")})` : ""} — delete one in Railway, then retry the upgrade`,
      );
    }
    const target = plan.eligible[0]!;
    let workflowId: string;
    try {
      workflowId = await deleteVolumeBackup(client, volumeInstanceId, target.id, { signal: o.signal });
    } catch (err) {
      if (o.signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/deletion.*in progress|already.*in progress/i.test(msg)) {
        // Someone else's deletion (Railway runs one per volume): wait, then re-plan,
        // because once it finishes the volume may already have room.
        if (now() >= deadline) {
          throw new BackupPruneTimeoutError(`volume instance ${volumeInstanceId}: another backup deletion was still in progress after ${minutes}; the upgrade will retry`);
        }
        o.log?.info("waiting for a backup deletion already in progress", { volumeInstanceId });
        await sleep(pollMs);
        continue;
      }
      if (/locked/i.test(msg) || (/backup/i.test(msg) && /not found|does not exist/i.test(msg) && !/volume/i.test(msg))) {
        skipped.add(target.id);
        o.log?.warn("a backup could not be pruned; leaving it alone", { volumeInstanceId, backupId: target.id, error: msg });
        continue;
      }
      throw err;
    }
    pruned.push(target.id);
    o.log?.info("pruned an old pre-upgrade backup", { volumeInstanceId, backupId: target.id, createdAt: target.createdAt, workflowId });
    // Railway deletes asynchronously: watch the list, never re-send the delete.
    for (;;) {
      if (now() >= deadline) {
        throw new BackupPruneTimeoutError(`volume instance ${volumeInstanceId}: the deletion of backup ${target.id} had not finished after ${minutes}; the upgrade will retry`);
      }
      await sleep(pollMs);
      if (o.signal?.aborted) throw o.signal.reason;
      if (!(await list()).some((b) => b.id === target.id)) break;
    }
  }
}
