// AgentDash: the Railway GraphQL operations the fleet upgrade uses (SC-12,
// GH #773), beside the provisioner's in ./api.ts. Same rules: fixed query
// strings, every value a variable, which the client never logs.
import type { DeploymentInfo } from "./api.js";
import type { RailwayClient } from "./client.js";

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
