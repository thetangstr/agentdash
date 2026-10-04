// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardHarnessHealth } from "@paperclipai/shared";
import { HarnessHealthPanel } from "./HarnessHealthPanel";

describe("HarnessHealthPanel", () => {
  it("renders adapter failure-rate monitoring with the top failure category", () => {
    const health: DashboardHarnessHealth = {
      windowHours: 24,
      overallStatus: "critical",
      totalRuns: 5,
      failedRuns: 3,
      failureRatePercent: 60,
      adapters: [
        {
          adapterType: "codex_local",
          status: "critical",
          totalRuns: 4,
          failedRuns: 3,
          failureRatePercent: 75,
          agents: 2,
          affectedAgents: 2,
          latestFailureAt: "2026-05-29T16:00:00.000Z",
          topFailureCategory: "rate_limited",
        },
      ],
    };

    const html = renderToStaticMarkup(<HarnessHealthPanel health={health} />);

    expect(html).toContain("Run reliability");
    expect(html).toContain("60%");
    expect(html).toContain("Codex (local)");
    expect(html).toContain("75%");
    expect(html).toContain("a rate limit was reached");
    expect(html).toContain(">2</span> agents");
  });

  it("renders a quiet empty state when no terminal runs are available", () => {
    const health: DashboardHarnessHealth = {
      windowHours: 24,
      overallStatus: "ok",
      totalRuns: 0,
      failedRuns: 0,
      failureRatePercent: 0,
      adapters: [],
    };

    const html = renderToStaticMarkup(<HarnessHealthPanel health={health} />);

    expect(html).toContain("No agent runs finished");
    expect(html).toContain("last 24 hours");
  });
});
