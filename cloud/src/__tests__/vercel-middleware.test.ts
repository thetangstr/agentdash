// GH #836 security review: www's routing middleware (repo-root middleware.ts)
// is what lets the control plane trust a visitor address at all. It must add
// the shared secret and Vercel's view of the address, strip client copies of
// both, add nothing without the secret, and touch only the proxied paths.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Mod = {
  default: (req: Request) => Response;
  proxiedHeaders: (req: Request, secret: string | undefined) => Headers;
  config: { matcher: string[] };
};
// A computed path, so the control plane's tsc (rootDir src) does not follow it.
const path = fileURLToPath(new URL("../../../middleware.js", import.meta.url));
const load = async () => (await import(/* @vite-ignore */ path)) as Mod;
const SECRET = "a".repeat(8) + "0123456789abcdef0123456789abcdef";

const req = (headers: Record<string, string>) => new Request("https://www.agentdash.cloud/api/cloud/signup", { method: "POST", headers });

describe("www routing middleware", () => {
  it("adds the secret and the visitor address from Vercel's x-real-ip, replacing client copies", async () => {
    const m = await load();
    const h = m.proxiedHeaders(req({ "x-real-ip": "198.51.100.7", "x-agentdash-edge-proxy": "forged", "x-agentdash-client-ip": "203.0.113.1" }), SECRET);
    expect(h.get("x-agentdash-edge-proxy")).toBe(SECRET);
    expect(h.get("x-agentdash-client-ip")).toBe("198.51.100.7");
  });

  it("adds nothing, and still strips client copies, without the secret", async () => {
    const m = await load();
    for (const secret of [undefined, "", "   "]) {
      const h = m.proxiedHeaders(req({ "x-real-ip": "198.51.100.7", "x-agentdash-edge-proxy": "forged", "x-agentdash-client-ip": "203.0.113.1" }), secret);
      expect(h.get("x-agentdash-edge-proxy")).toBeNull();
      expect(h.get("x-agentdash-client-ip")).toBeNull();
    }
  });

  it("continues the request with the headers overridden (Vercel's middleware protocol), only on the proxied paths", async () => {
    const m = await load();
    process.env.CLOUD_VERCEL_PROXY_SECRET = SECRET;
    try {
      const res = m.default(req({ "x-real-ip": "198.51.100.7" }));
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("x-middleware-request-x-agentdash-edge-proxy")).toBe(SECRET);
      expect(res.headers.get("x-middleware-request-x-agentdash-client-ip")).toBe("198.51.100.7");
      expect(res.headers.get("x-middleware-override-headers")).toContain("x-agentdash-edge-proxy");
    } finally {
      delete process.env.CLOUD_VERCEL_PROXY_SECRET;
    }
    expect(m.config.matcher).toEqual(["/api/cloud/:path*", "/api/invites/validate"]);
  });
});
