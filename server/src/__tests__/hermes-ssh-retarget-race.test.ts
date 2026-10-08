import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, environments, createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { agentService } from "../services/agents.js";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/index.js";

vi.mock("../services/access.js", () => ({ accessService: () => ({ canUser: async (_c: string, _u: string, permission: string) => permission === "environments:manage" }) }));
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { resolve, promise }; }

suite("Hermes SSH retarget serialization", () => {
  let db: ReturnType<typeof createDb>;
  let stop: () => Promise<void>;
  beforeAll(async () => { const started = await startEmbeddedPostgresTestDatabase("hermes-ssh-retarget-race"); db = createDb(started.connectionString); stop = started.stop; });
  afterAll(async () => { await stop?.(); });
  async function fixture() {
    const companyId = randomUUID(), environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic SSH", issuePrefix: companyId.slice(0, 8) });
    await db.insert(environments).values({ id: environmentId, companyId, name: "Synthetic", driver: "ssh", config: { username: "alice", host: "host.test", remoteWorkspacePath: "/work" } });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "synthetic-manager", source: "session", companyIds: [companyId] }; next(); });
    app.use("/api", environmentRoutes(db)); app.use(errorHandler);
    return { companyId, environmentId, app };
  }
  it("waits for an in-flight pin and refuses retargeting after that pin commits", async () => {
    const { companyId, environmentId, app } = await fixture();
    const ready = deferred(), release = deferred();
    const pin = db.transaction(async (tx) => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("no key update");
      await tx.insert(agents).values({ companyId, name: "Pinned Hermes", adapterType: "hermes_local", defaultEnvironmentId: environmentId });
      ready.resolve(); await release.promise;
    });
    await ready.promise;
    let finished = false;
    const retarget = request(app).patch(`/api/environments/${environmentId}`).send({ config: { username: "bob" } }).then((res) => { finished = true; return res; });
    try { await delay(100); expect(finished).toBe(false); }
    finally { release.resolve(); await pin; }
    const result = await retarget;
    expect(result.status).toBe(403);
    const [row] = await db.select().from(environments).where(eq(environments.id, environmentId));
    expect(row.config.username).toBe("alice");
  });
  it.each(["create", "update"])("serializes the agent service %s pin funnel with retargets", async (operation) => {
    const { companyId, environmentId } = await fixture();
    const id = randomUUID();
    if (operation === "update") await db.insert(agents).values({ id, companyId, name: "Existing", adapterType: "hermes_local" });
    const ready = deferred(), release = deferred();
    const retarget = db.transaction(async tx => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("no key update");
      ready.resolve(); await release.promise;
    });
    await ready.promise;
    let finished = false;
    const service = agentService(db);
    const pin = (operation === "create"
      ? service.create(companyId, { name: "New pin", adapterType: "hermes_local", defaultEnvironmentId: environmentId })
      : service.update(id, { defaultEnvironmentId: environmentId })).then(row => { finished = true; return row; });
    try { await delay(100); expect(finished).toBe(false); }
    finally { release.resolve(); await retarget; }
    expect((await pin)?.defaultEnvironmentId).toBe(environmentId);
  });

  it("keeps a root-bound pin inside the caller's supplied transaction", async () => {
    const { companyId, environmentId } = await fixture();
    await expect(db.transaction(async tx => {
      await agentService(db).create(companyId, { name: "Rolled back pin", adapterType: "hermes_local", defaultEnvironmentId: environmentId }, { executor: tx as unknown as typeof db, publications: [] });
      throw new Error("synthetic outer rollback");
    })).rejects.toThrow("synthetic outer rollback");
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toEqual([]);
  });

  it("merges a partial config only after the previous target update commits", async () => {
    const { companyId, environmentId, app } = await fixture();
    await db.insert(agents).values({ companyId, name: "Pinned Hermes", adapterType: "hermes_local", defaultEnvironmentId: environmentId });
    const ready = deferred(), release = deferred();
    const ownerUpdate = db.transaction(async (tx) => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("no key update");
      await tx.update(environments).set({ config: { username: "bob", host: "host.test", remoteWorkspacePath: "/work" } }).where(eq(environments.id, environmentId));
      ready.resolve(); await release.promise;
    });
    await ready.promise;
    const update = request(app).patch(`/api/environments/${environmentId}`).send({ config: { remoteWorkspacePath: "/new-work" } }).then((res) => res);
    await delay(100); release.resolve(); await ownerUpdate;
    expect((await update).status).toBe(200);
    const [row] = await db.select().from(environments).where(eq(environments.id, environmentId));
    expect(row.config).toMatchObject({ username: "bob", remoteWorkspacePath: "/new-work" });
  });
});
