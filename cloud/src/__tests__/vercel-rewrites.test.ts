// SC-9 (GH #770): www's rewrites send the front door and the self-hosted
// invite validator to the control plane, and nothing to the old instance.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vercel = JSON.parse(readFileSync(fileURLToPath(new URL("../../../vercel.json", import.meta.url)), "utf8")) as {
  rewrites: Array<{ source: string; destination: string }>;
  redirects: Array<{ source: string; destination: string; permanent: boolean }>;
};

/** Vercel's source syntax (path-to-regexp) for the forms vercel.json uses: literals, `:p*`, `:p(regex)`. */
function sourceRegex(source: string): RegExp {
  let out = "";
  for (let i = 0; i < source.length; ) {
    if (source.startsWith("/:", i)) {
      const m = /^\/:(\w+)(\*|\((.*)\))?/.exec(source.slice(i))!;
      if (m[2] === "*") out += "(?:/.*)?";
      else if (m[3] !== undefined) out += `/(${m[3]})`;
      else out += "/([^/]+)";
      i += m[0].length;
    } else {
      out += source[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Where www sends a path: the first matching redirect, or null (served). */
function redirectFor(path: string): string | null {
  const r = vercel.redirects.find((x) => sourceRegex(x.source).test(path));
  return r ? r.destination : null;
}
const CONTROL = "https://cloud-control-production.up.railway.app";

describe("vercel.json rewrites", () => {
  it("route /api/cloud and /api/invites/validate to the control plane, in that order before the catch-all", () => {
    const sources = vercel.rewrites.map((r) => r.source);
    expect(sources.slice(0, 3)).toEqual(["/api/cloud/:path*", "/api/invites/validate", "/api/:path*"]);
    expect(vercel.rewrites[0]!.destination).toBe(`${CONTROL}/api/cloud/:path*`);
    expect(vercel.rewrites[1]!.destination).toBe(`${CONTROL}/api/invites/validate`);
  });

  it("send every other /api path to the control plane's 410, never to the old instance", () => {
    expect(vercel.rewrites[2]!.destination).toBe(`${CONTROL}/api/gone`);
    expect(JSON.stringify(vercel)).not.toContain("web-production-33a3b6");
  });

  it("keep the SPA fallback for everything outside /api", () => {
    expect(vercel.rewrites.at(-1)).toEqual({ source: "/:path((?!api/|api$).*)", destination: "/index.html" });
  });
});

describe("vercel.json redirects for the old app (GH #837 review)", () => {
  it("keeps the marketing site, the new signup pages and static files", () => {
    for (const path of ["/", "/demo", "/consulting", "/about", "/mcp", "/start", "/start/verify", "/start/progress", "/find", "/terms", "/privacy", "/pricing", "/investors", "/assess", "/assess/history",
      "/assets/index-abc123.js", "/brands/logo.svg", "/favicon.ico", "/sw.js", "/site.webmanifest", "/apple-touch-icon.png", "/api/cloud/config", "/api/invites/validate"]) {
      expect(redirectFor(path), path).toBeNull();
    }
  });

  it("sends the old app's sign-in routes to /find and its sign-up routes to /start", () => {
    const cases: Record<string, string> = {
      "/auth": "/find", "/auth/callback": "/find", "/login": "/find", "/signin": "/find", "/sign-in": "/find",
      "/forgot-password": "/find", "/reset-password": "/find", "/invite/tok123": "/find", "/board-claim/tok": "/find",
      "/cli-auth/abc": "/find", "/claim": "/find", "/companies": "/find",
      "/signup": "/start", "/sign-up": "/start", "/company-create": "/start", "/onboarding": "/start", "/trial": "/start",
      "/share/tok": "/",
      // The app catch-all: company-prefixed board routes and anything else.
      "/ACME/dashboard": "/find", "/ACME/issues/ACME-1": "/find", "/cos": "/find", "/settings": "/find", "/startup": "/find",
    };
    for (const [path, dest] of Object.entries(cases)) expect(redirectFor(path), path).toBe(dest);
  });

  it("every redirect is temporary", () => {
    expect(vercel.redirects.every((r) => r.permanent === false)).toBe(true);
  });
});
