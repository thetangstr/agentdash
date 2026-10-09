import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Uploading the person's own file to their own OneDrive, from this machine.
 *
 * This module touches the local disk, so it is deliberately narrow:
 *
 * - It reads ONE file: the one the person named in the conversation. The
 *   caller passes a path; nothing here searches, lists or globs.
 * - The path must be a regular file, not a symlink and not a directory, and
 *   must not sit under a credential folder (checked on the path as given and
 *   on its real path, so a symlinked parent cannot smuggle one in).
 * - Size and type are checked before a byte is hashed; the first bytes must
 *   match the extension (OOXML is a zip, PDF starts `%PDF-`).
 * - Only metadata goes to AgentDash at propose time (name, size, type,
 *   SHA-256). Bytes go only after the person's yes, in bounded fragments, and
 *   the server forwards them to Microsoft. This machine never learns the
 *   Microsoft upload URL.
 * - After the yes the file is opened ONCE, without following a symlink, and
 *   everything (the hash check, every fragment) is read from that one open
 *   file. A running SHA-256 of the bytes actually sent must equal the hash
 *   that was read back before the last fragment goes, so a file edited or
 *   swapped mid-upload is never shared as the one the person confirmed.
 *
 * Dependency-free, like the rest of the package.
 */

export const UPLOAD_MAX_BYTES = 250 * 1024 * 1024;

/** Open without following a symlink at the last path component (0 where the platform has no such flag). */
const OPEN_READ_NOFOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
const HASH_CHUNK_BYTES = 1024 * 1024;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

/** The only kinds of file this uploads, by extension. */
export const UPLOAD_TYPES = {
  ".pptx": { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", magic: ZIP_MAGIC },
  ".docx": { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: ZIP_MAGIC },
  ".xlsx": { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: ZIP_MAGIC },
  ".pdf": { contentType: "application/pdf", magic: PDF_MAGIC },
};

/**
 * Folders that hold credentials. Nothing under them is ever read, whatever
 * the person or a document says. Relative to the home directory.
 */
export const DENIED_FOLDERS = [
  ".agentdash",
  ".ssh",
  ".claude",
  ".codex",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  path.join(".config", "gh"),
  path.join(".config", "gcloud"),
  path.join("Library", "Keychains"),
];

export class UploadRefusal extends Error {
  /**
   * @param {string} reason
   * @param {string} message
   * @param {{ note?: string }} [options] what the person should take away; the
   *   default, "Nothing was uploaded or shared.", is wrong once bytes have gone.
   */
  constructor(reason, message, options = {}) {
    super(message);
    this.name = "UploadRefusal";
    this.reason = reason;
    if (options.note) this.note = options.note;
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Check the one file the person named, without reading its content beyond
 * the first few bytes. Returns what may be told to the server, plus what this
 * process keeps to bind the bytes later (absolute path, mtime).
 */
export function inspectLocalFile(rawPath, { home = os.homedir(), cwd = process.cwd(), maxBytes = UPLOAD_MAX_BYTES } = {}) {
  if (typeof rawPath !== "string" || rawPath.trim() === "" || rawPath.includes("\0")) {
    throw new UploadRefusal("path_required", "Say which file to upload: the full path of one file on this computer.");
  }
  const trimmed = rawPath.trim();
  if (/[*?[\]{}]/.test(trimmed)) {
    throw new UploadRefusal("glob_not_allowed", "Name one file exactly; wildcards are not accepted.");
  }
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? path.join(home, trimmed.slice(2)) : trimmed;
  const absolute = path.resolve(cwd, expanded);

  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    throw new UploadRefusal("not_found", `There is no file at ${absolute}.`);
  }
  if (stat.isSymbolicLink()) {
    throw new UploadRefusal("symlink_not_allowed", "That path is a shortcut (symlink). Give the path of the file itself.");
  }
  if (stat.isDirectory()) {
    throw new UploadRefusal("directory_not_allowed", "That is a folder. Name one file inside it.");
  }
  if (!stat.isFile()) {
    throw new UploadRefusal("not_regular_file", "That is not an ordinary file.");
  }

  const real = realOrSelf(absolute);
  const homes = [...new Set([home, realOrSelf(home)])];
  for (const base of homes) {
    for (const folder of DENIED_FOLDERS) {
      const denied = path.join(base, folder);
      if (isInside(absolute, denied) || isInside(real, denied)) {
        throw new UploadRefusal(
          "credential_folder",
          "Files in that folder hold credentials and are never uploaded.",
        );
      }
    }
  }

  const name = path.basename(absolute);
  const ext = path.extname(name).toLowerCase();
  const type = UPLOAD_TYPES[ext];
  if (!type) {
    throw new UploadRefusal(
      "type_not_allowed",
      "Only PowerPoint (.pptx), Word (.docx), Excel (.xlsx) and PDF files can be uploaded this way.",
    );
  }
  if (stat.size === 0) throw new UploadRefusal("empty_file", "That file is empty.");
  if (stat.size > maxBytes) {
    throw new UploadRefusal("too_large", `That file is ${formatBytes(stat.size)}; the limit is ${formatBytes(maxBytes)}.`);
  }

  const head = Buffer.alloc(type.magic.length);
  let fd;
  try {
    fd = fs.openSync(absolute, OPEN_READ_NOFOLLOW);
  } catch (err) {
    if (err?.code === "ELOOP") {
      throw new UploadRefusal("symlink_not_allowed", "That path is a shortcut (symlink). Give the path of the file itself.");
    }
    throw new UploadRefusal("not_found", `There is no file at ${absolute}.`);
  }
  try {
    // The file opened must be the one just checked, not one swapped in since.
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw new UploadRefusal("file_changed", "The file changed while it was being checked. Try again.");
    }
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.equals(type.magic)) {
    throw new UploadRefusal(
      "content_mismatch",
      `That file does not look like a real ${ext} file. Export it again from the app that made it.`,
    );
  }

  return { path: absolute, name, byteSize: stat.size, mtimeMs: stat.mtimeMs, contentType: type.contentType };
}

/**
 * Open the file once for upload: no symlink followed, a regular file only.
 * Everything after the person's yes reads from the handle this returns.
 */
export async function openForUpload(filePath) {
  let file;
  try {
    file = await fs.promises.open(filePath, OPEN_READ_NOFOLLOW);
  } catch (err) {
    if (err?.code === "ELOOP") {
      throw new UploadRefusal("symlink_not_allowed", "That path is a shortcut (symlink). Give the path of the file itself.");
    }
    throw new UploadRefusal("not_found", `There is no file at ${filePath}.`);
  }
  const stat = await file.stat();
  if (!stat.isFile()) {
    await file.close();
    throw new UploadRefusal("not_regular_file", "That is not an ordinary file.");
  }
  return { file, stat };
}

/** Exactly `length` bytes at `offset` from an open file. */
async function readSlice(file, offset, length) {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(buf, read, length - read, offset + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  if (read !== length) {
    throw new UploadRefusal("file_changed", "The file got shorter while it was uploading. Propose it again.");
  }
  return buf;
}

/** Feed bytes [0, end) of an open file into `hash`. */
async function hashRange(file, hash, end) {
  for (let pos = 0; pos < end; pos += HASH_CHUNK_BYTES) {
    hash.update(await readSlice(file, pos, Math.min(HASH_CHUNK_BYTES, end - pos)));
  }
  return hash;
}

/** SHA-256 of an open file's first `size` bytes. */
export async function sha256Of(file, size) {
  return (await hashRange(file, createHash("sha256"), size)).digest("hex");
}

/** SHA-256 of the file at `filePath`, opened without following a symlink. */
export async function sha256File(filePath) {
  const { file, stat } = await openForUpload(filePath);
  try {
    return await sha256Of(file, stat.size);
  } finally {
    await file.close();
  }
}

/** The first offset Microsoft still expects: `"12345-"` or `"12345-67890"` → 12345. */
export function nextOffset(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const starts = ranges
    .map((r) => Number(String(r).split("-")[0]))
    .filter((n) => Number.isInteger(n) && n >= 0);
  return starts.length > 0 ? Math.min(...starts) : null;
}

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

const SESSION_ENDED =
  "The upload session expired or was cancelled. Nothing was shared. Propose the upload again.";

/**
 * Send the file in fragments, sequentially, resuming from what Microsoft says
 * it still expects after any failure.
 *
 * `file` is the handle from `openForUpload` (or pass `path` and it is opened
 * here). `send(offset, bytes)` → `{ status, body }` (status 0 = network
 * failure). `status()` → `{ status, body }` from the upload status route.
 * With `expectedSha256`, the last fragment is sent only if the bytes sent
 * (and the open file's size and modified time) still match the read-back.
 * While AgentDash is still sharing (`finishing`), this asks for the status
 * until the outcome is stored, so a caller never reports a sharing list that
 * was not yet written. Returns the final server body.
 */
export async function streamFragments({
  file: openFile,
  path: filePath,
  byteSize,
  fragmentBytes,
  send,
  status,
  expectedSha256,
  expectedMtimeMs,
  maxRetries = 5,
  pollIntervalMs = 2000,
  maxPolls = 150,
}) {
  const owned = openFile ? null : await openForUpload(filePath);
  const file = openFile ?? owned.file;
  try {
    return await stream();
  } finally {
    if (owned) await owned.file.close();
  }

  async function settle(body) {
    const { reason, ...rest } = body ?? {};
    let current = { ...rest, ...(reason && reason !== "already_completed" ? { reason } : {}), ok: true, completed: true };
    for (let i = 0; current.finishing && i < maxPolls; i += 1) {
      await sleep(pollIntervalMs);
      const st = await status();
      if (st.status === 200 && st.body?.status === "completed") current = { ...st.body, ok: true, completed: true };
    }
    return current;
  }

  async function stream() {
    let offset = 0;
    let failures = 0;
    // SHA-256 of bytes [0, hashedUpTo) as sent, from this one open file.
    let hash = createHash("sha256");
    let hashedUpTo = 0;
    while (offset < byteSize) {
      const length = Math.min(fragmentBytes, byteSize - offset);
      if (offset !== hashedUpTo) {
        // A resume moved the position: hash the prefix again from the same file.
        hash = await hashRange(file, createHash("sha256"), offset);
        hashedUpTo = offset;
      }
      const bytes = await readSlice(file, offset, length);
      const withThis = hash.copy();
      withThis.update(bytes);
      if (offset + length === byteSize && expectedSha256) {
        const now = await file.stat();
        const changed =
          withThis.copy().digest("hex") !== expectedSha256 ||
          now.size !== byteSize ||
          (expectedMtimeMs !== undefined && now.mtimeMs !== expectedMtimeMs);
        if (changed) {
          throw new UploadRefusal(
            "file_changed",
            "The file changed while it was uploading, so the last part was not sent. Propose it again.",
            { note: "Nothing was shared. The unfinished upload was cancelled." },
          );
        }
      }
      const res = await send(offset, bytes);

      if (res.status === 200 && res.body?.ok) {
        if (res.body.completed) return settle(res.body);
        failures = 0;
        hash = withThis;
        hashedUpTo = offset + length;
        offset = nextOffset(res.body.nextExpectedRanges) ?? offset + length;
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        throw new UploadRefusal("session_expired", res.body?.message ?? SESSION_ENDED, { note: "Nothing was shared." });
      }
      if (res.status === 409 && res.body?.reason === "already_completed") return settle(res.body);
      const retryable = res.status === 0 || res.status >= 500 || res.status === 409 || res.status === 429;
      if (!retryable) {
        throw new UploadRefusal(
          res.body?.reason ?? "upload_refused",
          res.body?.message ?? res.body?.error ?? `AgentDash refused the fragment (${res.status}).`,
          { note: "Nothing was shared." },
        );
      }
      failures += 1;
      if (failures > maxRetries) {
        throw new UploadRefusal(
          "upload_interrupted",
          "The upload kept failing. Nothing was shared. Try again later; the upload can be cancelled with upload_cancel.",
          { note: "Nothing was shared." },
        );
      }
      const st = await status();
      if (st.status === 200 && st.body?.status === "completed") return settle(st.body);
      if (st.status === 200 && st.body?.ok) {
        offset = nextOffset(st.body.nextExpectedRanges) ?? offset;
        continue;
      }
      if (st.body?.reason === "session_expired" || st.status === 404 || st.status === 410) {
        throw new UploadRefusal("session_expired", st.body?.message ?? SESSION_ENDED, { note: "Nothing was shared." });
      }
      // Status itself failed: try the same fragment again.
    }
    // The loop only ends on a completed body; a file shorter than declared ends here.
    throw new UploadRefusal("upload_incomplete", "Microsoft did not confirm the upload. Nothing was shared.", {
      note: "Nothing was shared.",
    });
  }
}
