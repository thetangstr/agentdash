// AgentDash: the Railway GraphQL operations the fleet upgrade uses (SC-12,
// GH #773), beside the provisioner's in ./api.ts. Same rules: fixed query
// strings, every value a variable, which the client never logs.
import type { DeploymentInfo } from "./api.js";
import type { RailwayClient } from "./client.js";

type Opt = { signal?: AbortSignal };

/** One deployment by id, or null when Railway no longer knows it. */
export async function getDeployment(client: RailwayClient, id: string, o: Opt = {}): Promise<DeploymentInfo | null> {
  const d = await client.request<{ deployment: DeploymentInfo | null }>(
    "deployment",
    `query($id:String!){ deployment(id:$id){ id status createdAt } }`,
    { id },
    o,
  );
  return d.deployment ?? null;
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
