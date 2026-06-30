// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrivacyPage } from "./PrivacyPage";

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
    root.render(<PrivacyPage />);
  });
}

describe("PrivacyPage", () => {
  it("mounts and shows the document title", () => {
    render();
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toContain("Privacy Policy");
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
    expect(text).toContain("Data we collect");
    expect(text).toContain("How we use your information");
    expect(text).toContain("Subprocessors");
    expect(text).toContain("Cookies");
    expect(text).toContain("Your rights");
  });

  it("lists the real subprocessors and the legal-entity placeholder", () => {
    render();
    const text = container.textContent ?? "";
    expect(text).toContain("Railway");
    expect(text).toContain("Resend");
    expect(text).toContain("Stripe");
    expect(text).toContain("[Legal entity & registered address — to be completed]");
    expect(container.querySelector('a[href="mailto:edward@agentdash.cloud"]')).not.toBeNull();
  });
});
