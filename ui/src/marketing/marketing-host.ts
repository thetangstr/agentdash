/**
 * AgentDash (scan 2, E4, PR #955 review): whether this page is being served
 * as the marketing site, decided by hostname.
 *
 * The SPA bundle is the same on www and on every install, so something has to
 * tell them apart, and health cannot: Vercel rewrites www's `/api/health` to
 * the legacy Railway install, which answers 200 with an install's health
 * (`deploymentMode: "authenticated"`, `hostedBox: false`). Deciding from health
 * redirected every signed-out visitor at www's root to the sign-in page.
 *
 * The marketing site is www.agentdash.cloud and the apex agentdash.cloud, plus
 * this project's Vercel preview deployments (`*.vercel.app`). Every other host
 * is an install: a hosted box (`<name>.agentdash.cloud`), a self-hosted server,
 * or dev.
 */
const MARKETING_HOSTNAMES = new Set(["www.agentdash.cloud", "agentdash.cloud"]);

export function isMarketingHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return MARKETING_HOSTNAMES.has(host) || host.endsWith(".vercel.app");
}

/** The current page's answer; false outside a browser. */
export function isMarketingHost(): boolean {
  if (typeof window === "undefined") return false;
  return isMarketingHostname(window.location.hostname);
}
