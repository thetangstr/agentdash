// SC-9 (GH #770): www's rewrites send the front door and the self-hosted
// invite validator to the control plane, and nothing to the old instance.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vercel = JSON.parse(readFileSync(fileURLToPath(new URL("../../../vercel.json", import.meta.url)), "utf8")) as {
  rewrites: Array<{ source: string; destination: string }>;
};
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
