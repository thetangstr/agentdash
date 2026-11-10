// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReleaseMarkdown, type ReleaseNote } from "@/lib/release-notes";
import { listPublishedReleaseNotes } from "../content/releases";
import { Release, ReleaseRoute } from "./Release";
import { Releases } from "./Releases";
import { WhatsNew } from "./WhatsNew";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const NOTES: ReleaseNote[] = [
  parseReleaseMarkdown("# v2026.1108.0\n> Released: 2026-11-08\n\n## What’s new\n- Change many records at once.\n- Preview before applying.\n\n## For admins\n- Three company switches.\n\n## Upgrade\n- No changes.\n\n## Security\n- Each record passes its own guard.\n"),
  parseReleaseMarkdown("# v2026.1105.0\n> Released: 2026-11-05\n"),
];
const text = () => container.textContent?.replace(/\s+/g, " ").trim() ?? "";
const description = () => document.querySelector('meta[name="description"]')?.getAttribute("content");

describe("public release-notes index", () => {
  it("lists published releases newest first, each linking to its page", async () => {
    await act(async () => root.render(<Releases notes={NOTES} />));
    expect(document.title).toBe("Release notes · AgentDash");
    expect(description()).toMatch(/Every published AgentDash release/);
    expect(container.querySelector("h1")?.textContent).toBe("Release notes.");
    const entries = [...container.querySelectorAll("[data-release]")];
    expect(entries.map((entry) => entry.getAttribute("data-release"))).toEqual(["v2026.1108.0", "v2026.1105.0"]);
    expect(entries[0]?.querySelector("h2 a")?.getAttribute("href")).toBe("/releases/v2026.1108.0");
    expect(entries[0]?.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-08");
    expect(entries[0]?.textContent).toContain("November 8, 2026");
    expect(entries[0]?.textContent).toContain("Change many records at once.");
    expect(entries[0]?.textContent).toContain("5 changes");
    expect(entries[0]?.textContent).toContain("What’s new · For admins · Upgrade · Security");
    // A release whose notes are all withheld still appears, honestly.
    expect(entries[1]?.textContent).toContain("No public summary for this release.");
    expect(container.querySelector('.mkt-footer a[href="/releases"]')?.textContent).toBe("Release notes");
  });

  it("renders this build's published releases by default", async () => {
    await act(async () => root.render(<Releases />));
    const versions = [...container.querySelectorAll("[data-release]")].map((entry) => entry.getAttribute("data-release"));
    expect(versions).toEqual(listPublishedReleaseNotes().map((n) => n.version));
  });
});

describe("public release-notes page", () => {
  it("shows the sanitized notes, links to the GitHub Release and sets title and meta", async () => {
    await act(async () => root.render(<Release version="v2026.1108.0" notes={NOTES} />));
    expect(document.title).toBe("v2026.1108.0 release notes · AgentDash");
    expect(description()).toBe("What changed in AgentDash v2026.1108.0, released November 8, 2026: the public release notes and a link to the GitHub Release.");
    expect(container.querySelector("h1")?.textContent).toBe("v2026.1108.0");
    expect([...container.querySelectorAll(".mkt-release__section h2")].map((h) => h.textContent)).toEqual(["What’s new", "For admins", "Upgrade", "Security"]);
    expect(container.querySelectorAll(".mkt-release__section li")).toHaveLength(5);
    const github = [...container.querySelectorAll('a[href="https://github.com/thetangstr/agentdash/releases/tag/v2026.1108.0"]')];
    expect(github.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('a.mkt-updates__back')?.getAttribute("href")).toBe("/releases");
    expect(text()).toContain("Availability depends on the version your operator has installed");
  });

  it("says when a published release has no public summary", async () => {
    await act(async () => root.render(<Release version="v2026.1105.0" notes={NOTES} />));
    expect(container.querySelector("h1")?.textContent).toBe("v2026.1105.0");
    expect(text()).toContain("This release has no public summary here. Its full notes are on the GitHub Release.");
  });

  it("gives an unknown or unpublished version the marketing not-found page", async () => {
    for (const version of ["v2026.1200.0", "v2026.902.1", "not-a-version", "published.json", undefined]) {
      await act(async () => root.render(<Release version={version} notes={NOTES.slice(1)} />));
      expect(container.querySelector("[data-release-not-found]"), String(version)).toBeTruthy();
      expect(container.querySelector("h1")?.textContent).toBe("Release not found.");
      expect(document.title).toBe("Release not found · AgentDash");
      expect(container.querySelector(".mkt-header")).toBeTruthy();
    }
  });

  it("reads the version from /releases/:version", async () => {
    const renderAt = (path: string) =>
      act(async () =>
        root.render(
          <MemoryRouter key={path} initialEntries={[path]}>
            <Routes>
              <Route path="releases/:version" element={<ReleaseRoute />} />
            </Routes>
          </MemoryRouter>,
        ),
      );
    // Whatever this build lists: the newest, if any.
    const newest = listPublishedReleaseNotes()[0]?.version;
    if (newest) {
      await renderAt(`/releases/${newest}`);
      expect(container.querySelector("h1")?.textContent).toBe(newest);
      expect(container.querySelector(`[data-release="${newest}"]`)).toBeTruthy();
    }
    await renderAt("/releases/v1999.101.0");
    expect(container.querySelector("[data-release-not-found]")).toBeTruthy();
  });
});

describe("links to the release notes", () => {
  it("What's new links to all release notes", async () => {
    await act(async () => root.render(<WhatsNew />));
    const link = [...container.querySelectorAll('a[href="/releases"]')].find((a) => a.textContent?.includes("All release notes"));
    expect(link).toBeTruthy();
  });
});
