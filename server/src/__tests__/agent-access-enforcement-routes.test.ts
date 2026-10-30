import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authUsers, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { addCompany, addUser, addAgent, agentRequestActor, boardActor, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { activityRows } from "./helpers/agent-access-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { agentAccessEnforcementRoutes } from "../routes/agent-access-enforcement.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: APM gate 2 (P2.3) — the company enforcement-mode routes. Members
 * and the company's agents read the mode; only owners/admins change it, only
 * to `off` or `shadow`; `enforce` is refused until gate 3.
 */
describeEmbeddedPostgres("agent access enforcement routes (APM gate 2, P2.3)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-access-enforcement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function send(actor: Record<string, unknown>, method: "get" | "patch", path: string, body?: unknown) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", agentAccessEnforcementRoutes(db));
    app.use(errorHandler);
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const call = request(`http://127.0.0.1:${address.port}`)[method](path);
      return await (body === undefined ? call : call.send(body as object));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }

  async function seed() {
    const company = await addCompany(db, "Enforcement", "default");
    const ownerUserId = await addUser(db, company.id, "owner");
    const memberUserId = await addUser(db, company.id, "member");
    const agent = await addAgent(db, company.id, { name: "Worker" });
    return {
      company,
      owner: boardActor(company.id, ownerUserId, "owner"),
      member: boardActor(company.id, memberUserId, "member"),
      agent: agentRequestActor(agent),
      path: `/api/companies/${company.id}/agent-access-enforcement`,
    };
  }

  async function modeOf(companyId: string) {
    return db
      .select({ mode: companies.agentAccessEnforcement })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.mode);
  }

  it("GET reads the mode for a plain member and for the company's agent", async () => {
    const s = await seed();
    const asMember = await send(s.member, "get", s.path);
    expect(asMember.status, JSON.stringify(asMember.body)).toBe(200);
    // APM gate 3 (P3.4): enforce is selectable.
    expect(asMember.body).toEqual({ companyId: s.company.id, mode: "off", selectableModes: ["off", "shadow", "enforce"] });
    const asAgent = await send(s.agent, "get", s.path);
    expect(asAgent.status, JSON.stringify(asAgent.body)).toBe(200);
    expect(asAgent.body.mode).toBe("off");
  });

  it("GET and PATCH refuse a principal of another company", async () => {
    const s = await seed();
    const other = await addCompany(db, "Other", "default");
    const outsiderUserId = await addUser(db, other.id, "owner");
    const outsider = boardActor(other.id, outsiderUserId, "owner");
    const read = await send(outsider, "get", s.path);
    expect(read.status).toBe(403);
    const otherAgent = agentRequestActor(await addAgent(db, other.id, { name: "Elsewhere" }));
    expect((await send(otherAgent, "get", s.path)).status).toBe(403);
    const write = await send(outsider, "patch", s.path, { mode: "shadow" });
    expect(write.status).toBe(403);
    expect(await modeOf(s.company.id)).toBe("off");
  });

  it("PATCH shadow by an owner sets the mode and records one activity row", async () => {
    const s = await seed();
    const res = await send(s.owner, "patch", s.path, { mode: "shadow" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ companyId: s.company.id, mode: "shadow", changed: true, previousMode: "off" });
    expect(await modeOf(s.company.id)).toBe("shadow");
    const rows = await activityRows(db, s.company.id, "company.agent_access_enforcement_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toEqual({ from: "off", to: "shadow" });
    expect(rows[0]!.entityType).toBe("company");
    expect(rows[0]!.entityId).toBe(s.company.id);

    // And back to off.
    const back = await send(s.owner, "patch", s.path, { mode: "off" });
    expect(back.status).toBe(200);
    expect(await modeOf(s.company.id)).toBe("off");
    expect(await activityRows(db, s.company.id, "company.agent_access_enforcement_changed")).toHaveLength(2);
  });

  it("PATCH by a plain member or an agent is 403 and leaves the mode alone", async () => {
    const s = await seed();
    const asMember = await send(s.member, "patch", s.path, { mode: "shadow" });
    expect(asMember.status).toBe(403);
    const asAgent = await send(s.agent, "patch", s.path, { mode: "shadow" });
    expect(asAgent.status).toBe(403);
    expect(await modeOf(s.company.id)).toBe("off");
    expect(await activityRows(db, s.company.id, "company.agent_access_enforcement_changed")).toHaveLength(0);
  });

  // APM gate 3 (P3.4): enforce is selectable by an admin, with activity; still admin-only.
  it("PATCH enforce by an owner sets the mode and records the change; members and agents are still 403", async () => {
    const s = await seed();
    await send(s.owner, "patch", s.path, { mode: "shadow" });
    expect((await send(s.member, "patch", s.path, { mode: "enforce" })).status).toBe(403);
    expect((await send(s.agent, "patch", s.path, { mode: "enforce" })).status).toBe(403);
    expect(await modeOf(s.company.id)).toBe("shadow");
    const res = await send(s.owner, "patch", s.path, { mode: "enforce" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ mode: "enforce", changed: true, previousMode: "shadow", selectableModes: ["off", "shadow", "enforce"] });
    expect(await modeOf(s.company.id)).toBe("enforce");
    const rows = await activityRows(db, s.company.id, "company.agent_access_enforcement_changed");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.details).toEqual({ from: "shadow", to: "enforce" });
  });

  it("PATCH with the current mode is a no-op: 200, changed false, no activity", async () => {
    const s = await seed();
    const res = await send(s.owner, "patch", s.path, { mode: "off" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "off", changed: false, previousMode: "off" });
    expect(await activityRows(db, s.company.id, "company.agent_access_enforcement_changed")).toHaveLength(0);
  });

  it("PATCH with an invalid body is 400", async () => {
    const s = await seed();
    expect((await send(s.owner, "patch", s.path, { mode: "loud" })).status).toBe(400);
    expect((await send(s.owner, "patch", s.path, {})).status).toBe(400);
    expect((await send(s.owner, "patch", s.path, { mode: "shadow", extra: true })).status).toBe(400);
    expect(await modeOf(s.company.id)).toBe("off");
  });
});
