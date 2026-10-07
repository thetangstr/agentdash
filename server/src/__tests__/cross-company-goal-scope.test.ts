import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, goals, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cross-company goal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// UltraQA QA-A (XC-28/XC-30): a caller in company B could name a goal id owned
// by company A on issue/project create, and the foreign reference was stored.
// Update paths already refuse via issueCurrentAuthority ("Goal not found");
// these tests pin the same refusal on the create paths.
describeEmbeddedPostgres("cross-company goal scoping", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyA = await db
      .insert(companies)
      .values({ name: "Alpha", issuePrefix: "QGA" })
      .returning()
      .then((rows) => rows[0]!);
    const companyB = await db
      .insert(companies)
      .values({ name: "Beta", issuePrefix: "QGB" })
      .returning()
      .then((rows) => rows[0]!);
    const goalA = await db
      .insert(goals)
      .values({ companyId: companyA.id, title: "Alpha goal", level: "company" })
      .returning()
      .then((rows) => rows[0]!);
    const goalB = await db
      .insert(goals)
      .values({ companyId: companyB.id, title: "Beta goal", level: "company" })
      .returning()
      .then((rows) => rows[0]!);
    return { companyA, companyB, goalA, goalB };
  }

  it("issueService.create rejects a goalId owned by another company", async () => {
    const { companyB, goalA } = await seed();
    await expect(
      issueService(db).create(companyB.id, { title: "Foreign goal", goalId: goalA.id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("issueService.create rejects a nonexistent goalId", async () => {
    const { companyB } = await seed();
    await expect(
      issueService(db).create(companyB.id, { title: "Missing goal", goalId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("issueService.create accepts a same-company goalId", async () => {
    const { companyB, goalB } = await seed();
    const issue = await issueService(db).create(companyB.id, { title: "Own goal", goalId: goalB.id });
    expect(issue.goalId).toBe(goalB.id);
  });

  it("projectService.create rejects a goalId owned by another company", async () => {
    const { companyB, goalA } = await seed();
    await expect(
      projectService(db).create(companyB.id, { name: "Foreign goal project", goalId: goalA.id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("projectService.create rejects goalIds owned by another company", async () => {
    const { companyB, goalA, goalB } = await seed();
    await expect(
      projectService(db).create(companyB.id, { name: "Mixed goals", goalIds: [goalB.id, goalA.id] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("projectService.update rejects a goalId owned by another company", async () => {
    const { companyB, goalA, goalB } = await seed();
    const project = await projectService(db).create(companyB.id, { name: "Beta project", goalId: goalB.id });
    await expect(
      projectService(db).update(project.id, { goalId: goalA.id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("projectService.create accepts a same-company goalId", async () => {
    const { companyB, goalB } = await seed();
    const project = await projectService(db).create(companyB.id, { name: "Beta project", goalId: goalB.id });
    expect(project.goalId).toBe(goalB.id);
  });
});
