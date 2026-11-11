// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* the scene modules pull in three: record whether the page ever asks for them */
const sceneLoads = vi.hoisted(() => ({ cards: 0, lanes: 0 }));
vi.mock("../how-it-works/scenes/cards", () => {
  sceneLoads.cards++;
  return { default: () => ({ init() {}, frame() {}, resize() {}, theme() {} }) };
});
vi.mock("../how-it-works/scenes/lanes", () => {
  sceneLoads.lanes++;
  return { default: () => ({ init() {}, frame() {}, resize() {}, theme() {} }) };
});

import { BEHIND_EACH_STEP, HowItWorks } from "./HowItWorks";
import { ILLUSTRATION_NOTE, STORY, storyLines } from "../how-it-works/story";
import { SHIPPED_TREATMENT, treatmentFromSearch } from "../how-it-works/StorySection";
import { HOW_IT_WORKS_PATH, isMarketingPath } from "../marketing-path";
import { CONTACT_EMAIL, NAV_LINKS } from "../content/site";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const realGetContext = HTMLCanvasElement.prototype.getContext;

function stubMatchMedia(reducedMotion: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  })) as unknown as typeof window.matchMedia;
}

async function renderPage() {
  await act(async () => {
    root.render(<HowItWorks />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  stubMatchMedia(false);
  vi.spyOn(console, "warn").mockImplementation(() => {}); /* the expected no-WebGL notice */
  /* jsdom has no canvas: getContext answers null, which is what a browser without WebGL does too */
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof realGetContext;
  sceneLoads.cards = sceneLoads.lanes = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  HTMLCanvasElement.prototype.getContext = realGetContext;
  vi.restoreAllMocks();
});

describe("How it works page", () => {
  it("puts the heading and intro in HTML above the story section", async () => {
    await renderPage();
    expect(container.querySelector("h1")?.textContent).toBe("Agents managed like staff.");
    const head = container.querySelector(".hiw-head");
    const story = container.querySelector("[data-player]");
    expect(head && story && head.compareDocumentPosition(story) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.title).toContain("Agents managed like staff");
  });

  it("carries every story line, verbatim, as text (the reduced-motion and screen-reader version)", async () => {
    await renderPage();
    const text = container.querySelector(".tp-still")?.textContent ?? "";
    const lines = storyLines();
    expect(lines).toHaveLength(13);
    for (const line of lines) expect(text).toContain(line);
    for (const c of STORY.chapters) expect(text).toContain(c.label);
    expect(text).toContain("Agents managed like staff. People stay in charge.");
  });

  it("says directly under the stage that it is an illustration, not a recording", async () => {
    await renderPage();
    const note = container.querySelector(".hiw-story__note");
    expect(note?.textContent).toBe("An illustration of how AgentDash works, not a recording. Names are examples.");
    expect(note?.textContent).toBe(ILLUSTRATION_NOTE);
    /* the note follows the stage host and comes before the caption host */
    expect(note?.previousElementSibling?.classList.contains("hiw-story__stage")).toBe(true);
    expect(note?.nextElementSibling?.classList.contains("hiw-story__foot")).toBe(true);
  });

  it("without WebGL, shows the text story, never downloads three and throws nothing", async () => {
    const warn = vi.mocked(console.warn);
    await renderPage();
    const player = container.querySelector("[data-player]");
    expect(player?.classList.contains("is-failed")).toBe(true);
    expect(sceneLoads.cards + sceneLoads.lanes).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("WebGL is unavailable"), "");
    expect(container.querySelector(".tp-still")?.textContent).toContain(storyLines()[0]);
  });

  it("with reduced motion, shows the story as text and builds no stage", async () => {
    stubMatchMedia(true);
    await renderPage();
    const player = container.querySelector("[data-player]");
    expect(player?.classList.contains("is-still")).toBe(true);
    expect(container.querySelector(".tp-stage")).toBeNull();
    expect(container.querySelector(".hiw-story__note")?.textContent).toBe(ILLUSTRATION_NOTE);
  });

  it("lists what is behind each step, one mechanism per chapter", async () => {
    await renderPage();
    const items = [...container.querySelectorAll(".hiw-behind__item")];
    expect(items.map((li) => li.querySelector("h3")?.textContent)).toEqual(STORY.chapters.map((c) => c.label));
    expect(BEHIND_EACH_STEP.every((b) => b.mechanism.length > 60)).toBe(true);
    expect(container.textContent).toContain("Access rules stay off until an admin turns them on");
    expect(container.textContent).toContain("A pause recommendation never pauses the agent.");
  });

  it("ends with the site's call to action", async () => {
    await renderPage();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toContain("/start");
    expect(hrefs.some((h) => h.startsWith(`mailto:${CONTACT_EMAIL}`))).toBe(true);
    expect(hrefs).not.toContain("/auth");
  });
});

describe("How it works route", () => {
  it("is a marketing path, linked from the header nav", () => {
    expect(HOW_IT_WORKS_PATH).toBe("/how-it-works");
    expect(isMarketingPath("/how-it-works")).toBe(true);
    expect(isMarketingPath("/how-it-works/")).toBe(true);
    expect(NAV_LINKS).toContainEqual({ label: "How it works", href: "/how-it-works" });
  });

  it("is registered in App.tsx as a lazy route, so three never reaches the landing bundle", () => {
    const app = readFileSync(join(__dirname, "..", "..", "App.tsx"), "utf8");
    expect(app).toMatch(/<Route path="how-it-works" element=\{<Suspense fallback=\{null\}><MarketingHowItWorks \/><\/Suspense>\} \/>/);
    expect(app).toMatch(/lazy\(\(\) => import\("\.\/marketing\/pages\/HowItWorks"\)/);
    expect(app).not.toMatch(/^import .*marketing\/pages\/HowItWorks/m);
  });

  it("ships one treatment and keeps the other reachable for review", () => {
    expect(SHIPPED_TREATMENT).toBe("cards");
    expect(treatmentFromSearch("")).toBe(SHIPPED_TREATMENT);
    expect(treatmentFromSearch("?treatment=lanes")).toBe("lanes");
    expect(treatmentFromSearch("?treatment=nope")).toBe(SHIPPED_TREATMENT);
  });
});
