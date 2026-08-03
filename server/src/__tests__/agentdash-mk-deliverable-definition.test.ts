import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  deliverableChecks,
  deliverableFacts,
  deliverables,
  workflowEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { deliverableRoutes } from "../routes/deliverables.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const repoRoot = path.resolve(import.meta.dirname, "../../..");

/**
 * AgentDash-MK Slice G1 — the definition surface.
 *
 * The finding this whole shape traces to: **self-service process capture does
 * not work.** There is no evidence of it working anywhere, and every working
 * analogue has a third party doing the encoding. So the fact list is produced
 * by an implementer watching one real cycle, and there is deliberately **no
 * self-service authoring surface** — not a hidden one, not a permission away.
 * A customer with every membership role this product has still cannot author a
 * deliverable.
 *
 * The `deliverable_checks` half of that is the load-bearing one for G3. A
 * checker whose acceptance criteria the assembling agent could write is a
 * checker the assembler passes by construction, and running it on a separate
 * code path would not help at all.
 */
describeEmbeddedPostgres("agentdash-mk deliverable definition", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-deliv-def-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workflowEvents);
    await db.delete(activityLog);
    await db.delete(deliverableChecks);
    await db.delete(deliverableFacts);
    await db.delete(deliverables);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(profile: "agentdash_mk" | "default" = "agentdash_mk") {
    const company = await db
      .insert(companies)
      .values({
        name: `Deliverables ${randomUUID()}`,
        issuePrefix: `DL${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: profile,
      })
      .returning()
      .then((rows) => rows[0]!);

    async function member(role: string) {
      return db
        .insert(companyMemberships)
        .values({
          companyId: company.id,
          principalType: "user",
          principalId: randomUUID(),
          status: "active",
          membershipRole: role,
        })
        .returning()
        .then((rows) => rows[0]!);
    }

    async function agent(name: string) {
      return db
        .insert(agents)
        .values({
          companyId: company.id,
          name,
          role: "engineer",
          status: "idle",
          adapterType: "process",
        })
        .returning()
        .then((rows) => rows[0]!);
    }

    return {
      company,
      owner: await member("owner"),
      operator: await member("operator"),
      approverOne: await member("operator"),
      approverTwo: await member("operator"),
      assembler: await agent(`Assembler ${randomUUID().slice(0, 6)}`),
      producer: await agent(`Producer ${randomUUID().slice(0, 6)}`),
    };
  }

  function boardActor(
    companyId: string,
    userId: string,
    opts: { isInstanceAdmin?: boolean; membershipRole?: string } = {},
  ) {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: opts.isInstanceAdmin ?? false,
      companyIds: [companyId],
      memberships: [
        { companyId, membershipRole: opts.membershipRole ?? "operator", status: "active" },
      ],
    };
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, source: "agent_key", companyIds: [companyId] };
  }

  function app(actor: Record<string, unknown>) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      (req as any).actor = { ...actor, companyIds: [...((actor.companyIds as string[]) ?? [])] };
      next();
    });
    instance.use("/api", deliverableRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function call(instance: express.Express, build: (baseUrl: string) => request.Test) {
    const server = createServer(instance);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      return await build(`http://127.0.0.1:${address.port}`);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }

  function definitionBody(seeded: Awaited<ReturnType<typeof seed>>) {
    return {
      key: "weekly-project-review",
      name: "Weekly project review",
      cadence: "weekly",
      assemblerAgentId: seeded.assembler.id,
      firstApproverUserId: seeded.approverOne.principalId,
      secondApproverUserId: seeded.approverTwo.principalId,
    };
  }

  // -- G1: an implementer defines it through a real route -------------------

  it("lets an implementer define a deliverable and its fact list through the routes", async () => {
    const seeded = await seed();
    const admin = app(boardActor(seeded.company.id, seeded.owner.principalId, {
      isInstanceAdmin: true,
    }));

    const created = await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/deliverables`)
        .send(definitionBody(seeded)),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.key).toBe("weekly-project-review");

    // A fact that lives in a system, and one that lives in a person's head.
    // That split IS the dial: whatever can be fetched is fetched, whatever
    // cannot is asked for.
    const systemFact = await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/deliverables/weekly-project-review/facts`)
        .send({
          key: "labour.hours_booked",
          label: "Hours booked this week",
          sourceType: "system",
          derivation: "Sum of the Hours column of the WeeklyHours table.",
          ownerAgentId: seeded.producer.id,
          connectorProvider: "sharepoint",
          connectorConfig: {
            siteId: "site-1",
            itemId: "item-1",
            target: { kind: "table", name: "WeeklyHours" },
          },
          orderIndex: 0,
        }),
    );
    expect(systemFact.status, JSON.stringify(systemFact.body)).toBe(201);

    const humanFact = await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/deliverables/weekly-project-review/facts`)
        .send({
          key: "risk.narrative",
          label: "This week's risks",
          sourceType: "human",
          derivation: "The project lead's own read, in their own words.",
          ownerAgentId: seeded.producer.id,
          orderIndex: 1,
        }),
    );
    expect(humanFact.status, JSON.stringify(humanFact.body)).toBe(201);

    const check = await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/deliverables/weekly-project-review/checks`)
        .send({
          key: "hours-did-not-jump",
          kind: "moved_more_than",
          config: { factKey: "labour.hours_booked", percent: 40 },
          severity: "blocking",
        }),
    );
    expect(check.status, JSON.stringify(check.body)).toBe(201);

    const read = await call(admin, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${seeded.company.id}/deliverables/weekly-project-review`),
    );
    expect(read.status).toBe(200);
    expect(read.body.facts).toHaveLength(2);
    expect(read.body.facts[0].key).toBe("labour.hours_booked");
    expect(read.body.facts[1].sourceType).toBe("human");
    expect(read.body.checks).toHaveLength(1);
    // Two approvers, named at definition time. Not resolved from an org chart:
    // who signs an artifact off is a property of the artifact.
    expect(read.body.firstApproverUserId).toBe(seeded.approverOne.principalId);
    expect(read.body.secondApproverUserId).toBe(seeded.approverTwo.principalId);
  });

  // -- G1 adversarial: no customer authors anything -------------------------

  it("refuses a deliverable definition from an ordinary member", async () => {
    const seeded = await seed();
    const res = await call(
      app(boardActor(seeded.company.id, seeded.operator.principalId)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverables`)
          .send(definitionBody(seeded)),
    );
    expect(res.status, "a customer authored a deliverable").toBe(403);
    expect(await db.select().from(deliverables)).toHaveLength(0);
  });

  it("refuses a fact list edit from an ordinary member", async () => {
    const seeded = await seed();
    const admin = app(boardActor(seeded.company.id, seeded.owner.principalId, {
      isInstanceAdmin: true,
    }));
    await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/deliverables`)
        .send(definitionBody(seeded)),
    );

    const res = await call(
      app(boardActor(seeded.company.id, seeded.operator.principalId)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverables/weekly-project-review/facts`)
          .send({
            key: "revenue.total",
            label: "Revenue",
            sourceType: "human",
            derivation: "whatever I say it is",
            ownerAgentId: seeded.producer.id,
          }),
    );
    expect(res.status, "a customer edited the encoding artifact").toBe(403);
    expect(await db.select().from(deliverableFacts)).toHaveLength(0);
  });

  /**
   * G3's load-bearing half, attempted rather than asserted.
   *
   * The assembling agent must not be able to write its own acceptance tests. If
   * it could, running the check on a separate execution path would buy nothing:
   * self-certification would happen at definition time instead of at check
   * time, and would be invisible.
   */
  it("refuses an acceptance check written by the assembling agent itself", async () => {
    const seeded = await seed();
    const admin = app(boardActor(seeded.company.id, seeded.owner.principalId, {
      isInstanceAdmin: true,
    }));
    await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/deliverables`)
        .send(definitionBody(seeded)),
    );

    const res = await call(
      app(agentActor(seeded.company.id, seeded.assembler.id)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverables/weekly-project-review/checks`)
          .send({
            key: "always-passes",
            kind: "missing",
            config: { factKey: "labour.hours_booked" },
            severity: "blocking",
          }),
    );
    expect(res.status, "the assembler authored its own acceptance test").toBe(403);
    expect(await db.select().from(deliverableChecks)).toHaveLength(0);
  });

  // -- definition integrity -------------------------------------------------

  it("refuses one person holding both approver seats", async () => {
    const seeded = await seed();
    const res = await call(
      app(boardActor(seeded.company.id, seeded.owner.principalId, { isInstanceAdmin: true })),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverables`)
          .send({
            ...definitionBody(seeded),
            secondApproverUserId: seeded.approverOne.principalId,
          }),
    );
    // Two approvals from one human is one approval with extra ceremony, and G7
    // would then be satisfiable by a single decision.
    expect(res.status, "one person was given both approver seats").toBe(400);
    expect(await db.select().from(deliverables)).toHaveLength(0);
  });

  it("refuses a human fact owned by the agent that assembles the deliverable", async () => {
    const seeded = await seed();
    const admin = app(boardActor(seeded.company.id, seeded.owner.principalId, {
      isInstanceAdmin: true,
    }));
    await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/deliverables`)
        .send(definitionBody(seeded)),
    );

    const res = await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/deliverables/weekly-project-review/facts`)
        .send({
          key: "self.reported",
          label: "Something the assembler asks itself",
          sourceType: "human",
          derivation: "n/a",
          ownerAgentId: seeded.assembler.id,
        }),
    );
    // An agent asking itself would manufacture provenance for a figure nobody
    // produced — the fabrication the fact-request table's provenance exists to
    // make visible.
    expect(res.status, "the assembler was made the owner of a fact it must ask for").toBe(400);
    expect(await db.select().from(deliverableFacts)).toHaveLength(0);
  });

  it("refuses a system fact with no connector target at the database", async () => {
    const seeded = await seed();
    const created = await db
      .insert(deliverables)
      .values({
        companyId: seeded.company.id,
        key: "raw",
        name: "Raw",
        cadence: "weekly",
        assemblerAgentId: seeded.assembler.id,
        firstApproverUserId: seeded.approverOne.principalId,
        secondApproverUserId: seeded.approverTwo.principalId,
      })
      .returning()
      .then((rows) => rows[0]!);

    let refusal: unknown = null;
    try {
      await db.insert(deliverableFacts).values({
        companyId: seeded.company.id,
        deliverableId: created.id,
        key: "orphan",
        label: "Orphan",
        sourceType: "system",
        derivation: "nothing fetches this",
        ownerAgentId: seeded.producer.id,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal, "a system fact with nothing to fetch from was accepted").not.toBeNull();
    const cause = (refusal as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe("deliverable_facts_source_shape_ck");
  });

  // -- profile boundary -----------------------------------------------------

  it("404s the definition routes outside the mk profile", async () => {
    const seeded = await seed("default");
    const res = await call(
      app(boardActor(seeded.company.id, seeded.owner.principalId, { isInstanceAdmin: true })),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverables`)
          .send(definitionBody(seeded)),
    );
    expect(res.status, "a profile-only route answered 403 instead of 404").toBe(404);
  });

  it("refuses a definition that crosses a company boundary", async () => {
    const first = await seed();
    const second = await seed();
    const res = await call(
      app(boardActor(first.company.id, first.owner.principalId, { isInstanceAdmin: true })),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${first.company.id}/deliverables`)
          .send({ ...definitionBody(first), assemblerAgentId: second.assembler.id }),
    );
    expect(res.status, "a deliverable was assembled by another company's agent").toBe(404);
  });
});

/**
 * G1g. Every exported function reachable from a route or a scheduler tick, and
 * provable by grep rather than by reading. `buildApprovalKeyboard` shipped here
 * with nine passing tests and no caller at all.
 */
describe("deliverable definition wiring", () => {
  it("mounts the deliverable routes in the real app", () => {
    const appSource = readFileSync(path.join(repoRoot, "server/src/app.ts"), "utf8");
    expect(
      appSource.includes("deliverableRoutes(db)"),
      "deliverableRoutes has no non-test caller; the definition surface is unreachable",
    ).toBe(true);
  });
});
