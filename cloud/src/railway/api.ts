// AgentDash: the Railway GraphQL operations the provisioner uses (SC-2,
// GH #763), each a thin typed wrapper over RailwayClient. Queries are fixed
// strings; every value travels as a variable, which the client never logs.
import type { RailwayClient } from "./client.js";

type Opt = { signal?: AbortSignal };

export interface ServiceInfo {
  id: string;
  name: string;
  instances: Array<{ environmentId: string; image: string | null; repo: string | null }>;
}

export interface VolumeInstanceInfo {
  id: string;
  volumeId: string;
  serviceId: string | null;
  mountPath: string;
  environmentId: string;
}

export interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  workspaceId: string | null;
  environments: Array<{ id: string; name: string }>;
  services: ServiceInfo[];
  volumes: VolumeInstanceInfo[];
}

export interface DeploymentInfo {
  id: string;
  status: string;
  createdAt: string;
}

const PROJECT_DETAIL = `id name description workspaceId
  environments { edges { node { id name } } }
  services { edges { node { id name serviceInstances { edges { node { environmentId source { image repo } } } } } } }
  volumes { edges { node { id volumeInstances { edges { node { id volumeId serviceId mountPath environmentId } } } } } }`;

interface RawProject {
  id: string;
  name: string;
  description: string | null;
  workspaceId: string | null;
  environments: { edges: Array<{ node: { id: string; name: string } }> };
  services: {
    edges: Array<{
      node: { id: string; name: string; serviceInstances: { edges: Array<{ node: { environmentId: string; source: { image: string | null; repo: string | null } | null } }> } };
    }>;
  };
  volumes: { edges: Array<{ node: { id: string; volumeInstances: { edges: Array<{ node: VolumeInstanceInfo }> } } }> };
}

function toDetail(p: RawProject): ProjectDetail {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    workspaceId: p.workspaceId,
    environments: p.environments.edges.map((e) => e.node),
    services: p.services.edges.map((e) => ({
      id: e.node.id,
      name: e.node.name,
      instances: e.node.serviceInstances.edges.map((i) => ({
        environmentId: i.node.environmentId,
        image: i.node.source?.image ?? null,
        repo: i.node.source?.repo ?? null,
      })),
    })),
    volumes: p.volumes.edges.flatMap((v) => v.node.volumeInstances.edges.map((i) => ({ ...i.node, volumeId: i.node.volumeId ?? v.node.id }))),
  };
}

export async function getProject(client: RailwayClient, id: string, o: Opt = {}): Promise<ProjectDetail> {
  const d = await client.request<{ project: RawProject }>("project", `query($id:String!){ project(id:$id){ ${PROJECT_DETAIL} } }`, { id }, o);
  return toDetail(d.project);
}

export async function createProject(
  client: RailwayClient,
  input: { name: string; workspaceId: string; description: string },
  o: Opt = {},
): Promise<{ id: string }> {
  const d = await client.request<{ projectCreate: { id: string } }>(
    "projectCreate",
    `mutation($i:ProjectCreateInput!){ projectCreate(input:$i){ id } }`,
    { i: { name: input.name, workspaceId: input.workspaceId, description: input.description, defaultEnvironmentName: "production" } },
    o,
  );
  return d.projectCreate;
}

export async function createService(client: RailwayClient, input: { projectId: string; environmentId: string; name: string }, o: Opt = {}): Promise<string> {
  const d = await client.request<{ serviceCreate: { id: string } }>("serviceCreate", `mutation($i:ServiceCreateInput!){ serviceCreate(input:$i){ id } }`, { i: input }, o);
  return d.serviceCreate.id;
}

export async function createVolume(
  client: RailwayClient,
  input: { projectId: string; environmentId: string; serviceId: string; mountPath: string },
  o: Opt = {},
): Promise<string> {
  const d = await client.request<{ volumeCreate: { id: string } }>("volumeCreate", `mutation($i:VolumeCreateInput!){ volumeCreate(input:$i){ id } }`, { i: input }, o);
  return d.volumeCreate.id;
}

export class VariablesUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VariablesUnreadable";
  }
}

/**
 * The NAMES of a service's variables. Throws VariablesUnreadable when the read
 * fails or the answer is not an object: a caller must never mistake "could not
 * read" for "not set" (that would regenerate live secrets, lib.sh rule).
 */
export async function variableNames(client: RailwayClient, p: string, e: string, s: string, o: Opt = {}): Promise<string[]> {
  let d: { variables: unknown };
  try {
    d = await client.request<{ variables: unknown }>(
      "variables",
      `query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s, unrendered:true) }`,
      { p, e, s },
      o,
    );
  } catch (err) {
    throw new VariablesUnreadable(`could not read the service's variables: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!d.variables || typeof d.variables !== "object" || Array.isArray(d.variables)) {
    throw new VariablesUnreadable("Railway returned no variables object");
  }
  return Object.keys(d.variables);
}

/** One variable's rendered VALUE, for in-memory use only (never logged). Throws VariablesUnreadable on a failed read. */
export async function variableValue(client: RailwayClient, p: string, e: string, s: string, name: string, o: Opt = {}): Promise<string | null> {
  let d: { variables: Record<string, string> | null };
  try {
    d = await client.request<{ variables: Record<string, string> | null }>(
      "variables",
      `query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }`,
      { p, e, s },
      o,
    );
  } catch (err) {
    throw new VariablesUnreadable(`could not read the service's variables: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!d.variables || typeof d.variables !== "object") throw new VariablesUnreadable("Railway returned no variables object");
  return d.variables[name] ?? null;
}

/** Upsert variables without triggering a deploy (they take effect at the next deploy). */
export async function upsertVariables(client: RailwayClient, p: string, e: string, s: string, variables: Record<string, string>, o: Opt = {}): Promise<void> {
  await client.request(
    "variableCollectionUpsert",
    `mutation($i:VariableCollectionUpsertInput!){ variableCollectionUpsert(input:$i) }`,
    { i: { projectId: p, environmentId: e, serviceId: s, variables, skipDeploys: true } },
    o,
  );
}

export async function serviceDomains(client: RailwayClient, p: string, e: string, s: string, o: Opt = {}): Promise<string[]> {
  const d = await client.request<{ domains: { serviceDomains: Array<{ domain: string }> } }>(
    "domains",
    `query($p:String!,$e:String!,$s:String!){ domains(projectId:$p, environmentId:$e, serviceId:$s){ serviceDomains { domain } } }`,
    { p, e, s },
    o,
  );
  return d.domains.serviceDomains.map((x) => x.domain);
}

export async function createServiceDomain(client: RailwayClient, e: string, s: string, targetPort: number, o: Opt = {}): Promise<string> {
  const d = await client.request<{ serviceDomainCreate: { domain: string } }>(
    "serviceDomainCreate",
    `mutation($i:ServiceDomainCreateInput!){ serviceDomainCreate(input:$i){ domain } }`,
    { i: { environmentId: e, serviceId: s, targetPort } },
    o,
  );
  return d.serviceDomainCreate.domain;
}

export async function updateServiceInstance(client: RailwayClient, s: string, e: string, input: Record<string, unknown>, o: Opt = {}): Promise<void> {
  await client.request(
    "serviceInstanceUpdate",
    `mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:$i) }`,
    { s, e, i: input },
    o,
  );
}

export async function latestDeployment(client: RailwayClient, p: string, e: string, s: string, o: Opt = {}): Promise<DeploymentInfo | null> {
  const d = await client.request<{ deployments: { edges: Array<{ node: DeploymentInfo }> } }>(
    "deployments",
    `query($i:DeploymentListInput!){ deployments(first:1, input:$i){ edges { node { id status createdAt } } } }`,
    { i: { projectId: p, environmentId: e, serviceId: s } },
    o,
  );
  return d.deployments.edges[0]?.node ?? null;
}

export async function deployService(client: RailwayClient, s: string, e: string, commitSha: string | null, o: Opt = {}): Promise<string> {
  const d = await client.request<{ serviceInstanceDeployV2: string }>(
    "serviceInstanceDeployV2",
    `mutation($s:String!,$e:String!,$c:String){ serviceInstanceDeployV2(serviceId:$s, environmentId:$e, commitSha:$c) }`,
    { s, e, c: commitSha },
    o,
  );
  return d.serviceInstanceDeployV2;
}

export async function setBackupSchedule(client: RailwayClient, volumeInstanceId: string, kinds: Array<"DAILY" | "WEEKLY" | "MONTHLY">, o: Opt = {}): Promise<void> {
  await client.request(
    "volumeInstanceBackupScheduleUpdate",
    `mutation($v:String!,$k:[VolumeInstanceBackupScheduleKind!]!){ volumeInstanceBackupScheduleUpdate(volumeInstanceId:$v, kinds:$k) }`,
    { v: volumeInstanceId, k: kinds },
    o,
  );
}

export async function deploymentTriggerIds(client: RailwayClient, p: string, e: string, s: string, o: Opt = {}): Promise<string[]> {
  const d = await client.request<{ deploymentTriggers: { edges: Array<{ node: { id: string } }> } }>(
    "deploymentTriggers",
    `query($p:String!,$e:String!,$s:String!){ deploymentTriggers(projectId:$p, environmentId:$e, serviceId:$s){ edges { node { id } } } }`,
    { p, e, s },
    o,
  );
  return d.deploymentTriggers.edges.map((x) => x.node.id);
}

export async function deleteDeploymentTrigger(client: RailwayClient, id: string, o: Opt = {}): Promise<void> {
  await client.request("deploymentTriggerDelete", `mutation($id:String!){ deploymentTriggerDelete(id:$id) }`, { id }, o);
}

/** Terminal deployment states: SUCCESS is the only good one. */
export const DEPLOY_FAILED = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);
export const DEPLOY_IN_PROGRESS = new Set(["QUEUED", "WAITING", "INITIALIZING", "BUILDING", "DEPLOYING", "NEEDS_APPROVAL"]);
