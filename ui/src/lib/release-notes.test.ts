import { describe, expect, it } from "vitest";
import { listReleaseNotes, parseReleaseMarkdown } from "./release-notes";

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
});
