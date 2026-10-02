import { describe, expect, it } from "vitest";
import { issueStatusLabel } from "./issue-status-label";

describe("issueStatusLabel", () => {
  it("uses the board's words for every status", () => {
    expect(issueStatusLabel("backlog")).toBe("Backlog");
    expect(issueStatusLabel("todo")).toBe("To do");
    expect(issueStatusLabel("in_progress")).toBe("In progress");
    expect(issueStatusLabel("in_review")).toBe("In review");
    expect(issueStatusLabel("done")).toBe("Done");
    expect(issueStatusLabel("cancelled")).toBe("Cancelled");
  });

  it("never shows a raw slug or an empty value", () => {
    expect(issueStatusLabel("waiting_on_client")).toBe("Waiting on client");
    expect(issueStatusLabel(null)).toBe("None");
    expect(issueStatusLabel("")).toBe("None");
  });
});
