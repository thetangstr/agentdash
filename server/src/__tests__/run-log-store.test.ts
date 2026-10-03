// AgentDash (GH #992): `redactedAtPersist` must mean "every byte in this file
// came through the redacting append path" — a file seeded before the mark was
// recorded keeps its legacy content, so appending to it must never mark it.
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRunLogStore, resetRunLogStoreForTests } from "../services/run-log-store.js";

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
});
