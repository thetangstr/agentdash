import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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

  it("single-admin company: CoS gets the admin as steward, hires become autonomous with the admin accountable, titles and roles are repaired; a re-run is a no-op", async () => {
    const company = await createCompany(db);
    const admin = await createHuman(db, company.id, "admin");
    const cos = await createAgent(db, company.id, { role: "chief_of_staff", title: "Chief of Staff" });
    const deploy = await createAgent(db, company.id, { title: "deployment_lead" });
    const content = await createAgent(db, company.id, { title: "content_lead" });
    const research = await createAgent(db, company.id, { title: "research_analyst" });
    const sales = await createAgent(db, company.id, { title: "sales_support" });
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
    // A role someone chose is kept; only the slug title is humanised.
    expect(await agentRow(engineer.id)).toMatchObject({ role: "engineer", title: "Backend Dev" });
    // Terminated agents are history: untouched.
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
    expect(byAction("agent.updated")).toHaveLength(5);
    expect(byAction("agent.updated").find((row) => row.agentId === deploy.id)?.details).toMatchObject({
      changedTopLevelKeys: ["role", "title"],
      fromRole: "general",
      toRole: "devops",
      fromTitle: "deployment_lead",
      toTitle: "Deployment Lead",
    });

    const before = activity.length;
    await runMigration();
    expect(await backfillActivity()).toHaveLength(before);
    expect(await db.select().from(agentStewardships).where(eq(agentStewardships.companyId, company.id))).toHaveLength(1);
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

  it("is a no-op for a multi-human company and names it in a notice; a sole member who is not an admin is also left alone", async () => {
    const multi = await createCompany(db, "Two Humans Co");
    await createHuman(db, multi.id, "admin");
    await createHuman(db, multi.id, "member");
    const multiHire = await createAgent(db, multi.id, { title: "deployment_lead" });

    const memberOnly = await createCompany(db);
    await createHuman(db, memberOnly.id, "member");
    const memberHire = await createAgent(db, memberOnly.id, { title: "deployment_lead" });

    const notices = await runMigration();

    expect(await agentRow(multiHire.id)).toMatchObject({ autonomy: "stewarded", accountableUserId: null, role: "general", title: "deployment_lead" });
    expect(await agentRow(memberHire.id)).toMatchObject({ autonomy: "stewarded", accountableUserId: null, role: "general", title: "deployment_lead" });
    expect(await backfillActivity()).toHaveLength(0);
    expect(await db.select().from(agentStewardships)).toHaveLength(0);

    const notice = notices.find((message) => message.startsWith("agentdash: migration 0144"));
    expect(notice).toBeTruthy();
    expect(notice).toContain(`${multi.id} (Two Humans Co)`);
    expect(notice).not.toContain(memberOnly.id);
  });

  it("maps slugs exactly as the shared helpers do, minus executive roles", async () => {
    const company = await createCompany(db);
    await createHuman(db, company.id, "admin");
    const slugs = [
      "deployment_lead", "content_lead", "research_analyst", "sales_support", "marketing_manager",
      "chief_executive_officer", "ceo_assistant", "chief_of_staff_aide", "cto", "tech_lead", "finance_ops",
      "security_engineer", "qa_lead", "test_automation", "contest_judge", "ux_researcher", "ui_designer",
      "guide_writer", "pm", "product_manager", "dev_advocate", "development_lead", "backend_dev",
      "full-stack-engineer", "sre_oncall", "platform_engineer", "data_scientist", "seo_specialist",
      "growth_hacker", "project_coordinator", "customer_success", "ai_trainer", "researcher", "general",
      "designer", "engineer", "devops", "privacy_officer", "release_manager", "mobile_dev", "cfo", "cmo",
      "brand_designer", "infra_on_call", "bookkeeper", "copywriter", "3d_artist",
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
