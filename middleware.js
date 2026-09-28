// AgentDash (GH #836 security review): Vercel Routing Middleware for www.
// Plain JavaScript (the repo root has no buildable tsconfig of its own).
//
// The control plane rate-limits the public front door and the self-hosted
// invite validator by visitor address. Behind Vercel's rewrite it only sees
// Vercel's address, and a header any caller can set cannot be believed. A
// static vercel.json rewrite cannot add a request header from an environment
// variable, so this middleware does, for the two proxied paths only:
//
//   X-AgentDash-Edge-Proxy  the shared secret CLOUD_VERCEL_PROXY_SECRET
//   X-AgentDash-Client-IP   the visitor's address, as Vercel's edge saw it
//
// Client-supplied copies of both are always removed first. Without the secret
// configured nothing is added, and the control plane falls back to the
// address it sees (fail safe). The rewrite to the control plane itself stays
// in vercel.json; this only changes the request headers it carries.
import { ipAddress, next } from "@vercel/edge";

export const PROXY_SECRET_HEADER = "x-agentdash-edge-proxy";
export const PROXY_CLIENT_IP_HEADER = "x-agentdash-client-ip";

export const config = {
  matcher: ["/api/cloud/:path*", "/api/invites/validate"],
};

/**
 * @param {Request} request
 * @param {string | undefined} secret
 * @returns {Headers}
 */
export function proxiedHeaders(request, secret) {
  const headers = new Headers(request.headers);
  headers.delete(PROXY_SECRET_HEADER);
  headers.delete(PROXY_CLIENT_IP_HEADER);
  const value = secret?.trim();
  if (value) {
    headers.set(PROXY_SECRET_HEADER, value);
    const ip = ipAddress(request);
    if (ip) headers.set(PROXY_CLIENT_IP_HEADER, ip);
  }
  return headers;
}

/**
 * @param {Request} request
 * @returns {Response}
 */
export default function middleware(request) {
  return next({ request: { headers: proxiedHeaders(request, process.env.CLOUD_VERCEL_PROXY_SECRET) } });
}
