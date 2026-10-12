import path from "node:path";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, issueAttachments } from "@paperclipai/db";

/**
 * AgentDash (co-worker slice 5): versions of the files sent through the bridge
 * or attached by an agent.
 *
 * A person and their agents pass the same deliverable back and forth: the
 * agent attaches `q3 figures.csv`, the person's own Claude corrects it and
 * sends it back, the agent revises it again. Each of those is stored as its
 * own attachment, named so a reader can tell them apart and see who sent it:
 *
 *     q3 figures v1 (Agent A).csv
 *     q3 figures v2 (Person A).csv
 *     q3 figures v3 (Agent A).csv
 *
 * The version counts per base name per issue. The base name is the file's
 * name with any version suffix taken off, so sending back a fetched
 * `q3 figures v2 (Person A).csv` makes v3 of `q3 figures.csv`, not v1 of a
 * new name. The newest version is the issue's current file for that name;
 * agents read the current file unless they were told to use another.
 *
 * A file a person attaches on the page is not versioned: its name is kept as
 * given and it carries no version.
 */

/** Longest stem kept, in characters; the extension and the suffix come on top. */
const MAX_STEM_CHARS = 160;
const MAX_AUTHOR_CHARS = 60;
const MAX_EXT_CHARS = 16;

/** ` v12 (Agent A)` at the end of a stem: a name this module wrote. */
const VERSION_SUFFIX_RE = /\s+v\d{1,6}\s+\([^()]*\)$/u;

function clean(value: string): string {
  return value
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * A name split into the parts a version is built from. Path segments,
 * control and format characters are dropped; a version suffix this module
 * wrote is taken off, so the base stays the same across versions.
 */
export function splitVersionedName(name: string | null | undefined): { stem: string; ext: string; baseKey: string } {
  const last = clean(String(name ?? "").split(/[\\/]/).pop() ?? "").replace(/[\s.]+$/u, "");
  const rawExt = path.extname(last);
  const ext = /^\.[A-Za-z0-9]{1,15}$/.test(rawExt) ? rawExt.slice(0, MAX_EXT_CHARS) : "";
  let stem = ext ? last.slice(0, last.length - rawExt.length) : last;
  stem = stem.replace(VERSION_SUFFIX_RE, "").trim();
  stem = stem.replace(/^\.+/, "").trim().slice(0, MAX_STEM_CHARS).trim() || "file";
  return { stem, ext, baseKey: `${stem}${ext}`.toLowerCase() };
}

/** Who sent it, as it appears in the name: one line, no parentheses or slashes. */
export function versionAuthorLabel(author: string | null | undefined): string {
  const label = clean(String(author ?? ""))
    .replace(/[()\\/]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AUTHOR_CHARS)
    .trim();
  return label || "unknown";
}

/** `<stem> v<n> (<author>)<ext>` */
export function versionedFileName(stem: string, version: number, author: string, ext: string): string {
  return `${stem} v${version} (${versionAuthorLabel(author)})${ext}`;
}

type Executor = Pick<Db, "select" | "insert" | "execute">;

/** The next version of a base name on an issue. Call inside the transaction that inserts it. */
async function nextVersion(executor: Executor, issueId: string, baseKey: string): Promise<number> {
  // One writer per (issue, base name) at a time, so two senders cannot take
  // the same number. The unique index on (issue, base name, version) is the
  // backstop.
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`attachment-version:${issueId}:${baseKey}`}, 0))`);
  const row = await executor
    .select({ max: sql<number | null>`max(${issueAttachments.version})` })
    .from(issueAttachments)
    .where(and(eq(issueAttachments.issueId, issueId), eq(issueAttachments.versionBaseName, baseKey)))
    .then((rows) => rows[0] ?? null);
  return Number(row?.max ?? 0) + 1;
}

export type AttachmentRowsInput = {
  companyId: string;
  issueId: string;
  issueCommentId?: string | null;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  /**
   * The person or agent name the version is credited to. When set, the file is
   * stored as the next version of its base name; when absent, unversioned.
   */
  versionAuthor?: string | null;
};

/**
 * Insert the asset and the attachment, versioned when `versionAuthor` is
 * given. Must run inside a transaction (the version lock is transaction-scoped).
 */
export async function insertAttachmentRows(executor: Executor, input: AttachmentRowsInput) {
  let originalFilename = input.originalFilename ?? null;
  let versionBaseName: string | null = null;
  let version: number | null = null;
  if (input.versionAuthor !== undefined && input.versionAuthor !== null) {
    const parts = splitVersionedName(originalFilename);
    versionBaseName = parts.baseKey;
    version = await nextVersion(executor, input.issueId, parts.baseKey);
    originalFilename = versionedFileName(parts.stem, version, input.versionAuthor, parts.ext);
  }
  const [asset] = await executor
    .insert(assets)
    .values({
      companyId: input.companyId,
      provider: input.provider,
      objectKey: input.objectKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      originalFilename,
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();
  const [attachment] = await executor
    .insert(issueAttachments)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      assetId: asset!.id,
      issueCommentId: input.issueCommentId ?? null,
      versionBaseName,
      version,
    })
    .returning();
  return {
    id: attachment!.id,
    companyId: attachment!.companyId,
    issueId: attachment!.issueId,
    issueCommentId: attachment!.issueCommentId,
    assetId: attachment!.assetId,
    provider: asset!.provider,
    objectKey: asset!.objectKey,
    contentType: asset!.contentType,
    byteSize: asset!.byteSize,
    sha256: asset!.sha256,
    originalFilename: asset!.originalFilename,
    createdByAgentId: asset!.createdByAgentId,
    createdByUserId: asset!.createdByUserId,
    createdAt: attachment!.createdAt,
    updatedAt: attachment!.updatedAt,
    version: attachment!.version,
    versionBaseName: attachment!.versionBaseName,
    // Just inserted with the next number: it is the newest of its name.
    isCurrent: true,
    currentAttachmentId: attachment!.id,
  };
}

export type VersionFields = {
  version: number | null;
  versionBaseName: string | null;
};

export type VersionMarker = {
  /** True for an unversioned file, and for the newest version of its base name. */
  isCurrent: boolean;
  /** The attachment that is current for this file's base name (itself when current). */
  currentAttachmentId: string;
};

/**
 * Mark which of an issue's attachments is current for its base name. Works on
 * a full list of one issue's attachments, as `listAttachments` returns it.
 */
export function markCurrentVersions<T extends { id: string } & VersionFields>(rows: T[]): Array<T & VersionMarker> {
  const newest = new Map<string, { id: string; version: number }>();
  for (const row of rows) {
    if (row.version === null || row.versionBaseName === null) continue;
    const seen = newest.get(row.versionBaseName);
    if (!seen || row.version > seen.version) newest.set(row.versionBaseName, { id: row.id, version: row.version });
  }
  return rows.map((row) => {
    const current = row.versionBaseName !== null && row.version !== null ? newest.get(row.versionBaseName) : null;
    return {
      ...row,
      isCurrent: !current || current.id === row.id,
      currentAttachmentId: current ? current.id : row.id,
    };
  });
}

/** The current version of one attachment's base name: the attachment's id and version. */
export async function currentVersionOf(
  reader: Pick<Db, "select">,
  attachment: { id: string; issueId: string } & VersionFields,
): Promise<{ attachmentId: string; version: number | null }> {
  if (attachment.version === null || attachment.versionBaseName === null) {
    return { attachmentId: attachment.id, version: null };
  }
  const row = await reader
    .select({ id: issueAttachments.id, version: issueAttachments.version })
    .from(issueAttachments)
    .where(
      and(
        eq(issueAttachments.issueId, attachment.issueId),
        eq(issueAttachments.versionBaseName, attachment.versionBaseName),
        isNotNull(issueAttachments.version),
      ),
    )
    .orderBy(sql`${issueAttachments.version} desc`)
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row ? { attachmentId: row.id, version: row.version } : { attachmentId: attachment.id, version: attachment.version };
}

/** The next version number each base name would take on an issue now (for a read-back). */
export async function nextVersionsFor(reader: Pick<Db, "select">, issueId: string, baseKeys: string[]) {
  const out = new Map<string, number>();
  const unique = [...new Set(baseKeys)];
  if (unique.length === 0) return out;
  const rows = await reader
    .select({ base: issueAttachments.versionBaseName, max: sql<number | null>`max(${issueAttachments.version})` })
    .from(issueAttachments)
    .where(and(eq(issueAttachments.issueId, issueId), inArray(issueAttachments.versionBaseName, unique)))
    .groupBy(issueAttachments.versionBaseName);
  for (const key of unique) out.set(key, 1);
  for (const row of rows) if (row.base) out.set(row.base, Number(row.max ?? 0) + 1);
  return out;
}
