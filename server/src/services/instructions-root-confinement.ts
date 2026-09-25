// AgentDash (security, #737): where an agent's instructions bundle may live.
//
// An instructions bundle is a directory the server `mkdir -p`s, lists, reads
// and writes files into. Its root used to be any absolute host path, so a
// company owner could point it at `~/.config/agentdash` (the env file the
// launchd wrapper sources as shell), `~/.ssh` or `~/.hermes` and write host
// code execution into place, or read any host file back through the bundle
// file route.
//
// The rule, applied by routes/agents.ts and the host-execution policy:
// - An instance admin (or the local_trusted implicit board) may choose any
//   external root, as before. Self-hosted installs that keep bundles in a
//   checkout keep working.
// - Everyone else may only use a root inside this company's instructions area
//   under the instance home:
//     <instance>/companies/<companyId>/shared-instructions/...
//     <instance>/companies/<companyId>/agents/<agentId>/instructions/...
//   (the second is where managed bundles already live). The path is checked
//   lexically and then component by component with lstat, and any symbolic
//   link below the instance root is refused, so a link planted inside the
//   area cannot lead back out — the approach #717 uses for workspace deletes.
// - Whatever the root, file reads, writes and deletes stay inside it: every
//   path component below the root is lstat'd and a symbolic link is refused,
//   so a link inside an admin-chosen root cannot reach the rest of the host.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unprocessable } from "../errors.js";
import { resolveHomeAwarePath, resolvePaperclipInstanceRoot } from "../home-paths.js";

export const COMPANY_SHARED_INSTRUCTIONS_DIR = "shared-instructions";
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

function companyBase(companyId: string): string | null {
  const segment = companyId.trim();
  if (!SAFE_SEGMENT.test(segment)) return null;
  return path.resolve(resolvePaperclipInstanceRoot(), "companies", segment);
}

/** `<instance>/companies/<companyId>/shared-instructions`, for external bundles a non-admin may use. */
export function resolveCompanySharedInstructionsRoot(companyId: string): string {
  const base = companyBase(companyId);
  if (!base) throw unprocessable("Invalid company id for an instructions path");
  return path.resolve(base, COMPANY_SHARED_INSTRUCTIONS_DIR);
}

function isInside(candidate: string, root: string, allowEqual: boolean): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return allowEqual;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Lexical only: does `absolutePath` sit in this company's instructions area? */
export function isLexicallyWithinCompanyInstructionsArea(companyId: string, absolutePath: string): boolean {
  const base = companyBase(companyId);
  if (!base || !path.isAbsolute(absolutePath)) return false;
  const resolved = path.resolve(absolutePath);
  if (!isInside(resolved, base, false)) return false;
  const parts = path.relative(base, resolved).split(path.sep);
  if (parts[0] === COMPANY_SHARED_INSTRUCTIONS_DIR) return true;
  return parts.length >= 3 && parts[0] === "agents" && SAFE_SEGMENT.test(parts[1]!) && parts[2] === "instructions";
}

/** First symbolic link met walking from `from` (exclusive) down to `to`, or null. Missing tails are fine. */
function firstSymlinkBelowSync(from: string, to: string): string | null {
  const relative = path.relative(from, to);
  if (!relative) return null;
  let current = from;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return current;
  }
  return null;
}

async function firstSymlinkBelow(from: string, to: string): Promise<string | null> {
  const relative = path.relative(from, to);
  if (!relative) return null;
  let current = from;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return current;
  }
  return null;
}

/**
 * Host directories no bundle root may cover or sit inside, whoever sets it:
 * the Hermes root, its profiles (each holds a provider `.env`) and the
 * per-agent wrapper directory (a rewritten wrapper runs as the next agent and
 * redirects its metering), plus the SSH directory and the AgentDash config
 * directory the launchd wrapper sources. Reads the same variables the Hermes
 * profile service and the hosted image use.
 */
export function protectedHostDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || os.homedir();
  const candidates = [
    env.AGENTDASH_HERMES_ROOT,
    env.HERMES_HOME,
    env.HERMES_PROFILES_DIR,
    env.AGENTDASH_HERMES_BIN_DIR,
    path.join(home, ".hermes"),
    path.join(home, ".local", "bin"),
    path.join(home, ".ssh"),
    path.join(home, ".config", "agentdash"),
  ];
  const out = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      out.add(path.resolve(resolveHomeAwarePath(candidate.trim())));
    }
  }
  return [...out];
}

/** Resolve symlinks in the longest existing prefix of `target`, keeping the missing tail. */
function canonicalizeExistingPrefix(target: string): string {
  let existing = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...tail);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(target);
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * The protected directory `candidate` overlaps (covers or sits inside), or
 * null. Both sides are compared lexically and after resolving symlinks.
 */
export function findProtectedHostDirectoryOverlap(candidate: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const forms = new Set([path.resolve(candidate), canonicalizeExistingPrefix(candidate)]);
  for (const protectedDir of protectedHostDirectories(env)) {
    const protectedForms = new Set([protectedDir, canonicalizeExistingPrefix(protectedDir)]);
    for (const a of forms) {
      for (const b of protectedForms) {
        if (isInside(a, b, true) || isInside(b, a, true)) return protectedDir;
      }
    }
  }
  return null;
}

export type CompanyInstructionsPathCheck =
  | { ok: true; resolvedPath: string }
  | { ok: false; reason: string };

/**
 * Is `candidate` (a root directory or a file path) inside this company's
 * instructions area, with no symbolic link between the instance root and it?
 * Synchronous so the host-execution policy can call it.
 */
export function checkCompanyInstructionsPath(companyId: string, candidate: unknown): CompanyInstructionsPathCheck {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return { ok: false, reason: "instructions path is empty" };
  }
  const resolvedPath = resolveHomeAwarePath(candidate.trim());
  if (!path.isAbsolute(resolvedPath)) return { ok: false, reason: "instructions path is not absolute" };
  if (!isLexicallyWithinCompanyInstructionsArea(companyId, resolvedPath)) {
    return {
      ok: false,
      reason:
        `instructions path must be inside ${resolveCompanySharedInstructionsRoot(companyId)} ` +
        "or the agent's managed instructions directory",
    };
  }
  const link = firstSymlinkBelowSync(resolvePaperclipInstanceRoot(), resolvedPath);
  if (link) return { ok: false, reason: `instructions path traverses a symbolic link (${link})` };
  return { ok: true, resolvedPath };
}

/**
 * Resolve `relativePath` under `rootPath` for a bundle file read, write or
 * delete. Refuses `..` escapes and any symbolic link below the root, so the
 * operation lands inside the root's real location.
 */
export async function resolveConfinedBundleFilePath(rootPath: string, relativePath: string): Promise<string> {
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (!isInside(absolutePath, absoluteRoot, false)) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  const protectedDir = findProtectedHostDirectoryOverlap(absoluteRoot);
  if (protectedDir) {
    throw unprocessable(`Instructions bundle root overlaps a protected host directory (${protectedDir})`);
  }
  // A root under the instance home (managed and company-shared bundles) is
  // walked from the instance root, so the root itself cannot be a planted link.
  const instanceRoot = resolvePaperclipInstanceRoot();
  const walkFrom = isInside(absoluteRoot, instanceRoot, false) ? instanceRoot : absoluteRoot;
  const link = await firstSymlinkBelow(walkFrom, absolutePath);
  if (link) {
    throw unprocessable("Instructions file path must not traverse a symbolic link");
  }
  return absolutePath;
}
