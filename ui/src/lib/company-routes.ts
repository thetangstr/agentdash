const BOARD_ROUTE_ROOTS = new Set([
  "dashboard",
  "companies",
  "company",
  "skills",
  "org",
  "agents",
  "workforce",
  "projects",
  "workspaces",
  "execution-workspaces",
  "issues",
  "routines",
  "goals",
  "approvals",
  // AgentDash: UX-7 (GH #788) — the Decisions page (default profile).
  "decisions",
  "costs",
  "evaluation",
  "billing",
  "usage",
  "activity",
  "inbox",
  "u",
  "design-guide",
  "guides",
  // AgentDash: UX-2 (#783) — the Shipped page.
  "shipped",
  // AgentDash (GH #786): in-app assistant connection instructions
  "connect-assistant",
  // Missing here meant the sidebar's own "My Agent" link was broken.
  //
  // A root that is not in this set is assumed to BE a company prefix, so
  // applyCompanyPrefix looked at "/my-agent", concluded the path was already
  // prefixed with a company called MY-AGENT, and returned it unprefixed. The
  // link then fell through to the :companyPrefix route, which reported
  // "No company matches prefix MY-AGENT" — an error about a company, for a
  // page that has nothing to do with one.
  //
  // Anything added under boardRoutes() needs an entry here, or it silently
  // becomes a company code.
  "my-agent",
  // AgentDash: Ask (the Chief of Staff conversation) lives under the company
  // prefix so it renders inside the sidebar Layout. Bare /cos still answers
  // and redirects to the selected company's /:prefix/cos.
  "cos",
  // AgentDash (Scan 3, lane J): /:prefix/onboarding is a board route too.
  // Without it "/WAN/onboarding" kept its prefix when remembered as a
  // company-relative path, and switching companies then landed on
  // "/WAN/WAN/onboarding" (a 404).
  "onboarding",
  // AgentDash (Scan 4, lane M): board routes that were missing, so a navigate
  // to "/settings" or "/plugins/x" from a board page was read as a company
  // code instead of being prefixed.
  "settings",
  "plugins",
]);

// AgentDash (Scan 4, lane M): every top-level route in App.tsx that is not a
// board route must be listed here. A root missing from both sets is read as a
// company prefix, so the company-aware navigate() on /setup turned "/cos" into
// "/SETUP/cos" ("Company not found"). company-routes.test.ts parses App.tsx
// and fails when a top-level route is in neither set.
const GLOBAL_ROUTE_ROOTS = new Set([
  "auth",
  "forgot-password",
  "reset-password",
  "invite",
  "board-claim",
  "cli-auth",
  "docs",
  "instance",
  "claim",
  "trial",
  "investors",
  "pricing",
  "mcp",
  "terms",
  "privacy",
  "share",
  "tests",
  "demo",
  "consulting",
  "about",
  // AgentDash: release posts are global marketing pages, never company prefixes.
  "whats-new",
  "start",
  "find",
  "assess",
  "company-create",
  "setup",
  "oauth",
  "member-onboarding",
]);

/**
 * Both root sets, for the test that keeps them inside the shared
 * RESERVED_COMPANY_PREFIXES (a company may never take one as its prefix).
 */
export function listRouteRoots(): { global: string[]; board: string[] } {
  return { global: [...GLOBAL_ROUTE_ROOTS], board: [...BOARD_ROUTE_ROOTS] };
}

/** True when a first path segment is a top-level, company-agnostic route. */
export function isGlobalRouteRoot(root: string): boolean {
  return GLOBAL_ROUTE_ROOTS.has(root.toLowerCase());
}

export function normalizeCompanyPrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

function splitPath(path: string): { pathname: string; search: string; hash: string } {
  const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] ?? path,
    search: match?.[2] ?? "",
    hash: match?.[3] ?? "",
  };
}

function getRootSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment ?? null;
}

export function isGlobalPath(pathname: string): boolean {
  if (pathname === "/") return true;
  const root = getRootSegment(pathname);
  if (!root) return true;
  return GLOBAL_ROUTE_ROOTS.has(root.toLowerCase());
}

export function isBoardPathWithoutPrefix(pathname: string): boolean {
  const root = getRootSegment(pathname);
  if (!root) return false;
  return BOARD_ROUTE_ROOTS.has(root.toLowerCase());
}

export function extractCompanyPrefixFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const first = segments[0]!.toLowerCase();
  if (GLOBAL_ROUTE_ROOTS.has(first) || BOARD_ROUTE_ROOTS.has(first)) {
    return null;
  }
  return normalizeCompanyPrefix(segments[0]!);
}

export function applyCompanyPrefix(path: string, companyPrefix: string | null | undefined): string {
  const { pathname, search, hash } = splitPath(path);
  if (!pathname.startsWith("/")) return path;
  if (isGlobalPath(pathname)) return path;
  if (!companyPrefix) return path;

  const prefix = normalizeCompanyPrefix(companyPrefix);
  const activePrefix = extractCompanyPrefixFromPath(pathname);
  if (activePrefix) return path;

  return `/${prefix}${pathname}${search}${hash}`;
}

export function toCompanyRelativePath(path: string): string {
  const { pathname, search, hash } = splitPath(path);
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length >= 2) {
    const second = segments[1]!.toLowerCase();
    if (!GLOBAL_ROUTE_ROOTS.has(segments[0]!.toLowerCase()) && BOARD_ROUTE_ROOTS.has(second)) {
      return `/${segments.slice(1).join("/")}${search}${hash}`;
    }
  }

  return `${pathname}${search}${hash}`;
}
