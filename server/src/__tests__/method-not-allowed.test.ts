import express, { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { apiFallthrough, collectAllowedMethods } from "../middleware/method-not-allowed.js";

/**
 * AgentDash (AGE-23): a wrong method on a known route is 405 with `Allow`;
 * an unknown path stays 404. The router below mirrors how app.ts mounts the
 * real API: sub-routers mounted bare (`api.use(router)`), one mounted under a
 * prefix (`api.use("/companies", …)`), param routes, and plain middleware.
 */
function buildApi() {
  const api = Router();
  api.use((_req, _res, next) => next());

  const agents = Router();
  agents.get("/agents/:id/keys", (_req, res) => res.json({ keys: [] }));
  agents.post("/agents/:id/keys", (_req, res) => res.status(201).json({ ok: true }));
  agents.delete("/agents/:id/keys/:keyId", (_req, res) => res.json({ ok: true }));
  api.use(agents);

  const health = Router();
  health.get("/health", (_req, res) => res.json({ ok: true }));
  api.use(health);

  const wake = Router();
  wake.post("/agents/:id/wakeup", (_req, res) => res.status(202).json({ ok: true }));
  api.use(wake);

  const companies = Router();
  companies.get("/:id", (_req, res) => res.json({ id: "c" }));
  companies.patch("/:id", (_req, res) => res.json({ id: "c" }));
  api.use("/companies", companies);

  const anything = Router();
  anything.all("/echo", (_req, res) => res.json({ ok: true }));
  api.use(anything);

  return api;
}

function buildApp() {
  const app = express();
  const api = buildApi();
  app.use("/api", api);
  app.use("/api", apiFallthrough(api));
  return app;
}

describe("collectAllowedMethods", () => {
  const api = buildApi();

  it("lists the methods of a bare-mounted route, with HEAD implied by GET", () => {
    expect(collectAllowedMethods(api, "/agents/a1/keys")).toEqual({
      methods: ["GET", "HEAD", "POST"],
      any: false,
    });
  });

  it("follows a prefix mount and matches param routes underneath it", () => {
    expect(collectAllowedMethods(api, "/companies/c1")).toEqual({ methods: ["GET", "HEAD", "PATCH"], any: false });
  });

  it("does not let a prefix match mid-segment", () => {
    expect(collectAllowedMethods(api, "/companiesx/c1")).toEqual({ methods: [], any: false });
  });

  it("reports an unknown path as having no methods", () => {
    expect(collectAllowedMethods(api, "/nope")).toEqual({ methods: [], any: false });
    expect(collectAllowedMethods(api, "/agents")).toEqual({ methods: [], any: false });
  });

  it("reports a route registered with all() as accepting anything", () => {
    expect(collectAllowedMethods(api, "/echo").any).toBe(true);
  });
});

describe("/api fallthrough", () => {
  const app = buildApp();

  it("answers 405 with Allow for a POST to a GET-only route", async () => {
    const res = await request(app).post("/api/health").send({});
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, HEAD");
    expect(res.body).toEqual({ error: "Method not allowed", method: "POST", allow: ["GET", "HEAD"] });
  });

  it("answers 405 with Allow for a GET to a POST-only route", async () => {
    const res = await request(app).get("/api/agents/a1/wakeup");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });

  it("lists every supported method for a route with several", async () => {
    const res = await request(app).put("/api/agents/a1/keys").send({});
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, HEAD, POST");
  });

  it("still answers 404 for an unknown path", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.allow).toBeUndefined();
    expect(res.body).toEqual({ error: "API route not found" });
  });

  it("does not interfere with a request the right method handles", async () => {
    const ok = await request(app).get("/api/agents/a1/keys");
    expect(ok.status).toBe(200);
    const created = await request(app).post("/api/agents/a1/keys").send({});
    expect(created.status).toBe(201);
    const under = await request(app).patch("/api/companies/c1").send({});
    expect(under.status).toBe(200);
  });
});
