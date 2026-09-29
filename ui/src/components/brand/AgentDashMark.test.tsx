// @vitest-environment jsdom
// AgentDash: the shared brand mark, the marketing lockup that wraps it, and the
// favicon generated from it must all carry the same geometry.

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentDashLogo } from "../../marketing/components/AgentDashLogo";
import { AGENTDASH_MARK_TILE_PATH, AGENTDASH_TEAL, AgentDashMark } from "./AgentDashMark";

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

describe("AgentDashMark", () => {
  it("renders the teal chamfered tile with an accessible name when titled", () => {
    act(() => root.render(<AgentDashMark size={24} title="AgentDash" />));
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("AgentDash");
    expect(svg.getAttribute("width")).toBe("24");
    const tile = svg.querySelector("path")!;
    expect(tile.getAttribute("d")).toBe(AGENTDASH_MARK_TILE_PATH);
    expect(tile.getAttribute("fill")).toBe(AGENTDASH_TEAL);
  });

  it("is decorative without a title and inverts for the dark tone", () => {
    act(() => root.render(<AgentDashMark tone="dark" />));
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("g")!.getAttribute("stroke")).toBe(AGENTDASH_TEAL);
  });

  it("is what the marketing lockup renders", () => {
    act(() => root.render(<AgentDashLogo variant="mark" />));
    const svg = container.querySelector('[data-testid="agentdash-mark"]')!;
    expect(svg.classList.contains("mkt-logo__mark")).toBe(true);
    expect(svg.querySelector("path")!.getAttribute("d")).toBe(AGENTDASH_MARK_TILE_PATH);
  });

  it("matches the committed favicon.svg geometry", () => {
    const favicon = readFileSync(path.resolve(__dirname, "../../../public/favicon.svg"), "utf8");
    expect(favicon).toContain(`d="${AGENTDASH_MARK_TILE_PATH}"`);
    expect(favicon).toContain(`fill="${AGENTDASH_TEAL}"`);
    expect(favicon.toLowerCase()).not.toContain("8.414");
  });
});
