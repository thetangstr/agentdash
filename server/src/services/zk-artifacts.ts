// CLO-137: truncation-proof Semaphore snark-artifact resolution.
//
// Why this exists: @zk-kit/artifacts (used by @semaphore-protocol/proof's generateProof)
// streams the wasm/zkey straight to their FINAL path, resolves the promise BEFORE the write
// stream has flushed, does no length check, and treats existsSync as "complete". Under IO/CPU
// load the artifact arrives TRUNCATED and generateProof throws nondeterministically — the zk
// test flake (empirically: ~3/6 downloads truncated under load). Worse, the library caches at
// `${tmpdir()}/snark-artifacts`, and the stable test runner hands every invocation a fresh
// ephemeral TMPDIR, so the cache is cold every run and the race is hit every time.
//
// This resolver fixes the root cause: it buffers the whole body, verifies it against
// Content-Length, writes atomically (temp file -> fsync -> rename) into a STABLE cache dir
// independent of TMPDIR (so it is downloaded once and reused), and re-fetches on a verified
// truncation instead of caching a partial file. Callers pass the result to generateProof's
// snarkArtifacts parameter, bypassing the broken downloader entirely.

import { existsSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

// The version + host @semaphore-protocol/proof@4.14.3 pins internally
// (maybeGetSnarkArtifacts(SEMAPHORE, { parameters: [depth], version: "4.13.0" })).
// Keep in lockstep with the installed proof package.
const ARTIFACTS_VERSION = "4.13.0";
const ARTIFACTS_BASE_URL = "https://snark-artifacts.pse.dev/semaphore";

export type SnarkArtifacts = { wasm: string; zkey: string };

type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type ResolveOptions = {
  /** Stable cache directory. Defaults to a persistent per-user dir (NOT the ephemeral TMPDIR). */
  cacheDir?: string;
  /** Injectable fetch, for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Bounded, integrity-driven re-fetch on verified truncation. Default 3. */
  maxAttempts?: number;
};

/** The exact PSE URLs Semaphore would resolve for a given merkle-tree depth. */
export function __artifactUrlsForDepth(depth: number): { wasm: string; zkey: string } {
  const base = `${ARTIFACTS_BASE_URL}/${ARTIFACTS_VERSION}/semaphore-${depth}`;
  return { wasm: `${base}.wasm`, zkey: `${base}.zkey` };
}

function defaultCacheDir(): string {
  const override = process.env.AGENTDASH_ZK_ARTIFACTS_DIR;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".cache", "agentdash", "snark-artifacts", ARTIFACTS_VERSION);
}

// Dedupe concurrent resolutions for the same (dir, depth) within one process. Entries live
// only for the duration of the in-flight resolution and are never left holding a rejection.
const inflight = new Map<string, Promise<SnarkArtifacts>>();

/**
 * Download (once) and return local paths to the Semaphore wasm/zkey for `depth`, guaranteed
 * complete. Safe to call concurrently and on every proof — a present file is complete by
 * construction, because this is the only writer and it only ever renames a fully-verified
 * temp file into place.
 */
export async function resolveSemaphoreArtifacts(depth: number, opts: ResolveOptions = {}): Promise<SnarkArtifacts> {
  const dir = opts.cacheDir ?? defaultCacheDir();
  const key = `${dir} ${depth}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const run = (async (): Promise<SnarkArtifacts> => {
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    const { wasm: wasmUrl, zkey: zkeyUrl } = __artifactUrlsForDepth(depth);
    const wasmDest = path.join(dir, `semaphore-${depth}.wasm`);
    const zkeyDest = path.join(dir, `semaphore-${depth}.zkey`);
    await mkdir(dir, { recursive: true });
    // allSettled (not all): let both downloads fully settle so each cleans up its own temp
    // file before we surface a failure — a fail-fast reject would orphan the sibling's *.tmp.
    const results = await Promise.allSettled([
      ensureCompleteFile(wasmUrl, wasmDest, fetchImpl, maxAttempts),
      ensureCompleteFile(zkeyUrl, zkeyDest, fetchImpl, maxAttempts),
    ]);
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
    return { wasm: wasmDest, zkey: zkeyDest };
  })();

  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

async function ensureCompleteFile(url: string, dest: string, fetchImpl: FetchLike, maxAttempts: number): Promise<void> {
  // A file present at the final path was put there by an atomic rename of a verified body,
  // so its mere existence means it is complete — unlike @zk-kit's existsSync-on-a-partial.
  if (existsSync(dest)) return;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let tmp: string | undefined;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);

      const buf = Buffer.from(await res.arrayBuffer());
      const declared = res.headers.get("content-length");
      if (declared !== null && declared !== undefined) {
        const expected = Number(declared);
        if (Number.isFinite(expected) && buf.byteLength !== expected) {
          throw new Error(
            `truncated download ${url}: got ${buf.byteLength} of ${expected} bytes (content-length mismatch)`,
          );
        }
      }
      if (buf.byteLength === 0) throw new Error(`empty download ${url}`);

      // Atomic publish: write + fsync a uniquely-named temp, then rename onto the final path.
      // A crash or truncation can only ever leave a *.tmp orphan, never a partial artifact.
      tmp = `${dest}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      const handle = await open(tmp, "w");
      try {
        await handle.writeFile(buf);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, dest);
      tmp = undefined; // renamed away — nothing to clean
      return;
    } catch (err) {
      lastErr = err;
      if (tmp) await rm(tmp, { force: true }).catch(() => {});
      if (attempt >= maxAttempts) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
