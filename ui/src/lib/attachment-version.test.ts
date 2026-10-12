import { describe, expect, it } from "vitest";
import { attachmentVersionMarker } from "./attachment-version";

describe("attachmentVersionMarker", () => {
  it("marks the newest version current and the others older; an unversioned file gets no marker", () => {
    expect(attachmentVersionMarker({ version: 3, isCurrent: true })).toMatchObject({ text: "current", current: true });
    expect(attachmentVersionMarker({ version: 1, isCurrent: false })).toMatchObject({ text: "older version", current: false });
    expect(attachmentVersionMarker({ version: 1, isCurrent: false })!.title).toContain("Version 1");
    expect(attachmentVersionMarker({ version: null, isCurrent: true })).toBeNull();
    expect(attachmentVersionMarker({})).toBeNull();
  });
});
