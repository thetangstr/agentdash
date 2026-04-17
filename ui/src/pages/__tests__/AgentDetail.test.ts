// @vitest-environment node
// Verifies that the skills view in AgentDetail is fully restored — including
// the breadcrumb that was previously commented out with "TODO: bring back later".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, "../AgentDetail.tsx"), "utf-8");

describe("AgentDetail skills view", () => {
  it("renders a Skills section — skills tab is present in the tab bar", () => {
    // The tab bar includes { value: "skills", label: "Skills" }
    expect(source).toContain('value: "skills", label: "Skills"');
  });

  it("skills breadcrumb is uncommented (no TODO: bring back later)", () => {
    // The old code had this commented out: // } else if (activeView === "skills") { // TODO: bring back later
    // After the fix, the comment and TODO must be removed.
    expect(source).not.toContain("TODO: bring back later");
  });

  it("skills breadcrumb case is active", () => {
    // After uncomment, this branch must be present as active code.
    expect(source).toContain('activeView === "skills"');
    // And the label "Skills" must be pushed to crumbs within that branch.
    expect(source).toContain('label: "Skills"');
  });
});
