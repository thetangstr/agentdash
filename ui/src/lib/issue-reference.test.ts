import { describe, expect, it } from "vitest";
import {
  parseIssuePathIdFromPath,
  parseIssueReferenceFromHref,
  remarkLinkIssueReferences,
  type IssueReferenceOptions,
} from "./issue-reference";

type TestNode = { type: string; value?: string; url?: string; children?: TestNode[] };

function linkedUrlsIn(text: string, options?: IssueReferenceOptions) {
  const tree: TestNode = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] };
  remarkLinkIssueReferences(options)(tree);
  const paragraph = tree.children![0]!;
  return {
    urls: (paragraph.children ?? []).filter((node) => node.type === "link").map((node) => node.url),
    text: (paragraph.children ?? [])
      .map((node) => node.value ?? node.children?.map((child) => child.value).join("") ?? "")
      .join(""),
  };
}

describe("issue-reference", () => {
  it("extracts issue ids from company-scoped issue paths", () => {
    expect(parseIssuePathIdFromPath("/PAP/issues/PAP-1271")).toBe("PAP-1271");
    expect(parseIssuePathIdFromPath("/PAP/issues/pap-1272")).toBe("PAP-1272");
    expect(parseIssuePathIdFromPath("/issues/PAP-1179")).toBe("PAP-1179");
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
  });

  it("does not treat full issue URLs as internal issue paths", () => {
    expect(parseIssuePathIdFromPath("http://localhost:3100/PAP/issues/PAP-1179")).toBeNull();
    expect(parseIssuePathIdFromPath("http://remote.example.test:3103/PAPA/issues/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("does not treat GitHub issue URLs as internal Paperclip issue links", () => {
    expect(parseIssuePathIdFromPath("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
    expect(parseIssueReferenceFromHref("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
  });

  it("ignores placeholder issue paths", () => {
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
    expect(parseIssuePathIdFromPath("http://localhost:3100/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
  });

  it("normalizes bare identifiers, relative issue paths, and issue scheme links into internal links", () => {
    expect(parseIssueReferenceFromHref("pap-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
    expect(parseIssueReferenceFromHref("/PAP/issues/pap-1180")).toEqual({
      issuePathId: "PAP-1180",
      href: "/issues/PAP-1180",
    });
    expect(parseIssueReferenceFromHref("issue://PAP-1310")).toEqual({
      issuePathId: "PAP-1310",
      href: "/issues/PAP-1310",
    });
    expect(parseIssueReferenceFromHref("issue://:PAP-1311")).toEqual({
      issuePathId: "PAP-1311",
      href: "/issues/PAP-1311",
    });
  });

  it("normalizes exact inline-code-like issue identifiers", () => {
    expect(parseIssueReferenceFromHref("PAP-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
  });

  it("preserves absolute Paperclip issue URLs so origin, port, and hash are not lost", () => {
    expect(parseIssueReferenceFromHref("http://localhost:3100/PAP/issues/PAP-1179")).toBeNull();
    expect(parseIssueReferenceFromHref("http://remote.example.test:3103/PAPA/issues/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("ignores literal route placeholder paths", () => {
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("http://localhost:3100/api/issues/:id")).toBeNull();
  });

  // AgentDash: UUID fragments and model names were linkified and each one fetched a
  // nonexistent issue (e.g. GET /issues/BD42-4916 404).
  describe("bare identifiers in prose", () => {
    const uuidText = "Run 3f9a1c7e-bd42-4916-a8c3-5e0f2b7d9c14 finished; see ACME-60.";

    it("does not link UUID fragments", () => {
      expect(linkedUrlsIn(uuidText).urls).toEqual(["/issues/ACME-60"]);
      expect(linkedUrlsIn(uuidText, { issuePrefixes: ["ACME"] }).urls).toEqual(["/issues/ACME-60"]);
      expect(linkedUrlsIn("approval a41f0c3e-dab7-4308-9e1c-5b2d7f0a6c81").urls).toEqual([]);
      expect(linkedUrlsIn("id 1b2c3d4e-FACE-4071-8abc-0123456789ab", { issuePrefixes: ["FACE"] }).urls).toEqual([]);
    });

    it("keeps the surrounding text intact when nothing is linked", () => {
      const linked = linkedUrlsIn(uuidText, { issuePrefixes: ["ACME"] });
      expect(linked.text).toBe(uuidText);
    });

    it("does not link model names or other words outside the company prefixes", () => {
      expect(linkedUrlsIn("Switched to GPT-4 and BUILD-2026.", { issuePrefixes: ["ACME"] }).urls).toEqual([]);
      expect(parseIssueReferenceFromHref("GPT-4", { issuePrefixes: ["ACME"] })).toBeNull();
    });

    it("links identifiers with a known company prefix", () => {
      expect(linkedUrlsIn("Blocked by ACME-60 (and acme-61).", { issuePrefixes: ["ACME", "PAP"] }).urls).toEqual([
        "/issues/ACME-60",
        "/issues/ACME-61",
      ]);
      expect(parseIssueReferenceFromHref("ACME-60", { issuePrefixes: ["acme"] })).toEqual({
        issuePathId: "ACME-60",
        href: "/issues/ACME-60",
      });
    });

    it("without company context, links only all-uppercase letter prefixes", () => {
      expect(linkedUrlsIn("See ACME-60, step-2 and c3d1-5820.").urls).toEqual(["/issues/ACME-60"]);
      expect(linkedUrlsIn("See ACME-60.", { issuePrefixes: null }).urls).toEqual(["/issues/ACME-60"]);
      expect(parseIssueReferenceFromHref("bd42-4916")).toBeNull();
    });

    it("links no bare identifiers while the company prefixes are still loading", () => {
      expect(linkedUrlsIn("Switched to GPT-4 for ACME-60.", { issuePrefixes: [] }).urls).toEqual([]);
      expect(parseIssueReferenceFromHref("gpt-4", { issuePrefixes: [] })).toBeNull();
      expect(linkedUrlsIn("See /issues/ACME-60.", { issuePrefixes: [] }).urls).toEqual(["/issues/ACME-60"]);
    });

    it("links identifiers glued into branch names and hyphenated words", () => {
      for (const options of [undefined, { issuePrefixes: ["ACME"] }]) {
        expect(linkedUrlsIn("Branch ACME-60-fix-login is up.", options).urls).toEqual(["/issues/ACME-60"]);
        expect(linkedUrlsIn("Opened re-ACME-60 today.", options).urls).toEqual(["/issues/ACME-60"]);
        expect(linkedUrlsIn("Split into ACME-60-2 later.", options).urls).toEqual(["/issues/ACME-60"]);
        expect(linkedUrlsIn("Range ACME-59-ACME-60.", options).urls).toEqual(["/issues/ACME-59", "/issues/ACME-60"]);
        expect(linkedUrlsIn(uuidText, options).urls).toEqual(["/issues/ACME-60"]);
      }
    });

    // GH #863 item 3: a company prefix that is all hex looks like a UUID group.
    it("links glued identifiers for a known all-hex company prefix", () => {
      for (const prefix of ["ABC", "CAF", "FAB", "BED", "DEF"]) {
        const options = { issuePrefixes: [prefix] };
        expect(linkedUrlsIn(`Branch ${prefix}-12-fix-login is up.`, options).urls).toEqual([`/issues/${prefix}-12`]);
        expect(linkedUrlsIn(`Opened re-${prefix}-12 today.`, options).urls).toEqual([`/issues/${prefix}-12`]);
        expect(linkedUrlsIn(`See ${prefix}-12.`, options).urls).toEqual([`/issues/${prefix}-12`]);
      }
    });

    it("still skips a known all-hex prefix that sits inside a complete UUID", () => {
      const text = "Run 3f9a1c7e-bd42-4916-a8c3-5e0f2b7d9c14 and 3f9a1c7e-cafe-4916-a8c3-5e0f2b7d9c14 done; see CAFE-7.";
      expect(linkedUrlsIn(text, { issuePrefixes: ["CAFE", "BD42"] }).urls).toEqual(["/issues/CAFE-7"]);
    });

    it("keeps the neighbour guard for an all-hex prefix with no company context", () => {
      expect(linkedUrlsIn("Opened re-ABC-12 today.").urls).toEqual([]);
    });

    it("still links explicit issue paths whatever the prefix", () => {
      expect(linkedUrlsIn("See /issues/PAP-1179.", { issuePrefixes: ["ACME"] }).urls).toEqual(["/issues/PAP-1179"]);
      expect(parseIssueReferenceFromHref("issue://PAP-1310", { issuePrefixes: ["ACME"] })).toEqual({
        issuePathId: "PAP-1310",
        href: "/issues/PAP-1310",
      });
    });
  });
});
