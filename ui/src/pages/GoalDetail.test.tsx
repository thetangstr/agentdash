// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { GoalPropertiesToggleButton } from "./GoalDetail";

describe("GoalPropertiesToggleButton", () => {
  it("shows the reopen control when the properties panel is hidden", () => {
    const html = renderToStaticMarkup(
      <GoalPropertiesToggleButton panelVisible={false} onShowProperties={() => {}} />,
    );

    expect(html).toContain('title="Show properties"');
    expect(html).toContain("opacity-100");
  });

  it("collapses the reopen control while the properties panel is already visible", () => {
    const html = renderToStaticMarkup(
      <GoalPropertiesToggleButton panelVisible onShowProperties={() => {}} />,
    );

    expect(html).toContain("opacity-0");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("w-0");
  });
});

/**
 * Source assertions rather than a render test, deliberately.
 *
 * Both messages live inside Radix `TabsContent`, which unmounts the inactive
 * tab, so proving this in the DOM means mocking five queries and four contexts
 * and then driving a tab click — disproportionate for a one-line render
 * condition, and more likely to rot than the thing it guards. The repo already
 * uses source assertions this way for the connect-a-machine guide.
 *
 * What it guards: the `if (error)` early return in this page covers the single
 * goal query only. The goals and projects lists are separate queries whose
 * failures were not captured at all, so a failed list rendered "No sub-goals."
 * or "No linked projects." as though the answer were known.
 */
describe("GoalDetail empty states", () => {
  // Comments are stripped before matching. The explanatory comment added with
  // this fix quotes both messages, so an ordering check against the raw file
  // found the prose before the JSX and failed on its own documentation.
  const source = readFileSync(new URL("./GoalDetail.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("captures the failure of each list that feeds an empty-state message", () => {
    expect(source).toContain("data: allGoals, error: allGoalsError");
    expect(source).toContain("data: allProjects, error: allProjectsError");
  });

  it("checks the error before claiming there are no sub-goals", () => {
    const guard = source.indexOf("allGoalsError ?");
    const claim = source.indexOf("No sub-goals.");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(claim);
  });

  it("checks the error before claiming nothing is linked", () => {
    const guard = source.indexOf("allProjectsError ?");
    const claim = source.indexOf("No linked projects.");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(claim);
  });

  it("distinguishes a failure from an empty answer in what it says", () => {
    expect(source).toContain("not the same as having no sub-goals");
    expect(source).toContain("not the same as none being linked");
  });
});
