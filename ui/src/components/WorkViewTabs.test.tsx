// @vitest-environment jsdom
// AgentDash (one UX): the Inbox's "Touched by me" and "Unread" views, kept on Work.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { WorkViewTabs, filterIssuesForWorkView, parseWorkView, workViewFilters } = await import("./WorkViewTabs");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Work views", () => {
  it("reads the view from the URL, defaulting to all", () => {
    expect(parseWorkView(null)).toBe("all");
    expect(parseWorkView("touched")).toBe("touched");
    expect(parseWorkView("unread")).toBe("unread");
    expect(parseWorkView("mine")).toBe("all");
  });

  it("asks the server for the person's touched issues, and for unread ones on Unread", () => {
    expect(workViewFilters("all")).toEqual({});
    expect(workViewFilters("touched")).toEqual({ touchedByUserId: "me" });
    expect(workViewFilters("unread")).toEqual({ touchedByUserId: "me", unreadForUserId: "me" });
  });

  it("drops an issue already read from a stale Unread page, and filters nothing elsewhere", () => {
    const issues = [
      { id: "a", isUnreadForMe: true },
      { id: "b", isUnreadForMe: false },
      { id: "c" },
    ] as unknown as Issue[];
    expect(filterIssuesForWorkView(issues, "unread").map((issue) => issue.id)).toEqual(["a", "c"]);
    expect(filterIssuesForWorkView(issues, "touched")).toHaveLength(3);
    expect(filterIssuesForWorkView(issues, "all")).toHaveLength(3);
  });

  describe("tabs", () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
    });

    it("links each view and marks the current one", async () => {
      await act(async () => root.render(<WorkViewTabs view="unread" />));
      const link = (id: string) => container.querySelector(`[data-testid="${id}"]`);
      expect(link("work-view-all")?.getAttribute("href")).toBe("/issues");
      expect(link("work-view-touched")?.getAttribute("href")).toBe("/issues?view=touched");
      expect(link("work-view-touched")?.textContent).toBe("Touched by me");
      expect(link("work-view-unread")?.getAttribute("href")).toBe("/issues?view=unread");
      expect(link("work-view-unread")?.getAttribute("aria-current")).toBe("page");
      expect(link("work-view-all")?.getAttribute("aria-current")).toBeNull();
    });
  });
});
