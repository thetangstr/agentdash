/**
 * AgentDash (Scan 4 lane M): words a company's issue prefix must never be.
 *
 * The UI routes a company at `/<PREFIX>/...`, and the first path segment is
 * also how it tells a company apart from a top-level page. A company whose
 * prefix is one of these words (for example "MCP" for "MCP Advisory", or
 * "ORG") is shadowed by the page of the same name and cannot be opened.
 *
 * This is the union of the UI's global route roots and board route roots
 * (ui/src/lib/company-routes.ts); a UI test fails when either set has a root
 * that is missing here. Compare in lowercase.
 */
export const RESERVED_COMPANY_PREFIXES = [
  // Top-level, company-agnostic pages.
  "about",
  "assess",
  "auth",
  "board-claim",
  "claim",
  "cli-auth",
  "company-create",
  "consulting",
  "demo",
  "docs",
  "find",
  "forgot-password",
  "instance",
  "invite",
  "investors",
  "mcp",
  "member-onboarding",
  "oauth",
  "pricing",
  "privacy",
  "reset-password",
  "setup",
  "share",
  "start",
  "terms",
  "tests",
  "trial",
  // Company (board) pages, which also answer unprefixed.
  "activity",
  "agents",
  "approvals",
  "billing",
  "companies",
  "company",
  "connect-assistant",
  "cos",
  "costs",
  "dashboard",
  "decisions",
  "design-guide",
  "evaluation",
  "execution-workspaces",
  "goals",
  "guides",
  "inbox",
  "issues",
  "my-agent",
  "onboarding",
  "org",
  "plugins",
  "projects",
  "routines",
  "settings",
  "shipped",
  "skills",
  "u",
  "usage",
  "workforce",
  "workspaces",
] as const;

const RESERVED = new Set<string>(RESERVED_COMPANY_PREFIXES);

/** True when an issue prefix would collide with a page's route. */
export function isReservedCompanyPrefix(prefix: string): boolean {
  return RESERVED.has(prefix.trim().toLowerCase());
}
