import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (AGE-24): every agent API key records what minted it and, when a
 * person or agent did, who — and the keys list reads it back. The steward's
 * question in MKT-38 was "who holds this `default` key?"; the answer is now a
 * column, not a guess.
 */
describeEmbeddedPostgres("agent api key provenance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-key-provenance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const company = await db
      .insert(companies)
      .values({ name: `Keys ${randomUUID()}`, issuePrefix: `KP${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    return db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: {},
        permissions: {},
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("records the source and creator of each key and lists them back", async () => {
    const agent = await seedAgent();
    const svc = agentService(db);
    const creator = randomUUID();

    const auto = await svc.createApiKey(agent.id, "default", {
      source: "agent_creation",
      createdByUserId: creator,
    });
    const byHand = await svc.createApiKey(agent.id, "laptop");
    const viaCode = await svc.createApiKey(agent.id, "phone", { source: "connect_code", createdByUserId: creator });

    expect(auto).toMatchObject({ source: "agent_creation", createdByUserId: creator, createdByAgentId: null });
    expect(byHand).toMatchObject({ source: "manual", createdByUserId: null, createdByAgentId: null });
    expect(viaCode).toMatchObject({ source: "connect_code", createdByUserId: creator });

    const listed = await svc.listKeys(agent.id);
    const byId = new Map(listed.map((key) => [key.id, key]));
    expect(byId.get(auto.id)).toMatchObject({ name: "default", source: "agent_creation", createdByUserId: creator });
    expect(byId.get(byHand.id)).toMatchObject({ name: "laptop", source: "manual", createdByUserId: null });
    expect(byId.get(viaCode.id)).toMatchObject({ name: "phone", source: "connect_code" });

    const fetched = await svc.getKeyById(auto.id);
    expect(fetched).toMatchObject({ source: "agent_creation", createdByUserId: creator });
    // The token itself is never listed back.
    expect(JSON.stringify(listed)).not.toContain(auto.token);
  });
});
