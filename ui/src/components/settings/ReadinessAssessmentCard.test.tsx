// @vitest-environment jsdom
// AgentDash (GH #785): the assessment is reachable from Settings.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadinessAssessmentCard } from "./ReadinessAssessmentCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReadinessAssessmentCard", () => {
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

  it("links to the assessment for every company", () => {
    act(() => root.render(<ReadinessAssessmentCard />));
    expect(container.textContent).toContain("Readiness assessment");
    expect(container.textContent).toContain("Optional");
    expect(container.querySelector<HTMLAnchorElement>('a[href="/assess"]')?.textContent).toBe("Run the assessment");
  });
});
