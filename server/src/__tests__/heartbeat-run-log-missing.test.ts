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
});
