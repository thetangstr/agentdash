// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { EndpointCapabilities, describeEndpointCapabilities } from "./EndpointCapabilities";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(capabilities: string[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<EndpointCapabilities capabilities={capabilities} />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("a connected machine's capabilities", () => {
  it("names each capability in words, with the raw names on hover", () => {
    const el = render(["bridge:read", "bridge:inbox", "bridge:work"]);
    const words = el.querySelector('[data-testid="endpoint-capabilities"] span');
    expect(words?.textContent).toBe("questions · inbox · review");
    expect(words?.getAttribute("title")).toBe("bridge:read, bridge:inbox, bridge:work");
    expect(el.querySelector('[data-testid="endpoint-review-missing"]')).toBeNull();
  });

  it("says review is not enabled and to reconnect when bridge:work is missing", () => {
    const el = render(["bridge:read", "bridge:inbox"]);
    expect(el.textContent).toContain("questions · inbox");
    expect(el.querySelector('[data-testid="endpoint-review-missing"]')?.textContent).toBe("review not enabled; reconnect");
  });

  it("keeps a capability it does not know by its own name", () => {
    expect(describeEndpointCapabilities(["bridge:inbox", "bridge:future"])).toEqual({
      words: ["inbox", "bridge:future"],
      reviewMissing: true,
    });
    expect(describeEndpointCapabilities([])).toEqual({ words: [], reviewMissing: true });
  });
});
