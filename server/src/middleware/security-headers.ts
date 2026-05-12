import type { RequestHandler } from "express";

// AgentDash (AGE-5, #172): Add Content-Security-Policy and X-Content-Type-Options
// headers to all API responses that don't already have them.
// - default-src 'self': restrictive CSP for API responses
// - X-Content-Type-Options: nosniff: prevents MIME-type sniffing

const DEFAULT_CSP = "default-src 'self'";
const DEFAULT_XCTO = "nosniff";

/**
 * Global security headers middleware for API routes.
 * Sets CSP and X-Content-Type-Options on all /api responses that don't already have them.
 * Route-specific CSP headers (e.g., for file downloads) take precedence.
 */
export function securityHeaders(): RequestHandler {
  return (req, res, next) => {
    // Only apply to /api routes
    if (req.path.startsWith("/api")) {
      res.setHeader("X-Content-Type-Options", DEFAULT_XCTO);
      // Only set CSP if not already set (allows route-specific overrides)
      if (!res.get("Content-Security-Policy")) {
        res.setHeader("Content-Security-Policy", DEFAULT_CSP);
      }
    }
    next();
  };
}
