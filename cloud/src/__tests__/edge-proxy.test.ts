// SC-4 (GH #765): the edge router's proxying, against local upstream servers.
// Header stripping and injection, streaming, WebSocket-style upgrades, the
// router's pages, resume requests and activity.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActivityBuffer, createEdgeServer, slugOf, upstreamHeaders } from "../edge/proxy.js";
import type { EdgeRoute, RouteLookup } from "../edge/routes.js";
import { createLogger } from "../logger.js";
import { Secret } from "../secret.js";

const SECRET = "edge-secret-fake-0123456789abcdef0123456789abcdef";
const lines: string[] = [];
const log = createLogger({ write: (l) => lines.push(l), level: "debug" });

let upstream: http.Server;
let upstreamHost = "";
let edge: http.Server;
let edgePort = 0;
const seenUpgrades: Array<Record<string, unknown>> = [];
const activity: string[] = [];
const resumes: string[] = [];
const routes = new Map<string, EdgeRoute>();
// Upgraded sockets are not tracked by closeAllConnections; track every socket so teardown can end them.
const sockets = new Set<import("node:net").Socket>();
function track(server: http.Server) {
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
}

const lookup: RouteLookup = { lookup: async (slug) => routes.get(slug) ?? null };

function route(slug: string, state: string, host: string | null = upstreamHost): void {
  routes.set(slug, { slug, state, upstreamHost: host, edgeSecret: new Secret(SECRET) });
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first\n");
      setTimeout(() => res.end("second\n"), 400);
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json", "x-upstream": "yes", connection: "keep-alive" });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  upstream.on("upgrade", (req, socket) => {
    seenUpgrades.push({ ...req.headers, url: req.url });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(`echo:${d.toString()}`));
  });
  track(upstream);
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamHost = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  edge = createEdgeServer({
    routes: lookup,
    edgeDomain: "agentdash.cloud",
    log,
    clientIpSource: "x-real-ip",
    upstreamProtocol: "http",
    recordActivity: (s) => activity.push(s),
    requestResume: async (s) => void resumes.push(s),
    status: () => ({ routes: routes.size }),
  });
  track(edge);
  await new Promise<void>((r) => edge.listen(0, "127.0.0.1", () => r()));
  edgePort = (edge.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  edge.closeAllConnections();
  upstream.closeAllConnections();
  await new Promise<void>((r) => edge.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

function get(host: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: edgePort, path, method: opts.method ?? "GET", headers: { host, ...(opts.headers ?? {}) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("host parsing and header rewriting", () => {
  it("takes exactly one label under the edge domain", () => {
    expect(slugOf("acme.agentdash.cloud", "agentdash.cloud")).toBe("acme");
    expect(slugOf("ACME.agentdash.cloud:443", "agentdash.cloud")).toBe("acme");
    expect(slugOf("a.b.agentdash.cloud", "agentdash.cloud")).toBeNull();
    expect(slugOf("agentdash.cloud", "agentdash.cloud")).toBeNull();
    expect(slugOf("acme.agentdash.cloud.evil.com", "agentdash.cloud")).toBeNull();
    expect(slugOf("edge-production.up.railway.app", "agentdash.cloud")).toBeNull();
  });

  it("drops every client X-AgentDash-* header and hop-by-hop headers, then sets its own", () => {
    const h = upstreamHeaders(
      { host: "acme.agentdash.cloud", "x-agentdash-edge": "forged", "x-agentdash-client-ip": "6.6.6.6", "x-agentdash-anything": "x", connection: "keep-alive, x-private", "x-private": "1", "keep-alive": "5", cookie: "a=1" },
      { upstreamHost: "web-acme.up.railway.app", publicHost: "acme.agentdash.cloud", edgeSecret: SECRET, clientIp: "203.0.113.5" },
    );
    expect(h).toMatchObject({ host: "web-acme.up.railway.app", "x-agentdash-edge": SECRET, "x-agentdash-client-ip": "203.0.113.5", "x-forwarded-host": "acme.agentdash.cloud", "x-agentdash-forwarded-host": "acme.agentdash.cloud", cookie: "a=1" });
    expect(h).not.toHaveProperty("x-agentdash-anything");
    expect(h).not.toHaveProperty("connection");
    expect(h).not.toHaveProperty("x-private");
    expect(h).not.toHaveProperty("keep-alive");
  });
});

describe("proxying", () => {
  it("forwards to the box with the edge secret and the client IP, stripping forged copies", async () => {
    route("acme", "active");
    const res = await get("acme.agentdash.cloud", "/api/companies?x=1", {
      method: "POST",
      body: "hello",
      headers: { "x-real-ip": "203.0.113.5", "x-agentdash-edge": "forged", "x-agentdash-client-ip": "6.6.6.6", "content-type": "text/plain" },
    });
    expect(res.status).toBe(201);
    expect(res.headers["x-upstream"]).toBe("yes");
    const echo = JSON.parse(res.body) as { method: string; url: string; body: string; headers: Record<string, string> };
    expect(echo).toMatchObject({ method: "POST", url: "/api/companies?x=1", body: "hello" });
    expect(echo.headers.host).toBe(upstreamHost);
    expect(echo.headers["x-agentdash-edge"]).toBe(SECRET);
    expect(echo.headers["x-agentdash-client-ip"]).toBe("203.0.113.5");
    expect(echo.headers["x-agentdash-forwarded-host"]).toBe("acme.agentdash.cloud");
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("streams a response unbuffered", async () => {
    route("streamy", "active");
    const started = Date.now();
    const firstChunkAt = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: edgePort, path: "/stream", headers: { host: "streamy.agentdash.cloud" } }, (res) => {
        res.once("data", () => resolve(Date.now() - started));
        res.resume();
      });
      req.on("error", reject);
      req.end();
    });
    expect(firstChunkAt).toBeLessThan(300); // the second chunk comes 400 ms later
  });

  it("pipes a WebSocket upgrade through, with the router's headers", async () => {
    route("wsbox", "active");
    const reply = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: edgePort,
        path: "/api/companies/c1/events/ws",
        headers: { host: "wsbox.agentdash.cloud", connection: "Upgrade", upgrade: "websocket", "x-agentdash-edge": "forged", "x-real-ip": "203.0.113.7" },
      });
      req.on("upgrade", (_res, socket) => {
        socket.once("data", (d) => {
          resolve(d.toString());
          socket.destroy();
        });
        socket.write("ping");
      });
      req.on("error", reject);
      req.end();
    });
    expect(reply).toBe("echo:ping");
    const seen = seenUpgrades.at(-1)!;
    expect(seen).toMatchObject({ "x-agentdash-edge": SECRET, "x-agentdash-client-ip": "203.0.113.7", upgrade: "websocket", url: "/api/companies/c1/events/ws" });
  });

  it("refuses an upgrade for an unknown box", async () => {
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: edgePort, path: "/", headers: { host: "nobody.agentdash.cloud", connection: "Upgrade", upgrade: "websocket" } });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("upgrade", () => resolve(101));
      req.on("error", () => resolve(0));
      req.end();
    });
    expect(status).toBe(404);
  });

  it("answers 502 with a page when the box does not answer", async () => {
    route("downbox", "active", "127.0.0.1:1");
    const res = await get("downbox.agentdash.cloud", "/");
    expect(res.status).toBe(502);
    expect(res.body).toContain("not answering");
  });
});

describe("pages", () => {
  it("unknown, reserved and malformed names get the branded 404 with a /find link", async () => {
    for (const host of ["nobody.agentdash.cloud", "admin.agentdash.cloud", "a.b.agentdash.cloud", "agentdash.cloud"]) {
      const res = await get(host, "/");
      expect(res.status, host).toBe(404);
      expect(res.body).toContain("https://www.agentdash.cloud/find");
    }
  });

  it("a suspended box gets the waking page and one resume request per window", async () => {
    route("sleepy", "suspended");
    const a = await get("sleepy.agentdash.cloud", "/");
    const b = await get("sleepy.agentdash.cloud", "/issues");
    expect(a.status).toBe(503);
    expect(a.headers["retry-after"]).toBe("10");
    expect(a.body).toContain("Waking your workspace");
    expect(b.status).toBe(503);
    expect(resumes.filter((s) => s === "sleepy")).toHaveLength(1);
  });

  it("a deleted box says so; a box still being set up says that", async () => {
    route("gone", "deleted");
    route("young", "provisioning");
    expect((await get("gone.agentdash.cloud", "/")).status).toBe(410);
    expect((await get("gone.agentdash.cloud", "/")).body).toContain("was deleted");
    const young = await get("young.agentdash.cloud", "/");
    expect(young.status).toBe(503);
    expect(young.body).toContain("not ready yet");
  });

  it("serves its own health on its Railway domain", async () => {
    const res = await get("edge-production.up.railway.app", "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok", service: "edge" });
  });
});

describe("activity", () => {
  it("counts human requests, not health polls or the assistant endpoint", async () => {
    route("busy", "active");
    activity.length = 0;
    await get("busy.agentdash.cloud", "/api/health");
    await get("busy.agentdash.cloud", "/api/mcp/assistant", { method: "POST", body: "{}" });
    expect(activity).toEqual([]);
    await get("busy.agentdash.cloud", "/issues");
    expect(activity).toEqual(["busy"]);
  });

  it("batches into one write and keeps the batch when the write fails", async () => {
    const writes: string[][] = [];
    let fail = true;
    const buf = new ActivityBuffer(async (slugs) => {
      if (fail) throw new Error("db down");
      writes.push(slugs);
    });
    buf.add("a");
    buf.add("b");
    buf.add("a");
    await expect(buf.flush()).rejects.toThrow("db down");
    fail = false;
    expect(await buf.flush()).toBe(2);
    expect(writes).toEqual([["a", "b"]]);
    expect(await buf.flush()).toBe(0);
  });
});
