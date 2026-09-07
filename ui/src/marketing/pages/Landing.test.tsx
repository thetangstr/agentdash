// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/marketing/video/HeroStoryPlayer", () => ({
  default: () => <div data-testid="hero-player">player</div>,
}));
vi.mock("@/marketing/hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => false,
}));

import { LandingContent } from "./Landing";
import { CONTACT_EMAIL, GITHUB_URL } from "../content/site";

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

describe("Landing", () => {
  it("leads with the steward story and honest calls to action", async () => {
    await act(async () => {
      root.render(<LandingContent />);
    });
    const text = container.textContent ?? "";
    expect(container.querySelector("h1")?.textContent).toContain("Chief of Staff");
    expect(text).toContain("Claude Code or Codex");
    expect(text).toContain("Simulated walkthrough");
    expect(text).toContain("Self-hosted and open source today");
    expect(text).not.toMatch(/Start free|Placeholder|Logo 1/);

    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith(`mailto:${CONTACT_EMAIL}`))).toBe(true);
    expect(hrefs.some((h) => h.startsWith(GITHUB_URL))).toBe(true);
    expect(hrefs).toContain("/demo");
    expect(hrefs.some((h) => h.includes("sign_up"))).toBe(false);
  });

  it("loads the marketing type families once, without touching the dashboard's fonts", async () => {
    await act(async () => {
      root.render(<LandingContent />);
    });
    const links = document.querySelectorAll('link#mkt-fonts');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toContain("Newsreader");
  });
});
