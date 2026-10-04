import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { buildIssuesSearchUrl, getNextIssuesPageOffset, issueUpdateErrorToast, mergeIssuePagesStable } from "./Issues";

function createIssue(id: string, title: string): Issue {
  return { id, title } as Issue;
}

describe("buildIssuesSearchUrl", () => {
  it("preserves trailing spaces in the synced search param", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug", "bug ")).toBe("/issues?q=bug+");
  });

  it("removes the search param when the input is cleared", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug#details", "")).toBe("/issues#details");
  });

  it("returns null when the URL already matches the current search", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug+", "bug ")).toBeNull();
  });
});

describe("issues page pagination helpers", () => {
  it("advances to the next offset when the current page is full", () => {
    expect(getNextIssuesPageOffset(500, 0)).toBe(500);
    expect(getNextIssuesPageOffset(500, 500)).toBe(1000);
    expect(getNextIssuesPageOffset(1000, 2000, 1000)).toBe(3000);
  });

  it("stops requesting issue pages when the current page is partial", () => {
    expect(getNextIssuesPageOffset(499, 0)).toBeUndefined();
    expect(getNextIssuesPageOffset(999, 2000, 1000)).toBeUndefined();
  });

  it("dedupes overlapping pages without moving the original issue position", () => {
    const first = createIssue("issue-1", "Original first");
    const second = createIssue("issue-2", "Second");
    const duplicateFirst = createIssue("issue-1", "Duplicate first");
    const third = createIssue("issue-3", "Third");

    expect(mergeIssuePagesStable([[first, second], [duplicateFirst, third]])).toEqual([
      first,
      second,
      third,
    ]);
  });
});

// AgentDash (review #1003, round 2): a failed issue update on the list/board
// must surface the server's message — and a document_revision_required refusal
// links to the issue page, where the documents can be read before accepting.
describe("issueUpdateErrorToast", () => {
  it("links a document_revision_required refusal to the issue detail page", () => {
    const err = new ApiError(
      "The document changed after the revision you saw — open the issue to review the latest.",
      409,
      { error: "conflict", details: { code: "document_revision_required" } },
    );
    expect(issueUpdateErrorToast(err, "issue-uuid-1", "ACM-6")).toEqual({
      title: "Review ACM-6 before marking it done",
      body: "Open the issue to review the latest document.",
      tone: "info",
      action: { label: "Open the issue", href: "/issues/issue-uuid-1" },
    });
  });

  it("uses a generic title for the refusal when the identifier is unknown", () => {
    const err = new ApiError("nope", 409, {
      error: "conflict",
      details: { code: "document_revision_required" },
    });
    expect(issueUpdateErrorToast(err, "issue-uuid-1").title).toBe(
      "Review the issue before marking it done",
    );
  });

  it("shows the server message with no link for other conflicts", () => {
    const err = new ApiError("Issue is checked out by another run", 409, {
      error: "conflict",
      details: { code: "document_revision_stale" },
    });
    expect(issueUpdateErrorToast(err, "issue-uuid-1")).toEqual({
      title: "Issue update failed",
      body: "Issue is checked out by another run",
      tone: "error",
    });
  });

  it("falls back for non-API errors", () => {
    expect(issueUpdateErrorToast(new Error("network down"), "issue-uuid-1").body).toBe("network down");
    expect(issueUpdateErrorToast("nope", "issue-uuid-1").body).toBe("Unable to save issue changes");
    expect(issueUpdateErrorToast("nope", "issue-uuid-1")).not.toHaveProperty("action");
  });
});
