// AgentDash: public pages render without the product's connection overlay.
export const HOW_IT_WORKS_PATH = "/how-it-works";
const MARKETING_PATHS = new Set(["/", "/demo", HOW_IT_WORKS_PATH, "/about", "/consulting", "/mcp", "/start", "/start/verify", "/start/progress", "/find"]);
export function isMarketingPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return MARKETING_PATHS.has(path) || path === "/docs" || path.startsWith("/docs/") || path === "/whats-new" || path.startsWith("/whats-new/");
}
