import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Instruction files are edited as source. This guards the decision, because it
 * is the kind that gets undone by someone reasonably thinking a markdown file
 * deserves a markdown editor.
 *
 * What went wrong: a steward pasted a prepared mandate into an instruction file
 * and the rich editor escaped it — `\*\*bold\*\*` and `&#x20;` entities — because
 * a WYSIWYG surface treats pasted markdown as literal text and re-escapes it on
 * the way back out.
 *
 * AGENTS.md happened to be safe already: the generated block markers are HTML
 * comments, MDXEditor has no import visitor for mdast `html` nodes, so it threw
 * and the component fell back to raw source. That accident does not cover
 * SOUL.md, HEARTBEAT.md, TOOLS.md, or a new AGENTS.md before any block exists —
 * the files a steward is most likely to write by hand.
 */
describe("agent instructions editor", () => {
  const page = readFileSync(new URL("./AgentDetail.tsx", import.meta.url), "utf8");

  it("edits instruction files as source, not through the rich markdown editor", () => {
    expect(
      page,
      "AgentDetail must not mount MarkdownEditor: instruction files are source",
    ).not.toContain("MarkdownEditor");
  });

  it("says why, so the next reader does not undo it", () => {
    expect(page).toMatch(/edited as SOURCE/i);
    expect(page).toMatch(/html/i);
  });
});
