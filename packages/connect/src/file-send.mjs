import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchBodyTimeoutMs, isMarkupFileName } from "./work-tools.mjs";

/**
 * The person's own Claude as co-worker: sending local files with a send-back
 * or a request.
 *
 * A propose tool takes local paths. This module reads each file, hashes it,
 * and sends only `{ name, sha256, size }` with the propose call: the bytes
 * stay on this machine until the person has said yes to the read-back. The
 * paths are kept here, in memory, against the handle the server returns.
 *
 * The confirm tool then reads each file again, refuses if it changed since
 * the read-back, uploads it against the handle (`work/upload`, which stores
 * it only when the handle names that exact sha256 and size), and only then
 * confirms. A session restarted in between has lost the paths; the server
 * then refuses the confirm and the person proposes again.
 *
 * Paths must be absolute or start with `~/`. A path through a hidden folder
 * or to a hidden file (`~/.ssh/...`, `.env`), a link, a folder, an empty
 * file or an HTML, SVG or XML file is refused here, before anything is
 * proposed: a send-back carries work files, never credentials or settings,
 * whatever an issue or a file asks for.
 */

export const MAX_FILES = 10;

/**
 * The largest file sent from here, checked from its size before any of it
 * is read. The server's own cap (the company attachment cap) is usually far
 * lower and is the one that decides; this only keeps a stray multi-GB path
 * from being read at all.
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** The sha256 and length of a file, read as a stream. */
async function hashFile(filePath) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

function tooLargeReason(name, size) {
  const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${name} is ${mb(size)}; files over ${mb(MAX_FILE_BYTES)} are not sent from here.`;
}

function refusal(code, reason) {
  return { ok: false, code, reason, note: "Nothing was proposed and nothing was sent." };
}

/** `~/x` and absolute paths only; resolved and normalized. */
export function resolveLocalPath(raw, homeDir = os.homedir()) {
  const value = String(raw ?? "").trim();
  if (value === "~" || value.startsWith("~/")) return path.resolve(homeDir, value.slice(2));
  if (path.isAbsolute(value)) return path.resolve(value);
  return null;
}

/** A hidden segment anywhere in the path: `.ssh`, `.config`, `.env`. */
function hasHiddenSegment(absolutePath) {
  return absolutePath
    .split(path.sep)
    .filter(Boolean)
    .some((segment) => segment.startsWith("."));
}

/**
 * Read and hash the files a propose call names. Returns
 * `{ ok: true, files: [{ path, name, size, sha256 }] }` or a refusal.
 * A file over MAX_FILE_BYTES is refused from its size, before it is read.
 */
export async function readLocalFiles(list, deps = {}) {
  if (list === undefined || list === null) return { ok: true, files: [] };
  if (!Array.isArray(list)) return refusal("invalid_files", "files must be a list of { path }.");
  if (list.length > MAX_FILES) return refusal("too_many_files", `Send at most ${MAX_FILES} files at once.`);
  const homeDir = deps.homeDir ?? os.homedir();
  const files = [];
  const seen = new Set();
  for (const entry of list) {
    const given = typeof entry === "string" ? entry : entry?.path;
    const resolved = resolveLocalPath(given, homeDir);
    if (!resolved) {
      return refusal("invalid_path", `Give each file as an absolute path or one starting with ~/ (got "${String(given ?? "")}").`);
    }
    if (hasHiddenSegment(resolved)) {
      return refusal(
        "hidden_path",
        `${resolved} is hidden or inside a hidden folder. Files from hidden places (credentials, settings) are never sent from here.`,
      );
    }
    let stat;
    try {
      stat = lstatSync(resolved);
    } catch {
      return refusal("not_found", `${resolved} does not exist.`);
    }
    if (!stat.isFile()) return refusal("not_a_file", `${resolved} is not a plain file (a folder or a link is not sent).`);
    // A folder on the way may be a link into a hidden place: check where it really is.
    let real;
    try {
      real = realpathSync(resolved);
    } catch {
      return refusal("not_found", `${resolved} does not exist.`);
    }
    if (hasHiddenSegment(real)) {
      return refusal(
        "hidden_path",
        `${resolved} leads into a hidden folder. Files from hidden places (credentials, settings) are never sent from here.`,
      );
    }
    if (stat.size === 0) return refusal("empty_file", `${resolved} is empty.`);
    const maxBytes = deps.maxFileBytes ?? MAX_FILE_BYTES;
    if (stat.size > maxBytes) return refusal("file_too_large", tooLargeReason(resolved, stat.size));
    const name = path.basename(resolved);
    if (isMarkupFileName(name)) {
      return refusal("file_refused", `${name}: HTML, SVG and XML files are not sent over the bridge: they can carry script.`);
    }
    if (seen.has(resolved)) return refusal("duplicate_file", `${resolved} is in the list twice.`);
    seen.add(resolved);
    let hashed;
    try {
      hashed = await hashFile(resolved);
    } catch (err) {
      return refusal("not_found", `${resolved} could not be read (${err?.message ?? String(err)}).`);
    }
    if (hashed.size > maxBytes) return refusal("file_too_large", tooLargeReason(resolved, hashed.size));
    files.push({ path: resolved, name, size: hashed.size, sha256: hashed.sha256 });
  }
  return { ok: true, files };
}

/** The `files` field a propose call sends: names and hashes, never bytes. */
export function filesField(files) {
  return files.map(({ name, sha256, size }) => ({ name, sha256, size }));
}

/**
 * Remember which local files a handle named, when the server's read-back
 * kept them (`upload`). Bounded: the oldest handles are forgotten first.
 */
export function rememberStaged(staged, response, files, limit = 50) {
  if (!response || response.ok !== true || typeof response.handle !== "string" || !response.upload) return;
  const named = new Set((response.upload.files ?? []).map((file) => file.sha256));
  const kept = files.filter((file) => named.has(file.sha256));
  if (kept.length === 0) return;
  staged.set(response.handle, kept);
  while (staged.size > limit) staged.delete(staged.keys().next().value);
}

/** What the propose result shows the person about their local files. */
export function localFilesNote(response, files) {
  if (files.length === 0) return {};
  const kept = new Set((response?.upload?.files ?? []).map((file) => file.sha256));
  return {
    localFiles: files.map((file) => ({
      path: file.path,
      bytes: file.size,
      sha256: file.sha256,
      sent: kept.has(file.sha256),
    })),
  };
}

class FileChanged extends Error {}

function fileChangedResult(file) {
  return {
    ok: false,
    code: "file_changed",
    reason: `${file.path} changed since the read-back. Nothing was sent; propose again so the person sees the file as it is now.`,
  };
}

/**
 * Upload the files a handle named, after the person's yes and before the
 * confirm. Each is read again and must still be the file that was read
 * back. Returns null when every upload landed, or the result to give the
 * caller (nothing is confirmed then).
 */
export async function uploadStaged({ staged, handle, fetchImpl, server, token, textResult }) {
  const files = staged.get(handle);
  if (!files) return null;
  for (const file of files) {
    let bytes;
    try {
      // A file that grew since the read-back is refused from its size, before it is read.
      if (statSync(file.path).size !== file.size) throw new FileChanged();
      bytes = readFileSync(file.path);
    } catch (err) {
      if (err instanceof FileChanged) return textResult(fileChangedResult(file));

      return textResult({
        ok: false,
        code: "file_gone",
        reason: `${file.path} could not be read (${err?.message ?? String(err)}). Nothing was sent; propose again.`,
      });
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== file.sha256 || bytes.length !== file.size) return textResult(fileChangedResult(file));
    const form = new FormData();
    form.append("file", new Blob([bytes]), file.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("upload timed out")), fetchBodyTimeoutMs(bytes.length));
    let raw = "";
    let status = 0;
    try {
      const res = await fetchImpl(`${server}/api/bridge/work/upload`, {
        method: "POST",
        // The handle goes in a header, so the server checks it before reading the body.
        headers: { authorization: `Bearer ${token}`, "x-bridge-handle": handle },
        body: form,
        signal: controller.signal,
      });
      status = res.status;
      raw = await res.text().catch(() => "");
    } catch (err) {
      return textResult(`Could not upload ${file.name}: ${err?.message ?? String(err)}. Nothing was sent.`, true);
    } finally {
      clearTimeout(timer);
    }
    if (status < 200 || status >= 300) {
      return textResult(`AgentDash answered ${status} to the upload of ${file.name}: ${raw.slice(0, 300)}. Nothing was sent.`, true);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return textResult(`Unexpected answer to the upload of ${file.name}: ${raw.slice(0, 300)}. Nothing was sent.`, true);
    }
    if (!parsed || parsed.ok !== true) {
      return textResult({ ...parsed, note: `${file.name} was not stored, so nothing was sent. Tell the person the reason.` });
    }
  }
  return null;
}
