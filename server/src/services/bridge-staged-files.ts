import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, bridgeStagedFiles, companies, stewardInboxActionHandles } from "@paperclipai/db";
import { normalizeIssueAttachmentMaxBytes } from "../attachment-types.js";
import { contentTypeForWorkspaceFile } from "../lib/agent-workspace-files.js";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { insertAttachmentRows, splitVersionedName, versionedFileName } from "./attachment-versions.js";
import { downloadVerdict, effectiveFileName, stewardWorkService, type WorkRefusal } from "./steward-work.js";

/**
 * AgentDash (co-worker slice 5): files over the bridge, person to agent.
 *
 * The person's own Claude may send files back with a send-back bundle
 * (steward-work-reply.ts) or with a request for another person's work
 * (steward-requests.ts). The bytes never travel with the propose call:
 *
 *   1. **propose** names each file by `{ name, sha256, size }`. The server
 *      derives the type from the name, refuses markup (D6), types off the
 *      allowlist and anything over the company's attachment cap, and puts
 *      the exact list in the single-use handle the person says yes to.
 *   2. **upload** (`POST /api/bridge/work/upload`, multipart) carries one
 *      file against that live handle. The server hashes the bytes and stores
 *      them only when the handle names that sha256 and size; the object goes
 *      under the company's `bridge-staged` namespace, and a
 *      `bridge_staged_files` row records it.
 *   3. **confirm** refuses while any named file has not arrived, then turns
 *      each staged row into a real attachment pointing at the same object,
 *      as the person, versioned with their name.
 *
 * Files travel only on issues in projects with restricted access (D2); on
 * any other issue the propose read-back leaves them out and says why.
 *
 * A staged file whose handle was never confirmed is swept after the
 * handle's expiry (plus a short grace, so a confirm in flight at the expiry
 * is never cut under): the object is deleted, then the row.
 */

export const BRIDGE_FILE_LIMITS = {
  /** Files per bundle or request. */
  files: 10,
  nameChars: 200,
} as const;

/** Handle kinds a file may be staged against. */
export const FILE_HANDLE_KINDS = ["reply", "request_work"] as const;

/** Unattached rows older than their expiry by this much are swept. */
export const STAGED_SWEEP_GRACE_MS = 5 * 60 * 1000;

/** One file as the read-back named it, stored in the handle. */
export type StagedFileSpec = {
  name: string;
  sha256: string;
  size: number;
  contentType: string;
};

function refusal(code: string, reason: string): WorkRefusal {
  return { ok: false, code, reason };
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** A file name as it will be stored: the last path segment, cleaned, capped. */
export function bridgeFileName(raw: unknown): string {
  const last = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  return effectiveFileName(last).replace(/\s+/gu, " ").trim().slice(0, BRIDGE_FILE_LIMITS.nameChars);
}

/** Bytes, said plainly: 18 KB, 2.4 MB. */
export function sizeInWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The files a propose call named, checked: a list of `{ name, sha256, size }`,
 * each an allowlisted, non-markup type within the company cap. The type is the
 * server's, from the name; a type the caller sends is ignored.
 */
export function validateBridgeFiles(
  raw: unknown,
  capBytes: number,
): { ok: true; files: StagedFileSpec[] } | WorkRefusal {
  if (raw === undefined || raw === null) return { ok: true, files: [] };
  if (!Array.isArray(raw)) return refusal("invalid_files", "files must be a list of { name, sha256, size }. Nothing was proposed.");
  if (raw.length > BRIDGE_FILE_LIMITS.files) {
    return refusal("too_many_files", `Send at most ${BRIDGE_FILE_LIMITS.files} files at once. Nothing was proposed.`);
  }
  const files: StagedFileSpec[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const name = bridgeFileName(item.name);
    const sha256 = typeof item.sha256 === "string" ? item.sha256.trim().toLowerCase() : "";
    const size = typeof item.size === "number" && Number.isSafeInteger(item.size) ? item.size : -1;
    if (!name || !SHA256_RE.test(sha256) || size <= 0) {
      return refusal(
        "invalid_files",
        "Each file needs a name, its sha256 (64 hex characters) and its size in bytes (more than 0). Nothing was proposed.",
      );
    }
    if (seen.has(sha256)) {
      return refusal("duplicate_file", `"${name}" is in the list twice (same sha256). Send each file once. Nothing was proposed.`);
    }
    seen.add(sha256);
    const contentType = contentTypeForWorkspaceFile(name);
    const verdict = downloadVerdict({ contentType, originalFilename: name, byteSize: size }, capBytes);
    if (!verdict.allowed) {
      const reason =
        size > capBytes
          ? `"${name}" is ${size.toLocaleString("en-US")} bytes; the cap for this company is ${capBytes.toLocaleString("en-US")} bytes (${sizeInWords(capBytes)}).`
          : `"${name}": ${verdict.reason}`;
      return refusal(size > capBytes ? "file_too_large" : "file_refused", `${reason} Nothing was proposed.`);
    }
    files.push({ name, sha256, size, contentType });
  }
  return { ok: true, files };
}

/** Why files were left out of a bundle on an issue outside a restricted project (D2). */
export function filesLeftOutReason(whyNot: string, files: StagedFileSpec[] | Array<{ name: string }>) {
  const names = files.map((file) => `"${file.name}"`).join(", ");
  return (
    `Files travel over the bridge only on issues in projects with restricted access, and ${whyNot}, ` +
    `so this goes as text only and ${names} ${files.length === 1 ? "was" : "were"} left out. ` +
    "Attach them on the AgentDash page if everyone who can see it may have them."
  );
}

/** The read-back line for one file, with the name it will be stored under. */
export function describeStagedFile(file: StagedFileSpec, storedAs: string): string {
  return `file "${file.name}" (${sizeInWords(file.size)}, ${file.contentType}) -> stored as "${storedAs}"`;
}

export function bridgeStagedFilesService(db: Db, options: { storage?: StorageService } = {}) {
  const work = stewardWorkService(db, { storage: options.storage });

  async function companyCap(companyId: string) {
    const company = await db
      .select({ attachmentMaxBytes: companies.attachmentMaxBytes })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes);
  }

  /** The live handle a file may be staged against, or null. */
  async function liveHandle(endpointId: string, owner: { companyId: string; userId: string }, token: string) {
    return db
      .select()
      .from(stewardInboxActionHandles)
      .where(
        and(
          eq(stewardInboxActionHandles.token, token),
          eq(stewardInboxActionHandles.bridgeEndpointId, endpointId),
          eq(stewardInboxActionHandles.companyId, owner.companyId),
          eq(stewardInboxActionHandles.actorUserId, owner.userId),
          inArray(stewardInboxActionHandles.kind, [...FILE_HANDLE_KINDS]),
          isNull(stewardInboxActionHandles.consumedAt),
          gt(stewardInboxActionHandles.expiresAt, new Date()),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Store one uploaded file against a live handle, when the handle names its
   * exact sha256 and size. Uploading the same file twice is not an error.
   */
  async function stage(
    endpointId: string,
    input: { token: unknown; file: { buffer: Buffer } | null },
  ): Promise<WorkRefusal | { ok: true; name: string; sha256: string; bytes: number; alreadyStaged: boolean }> {
    const owner = await work.resolveOwner(endpointId);
    if (work.isRefusal(owner)) return owner;
    const token = typeof input.token === "string" ? input.token.trim() : "";
    const handle = token ? await liveHandle(endpointId, owner, token) : null;
    if (!handle) {
      return refusal(
        "handle_not_valid",
        "That handle was already used, has expired, or belongs to another machine. Nothing was stored; propose again.",
      );
    }
    if (!input.file || input.file.buffer.length === 0) return refusal("no_file", "No file arrived. Nothing was stored.");
    const bytes = input.file.buffer;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const files = ((handle.payload as { files?: StagedFileSpec[] }).files ?? []) as StagedFileSpec[];
    const spec = files.find((file) => file.sha256 === sha256 && file.size === bytes.length);
    if (!spec) {
      return refusal(
        "file_not_in_handle",
        `This file (sha256 ${sha256}, ${bytes.length.toLocaleString("en-US")} bytes) is not one the read-back named. ` +
          "Only the exact files the person said yes to can be sent; if a file changed, propose again. Nothing was stored.",
      );
    }
    const existing = await db
      .select({ id: bridgeStagedFiles.id })
      .from(bridgeStagedFiles)
      .where(and(eq(bridgeStagedFiles.handleId, handle.id), eq(bridgeStagedFiles.sha256, sha256)))
      .then((rows) => rows[0] ?? null);
    if (existing) return { ok: true, name: spec.name, sha256, bytes: bytes.length, alreadyStaged: true };

    if (!options.storage) return refusal("storage_unavailable", "File storage is not available on this instance. Nothing was stored.");
    const issueId = (handle.payload as { issueId?: unknown }).issueId;
    const namespace =
      handle.kind === "reply" && typeof issueId === "string"
        ? `issues/${issueId}/bridge-staged`
        : `bridge-staged/requests/${handle.id}`;
    const stored = await options.storage.putFile({
      companyId: owner.companyId,
      namespace,
      originalFilename: spec.name,
      contentType: spec.contentType,
      body: bytes,
    });
    const inserted = await db
      .insert(bridgeStagedFiles)
      .values({
        companyId: owner.companyId,
        handleId: handle.id,
        bridgeEndpointId: endpointId,
        actorUserId: owner.userId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: spec.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: spec.name,
        expiresAt: handle.expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: bridgeStagedFiles.id })
      .then((rows) => rows[0] ?? null);
    if (!inserted) {
      // The same file raced in twice; keep the first copy.
      await options.storage.deleteObject(owner.companyId, stored.objectKey).catch(() => undefined);
      return { ok: true, name: spec.name, sha256, bytes: bytes.length, alreadyStaged: true };
    }
    logger.info({ endpointId, handleId: handle.id, bytes: bytes.length }, "bridge file staged");
    return { ok: true, name: spec.name, sha256, bytes: bytes.length, alreadyStaged: false };
  }

  return { stage, companyCap };
}

/** The names of the files a handle names that have not been uploaded yet. */
export async function missingUploads(reader: Pick<Db, "select">, handleId: string, files: StagedFileSpec[]) {
  if (files.length === 0) return [];
  const rows = await reader
    .select({ sha256: bridgeStagedFiles.sha256 })
    .from(bridgeStagedFiles)
    .where(and(eq(bridgeStagedFiles.handleId, handleId), isNull(bridgeStagedFiles.attachedAt)));
  const have = new Set(rows.map((row) => row.sha256));
  return files.filter((file) => !have.has(file.sha256)).map((file) => file.name);
}

/** The refusal for a confirm whose files have not all arrived. */
export function filesNotUploadedRefusal(names: string[]): WorkRefusal {
  return refusal(
    "files_not_uploaded",
    `${names.map((name) => `"${name}"`).join(", ")} ${names.length === 1 ? "has" : "have"} not been uploaded for this handle, ` +
      "so nothing was sent. The session uploads the files the read-back named before it confirms; if it no longer " +
      "has them, propose again.",
  );
}

/**
 * Turn a handle's staged files into attachments on the issue, as the person
 * and versioned with their name, in the caller's transaction. Returns the
 * attachments in the order the read-back named the files.
 */
export async function attachStagedFiles(
  tx: Db,
  input: {
    companyId: string;
    issueId: string;
    handleId: string;
    files: StagedFileSpec[];
    userId: string;
    personName: string;
    issueCommentId: string | null;
  },
) {
  const rows = await tx
    .select()
    .from(bridgeStagedFiles)
    .where(and(eq(bridgeStagedFiles.handleId, input.handleId), isNull(bridgeStagedFiles.attachedAt)))
    .for("update");
  const bySha = new Map(rows.map((row) => [row.sha256, row]));
  const attached = [];
  for (const spec of input.files) {
    const row = bySha.get(spec.sha256);
    if (!row) throw new Error(`staged file ${spec.sha256} is missing`);
    const attachment = await insertAttachmentRows(tx, {
      companyId: input.companyId,
      issueId: input.issueId,
      issueCommentId: input.issueCommentId,
      provider: row.provider,
      objectKey: row.objectKey,
      contentType: row.contentType,
      byteSize: row.byteSize,
      sha256: row.sha256,
      originalFilename: spec.name,
      createdByAgentId: null,
      createdByUserId: input.userId,
      versionAuthor: input.personName,
    });
    await tx
      .update(bridgeStagedFiles)
      .set({ attachedAt: new Date(), attachmentId: attachment.id })
      .where(eq(bridgeStagedFiles.id, row.id));
    attached.push(attachment);
  }
  return attached;
}

/** The name a file would be stored under now, for the read-back. */
export function storedNameFor(spec: StagedFileSpec, nextVersion: number, personName: string): string {
  const parts = splitVersionedName(spec.name);
  return versionedFileName(parts.stem, nextVersion, personName, parts.ext);
}

/**
 * Delete what was staged and never confirmed: rows unattached past their
 * expiry plus the grace, their objects first. An object an attachment points
 * at is never deleted.
 */
export async function sweepStagedFiles(db: Db, storage: StorageService, now = new Date(), limit = 200) {
  const cutoff = new Date(now.getTime() - STAGED_SWEEP_GRACE_MS);
  const rows = await db
    .select()
    .from(bridgeStagedFiles)
    .where(and(isNull(bridgeStagedFiles.attachedAt), lt(bridgeStagedFiles.expiresAt, cutoff)))
    .limit(limit);
  let removed = 0;
  for (const row of rows) {
    const referenced = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.companyId, row.companyId), eq(assets.objectKey, row.objectKey)))
      .then((found) => found.length > 0);
    if (!referenced) {
      try {
        await storage.deleteObject(row.companyId, row.objectKey);
      } catch (err) {
        logger.warn({ err, stagedFileId: row.id }, "staged bridge file not deleted; will retry");
        continue;
      }
    }
    await db.delete(bridgeStagedFiles).where(eq(bridgeStagedFiles.id, row.id));
    removed += 1;
  }
  return { removed };
}

/** Sweep unconfirmed staged files every ten minutes. */
export function startBridgeStagedFileSweep(db: Db, storage: StorageService, intervalMs = 10 * 60 * 1000) {
  const run = () => {
    void sweepStagedFiles(db, storage).catch((err) => logger.warn({ err }, "staged bridge file sweep failed"));
  };
  run();
  const handle = setInterval(run, intervalMs);
  handle.unref?.();
  return handle;
}
