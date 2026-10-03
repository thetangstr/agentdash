// AgentDash (security, GH #980): where a project workspace `cwd` may point.
//
// `project_workspaces.cwd` is the working directory runs execute in. It used
// to accept any non-empty string, so a company member could point a run at
// another company's agent workspace, the instance's own data directory, or
// any host path the server user can read and write — the same class the
// instructions-root confinement (#737) closed for bundle roots.
//
// The rule, applied by the project workspace write routes:
// - An instance admin (or the local_trusted implicit board) may choose any
//   path, as before. Self-hosted installs that keep workspaces in a checkout
//   keep working, and every stored value stays valid while it is unchanged —
//   callers only validate a cwd that is being SET.
// - Everyone else may only choose a cwd inside a server-managed root that
//   belongs to THIS company AND this actor:
//     <instance>/projects/<companyId>/<projectId>/...   managed checkout dirs
//        of a project the actor may see (GH #980 review — an off-list member
//        must not point a run into a restricted project's checkout)
//     <instance>/workspaces/<agentId>/...               instance workspaces of
//        agents the actor MANAGES (own key, or created/stewarded/accountable,
//        plus their reports — see workspace-command-authz.ts)
//   Paths under the instance root are also walked for symbolic links, so a
//   link planted inside a managed area cannot lead back out — the approach
//   instructions-root-confinement.ts uses for bundle roots.
//
// Registered executionWorkspaces rows used to form a third allowed root —
// any row's cwd/providerRef, archived rows included. That let a grandfathered
// or planted row hand an arbitrary subtree (e.g. $HOME) to any member, so
// the category was dropped entirely (GH #980 review): a genuine git
// worktree's providerRef already sits inside one of the managed roots above.
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import {
  resolveHomeAwarePath,
  resolvePaperclipInstanceRoot,
  sanitizeFriendlyPathSegment,
} from "../home-paths.js";
import {
  canonicalizeExistingPrefix,
  firstSymlinkBelowSync,
} from "./instructions-root-confinement.js";

export type CompanyWorkspaceCwdCheck =
  | { ok: true; resolvedPath: string }
  | { ok: false; reason: string };

/**
 * Actor-scoped refinement of the managed roots, supplied by the route layer
 * (which owns the request/visibility helpers). Both are only asked about a
 * path segment that already passed the lexical + symlink containment checks.
 */
export interface CompanyWorkspaceCwdScope {
  /** May the actor use <instance>/projects/<companyId>/<projectId>/... ? */
  isManagedProjectDirAllowed(projectId: string): Promise<boolean>;
  /** May the actor use <instance>/workspaces/<agentId>/... ? */
  isAgentWorkspaceDirAllowed(agentId: string): Promise<boolean>;
}

function isInside(candidate: string, root: string, allowEqual: boolean): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return allowEqual;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Both lexical and symlink-resolved containment — either form must stay inside. */
function isConfined(candidate: string, root: string, allowEqual: boolean): boolean {
  return (
    isInside(path.resolve(candidate), path.resolve(root), allowEqual) &&
    isInside(canonicalizeExistingPrefix(candidate), canonicalizeExistingPrefix(root), allowEqual)
  );
}

/**
 * Is `candidate` a host path inside one of this company's server-managed
 * workspace roots? See the file header for the root list and the authority
 * rule; the caller decides who may bypass it (instance admin, or an unchanged
 * stored value — see assertProjectWorkspaceCwdAuthority).
 */
export async function checkCompanyWorkspaceCwd(
  db: Db,
  companyId: string,
  candidate: unknown,
  scope: CompanyWorkspaceCwdScope,
): Promise<CompanyWorkspaceCwdCheck> {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return { ok: false, reason: "workspace path is empty" };
  }
  const resolvedPath = resolveHomeAwarePath(candidate.trim());
  if (!path.isAbsolute(resolvedPath)) {
    return { ok: false, reason: "workspace path must be absolute" };
  }

  const instanceRoot = resolvePaperclipInstanceRoot();

  // Managed project checkout dirs — strictly inside this company's dir so a
  // bare "<instance>/projects/<companyId>" (or another company's) never
  // passes. The segment directly below names the project the checkout
  // belongs to (see resolveManagedProjectWorkspaceDir): it must be a real
  // project of this company that the actor may see — anything else fails
  // closed rather than guessing which dir it names.
  const projectsRoot = path.resolve(
    instanceRoot,
    "projects",
    sanitizeFriendlyPathSegment(companyId, "company"),
  );
  if (isConfined(resolvedPath, projectsRoot, false)) {
    const projectId = path.relative(projectsRoot, resolvedPath).split(path.sep)[0]!;
    if (!isUuidLike(projectId)) {
      return { ok: false, reason: "workspace path is not inside a managed project directory" };
    }
    if (!(await scope.isManagedProjectDirAllowed(projectId))) {
      return { ok: false, reason: "workspace path is inside a project the actor cannot use" };
    }
    const link = firstSymlinkBelowSync(instanceRoot, resolvedPath);
    if (link) return { ok: false, reason: `workspace path traverses a symbolic link (${link})` };
    return { ok: true, resolvedPath };
  }

  // Per-agent instance workspaces — only for an agent that belongs to this
  // company AND that the actor manages, so "<instance>/workspaces/<foreign-
  // or-unmanaged-agent>" stays refused.
  const workspacesRoot = path.resolve(instanceRoot, "workspaces");
  if (isConfined(resolvedPath, workspacesRoot, false)) {
    const relative = path.relative(workspacesRoot, resolvedPath);
    const agentId = relative.split(path.sep)[0]!;
    const agent = isUuidLike(agentId)
      ? await db
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    if (agent && (await scope.isAgentWorkspaceDirAllowed(agentId))) {
      const link = firstSymlinkBelowSync(instanceRoot, resolvedPath);
      if (link) return { ok: false, reason: `workspace path traverses a symbolic link (${link})` };
      return { ok: true, resolvedPath };
    }
  }

  return {
    ok: false,
    reason:
      "workspace path must be inside this company's managed directories " +
      `(${projectsRoot}/<a project you can see>, or ${workspacesRoot}/<an agent you manage>)`,
  };
}
