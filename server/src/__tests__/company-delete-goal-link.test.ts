import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  goals,
  projectGoals,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (AGE-120): deleting a company whose project references a goal
 * used to fail the whole transaction with a foreign-key violation on
 * `projects_goal_id_goals_id_fk` — `remove()` deleted goals before projects,
 * and projects.goal_id -> goals.id is a NO ACTION foreign key. Hit 16/16 on
 * the seeded E2E-Eval companies during the AGE-114 cleanup (2026-09-08).
 * The delete order is now projects before goals; this test pins it.
 *
 * Runs entirely on a throwaway embedded Postgres (fresh tempdir, random
 * non-reserved port) — never the live instance database. Reproducing the bug
 * on the live instance is the AGE-114 incident class and is out of bounds.
 */
describeEmbeddedPostgres("company delete clears goal-referencing projects", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-delete-goal-link-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("removes a company whose project references a goal", async () => {
    const company = await db
      .insert(companies)
      .values({ name: `Del ${randomUUID()}`, issuePrefix: `DL${randomUUID().slice(0, 6).toUpperCase()}`, productProfile: "agentdash_mk" })
      .returning()
      .then((rows) => rows[0]!);
    const goal = await db
      .insert(goals)
      .values({ companyId: company.id, title: `Goal ${randomUUID().slice(0, 6)}` })
      .returning()
      .then((rows) => rows[0]!);
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, goalId: goal.id, name: `Proj ${randomUUID().slice(0, 6)}` })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(projectGoals).values({ companyId: company.id, projectId: project.id, goalId: goal.id });

    const removed = await companyService(db).remove(company.id);
    expect(removed?.id).toBe(company.id);

    // The company is gone and nothing in the goal-linking family survived it.
    const companyAfter = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(companyAfter).toHaveLength(0);
    const goalsAfter = await db.select().from(goals).where(eq(goals.companyId, company.id));
    expect(goalsAfter).toHaveLength(0);
    const projectsAfter = await db.select().from(projects).where(eq(projects.companyId, company.id));
    expect(projectsAfter).toHaveLength(0);
    const junctionAfter = await db.select().from(projectGoals).where(eq(projectGoals.companyId, company.id));
    expect(junctionAfter).toHaveLength(0);
  });
});
