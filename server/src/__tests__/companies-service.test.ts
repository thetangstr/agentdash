// AgentDash (#448/#449/#451): companyService.create must insert the creator's
// membership in the SAME transaction as the company row. Auth reads memberships
// fresh per request, so a request racing between "company created" and
// "membership inserted" used to 403 (the onboarding-wizard race).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, companyMemberships, environments, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres companies service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService.create — atomic creator membership", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companyService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-companies-service-");
    db = createDb(tempDb.connectionString);
    svc = companyService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyMemberships);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function getMembership(companyId: string, principalId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  it("inserts the creator's owner membership together with the company", async () => {
    const created = await svc.create(
      { name: "Acme Inc" },
      false,
      { principalType: "user", principalId: "creator-user-1", membershipRole: "owner" },
    );

    expect(created.id).toBeTruthy();
    expect(created.issuePrefix).toBe("ACM");

    const membership = await getMembership(created.id, "creator-user-1");
    expect(membership).not.toBeNull();
    expect(membership).toMatchObject({
      companyId: created.id,
      principalType: "user",
      principalId: "creator-user-1",
      status: "active",
      membershipRole: "owner",
    });
  });

  it("defaults membershipRole to owner when omitted", async () => {
    const created = await svc.create(
      { name: "Beta LLC" },
      false,
      { principalType: "user", principalId: "creator-user-2" },
    );

    const membership = await getMembership(created.id, "creator-user-2");
    expect(membership).not.toBeNull();
    expect(membership?.membershipRole).toBe("owner");
    expect(membership?.status).toBe("active");
  });

  it("still yields a company WITH membership after an issue-prefix conflict retry", async () => {
    // Occupy the base prefix "ACM" so the first insert attempt conflicts and
    // the retry loop must re-run the transaction with the "ACMA" suffix.
    await db.insert(companies).values({
      name: "Prefix Squatter",
      issuePrefix: "ACM",
      requireBoardApprovalForNewAgents: false,
    });

    const created = await svc.create(
      { name: "Acme Inc" },
      false,
      { principalType: "user", principalId: "creator-user-3", membershipRole: "owner" },
    );

    expect(created.issuePrefix).toBe("ACMA");

    const membership = await getMembership(created.id, "creator-user-3");
    expect(membership).not.toBeNull();
    expect(membership).toMatchObject({
      companyId: created.id,
      status: "active",
      membershipRole: "owner",
    });

    // The failed first attempt must not leave an orphan membership behind.
    const allMemberships = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.principalId, "creator-user-3"));
    expect(allMemberships).toHaveLength(1);
  });

  it("creates no membership when creatorMembership is omitted (legacy callers)", async () => {
    const created = await svc.create({ name: "Gamma Co" });
    const rows = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, created.id));
    expect(rows).toHaveLength(0);
  });
});
