// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminPowersUpdate } from "./AdminPowersUpdate";
import { WhatsNew } from "./WhatsNew";
import { ADMIN_POWERS_UPDATE, isUpdatePublished } from "../content/updates";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const PUBLISHED = ["v2026.1110.0", "v2026.1109.1"];

describe("admin powers update", () => {
  it("is shown only once its release is published", () => {
    expect(isUpdatePublished(ADMIN_POWERS_UPDATE, ["v2026.1109.1"])).toBe(false);
    expect(isUpdatePublished(ADMIN_POWERS_UPDATE, PUBLISHED)).toBe(true);
  });
  it("leaves What's new unchanged before publication and puts the entry first after it", async () => {
    await act(async () => root.render(<WhatsNew published={["v2026.1109.1"]} />));
    expect(container.querySelector('[data-update="admin-powers"]')).toBeNull();
    await act(async () => root.render(<WhatsNew published={PUBLISHED} />));
    const articles = [...container.querySelectorAll("article")];
    expect(articles[0]?.querySelector("h2 a")?.getAttribute("href")).toBe("/whats-new/admin-powers");
    expect(articles[1]?.querySelector("h2 a")?.getAttribute("href")).toBe("/whats-new/agent-performance");
  });
  it("says plainly that batch changes from Claude are off by default and not yet tried with Claude.ai", async () => {
    await act(async () => root.render(<AdminPowersUpdate published={PUBLISHED} />));
    const text = container.textContent ?? "";
    expect(text).toContain("off by default");
    expect(text).toContain("not yet been tried with Claude.ai itself");
    expect(container.querySelector('a[href="/docs/guides/board-operator/change-many-things-at-once"]')).toBeTruthy();
    expect(container.querySelector('a[href="/releases/v2026.1110.0"]')).toBeTruthy();
  });
  it("shows a not-yet page before publication", async () => {
    await act(async () => root.render(<AdminPowersUpdate published={["v2026.1109.1"]} />));
    expect(container.querySelector("[data-update-not-published]")).toBeTruthy();
    expect(container.textContent).not.toContain("Claude.ai");
  });
});
