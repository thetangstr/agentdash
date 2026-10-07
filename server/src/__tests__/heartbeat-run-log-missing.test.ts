// AgentDash: runs that never started (queued, or cancelled before they ran) have no
// log store or ref. The log endpoint polled them and logged a 404 each time; readLog
// now answers with an empty log marked `missing` instead.
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";

const mockRunLogStoreRead = vi.hoisted(() => vi.fn());

vi.mock("../services/run-log-store.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/run-log-store.ts")>(
    "../services/run-log-store.ts",
  );
  return {
    ...actual,
    getRunLogStore: () => ({ read: mockRunLogStoreRead }),
  };
});

// readLog with a lookup row never touches the database.
const heartbeat = heartbeatService({} as Db, { autoDispatchQueuedRuns: false });

describe("heartbeat readLog", () => {
  it("returns an empty, missing log for a run that never started", async () => {
    const result = await heartbeat.readLog({
      id: "run-never-started",
      companyId: "company-1",
      logStore: null,
      logRef: null,
    });

    expect(result).toEqual({
      runId: "run-never-started",
      store: null,
      logRef: null,
      content: "",
      missing: true,
    });
    expect(mockRunLogStoreRead).not.toHaveBeenCalled();
  });

  it("still reads the store when the run has a log", async () => {
    mockRunLogStoreRead.mockResolvedValueOnce({ content: "{\"chunk\":\"hi\"}\n", nextOffset: 16 });

    const result = await heartbeat.readLog(
      { id: "run-1", companyId: "company-1", logStore: "local_file", logRef: "logs/run-1.ndjson" },
      { offset: 0, limitBytes: 64 },
    );

    expect(mockRunLogStoreRead).toHaveBeenCalledWith(
      { store: "local_file", logRef: "logs/run-1.ndjson" },
      { offset: 0, limitBytes: 64 },
    );
    expect(result).toMatchObject({ runId: "run-1", store: "local_file", logRef: "logs/run-1.ndjson", nextOffset: 16 });
    expect(result).not.toHaveProperty("missing");
  });

  it("keeps the response contract and pages a large unmarked log instead of redacting it all at once", async () => {
    const line = (i: number) =>
      `${JSON.stringify({ ts: "t", stream: "stdout", chunk: i % 40 === 0 ? "export API_KEY=Zq8Rk2Vm7Tn4Wb9Xc3Ls\n" : `step ${i} ${"x".repeat(80)}\n` })}\n`;
    let content = "";
    for (let i = 0; Buffer.byteLength(content) < 600_000; i++) content += line(i);
    mockRunLogStoreRead.mockResolvedValueOnce({
      content,
      nextOffset: undefined,
      redactedAtPersist: false,
      buffer: Buffer.from(content),
      verifiedBytes: 0,
      startOffset: 0,
    });

    const result = await heartbeat.readLog(
      { id: "run-2", companyId: "company-1", logStore: "local_file", logRef: "logs/run-2.ndjson" },
      { offset: 0, limitBytes: 1024 * 1024 },
    );

    // Same fields the endpoint always returned — store internals never leak.
    expect(Object.keys(result).sort()).toEqual(["content", "logRef", "nextOffset", "redactedAtPersist", "runId", "store"]);
    expect(result.content).not.toContain("Zq8Rk2Vm7Tn4Wb9Xc3Ls");
    expect(result.nextOffset).toBeGreaterThan(0);
    expect(result.nextOffset).toBeLessThanOrEqual(256_000);
    expect(content.slice(0, result.nextOffset).endsWith("\n")).toBe(true);
  });

  it("serves a marked range as stored", async () => {
    const content = `${JSON.stringify({ ts: "t", stream: "stdout", chunk: "ok\n" })}\n`;
    mockRunLogStoreRead.mockResolvedValueOnce({
      content,
      redactedAtPersist: true,
      buffer: Buffer.from(content),
      verifiedBytes: Buffer.byteLength(content),
      startOffset: 0,
    });
    const result = await heartbeat.readLog(
      { id: "run-3", companyId: "company-1", logStore: "local_file", logRef: "logs/run-3.ndjson" },
    );
    expect(result).toEqual({
      runId: "run-3",
      store: "local_file",
      logRef: "logs/run-3.ndjson",
      content,
      nextOffset: undefined,
      redactedAtPersist: true,
    });
  });
});

