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
