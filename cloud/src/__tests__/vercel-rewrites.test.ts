// SC-9 (GH #770): www's rewrites send the front door and the self-hosted
// invite validator to the control plane, and nothing to the old instance.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vercel = JSON.parse(readFileSync(fileURLToPath(new URL("../../../vercel.json", import.meta.url)), "utf8")) as {
  rewrites: Array<{ source: string; destination: string }>;
  redirects: Array<{ source: string; destination: string; permanent: boolean; has?: Array<{ type: string; key: string; value?: string }> }>;
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
function redirectFor(pathWithQuery: string): string | null {
  const [path, query = ""] = pathWithQuery.split("?") as [string, string?];
  const params = new URLSearchParams(query);
  const r = vercel.redirects.find(
    (x) => sourceRegex(x.source).test(path) && (x.has ?? []).every((h) => h.type === "query" && (h.value === undefined ? params.has(h.key) : params.get(h.key) === h.value)),
  );
  return r ? r.destination : null;
}
const CONTROL = "https://cloud-control-production.up.railway.app";

describe("vercel.json rewrites", () => {
  it("route /api/cloud and /api/invites/validate to the control plane, in that order before the catch-all", () => {
    const sources = vercel.rewrites.map((r) => r.source);
    expect(sources.slice(0, 2)).toEqual(["/api/cloud/:path*", "/api/invites/validate"]);
    expect(sources.indexOf("/api/:path*")).toBeGreaterThan(sources.indexOf("/api/invites/validate"));
    expect(vercel.rewrites[0]!.destination).toBe(`${CONTROL}/api/cloud/:path*`);
    expect(vercel.rewrites[1]!.destination).toBe(`${CONTROL}/api/invites/validate`);
  });

  it("send every other /api path to the control plane's 410", () => {
    expect(vercel.rewrites.find((r) => r.source === "/api/:path*")!.destination).toBe(`${CONTROL}/api/gone`);
  });

  it("keep exactly the /assess API paths on the old instance until assess is re-homed, ahead of the 410 (GH #837 re-review)", () => {
    const OLD = "https://web-production-33a3b6.up.railway.app";
    const toOld = vercel.rewrites.filter((r) => r.destination.startsWith(OLD));
    expect(toOld.map((r) => r.source)).toEqual([
      "/api/health",
      "/api/auth/get-session",
      "/api/onboarding/finalize-assessment",
      "/api/onboarding/complete-initial-assessment",
      "/api/companies/:companyId/assess",
      "/api/companies/:companyId/assess/:path*",
    ]);
    for (const r of toOld) expect(r.destination).toBe(`${OLD}${r.source}`);
    const catchAll = vercel.rewrites.findIndex((r) => r.source === "/api/:path*");
    for (const r of toOld) expect(vercel.rewrites.indexOf(r)).toBeLessThan(catchAll);
    // Which rewrite a path takes: the first whose source matches.
    const target = (path: string) => vercel.rewrites.find((r) => sourceRegex(r.source).test(path))!.destination;
    expect(target("/api/companies/abc/assess")).toBe(`${OLD}/api/companies/:companyId/assess`);
    expect(target("/api/companies/abc/assess/project/run")).toBe(`${OLD}/api/companies/:companyId/assess/:path*`);
    expect(target("/api/companies/abc/issues")).toBe(`${CONTROL}/api/gone`);
    expect(target("/api/auth/sign-in/email")).toBe(`${CONTROL}/api/gone`);
    expect(target("/api/onboarding/mcp-signup")).toBe(`${CONTROL}/api/gone`);
  });

  it("keep the SPA fallback for everything outside /api", () => {
    expect(vercel.rewrites.at(-1)).toEqual({ source: "/:path((?!api/|api$).*)", destination: "/index.html" });
  });
});

describe("vercel.json redirects for the old app (GH #837 review)", () => {
  it("keeps the marketing site, the new signup pages and static files", () => {
    for (const path of ["/", "/demo", "/consulting", "/about", "/mcp", "/start", "/start/verify", "/start/progress", "/find", "/terms", "/privacy", "/pricing", "/investors", "/assess/history",
      "/assets/index-abc123.js", "/brands/logo.svg", "/favicon.ico", "/sw.js", "/site.webmanifest", "/apple-touch-icon.png", "/api/cloud/config", "/api/invites/validate"]) {
      expect(redirectFor(path), path).toBeNull();
    }
  });

  it("sends /assess to /start until assess is re-homed (GH #838)", () => {
    expect(redirectFor("/assess")).toBe("/start");
  });

  it("sends the old app's sign-in routes to /find and its sign-up routes to /start", () => {
    const cases: Record<string, string> = {
      "/auth": "/find", "/auth/callback": "/find", "/login": "/find", "/signin": "/find", "/sign-in": "/find",
      "/forgot-password": "/find", "/reset-password": "/find", "/invite/tok123": "/find", "/board-claim/tok": "/find",
      "/cli-auth/abc": "/find", "/claim": "/find", "/companies": "/find",
      "/auth?mode=sign_up": "/start", "/auth?mode=sign_in": "/find",
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
