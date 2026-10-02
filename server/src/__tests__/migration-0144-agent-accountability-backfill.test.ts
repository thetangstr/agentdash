import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agentConnectCodes,
  agents,
  agentStewardships,
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import { mapProposedAgentRole, proposedRoleTitle } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";

/**
 * Migration 0144 (canary1, v2026.1002.1): boxes upgraded from before #975 kept
 * onboarding hires stewarded with nobody paired ("Needs a steward" on every
 * agent) and slug titles with role "general". Run against a real Postgres:
 * the properties at stake are the 1:1 stewardship indexes and the check
 * constraint on autonomous agents.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const MIGRATION = fs.readFileSync(
  fileURLToPath(
    new URL(
      "../../../packages/db/src/migrations/0144_upgrade_agent_accountability_backfill.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const ACTOR = "migration:0144_upgrade_agent_accountability_backfill";
const EXECUTIVE_ROLES = new Set(["ceo", "chief_of_staff", "cto", "cmo", "cfo"]);

async function createCompany(db: TestDb, name = `Backfill ${randomUUID()}`) {
  return db
    .insert(companies)
    .values({ name, issuePrefix: `BF${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createHuman(db: TestDb, companyId: string, role: "owner" | "admin" | "member" = "admin") {
  const userId = randomUUID();
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    name: `Person ${userId.slice(0, 4)}`,
    email: `${userId}@example.test`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: role,
  });
  return userId;
}

async function createAgent(
  db: TestDb,
  companyId: string,
  input: { role?: string; title?: string | null; status?: string; autonomy?: "stewarded" | "autonomous"; accountableUserId?: string | null } = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID().slice(0, 8)}`,
      role: input.role ?? "general",
      title: input.title ?? null,
      status: input.status ?? "idle",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      ...(input.autonomy ? { autonomy: input.autonomy } : {}),
      ...(input.accountableUserId !== undefined ? { accountableUserId: input.accountableUserId } : {}),
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("migration 0144: upgrade backfill for agent accountability, titles and roles", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-migration-0144-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Run the migration file statement by statement, as the runner does, and
   * collect its notices. The test client keeps postgres.js's default notice
   * handler, which hands each notice to console.log.
   */
  async function runMigration(): Promise<string[]> {
    const notices: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      for (const arg of args) {
        const message = (arg as { message?: unknown } | null)?.message;
        if (typeof message === "string") notices.push(message);
      }
    });
    try {
      for (const statement of MIGRATION.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
        await db.execute(sql.raw(statement));
      }
    } finally {
      spy.mockRestore();
    }
    return notices;
  }

  async function agentRow(id: string) {
    return db.select().from(agents).where(eq(agents.id, id)).then((rows) => rows[0]!);
  }

  async function backfillActivity() {
    return db.select().from(activityLog).where(eq(activityLog.actorId, ACTOR));
  }

  it("single-admin company: CoS gets the admin as steward, pre-#975 hires become autonomous with the admin accountable, slug titles and general roles are repaired; a re-run is a no-op", async () => {
    const company = await createCompany(db);
    const admin = await createHuman(db, company.id, "admin");
    const cos = await createAgent(db, company.id, { role: "chief_of_staff", title: "Chief of Staff" });
    const deploy = await createAgent(db, company.id, { title: "deployment_lead" });
    const content = await createAgent(db, company.id, { title: "content_lead" });
    const research = await createAgent(db, company.id, { title: "research_analyst" });
    const sales = await createAgent(db, company.id, { title: "sales_support" });
    // A role someone chose: made autonomous, but its title and role are theirs.
    const engineer = await createAgent(db, company.id, { role: "engineer", title: "backend_dev" });
    const terminated = await createAgent(db, company.id, { title: "qa_lead", status: "terminated" });

    await runMigration();

    const stewardships = await db.select().from(agentStewardships).where(eq(agentStewardships.companyId, company.id));
    expect(stewardships).toHaveLength(1);
    expect(stewardships[0]).toMatchObject({ agentId: cos.id, userId: admin, endedAt: null });
    expect(await agentRow(cos.id)).toMatchObject({ autonomy: "stewarded", accountableUserId: null, role: "chief_of_staff", title: "Chief of Staff" });

    expect(await agentRow(deploy.id)).toMatchObject({ autonomy: "autonomous", accountableUserId: admin, role: "devops", title: "Deployment Lead" });
    // content_lead maps to cmo in mapProposedAgentRole; the backfill never hands out an executive role.
    expect(await agentRow(content.id)).toMatchObject({ autonomy: "autonomous", accountableUserId: admin, role: "general", title: "Content Lead" });
    expect(await agentRow(research.id)).toMatchObject({ role: "researcher", title: "Research Analyst" });
    expect(await agentRow(sales.id)).toMatchObject({ role: "general", title: "Sales Support" });
    expect(await agentRow(engineer.id)).toMatchObject({ autonomy: "autonomous", role: "engineer", title: "backend_dev" });
    expect(await agentRow(terminated.id)).toMatchObject({ autonomy: "stewarded", accountableUserId: null, role: "general", title: "qa_lead" });

    const activity = await backfillActivity();
    const byAction = (action: string) => activity.filter((row) => row.action === action);
    expect(byAction("agent.stewardship_assigned")).toHaveLength(1);
    expect(byAction("agent.stewardship_assigned")[0]).toMatchObject({ actorType: "system", agentId: cos.id, origin: "server" });
    expect(byAction("agent.accountability_changed")).toHaveLength(5);
    expect(byAction("agent.accountability_changed").find((row) => row.agentId === deploy.id)?.details).toMatchObject({
      fromAutonomy: "stewarded",
      toAutonomy: "autonomous",
      toAccountableUserId: admin,
      reason: "upgrade_backfill",
    });
    expect(byAction("agent.updated")).toHaveLength(4);
    expect(byAction("agent.updated").find((row) => row.agentId === deploy.id)?.details).toMatchObject({
      changedTopLevelKeys: ["role", "title"],
      fromRole: "general",
      toRole: "devops",
      fromTitle: "deployment_lead",
      toTitle: "Deployment Lead",
      reason: "upgrade_backfill",
    });

    const before = activity.length;
    await runMigration();
    expect(await backfillActivity()).toHaveLength(before);
    expect(await db.select().from(agentStewardships).where(eq(agentStewardships.companyId, company.id))).toHaveLength(1);
  });

  // Review of #994: step 3 used to rewrite agents outside the pre-#975 state.
  it("leaves agents outside the pre-#975 state, and single-word titles, exactly as they were", async () => {
    const company = await createCompany(db);
    const admin = await createHuman(db, company.id, "admin");
    const scout = await createAgent(db, company.id, { title: "scout", autonomy: "autonomous", accountableUserId: admin });
    const custom = await createAgent(db, company.id, { title: "my_custom_bot", autonomy: "autonomous", accountableUserId: admin });
    const runner = await createAgent(db, company.id, { title: "test_runner", autonomy: "autonomous", accountableUserId: admin });
    const ceoTitled = await createAgent(db, company.id, { title: "ceo" });
    const x = await createAgent(db, company.id, { title: "x" });
    const hyphen = await createAgent(db, company.id, { title: "full-stack-engineer" });

    await runMigration();

    expect(await agentRow(scout.id)).toMatchObject({ role: "general", title: "scout" });
    expect(await agentRow(custom.id)).toMatchObject({ role: "general", title: "my_custom_bot" });
    expect(await agentRow(runner.id)).toMatchObject({ role: "general", title: "test_runner" });
    // Pre-#975 but not a slug: made autonomous, title and role untouched.
    expect(await agentRow(ceoTitled.id)).toMatchObject({ autonomy: "autonomous", role: "general", title: "ceo" });
    expect(await agentRow(x.id)).toMatchObject({ autonomy: "autonomous", role: "general", title: "x" });
    expect(await agentRow(hyphen.id)).toMatchObject({ role: "general", title: "full-stack-engineer" });
    expect((await backfillActivity()).filter((row) => row.action === "agent.updated")).toHaveLength(0);
  });

  it("leaves the CoS alone when the sole human already stewards another agent, and still repairs the hires", async () => {
    const company = await createCompany(db);
    const owner = await createHuman(db, company.id, "owner");
    const personal = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(agentStewardships).values({ companyId: company.id, agentId: personal.id, userId: owner });
    const cos = await createAgent(db, company.id, { role: "chief_of_staff", title: "Chief of Staff" });
    const hire = await createAgent(db, company.id, { title: "deployment_lead" });

    await runMigration();

    const stewardships = await db.select().from(agentStewardships).where(eq(agentStewardships.companyId, company.id));
    expect(stewardships.map((row) => row.agentId)).toEqual([personal.id]);
    expect(await agentRow(cos.id)).toMatchObject({ autonomy: "stewarded", accountableUserId: null });
    expect(await agentRow(hire.id)).toMatchObject({ autonomy: "autonomous", accountableUserId: owner });
    expect(await agentRow(personal.id)).toMatchObject({ autonomy: "stewarded", accountableUserId: null });
  });

  it("keeps an agent a person holds a credential for stewarded and names it; a 'default' key alone does not count", async () => {
    const company = await createCompany(db);
    await createHuman(db, company.id, "admin");
    const keyed = await createAgent(db, company.id, { title: "sales_support" });
    await db.insert(agentApiKeys).values({ agentId: keyed.id, companyId: company.id, name: "laptop", keyHash: randomUUID() });
    const paired = await createAgent(db, company.id);
    await db.insert(agentConnectCodes).values({
      companyId: company.id,
      agentId: paired.id,
      codeHash: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      redeemedAt: new Date(),
    });
    const defaultOnly = await createAgent(db, company.id);
    await db.insert(agentApiKeys).values({ agentId: defaultOnly.id, companyId: company.id, name: "default", keyHash: randomUUID() });
    const revoked = await createAgent(db, company.id);
    await db.insert(agentApiKeys).values({
      agentId: revoked.id, companyId: company.id, name: "laptop", keyHash: randomUUID(), revokedAt: new Date(),
    });

    const notices = await runMigration();

    expect(await agentRow(keyed.id)).toMatchObject({ autonomy: "stewarded", accountableUserId: null });
    expect(await agentRow(paired.id)).toMatchObject({ autonomy: "stewarded", accountableUserId: null });
    expect(await agentRow(defaultOnly.id)).toMatchObject({ autonomy: "autonomous" });
    expect(await agentRow(revoked.id)).toMatchObject({ autonomy: "autonomous" });
    const notice = notices.find((message) => message.includes("holds a key or redeemed connect code"));
    expect(notice).toContain(keyed.id);
    expect(notice).toContain(paired.id);
    expect(notice).not.toContain(defaultOnly.id);
  });

  it("is a no-op for multi-human, demoted-founder and archived companies, naming the first two in notices", async () => {
    const multi = await createCompany(db, "Two Humans Co");
    await createHuman(db, multi.id, "admin");
    await createHuman(db, multi.id, "member");
    const multiHire = await createAgent(db, multi.id, { title: "deployment_lead" });

    const demoted = await createCompany(db, "Demoted Founder Co");
    await createHuman(db, demoted.id, "member");
    const demotedHire = await createAgent(db, demoted.id, { title: "deployment_lead" });

    const archived = await createCompany(db, "Archived Co");
    await createHuman(db, archived.id, "admin");
    const archivedHire = await createAgent(db, archived.id, { title: "deployment_lead" });
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, archived.id));

    const notices = await runMigration();

    for (const id of [multiHire.id, demotedHire.id, archivedHire.id]) {
      expect(await agentRow(id)).toMatchObject({ autonomy: "stewarded", accountableUserId: null, role: "general", title: "deployment_lead" });
    }
    expect(await backfillActivity()).toHaveLength(0);
    expect(await db.select().from(agentStewardships)).toHaveLength(0);

    const multiNotice = notices.find((message) => message.includes("multi-human companies"));
    expect(multiNotice).toContain(`${multi.id} (Two Humans Co)`);
    expect(multiNotice).not.toContain(demoted.id);
    const demotedNotice = notices.find((message) => message.includes("repair-founder-owner"));
    expect(demotedNotice).toContain(`${demoted.id} (Demoted Founder Co)`);
    expect(notices.join("\n")).not.toContain(archived.id);
  });

  it("maps underscore slugs exactly as the shared helpers do, minus executive roles", async () => {
    const company = await createCompany(db);
    await createHuman(db, company.id, "admin");
    const slugs = [
      "deployment_lead", "content_lead", "research_analyst", "sales_support", "marketing_manager",
      "chief_executive_officer", "ceo_assistant", "chief_of_staff_aide", "tech_lead", "finance_ops",
      "security_engineer", "qa_lead", "test_automation", "contest_judge", "ux_researcher", "ui_designer",
      "guide_writer", "product_manager", "dev_advocate", "development_lead", "backend_dev",
      "sre_oncall", "platform_engineer", "data_scientist", "seo_specialist", "growth_hacker",
      "project_coordinator", "customer_success", "ai_trainer", "privacy_officer", "release_manager",
      "mobile_dev", "brand_designer", "infra_on_call", "copy_writer", "3d_artist", "full_stack_engineer",
    ];
    const created = await Promise.all(slugs.map((slug) => createAgent(db, company.id, { title: slug })));

    await runMigration();

    for (const [i, slug] of slugs.entries()) {
      const row = await agentRow(created[i]!.id);
      const helperRole = mapProposedAgentRole(slug);
      const expectedRole = EXECUTIVE_ROLES.has(helperRole) ? "general" : helperRole;
      expect({ slug, role: row.role, title: row.title }).toEqual({ slug, role: expectedRole, title: proposedRoleTitle(slug) });
    }
  });
});
