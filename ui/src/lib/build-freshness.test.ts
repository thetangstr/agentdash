// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { isStale, parseEntryScript, runningEntryScript } from "./build-freshness";

function docWith(html: string, baseURI = "http://board.test/"): Document {
  const doc = document.implementation.createHTMLDocument("t");
  doc.head.innerHTML = html;
  Object.defineProperty(doc, "baseURI", { value: baseURI, configurable: true });
  return doc;
}

const RUNNING = '<script type="module" src="/assets/index-AAA111.js"></script>';

describe("parseEntryScript", () => {
  it("finds the hashed entry in a served index.html", () => {
    expect(
      parseEntryScript('<!doctype html><html><head><script type="module" crossorigin src="/assets/index-BBB222.js"></script></head></html>'),
    ).toBe("/assets/index-BBB222.js");
  });

  it("finds it when src comes before type", () => {
    expect(parseEntryScript('<script src="/assets/index-CCC.js" type="module"></script>')).toBe(
      "/assets/index-CCC.js",
    );
  });

  it("returns null when there is no module entry to compare", () => {
    expect(parseEntryScript("<html><head></head></html>")).toBeNull();
  });
});

describe("runningEntryScript", () => {
  it("reports this tab's entry as a path", () => {
    expect(runningEntryScript(docWith(RUNNING))).toBe("/assets/index-AAA111.js");
  });

  it("returns null when nothing hashed is loaded", () => {
    expect(runningEntryScript(docWith(""))).toBeNull();
  });
});

describe("isStale", () => {
  const fetchReturning = (html: string, ok = true) =>
    vi.fn(async () => ({ ok, text: async () => html })) as unknown as typeof fetch;

  it("is true when the server advertises a different build", async () => {
    await expect(
      isStale({
        doc: docWith(RUNNING),
        fetchImpl: fetchReturning('<script type="module" src="/assets/index-ZZZ999.js"></script>'),
      }),
    ).resolves.toBe(true);
  });

  it("is false when the build matches", async () => {
    await expect(
      isStale({ doc: docWith(RUNNING), fetchImpl: fetchReturning(RUNNING) }),
    ).resolves.toBe(false);
  });

  /**
   * Every uncertainty has to answer false. Telling somebody to reload on a
   * network blip is worse than staying quiet, and reloading can cost them an
   * unsaved mandate.
   */
  it("stays quiet on anything it cannot actually determine", async () => {
    const rejecting = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    await expect(isStale({ doc: docWith(RUNNING), fetchImpl: rejecting })).resolves.toBe(false);
    await expect(
      isStale({ doc: docWith(RUNNING), fetchImpl: fetchReturning("", false) }),
    ).resolves.toBe(false);
    await expect(
      isStale({ doc: docWith(RUNNING), fetchImpl: fetchReturning("<html></html>") }),
    ).resolves.toBe(false);
    // No hashed entry in this tab at all: a dev server, not a stale deploy.
    await expect(
      isStale({ doc: docWith(""), fetchImpl: fetchReturning(RUNNING) }),
    ).resolves.toBe(false);
  });

  it("asks the server not to serve it a cached document", async () => {
    const impl = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
      ok: true,
      text: async () => RUNNING,
    }));
    await isStale({ doc: docWith(RUNNING), fetchImpl: impl as unknown as typeof fetch });
    expect(impl.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
  });
});
