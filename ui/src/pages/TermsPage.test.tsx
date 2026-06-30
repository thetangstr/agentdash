// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TermsPage } from "./TermsPage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(<TermsPage />);
  });
}

describe("TermsPage", () => {
  it("mounts and shows the document title", () => {
    render();
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toContain("Terms of Service");
  });

  it("shows the template review banner", () => {
    render();
    expect(container.textContent).toContain(
      "Template — review with legal counsel before relying on this.",
    );
    expect(container.textContent).toContain("Last updated: June 30, 2026");
  });

  it("renders the key section headings", () => {
    render();
    const text = container.textContent ?? "";
    expect(text).toContain("Description of the service");
    expect(text).toContain("Subscriptions and billing");
    expect(text).toContain("Acceptable use");
    expect(text).toContain("Customer content and intellectual property");
    expect(text).toContain("Limitation of liability");
    expect(text).toContain("Governing law and disputes");
  });

  it("includes the key disclaimer about agent output and the governing-law placeholder", () => {
    render();
    const text = container.textContent ?? "";
    expect(text).toContain("may be inaccurate");
    expect(text).toContain("$29 per seat per month");
    expect(text).toContain("[Governing law / jurisdiction — to be completed]");
    expect(container.querySelector('a[href="mailto:edward@agentdash.cloud"]')).not.toBeNull();
  });
});
