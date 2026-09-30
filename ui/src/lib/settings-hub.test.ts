import { describe, expect, it } from "vitest";
import { isSettingsHubPath } from "./settings-hub";

describe("isSettingsHubPath", () => {
  it.each([
    "/PAP/company/settings",
    "/PAP/company/settings/access",
    "/PAP/company/settings/health",
    "/PAP/company/import",
    "/PAP/company/export",
    "/PAP/company/export/files/x",
    "/PAP/skills",
    "/PAP/skills/abc",
    "/PAP/billing",
    "/PAP/evaluation",
    "/PAP/evaluation/founder",
    "/PAP/instance/settings/adapters",
    "/instance/settings/general",
    "/instance/settings/plugins/p-1",
  ])("renders %s inside the settings navigation", (path) => {
    expect(isSettingsHubPath(path)).toBe(true);
  });

  it.each([
    "/PAP/dashboard",
    "/PAP/agents/all",
    "/PAP/org",
    "/PAP/costs",
    "/PAP/goals",
    "/PAP/guides",
    "/PAP/skillset",
    "/PAP/billingx",
    "/PAP/company",
    "/PAP",
    "/",
  ])("keeps %s on the main sidebar", (path) => {
    expect(isSettingsHubPath(path)).toBe(false);
  });
});
