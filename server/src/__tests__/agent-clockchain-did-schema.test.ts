import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  companies,
  agents,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agents.clockchainDid column", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-clockchain-did-schema-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("round-trips a provisioned clockchainDid, and defaults to null when absent", async () => {
    const [company] = await db.insert(companies).values({ name: "Meridian Pay" }).returning();

    const [withDid] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Atlas", clockchainDid: "did:test:x" })
      .returning();

    expect(withDid.clockchainDid).toBe("did:test:x");

    const [readWithDid] = await db.select().from(agents).where(eq(agents.id, withDid.id));
    expect(readWithDid.clockchainDid).toBe("did:test:x");

    const [withoutDid] = await db.insert(agents).values({ companyId: company.id, name: "Vega" }).returning();

    expect(withoutDid.clockchainDid).toBeNull();

    const [readWithoutDid] = await db.select().from(agents).where(eq(agents.id, withoutDid.id));
    expect(readWithoutDid.clockchainDid).toBeNull();
  });
});
