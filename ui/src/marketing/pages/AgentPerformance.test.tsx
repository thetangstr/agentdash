// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentPerformance } from "./AgentPerformance";
import { AgentPerformanceUpdate } from "./AgentPerformanceUpdate";
import { WhatsNew } from "./WhatsNew";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
describe("public agent performance pages", () => {
  it("makes the performance overview discoverable and keeps task evidence a supporting example", async () => {
    await act(async () => root.render(<AgentPerformance />));
    expect(container.querySelector("h1")?.textContent).toContain("agent performance");
    expect(container.querySelector('#task-evidence')?.textContent).toContain("not an overall score");
    expect(container.querySelector('.mkt-header__nav a[href="/agent-performance"]')).toBeTruthy();
    expect(container.querySelector('.mkt-footer a[href="/agent-performance"]')).toBeTruthy();
    expect(container.textContent).toContain("A correction count is not correction time");
    expect(container.textContent).toContain("evaluation does not require a person to approve every output");
  });
  it("gives concrete owner steps and distinguishes feature availability from the packaging correction", async () => {
    await act(async () => root.render(<AgentPerformanceUpdate />));
    const steps = container.querySelector('#how-to-use')?.textContent ?? "";
    for (const label of ["Draft changes", "Criterion text", "Proof type", "Map responsibility", "Performance", "Take snapshot"]) expect(steps).toContain(label);
    expect(container.querySelector('#release-notes')?.textContent).toContain("no product behavior, dependency or database change relative to v2026.1104.0");
    expect(container.querySelector('#release-notes')?.textContent).toContain("in-app Changelog contains the v2026.1104.0 feature notes");
    expect(container.querySelector('#release-notes')?.textContent).toContain("Availability depends on the version your operator has installed");
    expect(container.querySelector('a[href="https://github.com/thetangstr/agentdash/releases/tag/v2026.1105.0"]')).toBeTruthy();
  });
  it("puts the new customer update ahead of the preserved launch-week archive", async () => {
    await act(async () => root.render(<WhatsNew />));
    const articles = [...container.querySelectorAll("article")];
    expect(articles[0]?.querySelector("h2 a")?.getAttribute("href")).toBe("/whats-new/agent-performance");
    expect(articles[1]?.querySelector("h2 a")?.getAttribute("href")).toBe("/whats-new/launch-week");
  });
});
