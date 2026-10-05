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
// the upgrade prunes the oldest manual backups — never scheduled ones, never
// a locked one, and never the newest KEEP_MANUAL_BACKUPS — until one slot is
// free. Railway also runs only one deletion per volume at a time, so deletions
// are waited out by polling the list, inside a bounded window.

export interface VolumeBackup {
  id: string;
  name: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export const DEFAULT_VOLUME_BACKUP_LIMIT = 10;
/** The name Railway gives a backup taken through volumeInstanceBackupCreate. */
export const MANUAL_BACKUP_NAME = "Manual";
/** The newest manual backups a prune will not touch. */
export const KEEP_MANUAL_BACKUPS = 2;
/** How long to keep waiting for deletions Railway is still running. */
export const BACKUP_PRUNE_WAIT_MS = 5 * 60_000;

/** Pruning cannot free a slot: scheduled, kept, or locked backups fill the volume. Never retried. */
export class BackupPruneExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupPruneExhaustedError";
  }
}

/** Every backup on one volume instance, manual and scheduled. */
export async function listVolumeBackups(client: RailwayClient, volumeInstanceId: string, o: Opt = {}): Promise<VolumeBackup[]> {
  const d = await client.request<{ volumeInstanceBackupList: VolumeBackup[] | null }>(
    "volumeInstanceBackupList",
    `query($v:String!){ volumeInstanceBackupList(volumeInstanceId:$v){ id name createdAt expiresAt } }`,
    { v: volumeInstanceId },
    o,
  );
  return d.volumeInstanceBackupList ?? [];
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

export interface PruneBackupOptions {
  signal?: AbortSignal;
  /** Railway's per-volume backup cap. */
  limit?: number;
  /** The newest manual backups never pruned. */
  keepManual?: number;
  /** Between delete attempts while a deletion is in flight. */
  pollMs?: number;
  /** Give up waiting when no deletion has completed for this long. */
  waitMs?: number;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Delete the oldest eligible manual backups until createVolumeBackup has a
 * free slot. A backup is eligible when it is named "Manual" and is not among
 * the newest `keepManual` manual ones. Refusals (locked, already gone) skip
 * that backup; a deletion Railway is still running is waited out; when no
 * eligible backup is left — or waiting outran `waitMs` without progress —
 * BackupPruneExhaustedError names the volume so the caller fails the job.
 */
export async function makeRoomForVolumeBackup(client: RailwayClient, volumeInstanceId: string, o: PruneBackupOptions = {}): Promise<void> {
  const limit = o.limit ?? DEFAULT_VOLUME_BACKUP_LIMIT;
  const keepManual = o.keepManual ?? KEEP_MANUAL_BACKUPS;
  const pollMs = o.pollMs ?? 10_000;
  const waitMs = o.waitMs ?? BACKUP_PRUNE_WAIT_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const skipped = new Set<string>();
  let lastProgress = Date.now();

  for (;;) {
    if (o.signal?.aborted) throw o.signal.reason;
    const backups = await listVolumeBackups(client, volumeInstanceId, { signal: o.signal });
    // One free slot after the new snapshot is taken: prune only at limit - 1.
    if (backups.length < limit - 1) return;
    const candidates = backups
      .filter((b) => b.name === MANUAL_BACKUP_NAME && !skipped.has(b.id))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const eligible = candidates.slice(0, Math.max(0, candidates.length - keepManual));
    if (eligible.length === 0) {
      const manual = backups.filter((b) => b.name === MANUAL_BACKUP_NAME).length;
      throw new BackupPruneExhaustedError(
        `volume instance ${volumeInstanceId} holds ${backups.length} backups at the ${limit}-backup limit and none can be pruned ` +
          `(${manual} manual, of which the newest ${keepManual} are always kept${manual ? "" : "; the rest are scheduled"}) — delete one in Railway, then retry the upgrade`,
      );
    }
    const target = eligible[0]!;
    try {
      const workflowId = await deleteVolumeBackup(client, volumeInstanceId, target.id, { signal: o.signal });
      lastProgress = Date.now();
      o.log?.info("pruned an old pre-upgrade backup", { volumeInstanceId, backupId: target.id, createdAt: target.createdAt, workflowId });
      await sleep(pollMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/deletion.*in progress|already.*in progress/i.test(msg)) {
        if (Date.now() - lastProgress > waitMs) {
          throw new BackupPruneExhaustedError(
            `volume instance ${volumeInstanceId}: a backup deletion has been in progress for over ${Math.round(waitMs / 60_000)} min without completing — check the volume in Railway, then retry the upgrade`,
          );
        }
        await sleep(pollMs);
        continue;
      }
      if (/locked|not found|does not exist/i.test(msg)) {
        skipped.add(target.id);
        o.log?.warn("a backup could not be pruned; leaving it alone", { volumeInstanceId, backupId: target.id, error: msg });
        continue;
      }
      throw err;
    }
  }
}
