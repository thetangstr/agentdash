// AgentDash (GH #992): `redactedAtPersist` must mean "every byte in this file
// came through the redacting append path" — a file seeded before the mark was
// recorded keeps its legacy content, so appending to it must never mark it.
import { mkdtemp, mkdir, rm, writeFile, appendFile, readFile, rename, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRunLogStore,
  resetRunLogStoreForTests,
  RUN_LOG_REDACTED_MARK_SUFFIX,
} from "../services/run-log-store.js";
import { redactRunLogNdjson, redactRunLogReadForServe } from "../services/run-log-redaction.js";

describe("run-log store redactedAtPersist mark", () => {
  let base: string;
  let prevBasePath: string | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "run-log-store-"));
    prevBasePath = process.env.RUN_LOG_BASE_PATH;
    process.env.RUN_LOG_BASE_PATH = base;
    resetRunLogStoreForTests();
  });

  afterEach(async () => {
    if (prevBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = prevBasePath;
    resetRunLogStoreForTests();
    await rm(base, { recursive: true, force: true });
  });

  it("does not mark a legacy file appended to without begin()", async () => {
    const store = getRunLogStore();
    const logRef = join("c1", "a1", "r1.ndjson");
    await mkdir(join(base, "c1", "a1"), { recursive: true });
    // Legacy pre-redaction content written directly to disk.
    await writeFile(
      join(base, logRef),
      JSON.stringify({ ts: "t", stream: "stdout", chunk: "API_KEY=Zq8Rk2Vm7Tn4Wb9Xc3Ls\n" }) + "\n",
    );
    const before = await store.read({ store: "local_file", logRef });
    expect(before.redactedAtPersist).not.toBe(true);

    // The would-stop shadow-line path appends to a run's existing logRef.
    await store.append(
      { store: "local_file", logRef },
      { stream: "system", chunk: "[agentdash] shadow\n", ts: "t" },
    );
    const after = await store.read({ store: "local_file", logRef });
    // The append is redacted, but the mark must stay off so the serve-time
    // pass still catches the raw legacy line.
    expect(after.redactedAtPersist).not.toBe(true);
  });

  it("marks a begin()-created file and drops the mark on external writes", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "r2" });
    await store.append(handle, { stream: "stdout", chunk: "all good\n", ts: "t" });
    const marked = await store.read(handle);
    expect(marked.redactedAtPersist).toBe(true);

    // An outside writer — a restored copy or another process — changes the
    // file behind the store's back; the mark must not survive.
    await appendFile(join(base, handle.logRef), "external raw line\n");
    const after = await store.read(handle);
    expect(after.redactedAtPersist).not.toBe(true);
  });

  it("keeps the trusted prefix (not the whole mark) when bytes are written behind its back", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "r3" });
    await store.append(handle, { stream: "stdout", chunk: "first\n", ts: "t" });
    const prefix = (await store.read(handle)).content;
    await appendFile(join(base, handle.logRef), "external raw line\n");
    await store.append(handle, { stream: "stdout", chunk: "second\n", ts: "t" });

    const after = await store.read(handle);
    expect(after.redactedAtPersist).not.toBe(true);
    // Only the bytes the redacting writer produced before the foreign write
    // stay trusted; the foreign line and everything after it are not.
    expect(after.verifiedChars).toBe(prefix.length);
    expect(after.content.slice(0, after.verifiedChars)).toBe(prefix);
  });

  it("serializes concurrent appends and never drops the mark when reads race them", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "r4" });
    const pending: Promise<unknown>[] = [];
    const reads: Promise<{ redactedAtPersist?: boolean; content: string; verifiedChars?: number }>[] = [];
    for (let seq = 0; seq < 300; seq++) {
      pending.push(store.append(handle, { stream: "stdout", chunk: `line ${seq} ${"x".repeat(seq % 50)}\n`, ts: "t", seq }));
      reads.push(store.read(handle));
    }
    await Promise.all(pending);
    // A read racing an append may see a partly-written tail, but the bytes it
    // does trust always form whole, complete lines from the redacting writer.
    for (const read of await Promise.all(reads)) {
      const trusted = read.content.slice(0, read.verifiedChars ?? 0);
      expect(trusted === "" || trusted.endsWith("\n")).toBe(true);
    }
    const final = await store.read(handle);
    expect(final.redactedAtPersist).toBe(true);
    const finalBytes = Buffer.byteLength(final.content);
    expect(Buffer.byteLength(final.content.slice(0, final.verifiedChars ?? 0))).toBe(finalBytes);
    const seqs = final.content.trim().split("\n").map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });

  it("persists the mark across a restart for a finalized log", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "r5" });
    for (let i = 0; i < 20; i++) await store.append(handle, { stream: "stdout", chunk: `ok ${i}\n`, ts: "t" });
    await store.finalize(handle);

    resetRunLogStoreForTests(); // a new process: in-memory marks are gone
    const restarted = getRunLogStore();
    const read = await restarted.read(handle);
    expect(read.redactedAtPersist).toBe(true);
    expect(read.verifiedChars).toBe(read.content.length);

    // Appending after the restart keeps extending the trusted prefix.
    await restarted.append(handle, { stream: "stdout", chunk: "after restart\n", ts: "t" });
    expect((await restarted.read(handle)).redactedAtPersist).toBe(true);
  });

  it("after a restart trusts only the persisted prefix of a live log", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "r6" });
    await store.append(handle, { stream: "stdout", chunk: "one\n", ts: "t" });
    // No finalize: the sidecar may lag the file. Whatever it does not cover
    // must come back untrusted.
    resetRunLogStoreForTests();
    const read = await getRunLogStore().read(handle);
    const sidecar = JSON.parse(await readFile(join(base, handle.logRef + RUN_LOG_REDACTED_MARK_SUFFIX), "utf8")) as {
      size: number;
    };
    const trustedBytes = Buffer.byteLength(read.content.slice(0, read.verifiedChars ?? 0));
    expect(trustedBytes).toBe(Math.min(sidecar.size, Buffer.byteLength(read.content)));
    expect(read.redactedAtPersist).toBe(sidecar.size >= Buffer.byteLength(read.content));
  });

  it("does not trust a legacy file (no mark) after a restart, and serves it redacted", async () => {
    const logRef = join("c1", "a1", "legacy.ndjson");
    await mkdir(join(base, "c1", "a1"), { recursive: true });
    const raw = JSON.stringify({ ts: "t", stream: "stdout", chunk: "export API_KEY=Zq8Rk2Vm7Tn4Wb9Xc3Ls\n" }) + "\n";
    await writeFile(join(base, logRef), raw);
    resetRunLogStoreForTests();
    const read = await getRunLogStore().read({ store: "local_file", logRef });
    expect(read.redactedAtPersist).not.toBe(true);
    expect(read.verifiedChars).toBe(0);
    const served = await redactRunLogReadForServe(read);
    expect(served.content).not.toContain("Zq8Rk2Vm7Tn4Wb9Xc3Ls");
    expect(served.content).toBe(redactRunLogNdjson(raw));
  });

  it("drops the mark when the file is replaced (new inode) or truncated", async () => {
    const store = getRunLogStore();
    const replaced = await store.begin({ companyId: "c1", agentId: "a1", runId: "r7" });
    await store.append(replaced, { stream: "stdout", chunk: "fine\n", ts: "t" });
    await store.finalize(replaced);
    const abs = join(base, replaced.logRef);
    const inoBefore = (await stat(abs)).ino;
    // A restored copy: same bytes, new inode, stale sidecar alongside.
    await writeFile(`${abs}.restore`, await readFile(abs));
    await rename(`${abs}.restore`, abs);
    expect((await stat(abs)).ino).not.toBe(inoBefore);
    resetRunLogStoreForTests();
    const afterRestore = await getRunLogStore().read(replaced);
    expect(afterRestore.redactedAtPersist).not.toBe(true);
    expect(afterRestore.verifiedChars).toBe(0);

    const truncated = await getRunLogStore().begin({ companyId: "c1", agentId: "a1", runId: "r8" });
    await getRunLogStore().append(truncated, { stream: "stdout", chunk: "aaaaaaaaaa\n", ts: "t" });
    await truncate(join(base, truncated.logRef), 5);
    await appendFile(join(base, truncated.logRef), "raw tail that is longer than before\n");
    // Same inode, size grown past the mark: the prefix fingerprint no longer
    // matches, so none of it is trusted.
    const afterTruncate = await getRunLogStore().read(truncated);
    expect(afterTruncate.redactedAtPersist).not.toBe(true);
    expect(afterTruncate.verifiedChars).toBe(0);
    await getRunLogStore().append(truncated, { stream: "stdout", chunk: "next\n", ts: "t" });
    const afterAppend = await getRunLogStore().read(truncated);
    expect(afterAppend.verifiedChars).toBe(0);
    expect(afterAppend.redactedAtPersist).not.toBe(true);
  });
});
