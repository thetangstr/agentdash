// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarketingHeader } from "./MarketingHeader";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MarketingHeader", () => {
  it("opens and closes the mobile menu with a labelled toggle", async () => {
    await act(async () => {
      root.render(<MarketingHeader />);
    });
    const toggle = container.querySelector<HTMLButtonElement>(".mkt-header__toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    const sheetId = toggle?.getAttribute("aria-controls") ?? "";
    const sheet = document.getElementById(sheetId);
    expect(sheet?.hidden).toBe(true);

    await act(async () => {
      toggle?.click();
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(sheet?.hidden).toBe(false);
    expect(sheet?.textContent).toContain("Demo");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  });
});
