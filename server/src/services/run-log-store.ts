import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { redactRunLogText } from "./run-log-redaction.js";

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
   * Number of leading UTF-16 chars of `content` covered by the redacting
   * writer's mark. Equals `content.length` when `redactedAtPersist` is true,
   * 0 when nothing in the range is covered. The boundary always falls on a
   * line end, so the uncovered tail starts a fresh NDJSON line.
   */
  verifiedChars?: number;
  /** Byte offset in the file at which `content` starts. */
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
 * AgentDash: "written redacted" mark for a log file. `size` is the length of
 * the file prefix whose every byte came through the redacting append() path
 * of a file begin() created. `frozen` means a byte NOT written by append()
 * was seen after that prefix (an external writer): the prefix stays trusted,
 * nothing after it ever is.
 */
interface RedactedMark {
  ino: number;
  size: number;
  /**
   * Last bytes of the trusted prefix (up to MARK_TAIL_BYTES), re-read and
   * compared on every read so a file truncated and rewritten in place (same
   * inode, size grown past the mark) never has its new bytes trusted.
   */
  tail: Buffer;
  frozen: boolean;
  persistedAt: number;
}

const MARK_TAIL_BYTES = 64;

function nextTail(previous: Buffer, appended: Buffer): Buffer {
  const joined = appended.length >= MARK_TAIL_BYTES ? appended : Buffer.concat([previous, appended]);
  return Buffer.from(joined.subarray(Math.max(0, joined.length - MARK_TAIL_BYTES)));
}

/** Sidecar next to the log that carries the mark across restarts. */
export const RUN_LOG_REDACTED_MARK_SUFFIX = ".redacted-mark.json";
const MARK_SIDECAR_VERSION = 1;
// A live run rewrites its sidecar at most this often; a lagging sidecar only
// means a restart re-redacts the few bytes written since the last write.
const MARK_PERSIST_INTERVAL_MS = 2_000;
const MAX_MARKS = 100_000;

function sidecarPath(absPath: string) {
  return `${absPath}${RUN_LOG_REDACTED_MARK_SUFFIX}`;
}

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  // Files created by begin() — every byte in them arrived through the
  // redacting append() path. The mark is recorded at begin() (never at a bare
  // append(): appending to a pre-existing file must not mark its legacy
  // content safe) and verified on read against the file's inode/size, so a
  // restored or externally-written file never has its foreign bytes trusted.
  // It is persisted to a sidecar so a restart does not make every existing
  // log pay the serve-time redaction pass again. Capped: if it ever fills,
  // entries are dropped and reloaded from the sidecar on demand — the mark is
  // an optimization, not a safety boundary.
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

  async function writeSidecar(absPath: string, mark: RedactedMark) {
    const target = sidecarPath(absPath);
    const tmp = `${target}.${process.pid}.tmp`;
    const body = JSON.stringify({
      v: MARK_SIDECAR_VERSION,
      ino: String(mark.ino),
      size: mark.size,
      tail: mark.tail.toString("base64"),
      frozen: mark.frozen,
    });
    try {
      await fs.writeFile(tmp, body, "utf8");
      await fs.rename(tmp, target);
      mark.persistedAt = Date.now();
    } catch {
      // Best effort: without a sidecar the file is simply re-redacted on read
      // after a restart.
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async function dropMark(absPath: string) {
    marks.delete(absPath);
    await fs.rm(sidecarPath(absPath), { force: true }).catch(() => undefined);
  }

  /** In-memory mark, else the persisted sidecar (after a restart). */
  async function loadMark(absPath: string): Promise<RedactedMark | null> {
    const inMemory = marks.get(absPath);
    if (inMemory) return inMemory;
    const raw = await fs.readFile(sidecarPath(absPath), "utf8").catch(() => null);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; ino?: unknown; size?: unknown; tail?: unknown; frozen?: unknown };
      const ino = Number(parsed.ino);
      if (
        parsed.v !== MARK_SIDECAR_VERSION ||
        typeof parsed.ino !== "string" ||
        !Number.isFinite(ino) ||
        typeof parsed.size !== "number" ||
        !Number.isSafeInteger(parsed.size) ||
        parsed.size < 0 ||
        typeof parsed.tail !== "string"
      ) {
        return null;
      }
      const tail = Buffer.from(parsed.tail, "base64");
      if (tail.length !== Math.min(MARK_TAIL_BYTES, parsed.size)) return null;
      const mark: RedactedMark = { ino, size: parsed.size, tail, frozen: parsed.frozen === true, persistedAt: Date.now() };
      rememberMark(absPath, mark);
      return mark;
    } catch {
      return null;
    }
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
  ): Promise<{ buffer: Buffer; start: number; nextOffset?: number; ino: number; size: number }> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { buffer: Buffer.alloc(0), start, nextOffset: start, ino: stat.ino, size: stat.size };
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

    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { buffer: Buffer.concat(chunks), start, nextOffset, ino: stat.ino, size: stat.size };
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
        // Clear any stale mark first so a crash between the truncate and the
        // new sidecar can never leave an old mark describing new content.
        await dropMark(absPath);
        await fs.writeFile(absPath, "", "utf8");
        // The file is fresh and empty; from here on every append goes through
        // the redacting path, so the whole file is safe to serve without the
        // read pass. Record identity+size so a later mismatch is detected.
        const created = await fs.stat(absPath).catch(() => null);
        if (created && created.size === 0) {
          const mark: RedactedMark = { ino: created.ino, size: 0, tail: Buffer.alloc(0), frozen: false, persistedAt: 0 };
          rememberMark(absPath, mark);
          await writeSidecar(absPath, mark);
        }
      });

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return 0;
      const absPath = resolveWithin(basePath, handle.logRef);
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
        const mark = await loadMark(absPath);
        // The trusted prefix must still hold the bytes this store wrote — a
        // same-inode truncate-and-rewrite would otherwise slip under it.
        const prefixIntact = mark && !mark.frozen ? await prefixTailMatches(absPath, mark) : false;
        const fh = await fs.open(absPath, "a");
        let before: { ino: number; size: number };
        let after: { size: number };
        try {
          before = await fh.stat();
          await fh.appendFile(persisted);
          after = await fh.stat();
        } finally {
          await fh.close();
        }
        // Keep the mark honest. Appending to a file that was not created by
        // begin() never earns one — its earlier content may be legacy raw
        // output. The mark only grows when the file was exactly the verified
        // prefix before this write and exactly prefix+line after it, so no
        // foreign byte can ever land inside the trusted prefix.
        if (mark && !mark.frozen) {
          if (before.ino !== mark.ino || before.size < mark.size || !prefixIntact) {
            await dropMark(absPath);
          } else if (before.size === mark.size && after.size === before.size + persistedBytes) {
            mark.size = after.size;
            mark.tail = nextTail(mark.tail, persisted);
            if (Date.now() - mark.persistedAt >= MARK_PERSIST_INTERVAL_MS) await writeSidecar(absPath, mark);
          } else {
            mark.frozen = true;
            await writeSidecar(absPath, mark);
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
      // Flush the mark once the run's appends have drained so a restart
      // trusts the whole finished file.
      await serializePerFile(absPath, async () => {
        const mark = marks.get(absPath);
        if (mark) await writeSidecar(absPath, mark);
      });
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
      const mark = await loadMark(absPath);
      const snapshot = mark ? { ino: mark.ino, size: mark.size, tail: mark.tail } : null;
      const range = await readFileRange(absPath, offset, limitBytes);
      // Length of the trusted prefix. A size above the mark is an append in
      // flight (or a foreign write after the prefix): only the bytes beyond
      // the prefix lose trust, never the prefix itself. A different inode, a
      // file shorter than the prefix, or prefix bytes that no longer match
      // mean the prefix itself changed — nothing is trusted, the mark drops.
      let verifiedPrefix = 0;
      let markValid = false;
      if (mark && snapshot) {
        if (range.ino === snapshot.ino && range.size >= snapshot.size && (await prefixTailMatches(absPath, snapshot))) {
          verifiedPrefix = snapshot.size;
          markValid = true;
        } else {
          await serializePerFile(absPath, async () => {
            // Re-check inside the chain: begin() may have just recreated it.
            const current = marks.get(absPath);
            if (current === mark) await dropMark(absPath);
          });
        }
      }
      const coveredBytes = Math.max(0, Math.min(range.buffer.length, verifiedPrefix - range.start));
      const content = range.buffer.toString("utf8");
      const verifiedChars =
        coveredBytes >= range.buffer.length
          ? content.length
          : coveredBytes === 0
            ? 0
            : range.buffer.subarray(0, coveredBytes).toString("utf8").length;
      return {
        content,
        nextOffset: range.nextOffset,
        redactedAtPersist: markValid && coveredBytes >= range.buffer.length,
        verifiedChars,
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
