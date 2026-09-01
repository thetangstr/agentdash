import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

/**
 * Reading a file an agent wrote, addressed the way the agent knows it.
 *
 * An agent writes into its own workspace on the machine running the server, then
 * refers to what it made. Until now the only thing it could say was the absolute
 * path — which is true on that machine and meaningless to a person reading the
 * response on a laptop. The fix is for the server to hand back a URL instead, and
 * to do that it has to read the file, which means accepting a path from the agent.
 *
 * That is the whole risk here, so the design removes it rather than filtering it:
 * the workspace root is derived from the *authenticated* agent's id, never from
 * anything the caller sends. The caller supplies only a path relative to a root it
 * cannot name. Traversal, symlinks and absolute escapes are then checked on top —
 * belt and braces over a boundary the caller never had a handle on.
 */

/** Byte value that terminates a C string; a path containing one is an attack, not a typo. */
const NUL = "\0";

export class WorkspaceFileError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_path"
      | "escapes_workspace"
      | "not_found"
      | "not_a_file",
  ) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

/**
 * Extension to content type, as an allowlist.
 *
 * Deliberately not sniffed from the bytes and never taken from the caller: the
 * value ends up on a `Content-Type` header we serve back to a browser, so letting
 * either the file or the agent choose it turns "read my file" into "pick the type
 * my file is interpreted as". Anything unrecognised is served as a download.
 */
const CONTENT_TYPE_BY_EXTENSION = new Map<string, string>([
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".txt", "text/plain"],
  [".log", "text/plain"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".zip", "application/zip"],
]);

/**
 * SVG is absent from the map on purpose. It is script-bearing, and the upload path
 * sanitizes it before storing; there is no sanitizer on this path, so an `.svg`
 * arrives as an opaque download rather than something a browser will execute.
 */
export function contentTypeForWorkspaceFile(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION.get(ext) ?? "application/octet-stream";
}

export interface ResolvedWorkspaceFile {
  /** Absolute path, verified to sit inside the agent's own workspace. */
  absolutePath: string;
  /** Path relative to the workspace root, for logs and the stored filename. */
  relativePath: string;
  /** Basename, used as the attachment's original filename. */
  filename: string;
  byteSize: number;
}

/** True when `child` is `parent` itself or sits beneath it. */
function isContained(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * Resolve a caller-supplied relative path inside one agent's workspace.
 *
 * `agentId` must come from the authenticated actor, not the request body — passing
 * a caller-supplied id here would hand back exactly the boundary this function
 * exists to hold.
 */
export async function resolveAgentWorkspaceFile(
  agentId: string,
  requestedPath: string,
): Promise<ResolvedWorkspaceFile> {
  const raw = typeof requestedPath === "string" ? requestedPath.trim() : "";
  if (!raw) {
    throw new WorkspaceFileError("Path is required.", "invalid_path");
  }
  if (raw.includes(NUL)) {
    throw new WorkspaceFileError("Path contains a null byte.", "invalid_path");
  }
  if (path.isAbsolute(raw)) {
    throw new WorkspaceFileError(
      "Path must be relative to the agent's workspace, not absolute.",
      "invalid_path",
    );
  }

  // `resolveDefaultAgentWorkspaceDir` validates the id shape and throws otherwise,
  // so a malformed agent id cannot widen the root.
  const root = resolveDefaultAgentWorkspaceDir(agentId);
  const candidate = path.resolve(root, raw);

  // First check catches `../` before touching the filesystem.
  if (!isContained(root, candidate)) {
    throw new WorkspaceFileError("Path escapes the agent's workspace.", "escapes_workspace");
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(candidate);
  } catch {
    throw new WorkspaceFileError("File not found in the agent's workspace.", "not_found");
  }

  // Second check is the one that matters: `realpath` has followed every symlink, so
  // a link inside the workspace pointing at /etc/passwd is caught here and only here.
  // The root is resolved too, in case the workspace directory is itself a link.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    throw new WorkspaceFileError("File not found in the agent's workspace.", "not_found");
  }
  if (!isContained(realRoot, realPath)) {
    throw new WorkspaceFileError("Path escapes the agent's workspace.", "escapes_workspace");
  }

  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new WorkspaceFileError("Path is not a regular file.", "not_a_file");
  }

  return {
    absolutePath: realPath,
    relativePath: path.relative(realRoot, realPath),
    filename: path.basename(realPath),
    byteSize: stat.size,
  };
}
