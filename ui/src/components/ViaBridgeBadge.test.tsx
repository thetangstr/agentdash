// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ViaBridgeBadge } from "./ViaBridgeBadge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ViaBridgeBadge", () => {
  it("names the machine it came from", () => {
    const el = render(<ViaBridgeBadge via={{ channel: "bridge_work", endpointLabel: "person-a-laptop (darwin)" }} />);
    const badge = el.querySelector('[data-testid="via-bridge-badge"]');
    expect(badge?.textContent).toBe("via bridge (person-a-laptop (darwin))");
    expect(badge?.getAttribute("title")).toMatch(/their own Claude or Codex/);
  });

  it("says only 'via bridge' for an answer recorded before labels", () => {
    const el = render(<ViaBridgeBadge via={{ channel: "bridge_inbox", endpointLabel: null }} />);
    expect(el.textContent).toBe("via bridge");
  });

  it("renders nothing for something sent from the page", () => {
    const el = render(<ViaBridgeBadge via={null} />);
    expect(el.innerHTML).toBe("");
  });

  it("shows a label as text, never as markup", () => {
    const el = render(<ViaBridgeBadge via={{ channel: "bridge_work", endpointLabel: "<img src=x onerror=alert(1)>" }} />);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img");
  });
});
