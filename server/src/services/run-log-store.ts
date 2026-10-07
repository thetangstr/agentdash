import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { redactRunLogText, runLogRedactionEpoch } from "./run-log-redaction.js";

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
  /**
   * AgentDash (GH #992): true when every byte of this range was appended
   * through the store's redacting path — readers may then skip the
   * serve-time re-redaction pass. Ranges that reach past the verified prefix
   * (legacy files, or bytes written behind the store's back) report false.
   */
  redactedAtPersist?: boolean;
  /**
   * Raw file bytes of this range — `content` is their UTF-8 decoding.
   * Offsets for paging are always computed on these, never on re-encoded
   * text (a range starting inside a multi-byte character decodes to U+FFFD,
   * which re-encodes to a different length).
   */
  buffer?: Buffer;
  /**
   * Leading bytes of `buffer` covered by the written-redacted mark. Equals
   * `buffer.length` when `redactedAtPersist` is true, 0 when nothing in the
   * range is covered. The boundary always falls just after a newline.
   */
  verifiedBytes?: number;
  /** Byte offset in the file at which `buffer` starts. */
  startOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string; seq?: number },
  ): Promise<number>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
}

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

/**
 * AgentDash: "written redacted" mark for a log file, held in memory only.
 * `size` is the exact length of the file prefix whose every byte came through
 * the redacting append() path of a file begin() created in THIS process,
 * under redaction epoch `epoch` (rules version + instance known-secret set).
 * It is never persisted: a restart, a redactor upgrade or a change to the
 * known-secret set sends every byte back through the serve-time pass, and no
 * file on disk can switch that pass off.
 */
interface RedactedMark {
  ino: bigint;
  size: number;
  /**
   * Last bytes of the trusted prefix (up to MARK_TAIL_BYTES), re-read and
   * compared on every read and append so an in-place rewrite of the prefix
   * is caught.
   */
  tail: Buffer;
  epoch: string;
}

const MARK_TAIL_BYTES = 64;
const MAX_MARKS = 100_000;

function nextTail(previous: Buffer, appended: Buffer): Buffer {
  const joined = appended.length >= MARK_TAIL_BYTES ? appended : Buffer.concat([previous, appended]);
  return Buffer.from(joined.subarray(Math.max(0, joined.length - MARK_TAIL_BYTES)));
}

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  // Files created by begin() in this process — every byte in them arrived
  // through the redacting append() path. The mark is recorded at begin()
  // (never at a bare append(): appending to a pre-existing file must not mark
  // its legacy content safe) and verified on read against the file's inode,
  // exact size and prefix tail, so a restored or externally-written file
  // loses it. Capped: if it ever fills, entries are dropped and those files
  // simply get the serve-time pass again — the mark is an optimization, not
  // a safety boundary.
  const marks = new Map<string, RedactedMark>();
  // Per-file append chain: appends to one log run strictly in order, so the
  // mark's size always equals the bytes this store has finished writing.
  const appendChains = new Map<string, Promise<unknown>>();

  function serializePerFile<T>(absPath: string, task: () => Promise<T>): Promise<T> {
    const prev = appendChains.get(absPath) ?? Promise.resolve();
    const next = prev.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    appendChains.set(absPath, settled);
    void settled.then(() => {
      if (appendChains.get(absPath) === settled) appendChains.delete(absPath);
    });
    return next;
  }

  function rememberMark(absPath: string, mark: RedactedMark) {
    if (marks.size >= MAX_MARKS && !marks.has(absPath)) marks.clear();
    marks.set(absPath, mark);
  }

  /** The bytes just before `mark.size` are still the ones the store wrote. */
  async function prefixTailMatches(absPath: string, mark: Pick<RedactedMark, "size" | "tail">): Promise<boolean> {
    if (mark.tail.length === 0) return mark.size === 0;
    const fh = await fs.open(absPath, "r").catch(() => null);
    if (!fh) return false;
    try {
      const buffer = Buffer.alloc(mark.tail.length);
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, mark.size - mark.tail.length);
      return bytesRead === buffer.length && buffer.equals(mark.tail);
    } finally {
      await fh.close();
    }
  }

  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(
    filePath: string,
    offset: number,
    limitBytes: number,
  ): Promise<{ buffer: Buffer; start: number; nextOffset?: number; ino: bigint; size: number }> {
    const stat = await fs.stat(filePath, { bigint: true }).catch(() => null);
    if (!stat) throw notFound("Run log not found");
    const size = Number(stat.size);

    const start = Math.max(0, Math.min(offset, size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, size - 1));

    if (start > end) {
      return { buffer: Buffer.alloc(0), start, nextOffset: start, ino: stat.ino, size };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const nextOffset = end + 1 < size ? end + 1 : undefined;
    return { buffer: Buffer.concat(chunks), start, nextOffset, ino: stat.ino, size };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await serializePerFile(absPath, async () => {
        marks.delete(absPath);
        await fs.writeFile(absPath, "", "utf8");
        // The file is fresh and empty; from here on every append goes through
        // the redacting path, so the whole file is safe to serve without the
        // read pass. Record identity+size so a later mismatch drops the mark.
        const created = await fs.stat(absPath, { bigint: true }).catch(() => null);
        if (created && created.size === 0n) {
          rememberMark(absPath, { ino: created.ino, size: 0, tail: Buffer.alloc(0), epoch: runLogRedactionEpoch() });
        }
      });

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return 0;
      const absPath = resolveWithin(basePath, handle.logRef);
      // Epoch the line is redacted under — the mark only grows while it
      // still matches, so a key added mid-run never leaves earlier-redacted
      // bytes trusted.
      const epoch = runLogRedactionEpoch();
      // AgentDash (GH #992): defense in depth — callers redact before append
      // (with a stateful stream redactor for chunk boundaries), and the store
      // runs the stateless pass again so a forgotten call site still cannot
      // persist a known key.
      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: redactRunLogText(event.chunk),
        // Monotonic per-run sequence so readers can dedupe and order records
        // even when several identical chunks share the same millisecond ts
        // (common for ACP-style token deltas).
        ...(typeof event.seq === "number" && Number.isFinite(event.seq) ? { seq: event.seq } : {}),
      });
      const persisted = Buffer.from(`${line}\n`, "utf8");
      const persistedBytes = persisted.length;
      return serializePerFile(absPath, async () => {
        const mark = marks.get(absPath);
        const prefixIntact = mark ? await prefixTailMatches(absPath, mark) : false;
        const fh = await fs.open(absPath, "a");
        let before: { ino: bigint; size: bigint };
        let after: { size: bigint };
        try {
          before = await fh.stat({ bigint: true });
          await fh.appendFile(persisted);
          after = await fh.stat({ bigint: true });
        } finally {
          await fh.close();
        }
        // Keep the mark honest. Appending to a file that was not created by
        // begin() never earns one — its earlier content may be legacy raw
        // output. The mark grows only when the file was exactly the trusted
        // prefix before this write and exactly prefix+line after it, under
        // an unchanged redaction epoch; anything else drops it for good.
        if (mark && marks.get(absPath) === mark) {
          const intact =
            prefixIntact &&
            mark.epoch === epoch &&
            runLogRedactionEpoch() === epoch &&
            before.ino === mark.ino &&
            Number(before.size) === mark.size &&
            Number(after.size) === mark.size + persistedBytes;
          if (intact) {
            mark.size += persistedBytes;
            mark.tail = nextTail(mark.tail, persisted);
          } else {
            marks.delete(absPath);
          }
        }
        return persistedBytes;
      });
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      const hash = await sha256File(absPath);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      // Snapshot the mark BEFORE reading: appends only ever grow the file, so
      // the bytes it vouched for at this instant are still there when the
      // range is read, whatever appends land in between.
      const mark = marks.get(absPath) ?? null;
      const snapshot = mark ? { ino: mark.ino, size: mark.size, tail: mark.tail, epoch: mark.epoch } : null;
      const range = await readFileRange(absPath, offset, limitBytes);
      // The prefix is trusted only when the file is the same inode, its
      // prefix tail is unchanged, the redaction epoch is unchanged, and its
      // size is exactly what this store wrote: the snapshot size, or a larger
      // size explained by this store's own appends (one in flight, or one that
      // completed while the range was read). Any other size means bytes were
      // written behind the store's back — the mark is dropped for good. Bytes
      // past the snapshot are never trusted in this read; they get the pass.
      let verifiedPrefix = 0;
      let markValid = false;
      if (mark && snapshot) {
        const current = marks.get(absPath);
        const sizeExplained =
          range.size === snapshot.size ||
          (current === mark && (range.size === mark.size || appendChains.has(absPath)));
        if (
          range.ino === snapshot.ino &&
          snapshot.epoch === runLogRedactionEpoch() &&
          sizeExplained &&
          range.size >= snapshot.size &&
          (await prefixTailMatches(absPath, snapshot))
        ) {
          verifiedPrefix = snapshot.size;
          markValid = true;
        } else {
          await serializePerFile(absPath, async () => {
            // Re-check inside the chain: begin() may have just recreated it.
            if (marks.get(absPath) === mark) marks.delete(absPath);
          });
        }
      }
      const verifiedBytes = Math.max(0, Math.min(range.buffer.length, verifiedPrefix - range.start));
      return {
        content: range.buffer.toString("utf8"),
        nextOffset: range.nextOffset,
        redactedAtPersist: markValid && verifiedBytes >= range.buffer.length,
        buffer: range.buffer,
        verifiedBytes,
        startOffset: range.start,
      };
    },
  };
}

let cachedStore: RunLogStore | null = null;

// AgentDash run-fix: expose the resolved run-log base dir so the orphan reaper
// can stat a run's log-file mtime to detect a still-live (actively writing) run.
export function runLogBasePath() {
  return process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
}

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  cachedStore = createLocalFileRunLogStore(runLogBasePath());
  return cachedStore;
}

/** Tests only: drop the cached store after RUN_LOG_BASE_PATH changes. */
export function resetRunLogStoreForTests(): void {
  cachedStore = null;
}

// (ci: re-triggered after a flaky verify hang; no functional change)
