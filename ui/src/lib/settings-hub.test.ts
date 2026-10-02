import { describe, expect, it } from "vitest";
import { isSettingsHubPath, legacySettingsRedirectTarget } from "./settings-hub";

// AgentDash (Lane F2): a founder following a legacy /settings link lands on the
// workspace's settings, never on the instance-admin General page.
describe("legacySettingsRedirectTarget", () => {
  it.each([
    ["/settings", "/company/settings"],
    ["/BRI/settings", "/company/settings"],
    ["/settings/", "/company/settings"],
    ["/settings/billing", "/billing"],
    ["/BRI/settings/billing", "/billing"],
    ["/settings/connections", "/company/settings/connections"],
    ["/settings/invites", "/company/settings/invites"],
    ["/settings/access", "/company/settings/access"],
    ["/settings/something-old", "/company/settings"],
    ["/settings/general", "/instance/settings/general"],
    ["/settings/plugins/abc", "/instance/settings/plugins/abc"],
    ["/settings/profile", "/instance/settings/profile"],
  ])("%s -> %s", (pathname, target) => {
    expect(legacySettingsRedirectTarget(pathname)).toBe(target);
  });
});

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
