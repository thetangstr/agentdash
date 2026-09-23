import { describe, expect, it } from "vitest";
import {
  INSTANCE_URL_TOKEN,
  getGuide,
  guideLinks,
  guideLocation,
  listGuides,
  parseGuideMarkdown,
  renderGuide,
  tokensIn,
} from "./guides";

describe("guides: parsing", () => {
  it("reads title, summary, audience and order from front matter and strips it from the body", () => {
    const guide = parseGuideMarkdown(
      "../../../docs/guides/steward/example.md",
      `---
title: Example Guide
summary: "One line, quoted"
audience: steward
order: 7
---

Body starts here.
`,
    );
    expect(guide).toEqual({
      group: "steward",
      slug: "example",
      title: "Example Guide",
      summary: "One line, quoted",
      audience: "steward",
      order: 7,
      body: "Body starts here.",
    });
  });

  it("derives group and slug from the path", () => {
    expect(guideLocation("../../../docs/guides/board-operator/onboard-a-steward.md")).toEqual({
      group: "board-operator",
      slug: "onboard-a-steward",
    });
  });

  it("survives missing front matter with the slug as title", () => {
    const guide = parseGuideMarkdown("../../../docs/guides/steward/bare.md", "Just text.");
    expect(guide.title).toBe("bare");
    expect(guide.audience).toBe("all");
    expect(guide.body).toBe("Just text.");
  });
});

describe("guides: rendering", () => {
  it("substitutes the instance address everywhere, without a trailing slash", () => {
    const rendered = renderGuide(`Open ${INSTANCE_URL_TOKEN}/my-agent then ${INSTANCE_URL_TOKEN}.`, {
      instanceUrl: "https://mk.example:3112/",
    });
    expect(rendered).toBe("Open https://mk.example:3112/my-agent then https://mk.example:3112.");
    expect(rendered).not.toContain("{{");
  });
});

/**
 * The bundled set is checked as a whole. A guide that ships with an unknown
 * token renders a literal `{{…}}` to a new person; a guide that links to a slug
 * that does not exist sends them to a blank page. Both are the kind of thing
 * nobody notices until the first steward hits it.
 */
describe("guides: the bundled set", () => {
  const guides = listGuides();

  it("bundles the steward set and the admin pages that pair with it", () => {
    const keys = guides.map((guide) => `${guide.group}/${guide.slug}`);
    expect(keys).toContain("steward/getting-started");
    expect(keys).toContain("steward/connect-your-terminal");
    expect(keys).toContain("steward/your-inbox");
    expect(keys).toContain("steward/troubleshooting-connect");
    expect(keys).toContain("board-operator/onboard-a-steward");
    expect(keys).toContain("board-operator/agent-kinds-and-stewardship");
  });

  it("gives every guide a title, a summary and an explicit audience", () => {
    for (const guide of guides) {
      expect(guide.title, `${guide.group}/${guide.slug} title`).not.toBe(guide.slug);
      expect(guide.summary, `${guide.group}/${guide.slug} summary`).not.toBe("");
      expect(["steward", "admin"], `${guide.group}/${guide.slug} audience`).toContain(guide.audience);
    }
  });

  it("uses no token other than the instance address", () => {
    for (const guide of guides) {
      const unknown = tokensIn(guide.body).filter((token) => token !== INSTANCE_URL_TOKEN);
      expect(unknown, `${guide.group}/${guide.slug}`).toEqual([]);
    }
  });

  it("links only to guides that exist", () => {
    for (const guide of guides) {
      for (const link of guideLinks(guide)) {
        expect(
          getGuide(link.group, link.slug),
          `${guide.group}/${guide.slug} links to ${link.raw}`,
        ).not.toBeNull();
      }
    }
  });

  it("never tells anyone to run a CLI that does not exist", () => {
    // Mirrors server/src/__tests__/bridge-command-name.test.ts (AGE-12), which
    // scans docs/ too. Kept here so the failure names the guide, not the tree.
    for (const guide of guides) {
      expect(guide.body, `${guide.group}/${guide.slug}`).not.toMatch(/npx\s+agentdash(?![\w-])/);
    }
  });
});
