// AgentDash: public pages render without the product's connection overlay.
const MARKETING_PATHS = new Set(["/", "/demo", "/agent-performance", "/about", "/consulting", "/mcp", "/start", "/start/verify", "/start/progress", "/find"]);
export function isMarketingPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return MARKETING_PATHS.has(path) || path === "/docs" || path.startsWith("/docs/") || path === "/whats-new" || path.startsWith("/whats-new/") || path === "/releases" || path.startsWith("/releases/");
}
