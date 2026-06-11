// @vitest-environment jsdom

import { useEffect, type ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelProvider, usePanel } from "../context/PanelContext";
import { PropertiesPanel } from "./PropertiesPanel";

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function OpenPanelHarness() {
  const { openPanel } = usePanel();

  useEffect(() => {
    openPanel(<div>Issue details</div>);
  }, [openPanel]);

  return <PropertiesPanel />;
}

function createDomEvent(type: string, props: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

describe("PropertiesPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  async function renderPanel() {
    await act(async () => {
      root.render(
        <PanelProvider>
          <OpenPanelHarness />
        </PanelProvider>,
      );
    });
  }

  it("resizes with the keyboard and persists the panel width", async () => {
    await renderPanel();

    const panel = container.querySelector("aside") as HTMLElement | null;
    const separator = container.querySelector('[role="separator"]') as HTMLElement | null;

    expect(panel?.style.width).toBe("320px");
    expect(separator).not.toBeNull();
    expect(separator?.getAttribute("aria-valuenow")).toBe("320");

    await act(async () => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });

    expect(panel?.style.width).toBe("344px");
    expect(separator?.getAttribute("aria-valuenow")).toBe("344");
    expect(localStorage.getItem("paperclip:panel-width")).toBe("344");

    await act(async () => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });

    expect(panel?.style.width).toBe("280px");

    await act(async () => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });

    expect(panel?.style.width).toBe("560px");
  });

  it("resizes by dragging the panel divider", async () => {
    await renderPanel();

    const panel = container.querySelector("aside") as HTMLElement | null;
    const separator = container.querySelector('[role="separator"]') as HTMLElement | null;

    await act(async () => {
      separator?.dispatchEvent(createDomEvent("pointerdown", { button: 0, clientX: 500 }));
      window.dispatchEvent(createDomEvent("pointermove", { clientX: 440 }));
      window.dispatchEvent(createDomEvent("pointerup", {}));
    });

    expect(panel?.style.width).toBe("380px");
    expect(localStorage.getItem("paperclip:panel-width")).toBe("380");
  });
});
