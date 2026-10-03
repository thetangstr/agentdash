import { describe, expect, it } from "vitest";
import { navigationDestinationGroups } from "./navigation-destinations";

function paths(groups: ReturnType<typeof navigationDestinationGroups>) {
  return groups.flatMap((group) => group.items.map((item) => item.to));
}

// Every destination that was in the sidebar's former "Advanced" group, and
// every settings page, must stay reachable from the command palette.
const FORMER_ADVANCED = [
  "/guides",
  "/routines",
  "/goals",
  "/org",
  "/skills",
  "/costs",
  "/evaluation",
  "/billing",
  "/activity",
  "/company/import",
  "/company/export",
  "/company/settings/environments",
  "/company/settings/health",
  "/instance/settings/adapters",
  "/instance/settings/changelog",
  "/my-agent",
  "/projects",
];
const INSTANCE_ADMIN_ONLY = [
  "/instance/settings/heartbeats",
  "/instance/settings/plugins",
  "/instance/settings/experimental",
  "/instance/settings/general",
  "/instance/settings/access",
];

describe("navigationDestinationGroups", () => {
  it("offers the primary pages, More, Help and Settings", () => {
    const groups = navigationDestinationGroups({
      isInstanceAdmin: false,
      isCompanyAdmin: false,
      workspacesEnabled: false,
    });
    expect(groups.map((g) => g.heading)).toEqual(["Pages", "More", "Help", "Settings"]);
    const all = paths(groups);
    for (const href of ["/dashboard", "/cos", "/issues", "/decisions", "/shipped", "/agents"]) {
      expect(all).toContain(href);
    }
    for (const href of FORMER_ADVANCED) {
      expect(all, `expected ${href}`).toContain(href);
    }
    for (const href of [
      "/company/settings",
      "/company/settings/access",
      "/company/settings/invites",
      "/company/settings/model-key",
      "/company/settings/connections",
      "/instance/settings/profile",
      "/instance/settings/about",
    ]) {
      expect(all, `expected ${href}`).toContain(href);
    }
    for (const href of [...INSTANCE_ADMIN_ONLY, "/inbox/override", "/workspaces"]) {
      expect(all, `unexpected ${href}`).not.toContain(href);
    }
  });

  it("adds instance pages, Override and Workspaces by who the user is and what is enabled", () => {
    const all = paths(
      navigationDestinationGroups({ isInstanceAdmin: true, isCompanyAdmin: true, workspacesEnabled: true }),
    );
    for (const href of [...INSTANCE_ADMIN_ONLY, "/inbox/override", "/workspaces"]) {
      expect(all, `expected ${href}`).toContain(href);
    }
  });

  it("hides the Override destination from a member who can manage agents but is not an admin", () => {
    // GH #971 review: the override inbox is an owner/admin view on the server,
    // so the palette must not offer it to anyone the server would refuse.
    const all = paths(
      navigationDestinationGroups({ isInstanceAdmin: false, isCompanyAdmin: false, workspacesEnabled: false }),
    );
    expect(all).not.toContain("/inbox/override");
  });

  it("labels settings items with their group so same-named pages are distinguishable", () => {
    const settings = navigationDestinationGroups({
      isInstanceAdmin: true,
      isCompanyAdmin: false,
      workspacesEnabled: false,
    }).find((g) => g.heading === "Settings")!;
    const generals = settings.items.filter((item) => item.label === "General");
    expect(generals.map((item) => item.hint)).toEqual(["Workspace", "Instance"]);
  });
});
