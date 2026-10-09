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
 *
 * Dependency-free, like the rest of the package.
 */

export const UPLOAD_MAX_BYTES = 250 * 1024 * 1024;

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
  constructor(reason, message) {
    super(message);
    this.name = "UploadRefusal";
    this.reason = reason;
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
  const fd = fs.openSync(absolute, "r");
  try {
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

/** SHA-256 of the file, streamed. */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** The first offset Microsoft still expects: `"12345-"` or `"12345-67890"` → 12345. */
export function nextOffset(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const starts = ranges
    .map((r) => Number(String(r).split("-")[0]))
    .filter((n) => Number.isInteger(n) && n >= 0);
  return starts.length > 0 ? Math.min(...starts) : null;
}

function readSlice(filePath, offset, length) {
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    if (read !== length) throw new UploadRefusal("file_changed", "The file got shorter while it was uploading. Propose it again.");
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

/**
 * Send the file in fragments, sequentially, resuming from what Microsoft says
 * it still expects after any failure.
 *
 * `send(offset, bytes)` → `{ status, body }` (status 0 = network failure).
 * `status()` → `{ status, body }` from the upload status route.
 * Returns the final server body (the uploaded item and sharing outcome).
 */
export async function streamFragments({ path: filePath, byteSize, fragmentBytes, send, status, maxRetries = 5 }) {
  let offset = 0;
  let failures = 0;
  while (offset < byteSize) {
    const length = Math.min(fragmentBytes, byteSize - offset);
    const bytes = readSlice(filePath, offset, length);
    const res = await send(offset, bytes);

    if (res.status === 200 && res.body?.ok) {
      if (res.body.completed) return res.body;
      failures = 0;
      offset = nextOffset(res.body.nextExpectedRanges) ?? offset + length;
      continue;
    }
    if (res.status === 404 || res.status === 410) {
      throw new UploadRefusal(
        "session_expired",
        "The upload session expired or was cancelled. Nothing was shared. Propose the upload again.",
      );
    }
    if (res.status === 409 && res.body?.reason === "already_completed") return { ok: true, completed: true, ...res.body };
    const retryable = res.status === 0 || res.status >= 500 || res.status === 409 || res.status === 429;
    if (!retryable) {
      throw new UploadRefusal(
        res.body?.reason ?? "upload_refused",
        res.body?.message ?? res.body?.error ?? `AgentDash refused the fragment (${res.status}).`,
      );
    }
    failures += 1;
    if (failures > maxRetries) {
      throw new UploadRefusal(
        "upload_interrupted",
        "The upload kept failing. Nothing was shared. Try again later; the upload can be cancelled with upload_cancel.",
      );
    }
    const st = await status();
    if (st.status === 200 && st.body?.status === "completed") return { ok: true, completed: true, ...st.body };
    if (st.status === 200 && st.body?.ok) {
      offset = nextOffset(st.body.nextExpectedRanges) ?? offset;
      continue;
    }
    if (st.body?.reason === "session_expired" || st.status === 404 || st.status === 410) {
      throw new UploadRefusal(
        "session_expired",
        "The upload session expired. Nothing was shared. Propose the upload again.",
      );
    }
    // Status itself failed: try the same fragment again.
  }
  // The loop only ends on a completed body; a file shorter than declared ends here.
  throw new UploadRefusal("upload_incomplete", "Microsoft did not confirm the upload. Nothing was shared.");
}
