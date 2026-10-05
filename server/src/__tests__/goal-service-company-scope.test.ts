import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { agents, companies, createDb, goals } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { goalService } from "../services/goals.js";
import { HttpError } from "../errors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (GH #921): goalService used to insert parentId/ownerAgentId
 * verbatim — a foreign-company row was accepted as a parent/owner, and an id
 * matching no row surfaced the raw 23503 foreign-key violation as a 500.
 * References must resolve inside the same company and answer 404 on a miss,
 * matching the visibility rule's convention.
 */
describeEmbeddedPostgres("goalService company-scoped references (GH #921)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany(prefix: string) {
    return db
      .insert(companies)
      .values({
        name: `${prefix} ${randomUUID().slice(0, 6)}`,
        issuePrefix: `${prefix.slice(0, 2).toUpperCase()}${randomUUID().slice(0, 4).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  function expectHttpError(promise: Promise<unknown>, status: number) {
    return promise.then(
      () => { throw new Error(`expected HttpError ${status}, resolved instead`); },
      (err) => {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(status);
      },
    );
  }

  it("rejects a parentId from another company with 404, not an FK 500", async () => {
    const [a, b] = await Promise.all([makeCompany("Aco"), makeCompany("Bco")]);
    const otherGoal = await db
      .insert(goals)
      .values({ companyId: b.id, title: "foreign goal" })
      .returning()
      .then((rows) => rows[0]!);

    await expectHttpError(
      goalService(db).create(a.id, { title: "child", parentId: otherGoal.id }),
      404,
    );
  });

  it("rejects an unknown parentId with 404", async () => {
    const a = await makeCompany("Cco");
    await expectHttpError(
      goalService(db).create(a.id, { title: "child", parentId: randomUUID() }),
      404,
    );
  });

  it("rejects an ownerAgentId from another company with 404", async () => {
    const [a, b] = await Promise.all([makeCompany("Dco"), makeCompany("Eco")]);
    const foreignAgent = await db
      .insert(agents)
      .values({ companyId: b.id, name: "foreign-agent", role: "general" })
      .returning()
      .then((rows) => rows[0]!);

    await expectHttpError(
      goalService(db).create(a.id, { title: "owned", ownerAgentId: foreignAgent.id }),
      404,
    );
  });

  it("accepts same-company parent and owner", async () => {
    const a = await makeCompany("Fco");
    const parent = await db
      .insert(goals)
      .values({ companyId: a.id, title: "parent" })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({ companyId: a.id, name: "owner-agent", role: "general" })
      .returning()
      .then((rows) => rows[0]!);

    const goal = await goalService(db).create(a.id, {
      title: "child",
      parentId: parent.id,
      ownerAgentId: agent.id,
    });
    expect(goal.parentId).toBe(parent.id);
    expect(goal.ownerAgentId).toBe(agent.id);
  });

  it("update validates new parentId/ownerAgentId against the goal's company", async () => {
    const [a, b] = await Promise.all([makeCompany("Gco"), makeCompany("Hco")]);
    const goal = await db
      .insert(goals)
      .values({ companyId: a.id, title: "goal" })
      .returning()
      .then((rows) => rows[0]!);
    const foreignGoal = await db
      .insert(goals)
      .values({ companyId: b.id, title: "foreign" })
      .returning()
      .then((rows) => rows[0]!);

    await expectHttpError(goalService(db).update(goal.id, { parentId: foreignGoal.id }), 404);
    await expectHttpError(goalService(db).update(goal.id, { parentId: randomUUID() }), 404);
  });
});
