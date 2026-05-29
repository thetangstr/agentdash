// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardTaskOutcomeQuality } from "@paperclipai/shared";
import { TaskOutcomeQualityPanel } from "./TaskOutcomeQualityPanel";

describe("TaskOutcomeQualityPanel", () => {
  it("renders task acceptance, DoD coverage, and cost per accepted task", () => {
    const quality: DashboardTaskOutcomeQuality = {
      windowDays: 30,
      issuesInScope: 4,
      issuesWithDefinitionOfDone: 3,
      dodCoveragePercent: 75,
      reviewedIssues: 2,
      passedIssues: 1,
      failedIssues: 1,
      revisionRequestedIssues: 0,
      escalatedIssues: 0,
      unreviewedDoneIssues: 1,
      acceptanceRatePercent: 50,
      greenRunsPendingReview: 1,
      greenRunsWithOpenTasks: 1,
      issueLinkedSpendCents: 2300,
      issueLinkedTokens: 2600,
      spendPerAcceptedIssueCents: 2300,
    };

    const html = renderToStaticMarkup(<TaskOutcomeQualityPanel quality={quality} />);

    expect(html).toContain("Task outcome quality");
    expect(html).toContain("50%");
    expect(html).toContain("75%");
    expect(html).toContain("$23.00");
    expect(html).toContain("green run left a task open");
    expect(html).toContain("green runs pending review");
  });
});
