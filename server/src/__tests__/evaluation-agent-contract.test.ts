import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, createDb, evaluationEvents, projects } from "@paperclipai/db";
import { evaluationContractV2Schema, evaluationContractVersionOf } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { profileBody, responsibility } from "./helpers/responsibility-fixtures.js";
import { agentContractSourceId, buildAgentContractV2, declareAgentContract } from "../services/evaluation/agent-contract.js";
import { evaluationReplay } from "../services/evaluation/replay.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: Agent Performance Management gate 2 (P2.4) — `declareAgentContract`
 * against a real ledger: the append path, dedupe per profile revision, the
 * activity row, and that a milestone replay never reads it as a milestone
 * contract version.
 */
describeEmbeddedPostgres("declareAgentContract", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-contract-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const [company] = await db
      .insert(companies)
      .values({ name: `Contract ${randomUUID()}`, issuePrefix: `CT${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company!.id, name: "Reporter", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: {} })
      .returning();
    const body = profileBody([
      responsibility("weekly-report", {
        performance: {
          criteria: [
            { id: "c1", text: "Report shipped", check: { kind: "record", record: "deliverable.shipped" }, source: "human" },
            { id: "c2", text: "Numbers reconcile", source: "human" },
          ],
          coverage: ["deliverable_shipped", "human_acceptance"],
          deadline: { kind: "after_trigger", hours: 4 },
          outcomeLinks: [],
          expectedHumanSteps: ["sign_off"],
          judges: { automated: ["independent_agent"], human: { userId: "user-vp", sampleRate: 0.25, minPerWindow: 1 } },
          thresholds: null,
        },
      }),
      responsibility("ad-hoc"),
    ]);
    return { companyId: company!.id, agentId: agent!.id, body };
  }

  const contractEvents = (companyId: string) =>
    db
      .select()
      .from(evaluationEvents)
      .where(and(eq(evaluationEvents.companyId, companyId), eq(evaluationEvents.eventType, "contract.declared")));

  it("builds a V2 contract with one entry per responsibility, carrying its performance contract under its key", async () => {
    const { companyId, agentId, body } = await seed();
    const revisionId = randomUUID();
    const contract = buildAgentContractV2({ companyId, agentId, profileRevisionId: revisionId, body, accountableUserId: "user-vp" });
    expect(evaluationContractV2Schema.parse(contract)).toEqual(contract);
    expect(contract).toMatchObject({
      contractVersion: "v2",
      companyId,
      subjectRef: { kind: "agent", id: agentId },
      accountableUserId: "user-vp",
      profileRevisionId: revisionId,
      independenceRule: "independence/v1",
    });
    expect(contract.responsibilities.map((r) => r.key)).toEqual(["weekly-report", "ad-hoc"]);
    expect(contract.responsibilities[0]).toMatchObject({ coverage: ["deliverable_shipped", "human_acceptance"], expectedHumanSteps: ["sign_off"] });
    expect(contract.responsibilities[0]!.criteria.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("appends contract.declared through the ledger, idempotent per profile revision", async () => {
    const { companyId, agentId, body } = await seed();
    const revisionId = randomUUID();
    const actor = { actorType: "user" as const, actorId: "approver-1" };
    const first = await declareAgentContract(db, { companyId, agentId, profileRevisionId: revisionId, body, accountableUserId: "user-vp", actor });
    expect(first.inserted).toBe(true);

    // A resumed application, even with a different accountable user, finds the same event.
    const again = await declareAgentContract(db, { companyId, agentId, profileRevisionId: revisionId, body, accountableUserId: "someone-else", actor });
    expect(again).toEqual({ eventId: first.eventId, inserted: false });

    const events = await contractEvents(companyId);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      id: first.eventId,
      projectId: null,
      goalId: null,
      actorType: "user",
      actorId: "approver-1",
      sourceTable: "evaluation_contracts",
      sourceId: agentContractSourceId(agentId),
      sourceVersion: `revision:${revisionId}`,
    });
    expect(evaluationContractVersionOf(event!.payload)).toBe("v2");
    const stored = evaluationContractV2Schema.parse((event!.payload as { contract: unknown }).contract);
    expect(stored.accountableUserId).toBe("user-vp");
    expect(stored.subjectRef).toEqual({ kind: "agent", id: agentId });

    // One activity row, for the one mutation.
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "evaluation.contract_declared")));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: "user", actorId: "approver-1", entityType: "agent", entityId: agentId });
    expect(activity[0]!.details).toMatchObject({ contractVersion: "v2", eventId: first.eventId, profileRevisionId: revisionId, responsibilities: 2, criteria: 3 });
  });

  it("a new revision declares a new contract version", async () => {
    const { companyId, agentId, body } = await seed();
    const actor = { actorType: "system" as const, actorId: "profile-application" };
    const a = await declareAgentContract(db, { companyId, agentId, profileRevisionId: randomUUID(), body, accountableUserId: null, actor });
    const b = await declareAgentContract(db, { companyId, agentId, profileRevisionId: randomUUID(), body: profileBody([responsibility("ad-hoc")]), accountableUserId: null, actor });
    expect(a.inserted && b.inserted).toBe(true);
    expect(a.eventId).not.toBe(b.eventId);
    expect(await contractEvents(companyId)).toHaveLength(2);
  });

  it("is not read as a milestone contract version by a real replay", async () => {
    const { companyId, agentId, body } = await seed();
    const [project] = await db.insert(projects).values({ companyId, name: "Launch" }).returning();
    await declareAgentContract(db, { companyId, agentId, profileRevisionId: randomUUID(), body, accountableUserId: null, actor: { actorType: "user", actorId: "approver-1" } });
    const { card, state } = await evaluationReplay(db).replay(companyId, { kind: "project", id: project!.id });
    expect(card.contract.invalidVersions).toBe(0);
    expect(card.contract.source).toBe("derived");
    expect(state.hasContract).toBe(false);
  });

  it("refuses a body that cannot form a contract, and appends nothing", async () => {
    const { companyId, agentId } = await seed();
    const duplicate = profileBody([responsibility("same"), responsibility("same")]);
    await expect(
      declareAgentContract(db, { companyId, agentId, profileRevisionId: randomUUID(), body: duplicate, accountableUserId: null, actor: { actorType: "user", actorId: "approver-1" } }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await contractEvents(companyId)).toHaveLength(0);
  });
});
