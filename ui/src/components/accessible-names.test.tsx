// @vitest-environment jsdom
// AgentDash (c3-a11y): icon-only chrome must carry an accessible name —
// the phone tab <select>, the Properties panel close button.

import { act, useEffect } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageTabBar } from "./PageTabBar";
import { PropertiesPanel } from "./PropertiesPanel";
import { PanelProvider, usePanel } from "../context/PanelContext";

const mockSidebar = vi.hoisted(() => ({
  isMobile: true,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: mockSidebar.isMobile,
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function OpenPanel() {
  const { openPanel } = usePanel();
  useEffect(() => openPanel(<div>panel body</div>), [openPanel]);
  return null;
}

describe("accessible names (c3-a11y)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockSidebar.isMobile = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names the phone tab select", () => {
    act(() => {
      root.render(
        <PageTabBar
          ariaLabel="Agent sections"
          items={[
            { value: "overview", label: "Overview" },
            { value: "settings", label: "Settings" },
          ]}
          value="overview"
          onValueChange={() => {}}
        />,
      );
    });

    const select = container.querySelector('select[aria-label="Agent sections"]');
    expect(select).not.toBeNull();
  });

  it("falls back to a generic select name", () => {
    act(() => {
      root.render(
        <PageTabBar
          items={[{ value: "a", label: "A" }]}
          value="a"
          onValueChange={() => {}}
        />,
      );
    });

    expect(container.querySelector('select[aria-label="Page sections"]')).not.toBeNull();
  });

  it("names the Properties panel close button", () => {
    act(() => {
      root.render(
        <PanelProvider>
          <OpenPanel />
          <PropertiesPanel />
        </PanelProvider>,
      );
    });

    expect(container.querySelector('button[aria-label="Close properties panel"]')).not.toBeNull();
  });
});
