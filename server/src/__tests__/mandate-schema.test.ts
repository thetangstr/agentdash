import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  mandates,
  companies,
  agents,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mandates table", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mandate-schema-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inserts and reads back a mandate row with cc* anchor fields nullable", async () => {
    const [company] = await db.insert(companies).values({ name: "Meridian Pay", issuePrefix: "MER" }).returning();
    const [grantor] = await db.insert(agents).values({ companyId: company.id, name: "Atlas" }).returning();
    const [grantee] = await db.insert(agents).values({ companyId: company.id, name: "Vega" }).returning();

    const expiresAt = new Date(Date.now() + 86_400_000);
    const [row] = await db.insert(mandates).values({
      companyId: company.id,
      grantorAgentId: grantor.id,
      granteeAgentId: grantee.id,
      scope: { actions: ["attest"], vendor: "trellis" },
      permissionKey: "clockchain:attest",
      spendCapCents: 5000,
      expiresAt,
    }).returning();

    expect(row.status).toBe("active");
    expect(row.ccLedgerId).toBeNull();
    expect(row.spendCapCents).toBe(5000);

    const [read] = await db.select().from(mandates).where(eq(mandates.id, row.id));
    expect(read.granteeAgentId).toBe(grantee.id);
    expect(read.scope).toEqual({ actions: ["attest"], vendor: "trellis" });
  });
});
