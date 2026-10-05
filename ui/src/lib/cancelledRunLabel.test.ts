import { describe, expect, it } from "vitest";
import { RUN_CANCELLED_BY_OPERATOR_CODE } from "@paperclipai/shared";
import { cancelledRunLabel, normalizeStoppedRunEventMessage } from "./cancelledRunLabel";

describe("cancelledRunLabel", () => {
  it("reads 'Stopped manually' for an operator stop", () => {
    expect(
      cancelledRunLabel({
        errorCode: RUN_CANCELLED_BY_OPERATOR_CODE,
        error: "Stopped by you",
      }),
    ).toBe("Stopped manually");
  });

  it("shows the recorded reason for a system cancellation", () => {
    expect(
      cancelledRunLabel({
        errorCode: "cancelled",
        error: "Cancelled due to budget pause",
      }),
    ).toBe("Cancelled due to budget pause");
  });

  it("falls back to 'Stopped' when no reason was recorded", () => {
    expect(cancelledRunLabel({ errorCode: "cancelled", error: null })).toBe("Stopped");
    expect(cancelledRunLabel({})).toBe("Stopped");
  });

  // AgentDash (c4-stops): pre-rename rows carry the old message with a plain
  // "cancelled" code — they render with the same wording as new stops.
  it("reads a legacy 'Cancelled by control plane' row as a manual stop", () => {
    expect(
      cancelledRunLabel({ errorCode: "cancelled", error: "Cancelled by control plane" }),
    ).toBe("Stopped manually");
  });
});

describe("normalizeStoppedRunEventMessage", () => {
  // AgentDash (c4-stops): events written before the rename recorded "run
  // cancelled"; a killed process's exit could also record "run failed". On a
  // cancelled run both read "run stopped".
  it("renders historical 'run cancelled' and 'run failed' as 'run stopped'", () => {
    expect(normalizeStoppedRunEventMessage("run cancelled", "cancelled")).toBe("run stopped");
    expect(normalizeStoppedRunEventMessage("run failed", "cancelled")).toBe("run stopped");
  });

  it("leaves real failure wording on a failed run", () => {
    expect(normalizeStoppedRunEventMessage("run failed", "failed")).toBe("run failed");
  });

  it("leaves non-lifecycle messages alone", () => {
    expect(normalizeStoppedRunEventMessage("run completed 3 steps", "cancelled")).toBe(
      "run completed 3 steps",
    );
  });
});
