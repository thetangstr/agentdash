// AgentDash: the ONLY path by which the control plane deletes a Railway
// project (spec §3.4 "Cleanup"). A project is deleted only when all hold:
//   - the box was never claimed (claimed boxes go through §6.5 only);
//   - the project is named agentdash-box-<slug> and is not protected;
//   - the one project with that name in the boxes workspace has the ID
//     recorded on the box row (when one is recorded);
//   - the project lives in the boxes workspace;
//   - its description carries this box's control-plane tag.
// Any mismatch throws DeleteRefused and nothing is deleted.
import type { RailwayClient } from "./client.js";
import { assertBoxProjectName, boxProjectName, projectTag } from "./names.js";

export class DeleteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeleteRefused";
  }
}

export interface DeletableBox {
  id: string;
  slug: string;
  projectId: string | null;
  claimedAt: Date | null;
}

interface ProjectInfo {
  id: string;
  name: string;
  description: string | null;
  workspaceId: string | null;
}

const PROJECT_FIELDS = "id name description workspaceId";

export async function findProjectsByName(client: RailwayClient, workspaceId: string, name: string, signal?: AbortSignal): Promise<ProjectInfo[]> {
  const found: ProjectInfo[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: { projects: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: Array<{ node: ProjectInfo }> } } =
      await client.request(
        "projects",
        `query($w:String!,$after:String){ projects(workspaceId:$w, first:50, after:$after){ pageInfo { hasNextPage endCursor } edges { node { ${PROJECT_FIELDS} } } } }`,
        { w: workspaceId, after },
        { signal },
      );
    found.push(...data.projects.edges.map((e) => e.node).filter((p) => p.name === name));
    if (!data.projects.pageInfo.hasNextPage) break;
    after = data.projects.pageInfo.endCursor;
  }
  return found;
}

async function projectById(client: RailwayClient, id: string, signal?: AbortSignal): Promise<ProjectInfo | null> {
  try {
    const data = await client.request<{ project: ProjectInfo | null }>("project", `query($id:String!){ project(id:$id){ ${PROJECT_FIELDS} } }`, { id }, { signal });
    return data.project;
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) return null;
    throw err;
  }
}

/**
 * Delete the box's project if every guard passes. Returns "absent" when there
 * is nothing to delete (never created, or already gone).
 */
export async function guardedDeleteBoxProject(
  client: RailwayClient,
  box: DeletableBox,
  opts: { workspaceId: string; signal?: AbortSignal },
): Promise<"deleted" | "absent"> {
  if (box.claimedAt) {
    throw new DeleteRefused(`box ${box.slug} was claimed; a claimed box is deleted only through the customer deletion flow`);
  }
  const name = boxProjectName(box.slug);
  assertBoxProjectName(name);
  const byName = await findProjectsByName(client, opts.workspaceId, name, opts.signal);
  if (byName.length > 1) throw new DeleteRefused(`more than one project is named ${name}; refusing to guess`);
  const project = byName[0] ?? null;
  if (project && box.projectId && project.id !== box.projectId) {
    throw new DeleteRefused(`project ID mismatch for ${name}: the workspace has ${project.id}, the box row records ${box.projectId}`);
  }
  if (!project && box.projectId) {
    const other = await projectById(client, box.projectId, opts.signal);
    if (other) throw new DeleteRefused(`project name mismatch: ${box.projectId} is named '${other.name}', expected ${name}`);
    return "absent";
  }
  if (!project) return "absent";
  if (project.name !== name) throw new DeleteRefused(`project name mismatch: '${project.name}', expected ${name}`);
  if (project.workspaceId && project.workspaceId !== opts.workspaceId) {
    throw new DeleteRefused(`project ${project.id} is not in the boxes workspace`);
  }
  if (!(project.description ?? "").includes(projectTag(box.id))) {
    throw new DeleteRefused(`project ${project.id} does not carry this box's control-plane tag; it was not created for box ${box.id}`);
  }
  await client.request<{ projectDelete: boolean }>("projectDelete", `mutation($id:String!){ projectDelete(id:$id) }`, { id: project.id }, { signal: opts.signal });
  return "deleted";
}
