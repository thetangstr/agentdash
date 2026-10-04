import { describe, expect, it } from "vitest";
import { RUN_CANCELLED_BY_OPERATOR_CODE } from "@paperclipai/shared";
import { cancelledRunLabel } from "./cancelledRunLabel";

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
});
