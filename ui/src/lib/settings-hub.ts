// AgentDash: sidebar IA — the pages that render inside the one Settings
// navigation (SettingsSidebar) instead of the main sidebar. Every page keeps
// its URL; this only decides which sidebar Layout shows next to it.
//
// Company-scoped roots are matched after the company prefix
// (/:companyPrefix/<root>…); anything under /instance/ is instance settings.
const COMPANY_SETTINGS_HUB_ROOTS = [
  "company/settings",
  "company/import",
  "company/export",
  "skills",
  // AgentDash (#859): workforce roles and company knowledge (Settings › Agents).
  "workforce",
  "billing",
  "evaluation",
  // Adapters is also mounted under the company prefix (App.tsx boardRoutes).
  "instance/settings",
] as const;

export function isSettingsHubPath(pathname: string): boolean {
  if (pathname === "/instance" || pathname.startsWith("/instance/")) return true;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  const rest = segments.slice(1).join("/");
  return COMPANY_SETTINGS_HUB_ROOTS.some((root) => rest === root || rest.startsWith(`${root}/`));
}

// AgentDash (Lane F2): where a legacy `/settings…` URL goes. It used to send
// every one of them to /instance/settings/general, the instance-admin page
// (deployment and auth, bootstrap invite, log censoring), so a company founder
// following `/settings`, the billing upgrade link (`/settings/billing`) or the
// Slack OAuth return (`/settings/connections`) landed on a page about the
// deployment. Settings means the workspace's settings; only pages that exist
// solely as instance settings keep their instance target.
const LEGACY_COMPANY_SETTINGS_PAGES = new Set([
  "connections",
  "model-key",
  "environments",
  "access",
  "invites",
  "health",
]);
const LEGACY_INSTANCE_SETTINGS_PAGES = new Set([
  "general",
  "heartbeats",
  "experimental",
  "plugins",
  "adapters",
  "updates",
  "profile",
  "about",
  "changelog",
]);

export const WORKSPACE_SETTINGS_PATH = "/company/settings";

export function legacySettingsRedirectTarget(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const settingsIndex = segments.findIndex((segment) => segment.toLowerCase() === "settings");
  const page = settingsIndex >= 0 ? segments[settingsIndex + 1]?.toLowerCase() : undefined;
  if (!page) return WORKSPACE_SETTINGS_PATH;
  if (page === "billing") return "/billing";
  if (LEGACY_COMPANY_SETTINGS_PAGES.has(page)) return `${WORKSPACE_SETTINGS_PATH}/${page}`;
  if (LEGACY_INSTANCE_SETTINGS_PAGES.has(page)) {
    return `/instance/settings/${segments.slice(settingsIndex + 1).join("/")}`;
  }
  return WORKSPACE_SETTINGS_PATH;
}
