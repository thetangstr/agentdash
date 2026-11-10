import { describe, expect, it } from "vitest";
import { listReleaseNotes, parseReleaseMarkdown, type ReleaseNote } from "@/lib/release-notes";
import { forbiddenTokenOffsets } from "../../../../scripts/docs/forbidden-tokens.mjs";
import {
  findPublishedReleaseNote,
  formatReleaseDate,
  githubReleaseUrl,
  listPublishedReleaseNotes,
  publishedReleases,
  readPublishedVersions,
  releasePath,
  releaseSummary,
  resolvePublishedReleases,
  selectPublishedReleaseNotes,
} from "./releases";

const note = (markdown: string): ReleaseNote => parseReleaseMarkdown(markdown);
const NOTES = [
  note("# v2026.1108.0\n> Released: 2026-11-08\n\n## What’s new\n- Bulk changes for admins.\n\n## Security\n- No changes.\n"),
  note("# v2026.1105.0\n> Released: 2026-11-05\n\n## Fixes\n- Packaging.\n"),
  note("# v2026.1104.0\n> Released: 2026-11-04\n"),
  note("# v2026.902.1\n> Withdrawn, never released.\n"),
  note("# v2026.428.0\n> Released: 2026-04-28\n> Upstream: Inherited release.\n\n## Improvements\n- Upstream item.\n"),
];
// Fixtures only. The repository's own release list changes with every
// release; the build-wiring test below asserts invariants, never versions.

describe("published release list", () => {
  it("reads only schema-1 lists of stable versions", () => {
    expect(readPublishedVersions({ schema: 1, published: ["v2026.1105.0", "v2026.1105.0"] })).toEqual(["v2026.1105.0"]);
    for (const bad of [null, [], { schema: 2, published: [] }, { schema: 1 }, { schema: 1, published: ["v2026.1105.0", "latest"] }, { schema: 1, published: [42] }]) {
      expect(readPublishedVersions(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("uses the build's API list when there is one, and the snapshot otherwise", () => {
    const snapshot = { schema: 1, published: ["v2026.1104.0"] };
    expect(resolvePublishedReleases({ schema: 1, source: "github-api", published: ["v2026.1105.0"] }, snapshot)).toEqual({ source: "github-api", versions: ["v2026.1105.0"] });
    // An unknown source label is not trusted as the API's.
    expect(resolvePublishedReleases({ schema: 1, source: "github-feed", published: ["v2026.1104.0"] }, snapshot)).toEqual({ source: "snapshot", versions: ["v2026.1104.0"] });
    // The prebuild fell back: it wrote the snapshot, and says so.
    expect(resolvePublishedReleases({ schema: 1, source: "snapshot", published: ["v2026.1104.0"] }, snapshot)).toEqual({ source: "snapshot", versions: ["v2026.1104.0"] });
    // No generated file (tests, Docker, self-hosted builds) or a broken one: the committed snapshot.
    expect(resolvePublishedReleases(undefined, snapshot)).toEqual({ source: "snapshot", versions: ["v2026.1104.0"] });
    expect(resolvePublishedReleases({ schema: 1, source: "github-api", published: "oops" }, snapshot)).toEqual({ source: "snapshot", versions: ["v2026.1104.0"] });
    expect(resolvePublishedReleases(undefined, { broken: true })).toEqual({ source: "snapshot", versions: [] });
  });

  it("lists a note only when its release is published, never withdrawn or upstream notes", () => {
    const published = ["v2026.1105.0", "v2026.1104.0", "v2026.902.1", "v2026.428.0", "v2026.1200.0"];
    expect(selectPublishedReleaseNotes(NOTES, published).map((n) => n.version)).toEqual(["v2026.1105.0", "v2026.1104.0"]);
    // v2026.1108.0 has notes but no published GitHub Release, so it is not listed or served.
    expect(findPublishedReleaseNote("v2026.1108.0", selectPublishedReleaseNotes(NOTES, published))).toBeNull();
    expect(selectPublishedReleaseNotes(NOTES, [...published, "v2026.1108.0"])[0]?.version).toBe("v2026.1108.0");
    expect(findPublishedReleaseNote(undefined, NOTES)).toBeNull();
  });

  it("this build lists the bundled notes whose versions are in its published list, in the notes' order", () => {
    const { versions } = publishedReleases();
    const listed = listPublishedReleaseNotes();
    const published = new Set(versions);
    expect(listed).toEqual(listReleaseNotes().filter((n) => !n.withdrawn && !n.upstream && published.has(n.version)));
    expect(listed.every((n) => !n.withdrawn && !n.upstream)).toBe(true);
  });

  it("ships no denied identifier on any public release page", () => {
    expect(forbiddenTokenOffsets(JSON.stringify(listPublishedReleaseNotes())).length).toBe(0);
  });
});

describe("release page helpers", () => {
  it("links each version to its page and its GitHub Release", () => {
    expect(releasePath("v2026.1105.0")).toBe("/releases/v2026.1105.0");
    expect(githubReleaseUrl("v2026.1105.0")).toBe("https://github.com/thetangstr/agentdash/releases/tag/v2026.1105.0");
  });

  it("formats the release date without a time-zone shift", () => {
    expect(formatReleaseDate("2026-11-05")).toBe("November 5, 2026");
    expect(formatReleaseDate("2026-01-01")).toBe("January 1, 2026");
  });

  it("summarizes from What's new first, then the first section with a bullet", () => {
    expect(releaseSummary(NOTES[0]!)).toBe("Bulk changes for admins.");
    expect(releaseSummary(NOTES[1]!)).toBe("Packaging.");
    expect(releaseSummary(NOTES[2]!)).toBeNull();
  });
});
