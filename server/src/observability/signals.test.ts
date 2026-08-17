import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitSignal,
  resetSignalSubscribersForTest,
  subscribeToSignals,
  type Signal,
} from "./signals.js";

describe("signals", () => {
  beforeEach(() => {
    resetSignalSubscribersForTest();
  });

  it("delivers a signal to every subscriber", () => {
    const seen: Signal[] = [];
    subscribeToSignals((s) => void seen.push(s));
    subscribeToSignals((s) => void seen.push(s));

    emitSignal({ kind: "run_failed", summary: "agent Dex run failed" });

    expect(seen).toHaveLength(2);
    expect(seen[0].kind).toBe("run_failed");
    expect(seen[0].occurredAt).toBeInstanceOf(Date);
  });

  it("a throwing subscriber must not stop delivery to the others", () => {
    // The property that matters most: alerting failure on top of a real
    // failure degrades to "only the original problem".
    const seen: Signal[] = [];
    subscribeToSignals(() => {
      throw new Error("subscriber exploded");
    });
    subscribeToSignals((s) => void seen.push(s));

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => emitSignal({ kind: "server_error", summary: "boom" })).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a rejecting async subscriber must not become an unhandled rejection", async () => {
    subscribeToSignals(async () => {
      throw new Error("async subscriber exploded");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    emitSignal({ kind: "backup_failed", summary: "dump failed" });
    // Let the rejection propagate to the catch handler.
    await new Promise((resolve) => setImmediate(resolve));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("emitting with no subscribers is a no-op, not an error", () => {
    expect(() => emitSignal({ kind: "disk_low", summary: "disk under 10%" })).not.toThrow();
  });
});
