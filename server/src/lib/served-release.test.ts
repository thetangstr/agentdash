import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RELEASE_MARKER_FILENAME, findReleaseMarker } from "./served-release.js";

const COMMIT = "4637abd727dfe98b4865bec30a39cd772c484749";

describe("findReleaseMarker", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function release(marker: unknown) {
    const root = mkdtempSync(path.join(os.tmpdir(), "served-release-"));
    roots.push(root);
    const deep = path.join(root, "server", "dist", "lib");
    mkdirSync(deep, { recursive: true });
    if (marker !== undefined) {
      writeFileSync(path.join(root, RELEASE_MARKER_FILENAME), typeof marker === "string" ? marker : JSON.stringify(marker));
    }
    return { root, deep };
  }

  it("reads the commit and tag of the release the code sits in", () => {
    const { deep } = release({ schemaVersion: 1, tag: "v2026.930.0", commit: COMMIT, complete: true });
    expect(findReleaseMarker(deep)).toEqual({ tag: "v2026.930.0", commit: COMMIT });
  });

  it("reports nothing outside a release layout", () => {
    const { deep } = release(undefined);
    expect(findReleaseMarker(deep, 3)).toBeNull();
  });

  it("reports nothing for an incomplete or unreadable marker", () => {
    expect(findReleaseMarker(release({ commit: COMMIT, complete: false }).deep)).toBeNull();
    expect(findReleaseMarker(release("{not json").deep, 3)).toBeNull();
    expect(findReleaseMarker(release({ commit: "not a sha", complete: true }).deep)).toBeNull();
  });
});
