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
   * AgentDash (GH #992): true when every byte of this file was appended
   * through the store's redacting path in this process — readers may then
   * skip the serve-time re-redaction pass. Files written before the
   * redaction change (or after a restart clears the mark) report false and
   * still get the pass.
   */
  redactedAtPersist?: boolean;
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
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
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

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  // Files created by begin() in this process — every byte in them arrived
  // through the redacting append() path. The mark is recorded at begin()
  // (never at append(): appending to a pre-existing file must not mark its
  // legacy content safe) and verified on read against the file's actual
  // inode/size so a restored or externally-written file loses the mark.
  // Capped: if it ever fills, entries are dropped and those files simply
  // get the serve-time pass again — the mark is an optimization, not a
  // safety boundary.
  const redactedAtPersist = new Map<string, { ino: number; size: number }>();

  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
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

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
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
      await fs.writeFile(absPath, "", "utf8");
      // The file is fresh and empty; from here on every append goes through
      // the redacting path, so the whole file is safe to serve without the
      // read pass. Record identity+size so a later mismatch drops the mark.
      const created = await fs.stat(absPath).catch(() => null);
      if (created && created.size === 0) {
        if (redactedAtPersist.size > 100_000) redactedAtPersist.clear();
        redactedAtPersist.set(absPath, { ino: created.ino, size: created.size });
      }

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
      });
      const persisted = `${line}\n`;
      const persistedBytes = Buffer.byteLength(persisted, "utf8");
      await fs.appendFile(absPath, persisted, "utf8");
      // Keep the recorded size honest for marked files. Appending to a file
      // that was not created by begin() never earns the mark — its earlier
      // content may be legacy raw output.
      const mark = redactedAtPersist.get(absPath);
      if (mark) mark.size += persistedBytes;
      return persistedBytes;
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
      const result = await readFileRange(absPath, offset, limitBytes);
      const mark = redactedAtPersist.get(absPath);
      let marked = false;
      if (mark) {
        // Trust the mark only while the file is still the one begin()
        // created and its size matches exactly the bytes append() wrote —
        // a restored copy or a concurrent external writer drops it.
        const stat = await fs.stat(absPath).catch(() => null);
        marked = !!stat && stat.ino === mark.ino && stat.size === mark.size;
        if (!marked) redactedAtPersist.delete(absPath);
      }
      return { ...result, redactedAtPersist: marked };
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
