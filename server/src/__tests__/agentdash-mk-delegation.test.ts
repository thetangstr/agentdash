import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documents,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

describeEmbeddedPostgres("agentdash-mk child contributions", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-delegation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    return db
      .insert(companies)
      .values({
        name: `Deleg ${randomUUID()}`,
        issuePrefix: `DL${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: "agentdash_mk",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createAgent(companyId: string, name: string) {
    return db
      .insert(agents)
      .values({
        companyId,
        name: `${name} ${randomUUID().slice(0, 4)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  let issueCounter = 1000;
  async function createIssue(
    companyId: string,
    input: { parentId?: string | null; assigneeAgentId?: string | null; status?: string; title?: string },
  ) {
    issueCounter += 1;
    return db
      .insert(issues)
      .values({
        companyId,
        identifier: `DL-${issueCounter}`,
        issueNumber: issueCounter,
        title: input.title ?? `Issue ${issueCounter}`,
        status: input.status ?? "todo",
        priority: "medium",
        parentId: input.parentId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** CEO delegates to three stakeholders, each contributing a different artifact kind. */
  async function seedScenario() {
    const company = await createCompany();
    const ceo = await createAgent(company.id, "CEO");
    const product = await createAgent(company.id, "Product");
    const engineering = await createAgent(company.id, "Engineering");
    const marketing = await createAgent(company.id, "Marketing");

    const parent = await createIssue(company.id, {
      assigneeAgentId: ceo.id,
      status: "in_progress",
      title: "Board deck",
    });
    const productIssue = await createIssue(company.id, {
      parentId: parent.id,
      assigneeAgentId: product.id,
      status: "done",
    });
    const engineeringIssue = await createIssue(company.id, {
      parentId: parent.id,
      assigneeAgentId: engineering.id,
      status: "done",
    });
    const marketingIssue = await createIssue(company.id, {
      parentId: parent.id,
      assigneeAgentId: marketing.id,
      status: "done",
    });

    // Product ships a work product.
    await db.insert(issueWorkProducts).values({
      companyId: company.id,
      issueId: productIssue.id,
      type: "document",
      provider: "internal",
      title: "Pricing model",
      status: "ready",
    });

    // Engineering ships a document.
    const doc = await db
      .insert(documents)
      .values({
        companyId: company.id,
        title: "Architecture note",
        format: "markdown",
        latestBody: "## Architecture\nDetail that must not be truncated.",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(issueDocuments).values({
      companyId: company.id,
      issueId: engineeringIssue.id,
      documentId: doc.id,
      key: "architecture",
    });

    // Marketing leaves a long comment; the old wake payload truncated this.
    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: marketingIssue.id,
      authorAgentId: marketing.id,
      body: "M".repeat(4000),
    });

    return {
      company,
      ceo,
      product,
      engineering,
      marketing,
      parent,
      productIssue,
      engineeringIssue,
      marketingIssue,
    };
  }

  it("returns every child contribution in full with author provenance", async () => {
    const scenario = await seedScenario();
    const svc = issueService(db);

    const result = await svc.listChildContributions(scenario.company.id, scenario.parent.id);

    expect(result.contributions).toHaveLength(3);
    const byIssue = new Map(result.contributions.map((c) => [c.sourceIssueId, c]));

    const productContribution = byIssue.get(scenario.productIssue.id)!;
    expect(productContribution.agentId).toBe(scenario.product.id);
    expect(productContribution.workProducts.map((w) => w.title)).toContain("Pricing model");

    const engineeringContribution = byIssue.get(scenario.engineeringIssue.id)!;
    expect(engineeringContribution.agentId).toBe(scenario.engineering.id);
    expect(engineeringContribution.documents.map((d) => d.title)).toContain("Architecture note");

    const marketingContribution = byIssue.get(scenario.marketingIssue.id)!;
    expect(marketingContribution.agentId).toBe(scenario.marketing.id);
    // The whole comment, not a preview — this is the truncation the design names.
    expect(marketingContribution.comments[0].body).toHaveLength(4000);
  });

  it("names every contributing agent so the consolidated output can link them", async () => {
    const scenario = await seedScenario();
    const svc = issueService(db);

    const result = await svc.listChildContributions(scenario.company.id, scenario.parent.id);

    expect(result.contributingAgentIds.sort()).toEqual(
      [scenario.product.id, scenario.engineering.id, scenario.marketing.id].sort(),
    );
    for (const contribution of result.contributions) {
      expect(contribution.sourceIssueIdentifier).toMatch(/^DL-/);
    }
  });

  it("keeps the parent wake payload to references and counts, not artifact bodies", async () => {
    const scenario = await seedScenario();
    const svc = issueService(db);

    const wakeable = await svc.getWakeableParentAfterChildCompletion(scenario.parent.id);

    expect(wakeable).not.toBeNull();
    expect(wakeable!.assigneeAgentId).toBe(scenario.ceo.id);
    expect(wakeable!.childIssueIds).toHaveLength(3);

    // References and counts only: embedding artifact bodies here is exactly the
    // lossy substitute the design rules out, because a truncated copy invites
    // the parent to consolidate from the preview instead of the source.
    const serialized = JSON.stringify(wakeable);
    expect(serialized).not.toContain("M".repeat(200));
    expect(serialized).not.toContain("Detail that must not be truncated");
    for (const summary of wakeable!.childIssueSummaries) {
      expect(summary).toMatchObject({
        contributionCounts: expect.objectContaining({
          comments: expect.any(Number),
          documents: expect.any(Number),
          workProducts: expect.any(Number),
        }),
      });
    }
  });

  it("does not wake the parent until every required child is finished", async () => {
    const scenario = await seedScenario();
    await db
      .update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, scenario.marketingIssue.id));

    expect(
      await issueService(db).getWakeableParentAfterChildCompletion(scenario.parent.id),
    ).toBeNull();
  });

  it("scopes contributions to the company", async () => {
    const scenario = await seedScenario();
    const otherCompany = await createCompany();

    const result = await issueService(db).listChildContributions(
      otherCompany.id,
      scenario.parent.id,
    );

    expect(result.contributions).toEqual([]);
  });

  it("reports an unfinished child rather than silently omitting it", async () => {
    const scenario = await seedScenario();
    await db
      .update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, scenario.engineeringIssue.id));

    const result = await issueService(db).listChildContributions(
      scenario.company.id,
      scenario.parent.id,
    );

    // Completeness is the point: a consolidator must be able to see that a
    // required contribution is still outstanding.
    expect(result.complete).toBe(false);
    const engineering = result.contributions.find(
      (c) => c.sourceIssueId === scenario.engineeringIssue.id,
    )!;
    expect(engineering.status).toBe("in_progress");
  });
});
