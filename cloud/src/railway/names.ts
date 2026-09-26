// AgentDash: box project names and the guards around them, ported verbatim
// from scripts/hosted/lib.sh (assert_box_project_name, PROTECTED_PROJECTS)
// for the control plane (spec §3.3 step 2, §3.4 cleanup).
//
// The dedicated boxes workspace already puts the protected projects out of
// the token's reach; the guard stays anyway, so a mistyped workspace or token
// can never touch them.

export const BOX_PROJECT_PREFIX = "agentdash-box-";

/** Projects the control plane must never touch, even by name collision. */
export const PROTECTED_PROJECTS: readonly string[] = ["agentdash", "agentdash-demo", "yarda-backend-v2", "perceptive-integrity"];

export class ProjectNameRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectNameRefused";
  }
}

export function boxProjectName(slug: string): string {
  return `${BOX_PROJECT_PREFIX}${slug}`;
}

export function assertBoxProjectName(name: string): void {
  if (PROTECTED_PROJECTS.includes(name)) throw new ProjectNameRefused(`refusing to touch protected project '${name}'`);
  if (!name.startsWith(BOX_PROJECT_PREFIX)) {
    throw new ProjectNameRefused(`refusing to touch '${name}': box projects are named ${BOX_PROJECT_PREFIX}<slug>`);
  }
}

/**
 * The control-plane tag written into every box project's description. It
 * names the box row, so cleanup deletes only a project this control plane
 * created for exactly that box.
 */
export function projectTag(boxId: string): string {
  return `agentdash-cloud-box:${boxId}`;
}

export function boxProjectDescription(boxId: string): string {
  return `AgentDash hosted box, managed by the agentdash-cloud control plane. ${projectTag(boxId)}`;
}
