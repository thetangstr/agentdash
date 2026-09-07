// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useDocumentMeta } from "./useDocumentMeta";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Page({ title }: { title: string }) {
  useDocumentMeta(title, `${title} description`);
  return null;
}

describe("useDocumentMeta", () => {
  it("sets title and description while mounted and restores them on unmount", async () => {
    document.title = "AgentDash";
    document.querySelector('meta[name="description"]')?.remove();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => { root.render(<Page title="Demo page" />); });
    expect(document.title).toBe("Demo page");
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe("Demo page description");

    await act(async () => { root.unmount(); });
    expect(document.title).toBe("AgentDash");
    expect(document.querySelector('meta[name="description"]')).toBeNull();
    container.remove();
  });
});
