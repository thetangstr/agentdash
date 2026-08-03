import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSemaphoreArtifacts, __artifactUrlsForDepth } from "./zk-artifacts.js";

// Root-cause regression for the zk test flake (CLO-137): @zk-kit/artifacts streams the
// wasm/zkey straight to their final path, resolves BEFORE the stream flushes, and only
// checks existsSync — so under IO load a TRUNCATED artifact is cached and consumed, and
// generateProof throws nondeterministically. resolveSemaphoreArtifacts must instead buffer
// the whole body, verify it against Content-Length, and write atomically, so a short
// download is REJECTED rather than silently cached.

const DEPTH = 3;

// A Response-shaped stub good enough for the resolver (ok, headers.get, arrayBuffer).
function fakeResponse(body: Uint8Array, opts: { contentLength?: string | null; ok?: boolean; status?: number } = {}) {
  const contentLength = opts.contentLength === undefined ? String(body.byteLength) : opts.contentLength;
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: "OK",
    headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? contentLength : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

describe("resolveSemaphoreArtifacts (truncation-proof artifact cache)", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "zk-artifacts-test-"));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("uses the exact PSE version/params Semaphore expects", () => {
    const { wasm, zkey } = __artifactUrlsForDepth(DEPTH);
    expect(wasm).toBe("https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-3.wasm");
    expect(zkey).toBe("https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-3.zkey");
  });

  it("writes complete files whose bytes match what the server sent", async () => {
    const wasmBytes = new Uint8Array(2048).fill(7);
    const zkeyBytes = new Uint8Array(4096).fill(9);
    const fetchImpl = async (url: string) =>
      fakeResponse(url.endsWith(".wasm") ? wasmBytes : zkeyBytes) as unknown as Response;

    const art = await resolveSemaphoreArtifacts(DEPTH, { cacheDir, fetchImpl });

    expect(existsSync(art.wasm)).toBe(true);
    expect(existsSync(art.zkey)).toBe(true);
    expect(readFileSync(art.wasm).byteLength).toBe(2048);
    expect(readFileSync(art.zkey).byteLength).toBe(4096);
  });

  it("REJECTS a truncated download (body shorter than Content-Length) and caches no partial file", async () => {
    // The server advertises 4096 bytes but the body arrives short — the exact flake shape.
    const shortZkey = new Uint8Array(1000).fill(9);
    const fetchImpl = async (url: string) =>
      (url.endsWith(".wasm")
        ? fakeResponse(new Uint8Array(2048).fill(7))
        : fakeResponse(shortZkey, { contentLength: "4096" })) as unknown as Response;

    await expect(resolveSemaphoreArtifacts(DEPTH, { cacheDir, fetchImpl, maxAttempts: 1 })).rejects.toThrow(
      /truncat|incomplete|content-length|1000|4096/i,
    );

    // Critically: no truncated artifact and no temp residue may be left behind.
    const leaked = readdirSync(cacheDir, { recursive: true } as { recursive: true }) as string[];
    expect(leaked.some((f) => f.endsWith(".zkey"))).toBe(false);
    expect(leaked.some((f) => f.includes(".tmp"))).toBe(false);
  });

  it("recovers from a transient truncation by re-fetching (integrity-driven, not blind retry)", async () => {
    let zkeyCalls = 0;
    const fetchImpl = async (url: string) => {
      if (url.endsWith(".wasm")) return fakeResponse(new Uint8Array(2048).fill(7)) as unknown as Response;
      zkeyCalls += 1;
      // First attempt truncates; second delivers the full body.
      return (zkeyCalls === 1
        ? fakeResponse(new Uint8Array(1000).fill(9), { contentLength: "4096" })
        : fakeResponse(new Uint8Array(4096).fill(9))) as unknown as Response;
    };

    const art = await resolveSemaphoreArtifacts(DEPTH, { cacheDir, fetchImpl, maxAttempts: 3 });
    expect(readFileSync(art.zkey).byteLength).toBe(4096);
    expect(zkeyCalls).toBe(2);
  });

  it("reuses a cached artifact without re-fetching (stable across invocations)", async () => {
    let calls = 0;
    const fetchImpl = async (url: string) => {
      calls += 1;
      return fakeResponse(url.endsWith(".wasm") ? new Uint8Array(2048).fill(7) : new Uint8Array(4096).fill(9)) as unknown as Response;
    };

    await resolveSemaphoreArtifacts(DEPTH, { cacheDir, fetchImpl });
    const firstCalls = calls;
    // A second resolve against the same stable dir must not hit the network at all,
    // even from a fresh memo (new fetch that would throw if called).
    const art = await resolveSemaphoreArtifacts(DEPTH, {
      cacheDir,
      fetchImpl: async () => {
        throw new Error("must not re-fetch a cached artifact");
      },
    });
    expect(art.wasm).toContain("semaphore-3.wasm");
    expect(calls).toBe(firstCalls);
  });

  it("never returns a file at the destination unless it is complete (existence ⇒ completeness)", async () => {
    // A leftover *complete* file is trusted; the resolver only ever writes atomically, so
    // anything present at the final path is whole by construction.
    const fetchImpl = async (url: string) =>
      fakeResponse(url.endsWith(".wasm") ? new Uint8Array(2048).fill(7) : new Uint8Array(4096).fill(9)) as unknown as Response;
    const art = await resolveSemaphoreArtifacts(DEPTH, { cacheDir, fetchImpl });
    // No .tmp files linger after a successful resolve.
    const files = readdirSync(cacheDir, { recursive: true } as { recursive: true }) as string[];
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
    expect(existsSync(art.wasm)).toBe(true);
  });
});
