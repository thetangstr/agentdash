// @vitest-environment jsdom
// AgentDash (review-1015): the reference chips changed in c3-copy to say
// "Added references"/"Removed references" in words — a lone + or – read as
// a cryptic glyph. The words must stay visible.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { IssueReferenceActivitySummary } from "./IssueReferenceActivitySummary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("IssueReferenceActivitySummary", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("labels added and removed references in words, beside the chips", () => {
    act(() =>
      root.render(
        <IssueReferenceActivitySummary
          event={{
            details: {
              addedReferencedIssues: [{ id: "i1", identifier: "ACM-1" }],
              removedReferencedIssues: [{ id: "i2", identifier: "ACM-2" }],
            },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain("Added references");
    expect(container.textContent).toContain("Removed references");
    expect(container.textContent).toContain("ACM-1");
    expect(container.textContent).toContain("ACM-2");
  });

  it("renders nothing when the event touches no references", () => {
    act(() => root.render(<IssueReferenceActivitySummary event={{ details: {} }} />));
    expect(container.textContent).toBe("");
  });
});
