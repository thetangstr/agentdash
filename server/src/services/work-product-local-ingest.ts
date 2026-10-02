// AgentDash: Scan 3 lane I — local deliverables become issue documents.
//
// An agent running on the server's machine sometimes records its deliverable as
// a work product pointing at a file it wrote: `file:///private/tmp/.../plan.md`.
// That link opens nothing for the person reviewing it, and it leaks a filesystem
// path into the UI. Instead, the server reads the file once (text only, size
// capped, confined to the agent's own workspace) into an issue document, and the
// work product links to that document. The absolute path is never stored on the
// work product and never returned.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

/** Largest file pulled into a document. Issue documents cap the body at 512 KiB. */
export const LOCAL_DELIVERABLE_MAX_BYTES = 256 * 1024;

/** Text formats only. Anything else stays unlinked rather than being read. */
const TEXT_EXTENSIONS = new Map<string, "markdown" | "text" | "code">([
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".txt", "text"],
  [".log", "text"],
  [".csv", "code"],
  [".json", "code"],
  [".yaml", "code"],
  [".yml", "code"],
]);

/** Roots so broad that "inside the workspace" would mean "anywhere". */
const TOO_BROAD_ROOTS = new Set(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/private", "/var", "/Users", "/home", "/root", "/etc"]);

export type LocalDeliverableFailure =
  | "not_agent"
  | "invalid_path"
  | "outside_workspace"
  | "not_found"
  | "not_a_file"
  | "unsupported_type"
  | "too_large"
  | "not_text"
  | "empty";

export type LocalDeliverableRead =
  | { ok: true; filename: string; body: string; kind: "markdown" | "text" | "code"; byteSize: number }
  | { ok: false; reason: LocalDeliverableFailure };

export interface LocalWorkProductInput {
  provider?: string | null;
  url?: string | null;
  externalId?: string | null;
  metadata?: Record<string, unknown> | null;
}

function isFileUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && /^file:/i.test(url.trim());
}

/** A work product that points at a file on the server's disk. */
export function isLocalWorkProduct(input: LocalWorkProductInput): boolean {
  return isFileUrl(input.url) || (input.provider ?? "").trim().toLowerCase() === "local";
}

/** The path the agent named, from a file: URL or (provider local) metadata.path / externalId. */
export function localWorkProductPath(input: LocalWorkProductInput): string | null {
  if (isFileUrl(input.url)) {
    try {
      return fileURLToPath(input.url.trim());
    } catch {
      return null;
    }
  }
  const metaPath = input.metadata && typeof input.metadata.path === "string" ? input.metadata.path : null;
  const candidate = metaPath ?? input.externalId ?? null;
  return candidate && candidate.trim() ? candidate.trim() : null;
}

function isContained(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** False for "/", the home directory or anything above it, and shared temp roots. */
export function isAcceptableWorkspaceRoot(root: string): boolean {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) return false;
  if (TOO_BROAD_ROOTS.has(resolved)) return false;
  const home = path.resolve(os.homedir());
  if (isContained(resolved, home)) return false;
  return true;
}

/**
 * Read a text deliverable the agent wrote, confined to `roots`.
 *
 * `roots` must be derived server-side (the authenticated agent's workspace, its
 * run's workspace, its configured cwd), never from the request. The requested
 * path may be absolute or relative to the first root; either way it must
 * resolve, symlinks followed, inside one of the roots. Hidden segments
 * (`.env`, `.ssh/...`) are refused.
 */
export async function readLocalDeliverable(requestedPath: string, roots: string[]): Promise<LocalDeliverableRead> {
  const raw = requestedPath.trim();
  if (!raw || raw.includes("\0")) return { ok: false, reason: "invalid_path" };

  const realRoots: string[] = [];
  for (const root of roots) {
    if (!root || !path.isAbsolute(root) || !isAcceptableWorkspaceRoot(root)) continue;
    const realRoot = await fs.realpath(root).catch(() => null);
    if (realRoot && isAcceptableWorkspaceRoot(realRoot) && !realRoots.includes(realRoot)) realRoots.push(realRoot);
  }
  if (realRoots.length === 0) return { ok: false, reason: "outside_workspace" };

  const candidates = path.isAbsolute(raw) ? [path.resolve(raw)] : realRoots.map((root) => path.resolve(root, raw));
  for (const candidate of candidates) {
    const realPath = await fs.realpath(candidate).catch(() => null);
    if (!realPath) continue;
    const root = realRoots.find((r) => isContained(r, realPath) && realPath !== r);
    if (!root) continue;
    const relative = path.relative(root, realPath);
    if (relative.split(path.sep).some((segment) => segment.startsWith("."))) {
      return { ok: false, reason: "outside_workspace" };
    }
    const kind = TEXT_EXTENSIONS.get(path.extname(realPath).toLowerCase());
    if (!kind) return { ok: false, reason: "unsupported_type" };
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) return { ok: false, reason: "not_a_file" };
    if (stat.size === 0) return { ok: false, reason: "empty" };
    if (stat.size > LOCAL_DELIVERABLE_MAX_BYTES) return { ok: false, reason: "too_large" };
    const bytes = await fs.readFile(realPath);
    if (bytes.includes(0)) return { ok: false, reason: "not_text" };
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: "not_text" };
    }
    return { ok: true, filename: path.basename(realPath), body, kind, byteSize: stat.size };
  }
  // Either missing, or it exists outside every root. Both read as "not found
  // in the workspace": the response never confirms a file exists elsewhere.
  return { ok: false, reason: "not_found" };
}

/** A document key for a deliverable file: `deliverable-<slug>`, within the 64-char key limit. */
export function deliverableDocumentKey(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  return `deliverable-${slug || "file"}`;
}

/** The document body: markdown and text as-is, structured data in a code fence. */
export function deliverableDocumentBody(read: Extract<LocalDeliverableRead, { ok: true }>): string {
  if (read.kind !== "code") return read.body;
  const lang = path.extname(read.filename).slice(1).toLowerCase();
  const fence = read.body.includes("```") ? "~~~~" : "```";
  return `${fence}${lang}\n${read.body.replace(/\n$/, "")}\n${fence}\n`;
}

/** A title that is an absolute path (or a file: URL) shows as its file name. */
export function sanitizeDeliverableTitle(title: string): string {
  const trimmed = title.trim();
  if (isFileUrl(trimmed)) {
    try {
      return path.basename(fileURLToPath(trimmed)) || "Deliverable";
    } catch {
      return "Deliverable";
    }
  }
  if (/^(\/|~\/|[A-Za-z]:[\\/])/.test(trimmed) && !/\s/.test(trimmed)) {
    return path.basename(trimmed) || "Deliverable";
  }
  return title;
}

/**
 * The directories an agent's deliverables may come from, all derived from the
 * authenticated agent: its default workspace, the workspace of the run that is
 * recording the product (when that run is the agent's own, in this company),
 * and its configured cwd.
 */
export async function resolveAgentDeliverableRoots(
  db: Db,
  input: { companyId: string; agentId: string; runId?: string | null },
): Promise<string[]> {
  const roots: string[] = [];
  try {
    roots.push(resolveDefaultAgentWorkspaceDir(input.agentId));
  } catch {
    // Malformed id: no default root.
  }
  if (input.runId) {
    const run = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.companyId, input.companyId),
      ))
      .then((rows) => rows[0] ?? null);
    const snapshot = (run?.contextSnapshot ?? null) as Record<string, unknown> | null;
    const workspace = snapshot?.paperclipWorkspace as Record<string, unknown> | undefined;
    if (workspace && typeof workspace.cwd === "string" && workspace.cwd.trim()) roots.push(workspace.cwd.trim());
  }
  const agent = await db
    .select({ adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  const config = (agent?.adapterConfig ?? null) as Record<string, unknown> | null;
  if (config && typeof config.cwd === "string" && config.cwd.trim()) roots.push(config.cwd.trim());
  return roots;
}
