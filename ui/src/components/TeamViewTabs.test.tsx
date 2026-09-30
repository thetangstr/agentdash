// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamViewTabs } from "./TeamViewTabs";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("TeamViewTabs", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it.each([
    ["list", "List"],
    ["org", "Org chart"],
  ] as const)("renders List | Org chart with %s current", async (active, currentLabel) => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<TeamViewTabs active={active} />);
    });
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(["List", "Org chart"]);
    // Both views keep their own URL: /agents and /org still work.
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/agents/all", "/org"]);
    const current = links.filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.textContent)).toEqual([currentLabel]);
    await act(async () => root.unmount());
  });
});
