import type { Express, RequestHandler } from "express";
import { configuredPublicBaseUrl } from "../lib/public-base-url.js";

const HSTS_MAX_AGE = 15_552_000; // 180 days

/**
 * AgentDash (UltraQA QAD-6): standard security headers on every response.
 *
 * - X-Content-Type-Options nosniff: stops MIME sniffing of API JSON, plugin
 *   uploads, and static assets.
 * - Referrer-Policy strict-origin-when-cross-origin: full URL stays on
 *   same-origin navigations; cross-origin requests get the origin only.
 * - X-Frame-Options SAMEORIGIN: blocks clickjacking by foreign pages while
 *   keeping the same-origin embedding we rely on (plugin launchers iframe
 *   `/_plugins/...` documents served by this server). The OAuth consent
 *   surface escalates itself to DENY + frame-ancestors 'none' in app.ts,
 *   which stays the stricter value on that route.
 * - Strict-Transport-Security only when the request itself arrived over
 *   HTTPS (req.secure honours X-Forwarded-Proto via `trust proxy` on
 *   internet-facing deployments) or the configured public base URL is
 *   https — a loopback or Tailscale-HTTP box must not tell browsers to
 *   upgrade a transport it never serves.
 *
 * CSP is deliberately not set here: the UI shell inlines a theme bootstrap
 * <script>, pulls Google Fonts (styles + font files from two external
 * origins), uses same-origin WebSockets, and in dev runs behind Vite's
 * injected transforms. A strict CSP needs per-mode work and is tracked as
 * follow-up rather than shipped half-broken.
 */
export function securityHeaders(): RequestHandler {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    const publicBaseUrl = configuredPublicBaseUrl();
    if (req.secure || publicBaseUrl?.toLowerCase().startsWith("https://")) {
      res.setHeader("Strict-Transport-Security", `max-age=${HSTS_MAX_AGE}; includeSubDomains`);
    }
    next();
  };
}

/**
 * Installs the headers middleware and stops Express advertising itself.
 * Called once in createApp, before any route or gate can respond.
 */
export function applySecurityHeaders(app: Express): void {
  app.disable("x-powered-by");
  app.use(securityHeaders());
}
