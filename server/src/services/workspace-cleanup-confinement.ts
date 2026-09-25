// AgentDash (security): confinement for recursive deletion of runtime-created
// execution workspace directories.
//
// Archiving a `local_fs` execution workspace whose metadata says
// `createdByRuntime: true` used to `rm -rf` whatever path the row carried in
// `providerRef ?? cwd`. Those fields were writable through the public PATCH
// route, so a company member (or agent key) could point them at any host
// directory and have the archive delete it. The route now treats those fields
// as server-controlled; this module is the defence-in-depth layer: before any
// recursive delete, the target is canonicalised (realpath, so `..` segments and
// symlinked parents are resolved) and must sit strictly inside a directory the
// runtime itself manages under the Paperclip instance root.
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const FRIENDLY_PATH_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;

function sanitizeSegment(value: string): string | null {
  const sanitized = value.trim().replace(FRIENDLY_PATH_SEGMENT_RE, "-").replace(/^-+|-+$/g, "");
  if (!sanitized || sanitized === "." || sanitized === "..") return null;
  return sanitized;
}

/**
 * Directories under which the runtime creates workspace directories itself:
 * - `<instance>/workspaces/<agentId>` (agent default workspaces)
 * - `<instance>/projects/<companyId>/...` (managed project checkouts), scoped to
 *   the owning company when it is known.
 * Nothing outside these roots is ever eligible for runtime recursive deletion.
 */
export function resolveRuntimeManagedWorkspaceRoots(input: { companyId?: string | null } = {}): string[] {
  const instanceRoot = resolvePaperclipInstanceRoot();
  const roots = [path.resolve(instanceRoot, "workspaces")];
  const companySegment = input.companyId ? sanitizeSegment(input.companyId) : null;
  if (companySegment) {
    roots.push(path.resolve(instanceRoot, "projects", companySegment));
  }
  return roots;
}

function isStrictlyInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/**
 * Lexical pre-check (no filesystem access) used for close-readiness previews.
 * The authoritative check is `removeRuntimeManagedWorkspaceDirectory`.
 */
export function isLexicallyInsideManagedRoots(targetPath: string, roots: string[]) {
  if (!path.isAbsolute(targetPath)) return false;
  const resolved = path.resolve(targetPath);
  return roots.some((root) => isStrictlyInside(resolved, path.resolve(root)));
}

export type ManagedWorkspaceRemovalResult =
  | { status: "removed"; resolvedPath: string }
  | { status: "missing"; resolvedPath: string }
  | { status: "refused"; resolvedPath: string | null; reason: string };

/**
 * Recursively remove `targetPath` only if its canonical location is strictly
 * inside one of `managedRoots` (also canonicalised). Refuses relative paths,
 * a target that is itself a symlink, and anything that resolves outside (or
 * equal to) a managed root. Refusals are logged and returned, never thrown.
 */
export async function removeRuntimeManagedWorkspaceDirectory(input: {
  targetPath: string;
  managedRoots: string[];
  workspaceId?: string | null;
}): Promise<ManagedWorkspaceRemovalResult> {
  const refuse = (reason: string, resolvedPath: string | null): ManagedWorkspaceRemovalResult => {
    logger.warn(
      { workspaceId: input.workspaceId ?? null, targetPath: input.targetPath, resolvedPath, reason },
      "Refusing recursive delete of execution workspace path outside runtime-managed roots",
    );
    return { status: "refused", resolvedPath, reason };
  };

  if (!input.targetPath || !path.isAbsolute(input.targetPath)) {
    return refuse("workspace path is not absolute", null);
  }
  const lexicalPath = path.resolve(input.targetPath);

  let stat;
  try {
    stat = await fs.lstat(lexicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", resolvedPath: lexicalPath };
    }
    return refuse(`could not stat workspace path: ${(error as Error).message}`, lexicalPath);
  }
  if (stat.isSymbolicLink()) {
    return refuse("workspace path is a symbolic link", lexicalPath);
  }
  if (!stat.isDirectory()) {
    return refuse("workspace path is not a directory", lexicalPath);
  }

  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(lexicalPath);
  } catch (error) {
    return refuse(`could not resolve workspace path: ${(error as Error).message}`, lexicalPath);
  }

  const canonicalRoots: string[] = [];
  for (const root of input.managedRoots) {
    try {
      canonicalRoots.push(await fs.realpath(path.resolve(root)));
    } catch {
      // A managed root that does not exist cannot contain anything.
    }
  }
  if (!canonicalRoots.some((root) => isStrictlyInside(canonicalPath, root))) {
    return refuse("workspace path resolves outside the runtime-managed workspace roots", canonicalPath);
  }

  await fs.rm(canonicalPath, { recursive: true, force: true });
  return { status: "removed", resolvedPath: canonicalPath };
}
