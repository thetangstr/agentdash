import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source assertions, not a render test, and the reason is specific.
 *
 * The revisions query is `enabled: Boolean(revisionMenuOpenKey)`, and that key
 * is only set through the dropdown's `onOpenChange` — which the shared
 * dropdown mock in IssueDocumentsSection.test.tsx deliberately drops. So no
 * test there can open the menu, and the query never fires in that suite at
 * all. Reaching the error branch in the DOM would mean rewriting that shared
 * mock and re-verifying every other test depending on it, to prove one
 * disabled menu item.
 *
 * This lives in its own file because that suite declares the jsdom
 * environment, where `import.meta.url` is not a file URL and cannot be read
 * from disk.
 *
 * What it guards: `isFetching` goes false the moment the request fails while
 * `data` stays undefined, so the menu fell through to "No revisions yet" and
 * told someone a document had no history when it may have had one to restore.
 */
describe("IssueDocumentsSection revision menu", () => {
  // Comments stripped: the comment added with this fix quotes the message, so
  // an ordering check against the raw file would find the prose, not the JSX.
  const source = readFileSync(new URL("./IssueDocumentsSection.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("captures the revisions query failure, not only its fetching state", () => {
    expect(source).toContain("error: documentRevisionsError");
  });

  it("checks that failure before saying there are no revisions", () => {
    // The condition form, not the destructured name: matching the bare
    // identifier passed even with the branch deleted, because the query's own
    // `error: documentRevisionsError` sits earlier in the file.
    const guard = source.indexOf("documentRevisionsError &&");
    const claim = source.indexOf("No revisions yet");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(claim);
  });

  it("says the load failed rather than implying an empty history", () => {
    expect(source).toContain("Could not load revisions");
  });
});
