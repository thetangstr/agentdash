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
//   belongs to THIS company:
//     <instance>/projects/<companyId>/<projectId>/...   managed checkout dirs
//     <instance>/workspaces/<agentId>(...)             this company's agents
//     any cwd/providerRef an executionWorkspaces row of this company registers
//   (the third is where git worktrees and other managed execution dirs live).
//   Paths under the instance root are also walked for symbolic links, so a
//   link planted inside a managed area cannot lead back out — the approach
//   instructions-root-confinement.ts uses for bundle roots.
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, executionWorkspaces } from "@paperclipai/db";
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
  // bare "<instance>/projects/<companyId>" (or another company's) never passes.
  const projectsRoot = path.resolve(
    instanceRoot,
    "projects",
    sanitizeFriendlyPathSegment(companyId, "company"),
  );
  if (isConfined(resolvedPath, projectsRoot, false)) {
    const link = firstSymlinkBelowSync(instanceRoot, resolvedPath);
    if (link) return { ok: false, reason: `workspace path traverses a symbolic link (${link})` };
    return { ok: true, resolvedPath };
  }

  // Per-agent instance workspaces — only for an agent that belongs to this
  // company, so "<instance>/workspaces/<foreign-agent>" stays refused.
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
    if (agent) {
      const link = firstSymlinkBelowSync(instanceRoot, resolvedPath);
      if (link) return { ok: false, reason: `workspace path traverses a symbolic link (${link})` };
      return { ok: true, resolvedPath };
    }
  }

  // Registered execution dirs — the server materializes git worktrees and
  // other managed execution workspaces under the paths these rows name; they
  // may live outside the instance root, so both lexical and resolved forms
  // are compared.
  const registered = await db
    .select({ cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef })
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.companyId, companyId));
  for (const row of registered) {
    for (const raw of [row.cwd, row.providerRef]) {
      if (typeof raw !== "string" || raw.trim().length === 0) continue;
      const root = resolveHomeAwarePath(raw.trim());
      if (!path.isAbsolute(root)) continue;
      if (isConfined(resolvedPath, root, true)) return { ok: true, resolvedPath };
    }
  }

  return {
    ok: false,
    reason:
      "workspace path must be inside this company's managed directories " +
      `(${projectsRoot}/..., ${workspacesRoot}/<agent of this company>, or a registered execution workspace)`,
  };
}
