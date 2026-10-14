import { describe, expect, it } from "vitest";
import { formatTokenCeilingLift } from "./token-ceiling-lift";

describe("formatTokenCeilingLift", () => {
  // The Oct 13 UTC window lifts at midnight UTC at the end of it.
  const liftsAt = "2026-10-14T00:00:00.000Z";

  it("renders a midnight liftsAt as the next UTC day, not the day of the window", () => {
    const text = formatTokenCeilingLift(liftsAt, "UTC");
    expect(text).toBe("00:00 UTC on Oct 14, 2026");
    expect(text).not.toContain("Oct 13");
  });

  it("adds the viewer's wall-clock time west of UTC, where it is still the day before", () => {
    // PDT is UTC-7 in October.
    expect(formatTokenCeilingLift(liftsAt, "America/Los_Angeles")).toBe(
      "00:00 UTC on Oct 14, 2026 (5:00 PM Oct 13 your time)",
    );
  });

  it("adds the viewer's wall-clock time east of UTC", () => {
    expect(formatTokenCeilingLift(liftsAt, "Asia/Tokyo")).toBe(
      "00:00 UTC on Oct 14, 2026 (9:00 AM Oct 14 your time)",
    );
  });

  it("follows the viewer's daylight-saving offset", () => {
    // PST (UTC-8) in December.
    expect(formatTokenCeilingLift("2026-12-02T00:00:00.000Z", "America/Los_Angeles")).toBe(
      "00:00 UTC on Dec 2, 2026 (4:00 PM Dec 1 your time)",
    );
  });

  it("crosses a year boundary in UTC", () => {
    expect(formatTokenCeilingLift("2027-01-01T00:00:00.000Z", "America/New_York")).toBe(
      "00:00 UTC on Jan 1, 2027 (7:00 PM Dec 31 your time)",
    );
  });

  it("omits the local part when the viewer's zone matches UTC at that instant", () => {
    // London is on GMT (UTC+0) after the late-October change.
    expect(formatTokenCeilingLift("2026-11-14T00:00:00.000Z", "Europe/London")).toBe("00:00 UTC on Nov 14, 2026");
  });

  it("renders a non-midnight lift time as it is", () => {
    expect(formatTokenCeilingLift("2026-10-14T06:30:00.000Z", "UTC")).toBe("06:30 UTC on Oct 14, 2026");
  });

  it("accepts a Date and survives an unparseable value", () => {
    expect(formatTokenCeilingLift(new Date(liftsAt), "UTC")).toBe("00:00 UTC on Oct 14, 2026");
    expect(formatTokenCeilingLift("not a date", "UTC")).toBe("midnight UTC");
  });
});
