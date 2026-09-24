import { describe, expect, it } from "vitest";
import { compareReleaseNotes, listReleaseNotes, parseReleaseMarkdown, parseReleasedDate } from "./release-notes";

describe("release notes", () => {
  it("parses version, release date, and summary sections from release markdown", () => {
    const note = parseReleaseMarkdown(`\
# v2026.428.0

> Released: 2026-04-28

## Highlights

- **One** — see [#123](https://example.com)
- Two

## Fixes

- Three
`);

    expect(note).toEqual({
      version: "v2026.428.0",
      releasedAt: "2026-04-28",
      withdrawn: false,
      upstream: false,
      sections: [
        { title: "Highlights", items: ["One — see #123", "Two"] },
        { title: "Fixes", items: ["Three"] },
      ],
      body: expect.stringContaining("## Highlights"),
    });
  });

  it("lists bundled release notes newest first", () => {
    const notes = listReleaseNotes();

    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]?.version).toMatch(/^v/);
    expect(notes.map((note) => note.version)).toContain("v0.3.1");
  });

  it("does not mix package-specific notes into the application changelog", () => {
    const versions = listReleaseNotes().map((note) => note.version);

    expect(versions).not.toContain("agentdash-connect v0.1.5");
  });

  it("takes only the leading date from a Released line with trailing prose", () => {
    expect(parseReleasedDate("2026-09-14 as v2026.914.0.")).toBe("2026-09-14");
    expect(
      parseReleasedDate("2026-09-05 as v2026.904.0. Version date 2026-09-04 (the cut pinned the date)."),
    ).toBe("2026-09-05");
    expect(parseReleasedDate("2026-09-15.")).toBe("2026-09-15");
    expect(parseReleasedDate("2026-09-22")).toBe("2026-09-22");
    expect(parseReleasedDate("soon")).toBeNull();
    expect(parseReleasedDate("Sept 2026")).toBeNull();

    const note = parseReleaseMarkdown("# v2026.909.1\n\n> Released: 2026-09-09 as v2026.909.1, the second stable cut of the day.\n");
    expect(note.releasedAt).toBe("2026-09-09");
  });

  it("marks withdrawn and upstream notes", () => {
    const withdrawn = parseReleaseMarkdown("# v2026.902.1\n\n> Withdrawn, never released. The cut was cancelled.\n");
    expect(withdrawn.withdrawn).toBe(true);
    expect(withdrawn.releasedAt).toBeNull();

    const upstream = parseReleaseMarkdown(
      "# v0.3.1\n\n> Released: 2026-03-12\n>\n> Upstream: Paperclip release notes inherited with the fork.\n",
    );
    expect(upstream.upstream).toBe(true);
    expect(upstream.withdrawn).toBe(false);
  });

  it("orders by date, then by version for cuts on the same day", () => {
    const notes = [
      "# v2026.909.0\n\n> Released: 2026-09-09 as v2026.909.0.",
      "# v2026.914.0\n\n> Released: 2026-09-14 as v2026.914.0.",
      "# v2026.909.2\n\n> Released: 2026-09-09 as v2026.909.2, the third stable cut of the day.",
      "# v2026.428.0\n\n> Released: 2026-04-28",
    ].map(parseReleaseMarkdown);

    expect(notes.sort(compareReleaseNotes).map((note) => note.version)).toEqual([
      "v2026.914.0",
      "v2026.909.2",
      "v2026.909.0",
      "v2026.428.0",
    ]);
  });

  it("gives every bundled note a real date and sorts them newest first", () => {
    const notes = listReleaseNotes();

    for (const note of notes) {
      expect(note.releasedAt, note.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const dates = notes.map((note) => note.releasedAt!);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("leaves withdrawn cuts and the index README out of the in-app changelog", () => {
    const versions = listReleaseNotes().map((note) => note.version);

    expect(versions).not.toContain("v2026.902.1");
    expect(versions).not.toContain("v2026.827.3");
    expect(versions.every((version) => version.startsWith("v"))).toBe(true);
  });
});
