// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { IssueAssigneeSteward } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AwaitingReviewBadge,
  IssueStewardChip,
  isAwaitingViewerReview,
  stewardDisplayName,
  summarizeStewardBucket,
} from "./IssueStewardChip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const explicitSteward: IssueAssigneeSteward = {
  userId: "user-1",
  name: "Erik Steward",
  email: "erik@example.com",
  source: "steward",
};
const ownerFallback: IssueAssigneeSteward = {
  userId: "user-1",
  name: "Erik Steward",
  email: "erik@example.com",
  source: "owner",
};

describe("stewardDisplayName", () => {
  it("prefers the company label, then name, then email, then a userId prefix", () => {
    expect(stewardDisplayName(explicitSteward, new Map([["user-1", "Me"]]))).toBe("Me");
    expect(stewardDisplayName(explicitSteward)).toBe("Erik Steward");
    expect(stewardDisplayName({ userId: "user-1", name: "  ", email: "erik@example.com" })).toBe("erik@example.com");
    expect(stewardDisplayName({ userId: "abcdefgh", name: null, email: null })).toBe("abcde");
  });
});

describe("summarizeStewardBucket", () => {
  it("treats a bucket as a steward bucket when any issue has an explicit steward, regardless of order", () => {
    const mixedOwnerFirst = [{ assigneeSteward: ownerFallback }, { assigneeSteward: explicitSteward }];
    const mixedStewardFirst = [...mixedOwnerFirst].reverse();

    expect(summarizeStewardBucket(mixedOwnerFirst)).toEqual({ steward: explicitSteward, isOwnerFallback: false });
    expect(summarizeStewardBucket(mixedStewardFirst)).toEqual({ steward: explicitSteward, isOwnerFallback: false });
  });

  it("marks owner-only buckets as fallbacks and empty buckets as unstewarded", () => {
    expect(summarizeStewardBucket([{ assigneeSteward: ownerFallback }, { assigneeSteward: null }])).toEqual({
      steward: ownerFallback,
      isOwnerFallback: true,
    });
    expect(summarizeStewardBucket([{ assigneeSteward: null }, {}])).toEqual({ steward: null, isOwnerFallback: false });
  });
});

describe("isAwaitingViewerReview", () => {
  const pending = { viewerUserId: "user-1", stageType: "review" as const, status: "pending" as const, viewerMatchesPrincipal: true };

  it("requires the payload viewer to match the signed-in viewer", () => {
    expect(isAwaitingViewerReview(pending, "user-1")).toBe(true);
    expect(isAwaitingViewerReview(pending, "user-2")).toBe(false);
    expect(isAwaitingViewerReview({ ...pending, viewerMatchesPrincipal: false }, "user-1")).toBe(false);
    expect(isAwaitingViewerReview(pending, null)).toBe(false);
    expect(isAwaitingViewerReview(null, "user-1")).toBe(false);
  });
});

describe("IssueStewardChip / AwaitingReviewBadge rendering", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("labels explicit stewards and owner fallbacks differently", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueStewardChip steward={explicitSteward} />);
    });
    expect(container.querySelector('[aria-label="Steward: Erik Steward"]')).not.toBeNull();

    act(() => {
      root.render(<IssueStewardChip steward={ownerFallback} labelByUserId={new Map([["user-1", "Erik"]])} />);
    });
    expect(container.querySelector('[aria-label="Owner fallback: Erik"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders the awaiting-review badge only for the matching viewer", () => {
    const root = createRoot(container);
    const issue = {
      title: "Ship it",
      awaitingReviewByViewer: {
        viewerUserId: "user-1",
        stageType: "review" as const,
        status: "pending" as const,
        viewerMatchesPrincipal: true,
      },
    };

    act(() => {
      root.render(<AwaitingReviewBadge issue={issue} viewerUserId="user-1" />);
    });
    expect(container.textContent).toContain("Awaiting your review");

    act(() => {
      root.render(<AwaitingReviewBadge issue={issue} viewerUserId="user-2" />);
    });
    expect(container.textContent).toBe("");

    act(() => {
      root.unmount();
    });
  });
});
