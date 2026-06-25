import { describe, expect, it, vi } from "vitest";
import { hermesRoundTripProbeCheck } from "./hermes-roundtrip-probe.js";

describe("hermesRoundTripProbeCheck", () => {
  it("passes (info) when the model returns the expected answer", async () => {
    const run = vi.fn(async () => ({ stdout: "  ⚕ Hermes\n     42\n" }));
    const check = await hermesRoundTripProbeCheck({ command: "hermes", model: "M", provider: "p", run });
    expect(check).toMatchObject({ code: "hermes_roundtrip_ok", level: "info" });
    // arithmetic answer is not in the prompt; args carry model/provider + max-turns 1
    const args = (run.mock.calls[0] as unknown[])[1];
    expect(args).toEqual(["chat", "-q", expect.any(String), "--max-turns", "1", "-m", "M", "--provider", "p"]);
  });

  it("fails (error) when the model runs but gives the wrong answer (misconfig)", async () => {
    const run = vi.fn(async () => ({ stdout: "I cannot help with that." }));
    const check = await hermesRoundTripProbeCheck({ command: "hermes", run });
    expect(check.code).toBe("hermes_roundtrip_no_answer");
    expect(check.level).toBe("error");
  });

  it("fails (error) on ENOENT (binary missing)", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("spawn hermes ENOENT"), { code: "ENOENT" });
    });
    const check = await hermesRoundTripProbeCheck({ command: "hermes", run });
    expect(check.code).toBe("hermes_roundtrip_failed");
    expect(check.message).toContain("not found");
  });

  it("fails (error) on timeout", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("timeout"), { killed: true });
    });
    const check = await hermesRoundTripProbeCheck({ command: "hermes", run });
    expect(check.code).toBe("hermes_roundtrip_failed");
    expect(check.message).toContain("timed out");
  });

  it("omits model/provider args when not given", async () => {
    const run = vi.fn(async () => ({ stdout: "42" }));
    await hermesRoundTripProbeCheck({ command: "hermes", run });
    expect((run.mock.calls[0] as unknown[])[1]).toEqual(["chat", "-q", expect.any(String), "--max-turns", "1"]);
  });
});
