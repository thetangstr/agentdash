// AgentDash (GH #992): `redactedAtPersist` must mean "every byte in this file
// came through the redacting append path" — a file seeded before the mark was
// recorded keeps its legacy content, so appending to it must never mark it.
import { mkdtemp, mkdir, rm, writeFile, appendFile, readFile, rename, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRunLogStore, resetRunLogStoreForTests } from "../services/run-log-store.js";
import {
  redactRunLogNdjson,
  redactRunLogReadForServe,
  resetInstanceSecretsCacheForTests,
} from "../services/run-log-redaction.js";

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

  it("drops the mark for good when bytes are written behind its back", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "r3" });
    await store.append(handle, { stream: "stdout", chunk: "first\n", ts: "t" });
    await appendFile(join(base, handle.logRef), "external raw line\n");
    await store.append(handle, { stream: "stdout", chunk: "second\n", ts: "t" });

    const after = await store.read(handle);
    expect(after.redactedAtPersist).not.toBe(true);
    expect(after.verifiedBytes).toBe(0);
  });

  it("serializes concurrent appends and never drops the mark when reads race them", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "r4" });
    const pending: Promise<unknown>[] = [];
    const reads: Promise<{ redactedAtPersist?: boolean; buffer?: Buffer; verifiedBytes?: number }>[] = [];
    for (let seq = 0; seq < 300; seq++) {
      pending.push(store.append(handle, { stream: "stdout", chunk: `line ${seq} ${"x".repeat(seq % 50)}\n`, ts: "t", seq }));
      reads.push(store.read(handle));
    }
    await Promise.all(pending);
    // A read racing an append may see a partly-written tail, but the bytes it
    // does trust always form whole, complete lines from the redacting writer.
    for (const read of await Promise.all(reads)) {
      const trusted = read.buffer!.subarray(0, read.verifiedBytes ?? 0).toString("utf8");
      expect(trusted === "" || trusted.endsWith("\n")).toBe(true);
    }
    const final = await store.read(handle);
    expect(final.redactedAtPersist).toBe(true);
    expect(final.verifiedBytes).toBe(final.buffer!.length);
    const seqs = final.content.trim().split("\n").map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });

  it("carries no trust across a restart: the log is fully re-redacted", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "r5" });
    for (let i = 0; i < 20; i++) await store.append(handle, { stream: "stdout", chunk: `ok ${i}\n`, ts: "t" });
    await store.finalize(handle);
    expect((await store.read(handle)).redactedAtPersist).toBe(true);

    resetRunLogStoreForTests(); // a new process: in-memory marks are gone
    const restarted = getRunLogStore();
    const read = await restarted.read(handle);
    expect(read.redactedAtPersist).not.toBe(true);
    expect(read.verifiedBytes).toBe(0);
    expect((await redactRunLogReadForServe(read)).content).toBe(redactRunLogNdjson(read.content));

    // Appending after the restart never re-earns trust for the old bytes.
    await restarted.append(handle, { stream: "stdout", chunk: "after restart\n", ts: "t" });
    expect((await restarted.read(handle)).verifiedBytes).toBe(0);
  });

  it("ignores a forged or leftover .redacted-mark.json sidecar on a raw file", async () => {
    const logRef = join("c1", "a1", "forged.ndjson");
    await mkdir(join(base, "c1", "a1"), { recursive: true });
    const raw = JSON.stringify({ ts: "t", stream: "stdout", chunk: "export API_KEY=Zq8Rk2Vm7Tn4Wb9Xc3Ls\n" }) + "\n";
    const abs = join(base, logRef);
    await writeFile(abs, raw);
    const st = await stat(abs, { bigint: true });
    const bytes = Buffer.from(raw);
    await writeFile(
      `${abs}.redacted-mark.json`,
      JSON.stringify({ v: 1, ino: String(st.ino), size: bytes.length, tail: bytes.subarray(-64).toString("base64"), frozen: false }),
    );
    resetRunLogStoreForTests();
    const read = await getRunLogStore().read({ store: "local_file", logRef });
    expect(read.redactedAtPersist).not.toBe(true);
    expect(read.verifiedBytes).toBe(0);
    expect((await redactRunLogReadForServe(read)).content).not.toContain("Zq8Rk2Vm7Tn4Wb9Xc3Ls");
  });

  it("re-redacts marked bytes once a secret is added to the instance set at runtime", async () => {
    const lateSecret = "late-added-provider-key-7f3a9c2d4e5a";
    const prev = process.env.RUNLOG_TEST_PROVIDER_API_KEY;
    try {
      delete process.env.RUNLOG_TEST_PROVIDER_API_KEY;
      resetInstanceSecretsCacheForTests();
      const store = getRunLogStore();
      const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "r9" });
      // Not a known secret yet and shapeless — written as-is.
      await store.append(handle, { stream: "stdout", chunk: `value ${lateSecret}\n`, ts: "t" });
      const before = await store.read(handle);
      expect(before.redactedAtPersist).toBe(true);
      expect(before.content).toContain(lateSecret);

      // The operator configures it as a key; the instance cache refreshes.
      process.env.RUNLOG_TEST_PROVIDER_API_KEY = lateSecret;
      resetInstanceSecretsCacheForTests();
      const after = await store.read(handle);
      expect(after.redactedAtPersist).not.toBe(true);
      expect(after.verifiedBytes).toBe(0);
      const served = await redactRunLogReadForServe(after);
      expect(served.content).not.toContain(lateSecret);
    } finally {
      if (prev === undefined) delete process.env.RUNLOG_TEST_PROVIDER_API_KEY;
      else process.env.RUNLOG_TEST_PROVIDER_API_KEY = prev;
      resetInstanceSecretsCacheForTests();
    }
  });

  it("does not trust a legacy file (no mark) and serves it redacted", async () => {
    const logRef = join("c1", "a1", "legacy.ndjson");
    await mkdir(join(base, "c1", "a1"), { recursive: true });
    const raw = JSON.stringify({ ts: "t", stream: "stdout", chunk: "export API_KEY=Zq8Rk2Vm7Tn4Wb9Xc3Ls\n" }) + "\n";
    await writeFile(join(base, logRef), raw);
    const read = await getRunLogStore().read({ store: "local_file", logRef });
    expect(read.redactedAtPersist).not.toBe(true);
    expect(read.verifiedBytes).toBe(0);
    const served = await redactRunLogReadForServe(read);
    expect(served.content).not.toContain("Zq8Rk2Vm7Tn4Wb9Xc3Ls");
    expect(served.content).toBe(redactRunLogNdjson(raw));
  });

  it("drops the mark when the file is replaced (new inode) or truncated and rewritten", async () => {
    const store = getRunLogStore();
    const replaced = await store.begin({ companyId: "c1", agentId: "a1", runId: "r7" });
    await store.append(replaced, { stream: "stdout", chunk: "fine\n", ts: "t" });
    const abs = join(base, replaced.logRef);
    const inoBefore = (await stat(abs)).ino;
    // Same bytes, new inode.
    await writeFile(`${abs}.restore`, await readFile(abs));
    await rename(`${abs}.restore`, abs);
    expect((await stat(abs)).ino).not.toBe(inoBefore);
    const afterRestore = await store.read(replaced);
    expect(afterRestore.redactedAtPersist).not.toBe(true);
    expect(afterRestore.verifiedBytes).toBe(0);

    const truncated = await store.begin({ companyId: "c1", agentId: "a1", runId: "r8" });
    await store.append(truncated, { stream: "stdout", chunk: "aaaaaaaaaa\n", ts: "t" });
    await truncate(join(base, truncated.logRef), 5);
    await appendFile(join(base, truncated.logRef), "raw tail that is longer than before\n");
    const afterTruncate = await store.read(truncated);
    expect(afterTruncate.redactedAtPersist).not.toBe(true);
    expect(afterTruncate.verifiedBytes).toBe(0);
    await store.append(truncated, { stream: "stdout", chunk: "next\n", ts: "t" });
    expect((await store.read(truncated)).verifiedBytes).toBe(0);
  });
});
