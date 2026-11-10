// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listReleaseNotes } from "@/lib/release-notes";
import { InstanceChangelog } from "./InstanceChangelog";

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

describe("in-app Changelog", () => {
  it("links to every published release on the public site, by absolute URL", async () => {
    await act(async () => root.render(<InstanceChangelog />));
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent === "All release notes");
    // Absolute: self-hosted instances serve this page from their own host.
    expect(link?.getAttribute("href")).toBe("https://www.agentdash.cloud/releases");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  it("still shows the bundled notes, unfiltered by the published list", async () => {
    await act(async () => root.render(<InstanceChangelog />));
    expect(container.querySelector("h1")?.textContent).toBe("Changelog");
    expect(container.textContent).toContain(listReleaseNotes()[0]!.version);
  });
});
