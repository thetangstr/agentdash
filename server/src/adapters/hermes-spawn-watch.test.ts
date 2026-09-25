import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { withHermesSpawnWatch } from "./hermes-spawn-watch.js";
import { runningProcesses } from "./utils.js";

describe("withHermesSpawnWatch", () => {
  it("reports the child's pid and start time once runChildProcess registers it", async () => {
    const onSpawn = vi.fn(async () => {});
    const runId = "run-spawn-watch";
    const result = await withHermesSpawnWatch(
      { runId, onSpawn },
      async () => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: "ignore" });
        runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });
        await new Promise((resolve) => child.once("exit", resolve));
        runningProcesses.delete(runId);
        return "done";
      },
      20,
    );
    expect(result).toBe("done");
    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn.mock.calls[0]).toEqual([
      expect.objectContaining({ pid: expect.any(Number), processGroupId: null, startedAt: expect.any(String) }),
    ]);
  });

  it("passes straight through without onSpawn, and propagates errors", async () => {
    await expect(withHermesSpawnWatch({ runId: "x" }, async () => 7)).resolves.toBe(7);
    await expect(
      withHermesSpawnWatch({ runId: "y", onSpawn: async () => {} }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
