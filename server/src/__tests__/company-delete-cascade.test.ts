import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentDirectives,
  agentMemory,
  agentStewardships,
  agents,
  bridgeEndpoints,
  bridgeTasks,
  companies,
  createDb,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (AGE-36): deleting a company must clear every table that holds a
 * NO ACTION foreign key to its agents. Two of these were hit live on
 * 2026-09-02 (agent_directives, then bridge_endpoints) while deleting a
 * disposable mk-profile company; the rest are the same class, found by audit.
 * The test seeds one row in each family and expects remove() to succeed.
 */
describeEmbeddedPostgres("company delete clears agent-referencing tables", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-delete-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("removes a company that used directives, memory, stewardship, the bridge, and routines", async () => {
    const company = await db
      .insert(companies)
      .values({ name: `Del ${randomUUID()}`, issuePrefix: `DL${randomUUID().slice(0, 6).toUpperCase()}`, productProfile: "agentdash_mk" })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
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

    await db.insert(agentStewardships).values({
      companyId: company.id,
      agentId: agent.id,
      userId: "u-1",
      assignedByUserId: "u-1",
    });
    await db.insert(agentDirectives).values({
      companyId: company.id,
      agentId: agent.id,
      version: 1,
      directives: "Be terse.",
      pushedByUserId: "u-1",
      pushedAt: new Date(),
    });
    await db.insert(agentMemory).values({
      companyId: company.id,
      agentId: agent.id,
      version: 1,
      content: "prefers short answers",
      authorKind: "human",
    });
    const endpoint = await db
      .insert(bridgeEndpoints)
      .values({
        companyId: company.id,
        userId: "u-1",
        label: "laptop",
        tokenHash: `hash-${randomUUID()}`,
        capabilities: ["bridge:read"],
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(bridgeTasks).values({
      companyId: company.id,
      endpointId: endpoint.id,
      taskClass: "ask",
      instruction: "question?",
      status: "pending",
      requeueCount: "0",
    });
    await db.insert(routines).values({
      companyId: company.id,
      title: "daily",
      priority: "low",
      status: "active",
      concurrencyPolicy: "skip",
      catchUpPolicy: "skip",
      variables: {},
      assigneeAgentId: agent.id,
    });

    const removed = await companyService(db).remove(company.id);
    expect(removed?.id).toBe(company.id);

    // The company is gone, and nothing in the seeded families survived it.
    const companyAfter = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(companyAfter).toHaveLength(0);
    const directivesAfter = await db.select().from(agentDirectives).where(eq(agentDirectives.companyId, company.id));
    expect(directivesAfter).toHaveLength(0);
    const memoryAfter = await db.select().from(agentMemory).where(eq(agentMemory.companyId, company.id));
    expect(memoryAfter).toHaveLength(0);
    const endpointsAfter = await db.select().from(bridgeEndpoints).where(eq(bridgeEndpoints.companyId, company.id));
    expect(endpointsAfter).toHaveLength(0);
    const routinesAfter = await db.select().from(routines).where(eq(routines.companyId, company.id));
    expect(routinesAfter).toHaveLength(0);
    const agentsAfter = await db.select().from(agents).where(eq(agents.companyId, company.id));
    expect(agentsAfter).toHaveLength(0);
  });
});
