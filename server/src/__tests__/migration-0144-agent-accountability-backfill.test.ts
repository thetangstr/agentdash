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

// Migration 0146 carries the finance-role mapping that an in-place 0144 edit
// would have shipped: it replaces the backfill function's CASE and remaps the
// rows 0144 demoted to 'general' via the 'cfo' branch.
const MIGRATION_0146 = fs.readFileSync(
  fileURLToPath(
    new URL(
      "../../../packages/db/src/migrations/0146_finance_role_backfill.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const ACTOR_0146 = "migration:0146_finance_role_backfill";

async function createCompany(db: TestDb, name = `Backfill ${randomUUID()}`) {
  return db
    .insert(companies)
    .values({ name, issuePrefix: `BF${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createHuman(db: TestDb, companyId: string, role: "owner" | "admin" | "member" | null = "admin") {
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

    // A sole human with no role at all is the same case as a demoted founder.
    const roleless = await createCompany(db, "Roleless Co");
    await createHuman(db, roleless.id, null);
    const rolelessHire = await createAgent(db, roleless.id, { title: "deployment_lead" });

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
    expect(demotedNotice).toContain(`${roleless.id} (Roleless Co)`);
    expect(await agentRow(rolelessHire.id)).toMatchObject({ autonomy: "stewarded", title: "deployment_lead" });
    expect(notices.join("\n")).not.toContain(archived.id);
  });

  it("installs the backfill function with a pinned search_path and no EXECUTE for PUBLIC", async () => {
    await runMigration();
    const rows = (await db.execute(sql`
      select p.proconfig as config,
             has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
             has_function_privilege(current_user, p.oid, 'EXECUTE') as owner_execute
      from pg_proc p
      where p.oid = 'agentdash_backfill_agent_accountability(uuid,text,text)'::regprocedure
    `)) as unknown as Array<{ config: string[] | null; public_execute: boolean; owner_execute: boolean }>;
    expect(rows[0]?.config).toEqual(["search_path=pg_catalog, public, pg_temp"]);
    expect(rows[0]?.public_execute).toBe(false);
    expect(rows[0]?.owner_execute).toBe(true);
  });

  // AgentDash (review-1029): the migration file is frozen — it already ran on
  // deployed databases, so its CASE is pinned here to what it encoded at ship
  // time rather than derived from the live mapProposedAgentRole/proposedRoleTitle
  // helpers. Changes to the mapping land as new migrations (0146 onwards).
  it("maps underscore slugs exactly as the frozen migration encoded them at ship time", async () => {
    const company = await createCompany(db);
    await createHuman(db, company.id, "admin");
    const expectations: Array<[slug: string, role: string, title: string]> = [
      ["deployment_lead", "devops", "Deployment Lead"],
      ["content_lead", "general", "Content Lead"],
      ["research_analyst", "researcher", "Research Analyst"],
      ["sales_support", "general", "Sales Support"],
      ["marketing_manager", "general", "Marketing Manager"],
      ["chief_executive_officer", "general", "Chief Executive Officer"],
      ["ceo_assistant", "general", "CEO Assistant"],
      ["chief_of_staff_aide", "general", "Chief Of Staff Aide"],
      ["tech_lead", "general", "Tech Lead"],
      ["finance_ops", "general", "Finance Ops"],
      ["security_engineer", "security", "Security Engineer"],
      ["qa_lead", "qa", "QA Lead"],
      ["test_automation", "qa", "Test Automation"],
      ["contest_judge", "qa", "Contest Judge"],
      ["ux_researcher", "designer", "UX Researcher"],
      ["ui_designer", "designer", "UI Designer"],
      ["guide_writer", "general", "Guide Writer"],
      ["product_manager", "pm", "Product Manager"],
      ["dev_advocate", "engineer", "Dev Advocate"],
      ["development_lead", "general", "Development Lead"],
      ["backend_dev", "engineer", "Backend Dev"],
      ["sre_oncall", "devops", "SRE Oncall"],
      ["platform_engineer", "devops", "Platform Engineer"],
      ["data_scientist", "researcher", "Data Scientist"],
      ["seo_specialist", "general", "SEO Specialist"],
      ["growth_hacker", "general", "Growth Hacker"],
      ["project_coordinator", "pm", "Project Coordinator"],
      ["customer_success", "general", "Customer Success"],
      ["ai_trainer", "general", "AI Trainer"],
      ["privacy_officer", "security", "Privacy Officer"],
      ["release_manager", "devops", "Release Manager"],
      ["mobile_dev", "engineer", "Mobile Dev"],
      ["brand_designer", "general", "Brand Designer"],
      ["infra_on_call", "devops", "Infra On Call"],
      ["copy_writer", "general", "Copy Writer"],
      ["3d_artist", "general", "3d Artist"],
      ["full_stack_engineer", "engineer", "Full Stack Engineer"],
    ];
    const created = await Promise.all(
      expectations.map(([slug]) => createAgent(db, company.id, { title: slug })),
    );

    await runMigration();

    for (const [i, [slug, expectedRole, expectedTitle]] of expectations.entries()) {
      const row = await agentRow(created[i]!.id);
      expect({ slug, role: row.role, title: row.title }).toEqual({ slug, role: expectedRole, title: expectedTitle });
    }
  });
});

describeEmbeddedPostgres("migration 0146: finance role backfill on top of a 0144-migrated database", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-migration-0146-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function runSqlFile(contents: string): Promise<void> {
    for (const statement of contents.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await db.execute(sql.raw(statement));
    }
  }

  async function agentRow(id: string) {
    return db.select().from(agents).where(eq(agents.id, id)).then((rows) => rows[0]!);
  }

  it("remaps 0144-demoted finance agents to 'finance', keeps executives and chosen roles, and is idempotent", async () => {
    const company = await createCompany(db);
    const admin = await createHuman(db, company.id, "admin");
    const bookkeeper = await createAgent(db, company.id, { title: "bookkeeper" });
    const payroll = await createAgent(db, company.id, { title: "payroll_specialist" });
    const monthEnd = await createAgent(db, company.id, { title: "month_end_close" });
    const engineer = await createAgent(db, company.id, { title: "backend_dev" });
    const cfoTitled = await createAgent(db, company.id, { title: "chief_financial_officer" });
    const chosenRole = await createAgent(db, company.id, { role: "engineer", title: "bookkeeper" });
    const terminated = await createAgent(db, company.id, { title: "bookkeeper", status: "terminated" });

    // State as a deployed database has it: original 0144 ran first. Single-word
    // titles were never retitled (0144's slug regex needs an underscore), but
    // step 3 still made the agent autonomous with the admin accountable.
    await runSqlFile(MIGRATION);
    expect(await agentRow(bookkeeper.id)).toMatchObject({ role: "general", title: "bookkeeper", autonomy: "autonomous", accountableUserId: admin });
    expect(await agentRow(cfoTitled.id)).toMatchObject({ role: "general", title: "Chief Financial Officer" });

    await runSqlFile(MIGRATION_0146);

    // The remap fixes the role only — the title 0144 left alone stays as is.
    expect(await agentRow(bookkeeper.id)).toMatchObject({ role: "finance", title: "bookkeeper", autonomy: "autonomous", accountableUserId: admin });
    expect(await agentRow(payroll.id)).toMatchObject({ role: "finance", title: "Payroll Specialist" });
    expect(await agentRow(monthEnd.id)).toMatchObject({ role: "finance", title: "Month End Close" });
    // Executives the new CASE still maps to 'cfo' stay demoted to 'general'.
    expect(await agentRow(cfoTitled.id)).toMatchObject({ role: "general", title: "Chief Financial Officer" });
    // A role someone chose and a terminated agent are left alone.
    expect(await agentRow(engineer.id)).toMatchObject({ role: "engineer", title: "Backend Dev" });
    expect(await agentRow(chosenRole.id)).toMatchObject({ role: "engineer" });
    expect(await agentRow(terminated.id)).toMatchObject({ role: "general", title: "bookkeeper" });

    const activity = await db.select().from(activityLog).where(eq(activityLog.actorId, ACTOR_0146));
    expect(activity).toHaveLength(3);
    expect(activity.find((row) => row.agentId === bookkeeper.id)?.details).toMatchObject({
      fromRole: "general",
      toRole: "finance",
      reason: "upgrade_backfill",
    });

    await runSqlFile(MIGRATION_0146);
    expect(await db.select().from(activityLog).where(eq(activityLog.actorId, ACTOR_0146))).toHaveLength(3);
  });

  it("the replaced backfill function maps finance slugs to 'finance' on later repair runs", async () => {
    const company = await createCompany(db);
    const admin = await createHuman(db, company.id, "admin");

    // 0144 first, then 0146 replaces the function — the order a deployed
    // database sees them.
    await runSqlFile(MIGRATION);
    await runSqlFile(MIGRATION_0146);

    // An agent still in the pre-#975 state (e.g. a company 0144 skipped and a
    // later `repair-founder-owner` run reaches) — multi-word slug, so step 2's
    // retitle+remap applies.
    const monthEnd = await createAgent(db, company.id, { title: "month_end_close" });
    await db.execute(
      sql`select agentdash_backfill_agent_accountability(${company.id}::uuid, ${admin}, 'test')`,
    );

    expect(await agentRow(monthEnd.id)).toMatchObject({
      role: "finance",
      title: "Month End Close",
      autonomy: "autonomous",
      accountableUserId: admin,
    });
  });
});
