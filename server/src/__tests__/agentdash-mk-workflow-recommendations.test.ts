import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentStewardships,
  agents,
  approvalComments,
  approvals,
  companies,
  companyMemberships,
  createDb,
  deliverableChecks,
  deliverableFacts,
  deliverableRuns,
  deliverables,
  factCorrections,
  factValues,
  workflowEvents,
  workflowRecommendations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { workflowRecommendationRoutes } from "../routes/workflow-recommendations.js";
import { deliverableReviewService } from "../services/deliverable-review.js";
import { workflowEventsService } from "../services/workflow-events.js";
import { workflowRecommendationService } from "../services/workflow-recommendations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const repoRoot = path.resolve(import.meta.dirname, "../../..");

/**
 * AgentDash-MK Slice H — the review agent's RECOMMENDATION half.
 *
 * Slice B built measurement. This builds recommendation: an org-level reader of
 * accumulated `workflow_events` that surfaces suggestions for a human to
 * approve. **It observes and suggests; it never acts.**
 *
 * The constraint that shapes every test below is the one B made structural and
 * G resolved again by seat: an agent measuring "efficiency across human-agent
 * workflows" is, from an employee's chair, an agent watching how fast they
 * respond and how much help they needed. So the interesting assertions here are
 * the negative ones — what this surface refuses to say, and what the database
 * refuses to store even when the service is bypassed.
 */

/** G1. Every new exported function reached from a non-test caller. */
describe("workflow recommendation wiring", () => {
  it.each([
    ["workflowRecommendationRoutes", "server/src/app.ts"],
    ["sweepRecommendations", "server/src/index.ts"],
    ["settleRecommendationApproval", "server/src/routes/approvals.ts"],
    ["workflowRecommendationService", "server/src/routes/workflow-recommendations.ts"],
    // B's query surface, reached from H rather than from a second query of its
    // own. A second reader with its own SQL would be a second place the person
    // dimension could reappear.
    ["metricsForPipeline", "server/src/services/workflow-recommendations.ts"],
    ["listMeasuredPipelines", "server/src/services/workflow-recommendations.ts"],
    ["renderRecommendationStatement", "server/src/services/workflow-recommendations.ts"],
    ["isSeatShapedStepKey", "server/src/services/workflow-recommendations.ts"],
  ])("%s has a non-test caller in %s", (fnName, file) => {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    expect(source.includes(`${fnName}(`), `${fnName} has no non-test caller`).toBe(true);
  });

  /**
   * There is no authoring route, and that is load-bearing rather than an
   * omission. Every word a recommendation says is rendered from a step key and
   * a count, so there is no free-text field in which a person's name could
   * arrive from a caller.
   */
  it("exposes no route that creates a recommendation", () => {
    const source = readFileSync(
      path.join(repoRoot, "server/src/routes/workflow-recommendations.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/router\.(post|put|patch)\(/);
  });
});

describeEmbeddedPostgres("agentdash-mk workflow recommendations", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-wf-rec-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function purge(table: Parameters<TestDb["delete"]>[0], attempts = 20) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await db.delete(table);
        return;
      } catch (error) {
        if (attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  afterEach(async () => {
    await purge(workflowRecommendations);
    await purge(workflowEvents);
    await purge(factValues);
    await purge(factCorrections);
    await purge(deliverableRuns);
    await purge(deliverableChecks);
    await purge(deliverableFacts);
    await purge(deliverables);
    await purge(approvalComments);
    await purge(approvals);
    await purge(activityLog);
    await purge(agentStewardships);
    await purge(agents);
    await purge(companyMemberships);
    await purge(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const DELIVERABLE_KEY = "weekly-project-review";
  const PIPELINE_ID = `deliverable:${DELIVERABLE_KEY}`;
  const CORRECTED_FACT = "labour.hours_booked";
  const STALLED_FACT = "labour.hours_forecast";

  function boardActor(companyId: string, userId: string, isInstanceAdmin = false) {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    };
  }

  function createApp(mount: (app: express.Express) => void, actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor, companyIds: [...((actor.companyIds as string[]) ?? [])] };
      next();
    });
    mount(app);
    app.use(errorHandler);
    return app;
  }

  async function call(app: express.Express, build: (baseUrl: string) => request.Test) {
    const server = createServer(app);
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

  function recommendationApp(actor: Record<string, unknown>) {
    return createApp((app) => app.use("/api", workflowRecommendationRoutes(db)), actor);
  }

  function approvalApp(actor: Record<string, unknown>) {
    return createApp((app) => app.use("/api", approvalRoutes(db)), actor);
  }

  function decision(revision = 1) {
    return { revision, idempotencyKey: `web-${randomUUID()}`, channel: "web" };
  }

  /**
   * A company with one deliverable, two facts, and two named approvers.
   *
   * Deliberately does NOT drive a real cycle end to end: this suite is about
   * what the derivation reads, and the events below are written by B's real
   * emitters. What has never happened anywhere — here or in production — is a
   * real weekly cycle, and no test in this file pretends otherwise.
   */
  async function seed(profile: "agentdash_mk" | "default" = "agentdash_mk") {
    const company = await db
      .insert(companies)
      .values({
        name: `Rec ${randomUUID()}`,
        issuePrefix: `RC${randomUUID().slice(0, 6).toUpperCase()}`,
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

    const owner = await member("owner");
    const approverOne = await member("operator");
    const approverTwo = await member("operator");
    const bystander = await member("operator");

    const assembler = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Assembler ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
      })
      .returning()
      .then((rows) => rows[0]!);

    const deliverable = await db
      .insert(deliverables)
      .values({
        companyId: company.id,
        key: DELIVERABLE_KEY,
        name: "Weekly project review",
        cadence: "weekly",
        assemblerAgentId: assembler.id,
        firstApproverUserId: approverOne.principalId,
        secondApproverUserId: approverTwo.principalId,
      })
      .returning()
      .then((rows) => rows[0]!);

    const facts: Record<string, string> = {};
    for (const [index, key] of [CORRECTED_FACT, STALLED_FACT].entries()) {
      const fact = await db
        .insert(deliverableFacts)
        .values({
          companyId: company.id,
          deliverableId: deliverable.id,
          key,
          label: key,
          sourceType: "human",
          derivation: "Supplied by the owning agent.",
          ownerAgentId: assembler.id,
          orderIndex: index,
        })
        .returning()
        .then((rows) => rows[0]!);
      facts[key] = fact.id;
    }

    return { company, owner, approverOne, approverTwo, bystander, assembler, deliverable, facts };
  }

  /**
   * The constraint that refused a write, or null if nothing did.
   *
   * Named rather than pattern-matched on the message: these assertions are the
   * proof that a rule lives in the database and not in a service somebody can
   * rewrite, so the test has to fail if the write starts being refused by a
   * DIFFERENT constraint that happens to also throw.
   */
  async function refusedBy(write: Promise<unknown>): Promise<string | null> {
    try {
      await write;
      return null;
    } catch (error) {
      return (error as { cause?: { constraint_name?: string } }).cause?.constraint_name ?? "";
    }
  }

  /** One cycle's carrier row. The events inside it are written for real. */
  async function openCycle(companyId: string, deliverableId: string, runKey: string) {
    return db
      .insert(deliverableRuns)
      .values({ companyId, deliverableId, runKey, status: "collecting" })
      .returning()
      .then((rows) => rows[0]!);
  }

  /**
   * Accumulate `cycles` cycles of real events.
   *
   * Corrections go through `deliverableReviewService.recordCorrection`, the
   * same call an approver's correction takes. The escalation expiries go
   * through `workflowEventsService.emit`, B's real emitter with its real
   * allowlist and the real database constraints — a fact-lease sweep is a
   * different slice's machinery and reproducing it here would test that slice.
   */
  async function accumulate(
    seeded: Awaited<ReturnType<typeof seed>>,
    cycles: number,
    options: { correct?: boolean; stall?: boolean } = { correct: true, stall: true },
  ) {
    const review = deliverableReviewService(db);
    const events = workflowEventsService(db);
    const runIds: string[] = [];
    // Continue the calendar rather than restarting it, so a second call adds a
    // fourth cycle instead of colliding with the first week.
    const alreadyRun = await db
      .select({ id: deliverableRuns.id })
      .from(deliverableRuns)
      .where(eq(deliverableRuns.deliverableId, seeded.deliverable.id));
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const run = await openCycle(
        seeded.company.id,
        seeded.deliverable.id,
        `2026-W${String(20 + alreadyRun.length + cycle).padStart(2, "0")}`,
      );
      runIds.push(run.id);

      await events.emit({
        companyId: seeded.company.id,
        pipelineId: PIPELINE_ID,
        runId: run.id,
        stepKey: CORRECTED_FACT,
        eventType: "fact_asked",
        actorKind: "agent",
        payload: { factKey: CORRECTED_FACT },
      });

      if (options.correct !== false) {
        await review.recordCorrection(
          seeded.company.id,
          run.id,
          {
            factKey: CORRECTED_FACT,
            correction: { kind: "annotate", note: "the derivation reads the wrong column" },
            reason: "the derivation reads the wrong column",
          },
          seeded.approverOne.principalId,
        );
      }

      if (options.stall !== false) {
        await events.emit({
          companyId: seeded.company.id,
          pipelineId: PIPELINE_ID,
          runId: run.id,
          stepKey: STALLED_FACT,
          eventType: "escalation_opened",
          actorKind: "agent",
          payload: { taskClass: "read", approvalGated: false },
        });
        await events.emit({
          companyId: seeded.company.id,
          pipelineId: PIPELINE_ID,
          runId: run.id,
          stepKey: STALLED_FACT,
          eventType: "escalation_expired",
          actorKind: "system",
          durationMs: 4 * 60 * 60 * 1000,
          payload: { taskClass: "read", outcome: "missing", requeued: false },
        });
      }
    }
    return runIds;
  }

  // -------------------------------------------------------------------------
  // H5 — derived from real accumulated events, read through B's query surface
  // -------------------------------------------------------------------------

  it("H5: raises nothing below three accumulated cycles, and raises on the third", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);

    await accumulate(seeded, 2);
    // At the derivation as well as at the outcome. The table also refuses
    // anything below three cycles, so a test that only watched the table could
    // not tell whether the floor was being applied or merely backstopped.
    expect(await svc.derive(seeded.company.id, PIPELINE_ID)).toEqual([]);
    expect((await svc.sweepRecommendations()).raised).toBe(0);
    expect(await svc.list(seeded.company.id, { recipientUserId: seeded.approverOne.principalId }))
      .toHaveLength(0);

    await accumulate(seeded, 1);
    // Two cycles already there plus one more is three: the plan's own floor.
    const swept = await svc.sweepRecommendations();
    expect(swept.raised).toBeGreaterThan(0);

    const raised = await svc.list(seeded.company.id, {
      recipientUserId: seeded.approverOne.principalId,
    });
    expect(raised.map((row) => row.kind).sort()).toEqual([
      "chronic_escalation_stall",
      "recurring_correction",
    ]);
  });

  it("H5: reads the events that exist, not a shape nothing emits", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    // Corrections but no escalations: exactly one of the two kinds may fire.
    await accumulate(seeded, 3, { correct: true, stall: false });
    await svc.sweepRecommendations();
    const raised = await svc.list(seeded.company.id, {
      recipientUserId: seeded.approverOne.principalId,
    });
    expect(raised.map((row) => row.kind)).toEqual(["recurring_correction"]);
  });

  it("H5: a company outside agentdash_mk accumulates nothing and is never swept", async () => {
    const seeded = await seed("default");
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 4);
    // B declines to record for a default-profile company, so there is nothing
    // to derive from — the profile boundary holds without H restating it.
    expect(await db.select().from(workflowEvents)).toHaveLength(0);
    expect((await svc.sweepRecommendations()).raised).toBe(0);
  });

  // -------------------------------------------------------------------------
  // H4 — every recommendation cites its evidence
  // -------------------------------------------------------------------------

  it("H4: cites event ids that resolve to real rows, plus a reproducible query", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    await svc.sweepRecommendations();

    const raised = await svc.list(seeded.company.id, {
      recipientUserId: seeded.approverOne.principalId,
    });
    expect(raised.length).toBeGreaterThan(0);

    for (const recommendation of raised) {
      expect(recommendation.evidence.eventIds.length).toBeGreaterThanOrEqual(3);
      const rows = await db
        .select({
          id: workflowEvents.id,
          pipelineId: workflowEvents.pipelineId,
          stepKey: workflowEvents.stepKey,
          runId: workflowEvents.runId,
        })
        .from(workflowEvents)
        .where(inArray(workflowEvents.id, recommendation.evidence.eventIds));
      // Every cited id is a real row, on this pipeline, on this step.
      expect(rows).toHaveLength(recommendation.evidence.eventIds.length);
      for (const row of rows) {
        expect(row.pipelineId).toBe(PIPELINE_ID);
        expect(row.stepKey).toBe(recommendation.stepKey);
      }
      // The evidence spans at least three distinct cycles, which is the claim.
      expect(new Set(rows.map((row) => row.runId)).size).toBeGreaterThanOrEqual(3);
      expect(recommendation.evidence.query).toContain(PIPELINE_ID);
      expect(recommendation.evidence.query).toContain(recommendation.stepKey);
    }
  });

  it("H4 adversarial: the database refuses a recommendation citing nothing", async () => {
    const seeded = await seed();
    expect(
      await refusedBy(
        db.insert(workflowRecommendations).values({
          companyId: seeded.company.id,
          pipelineId: PIPELINE_ID,
          stepKey: CORRECTED_FACT,
          kind: "recurring_correction",
          cyclesObserved: 3,
          evidenceCycles: 3,
          observation: { cyclesObserved: 3, cyclesWithEvidence: 3 },
          // An opinion, not a recommendation.
          evidence: { query: "select 1", runIds: [], eventIds: [], eventTypes: [] },
          recipientUserId: seeded.approverOne.principalId,
          latestRunId: randomUUID(),
        }),
      ),
    ).toBe("workflow_recommendations_cites_evidence_ck");
  });

  // -------------------------------------------------------------------------
  // H2 — pipelines, steps and seats; never individuals
  // -------------------------------------------------------------------------

  /**
   * Five cycles in which a seat carries BOTH the realistic signal (a seat
   * waiting three days) and the adversarial one: events of exactly the kinds
   * the derivation does read, on a seat-shaped step key. If the derivation
   * looked at steps without asking what a step is, this is the input that
   * would make it emit "seat one is your bottleneck" — a sentence with no
   * reading that is not "this named colleague is slow", because a deliverable
   * names exactly one user per seat on its own row.
   */
  async function accumulateSeatPressure(seeded: Awaited<ReturnType<typeof seed>>) {
    const events = workflowEventsService(db);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const run = await openCycle(
        seeded.company.id,
        seeded.deliverable.id,
        `2026-W${String(30 + cycle)}`,
      );
      for (const [stepKey, actorRole] of [
        ["approval.first", "approver_1"],
        ["approval.second", "approver_2"],
      ]) {
        await events.emit({
          companyId: seeded.company.id,
          pipelineId: PIPELINE_ID,
          runId: run.id,
          stepKey,
          eventType: "approval_decided",
          actorKind: "human",
          durationMs: 3 * 24 * 60 * 60 * 1000,
          payload: {
            approvalType: "deliverable_review",
            decision: "approved",
            actorRole,
            channel: "web",
          },
        });
        // The injection: derivable event kinds, on a seat.
        await events.emit({
          companyId: seeded.company.id,
          pipelineId: PIPELINE_ID,
          runId: run.id,
          stepKey,
          eventType: "correction_recorded",
          actorKind: "human",
          payload: { correctionChars: 40 },
        });
        await events.emit({
          companyId: seeded.company.id,
          pipelineId: PIPELINE_ID,
          runId: run.id,
          stepKey,
          eventType: "escalation_expired",
          actorKind: "system",
          durationMs: 3 * 24 * 60 * 60 * 1000,
          payload: { taskClass: "read", outcome: "missing", requeued: false },
        });
      }
    }
  }

  it("H2 adversarial: the derivation will not even propose a seat as a subject", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulateSeatPressure(seeded);

    // Asserted on `derive` rather than on the swept outcome, because the
    // database also refuses a seat-shaped subject and a test that only watched
    // the table could not tell which mechanism held. Both must.
    const derived = await svc.derive(seeded.company.id, PIPELINE_ID);
    expect(
      derived.map((candidate) => candidate.stepKey),
      "the derivation proposed a recommendation about an approval seat",
    ).toEqual([]);
  });

  it("H2 adversarial: no recommendation about a seat survives a real sweep", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulateSeatPressure(seeded);

    expect((await svc.sweepRecommendations()).raised).toBe(0);
    expect(await db.select().from(workflowRecommendations)).toHaveLength(0);
  });

  it("H2 adversarial: the database refuses a seat-shaped subject even when the service is bypassed", async () => {
    const seeded = await seed();
    for (const stepKey of ["approval.first", "approval.second", "approver_1"]) {
      expect(
        await refusedBy(
          db.insert(workflowRecommendations).values({
            companyId: seeded.company.id,
            pipelineId: PIPELINE_ID,
            stepKey,
            kind: "recurring_correction",
            cyclesObserved: 3,
            evidenceCycles: 3,
            observation: { cyclesObserved: 3, cyclesWithEvidence: 3 },
            evidence: {
              query: "select 1",
              runIds: [randomUUID()],
              eventIds: [randomUUID()],
              eventTypes: ["correction_recorded"],
            },
            recipientUserId: seeded.approverOne.principalId,
            latestRunId: randomUUID(),
          }),
        ),
        `${stepKey} was accepted as a recommendation subject`,
      ).toBe("workflow_recommendations_step_not_a_seat_ck");
    }
  });

  it("H2 adversarial: the database refuses an identifier-shaped key in the observation or evidence", async () => {
    const seeded = await seed();
    const base = {
      companyId: seeded.company.id,
      pipelineId: PIPELINE_ID,
      stepKey: CORRECTED_FACT,
      kind: "recurring_correction" as const,
      cyclesObserved: 3,
      evidenceCycles: 3,
      recipientUserId: seeded.approverOne.principalId,
      latestRunId: randomUUID(),
    };
    const goodEvidence = {
      query: "select 1",
      runIds: [randomUUID()],
      eventIds: [randomUUID()],
      eventTypes: ["correction_recorded"],
    };

    expect(
      await refusedBy(
        db.insert(workflowRecommendations).values({
          ...base,
          observation: {
            cyclesObserved: 3,
            cyclesWithEvidence: 3,
            userId: seeded.owner.principalId,
          },
          evidence: goodEvidence,
        }),
      ),
    ).toBe("workflow_recommendations_no_person_ck");

    expect(
      await refusedBy(
        db.insert(workflowRecommendations).values({
          ...base,
          observation: { cyclesObserved: 3, cyclesWithEvidence: 3 },
          evidence: { ...goodEvidence, answeredByUserId: seeded.owner.principalId },
        }),
      ),
    ).toBe("workflow_recommendations_no_person_ck");
  });

  it("H2: nothing in what is served names a person except the addressee", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    await svc.sweepRecommendations();

    const response = await call(
      recommendationApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl).get(`/api/companies/${seeded.company.id}/workflow-recommendations`),
    );
    expect(response.status).toBe(200);
    const body = JSON.stringify(response.body);

    // The addressee is present exactly because a recommendation has to reach
    // somebody. Everyone else — the second approver, the owner, a bystander,
    // the assembling agent — must be absent.
    for (const identifier of [
      seeded.approverTwo.principalId,
      seeded.owner.principalId,
      seeded.bystander.principalId,
      seeded.assembler.id,
    ]) {
      expect(body, `${identifier} leaked into the recommendation surface`).not.toContain(
        identifier,
      );
    }
    // And the statement itself, which is the part a human reads.
    for (const recommendation of response.body.recommendations as Array<{ statement: string }>) {
      expect(recommendation.statement).not.toContain(seeded.approverOne.principalId);
      expect(recommendation.statement).toContain(DELIVERABLE_KEY);
    }
  });

  // -------------------------------------------------------------------------
  // H3 — the surface defaults to the pipeline owner, not up the org chart
  // -------------------------------------------------------------------------

  it("H3: the recipient is the pipeline owner — the first approver, not the second", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    await svc.sweepRecommendations();

    const rows = await db.select().from(workflowRecommendations);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.recipientUserId).toBe(seeded.approverOne.principalId);
    }
  });

  it("H3 adversarial: the more senior seat sees nothing by default", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    await svc.sweepRecommendations();

    for (const stranger of [seeded.approverTwo, seeded.bystander, seeded.owner]) {
      const response = await call(
        recommendationApp(boardActor(seeded.company.id, stranger.principalId)),
        (baseUrl) =>
          request(baseUrl).get(`/api/companies/${seeded.company.id}/workflow-recommendations`),
      );
      expect(response.status).toBe(200);
      expect(
        response.body.recommendations,
        `${stranger.membershipRole} was shown somebody else's recommendations`,
      ).toHaveLength(0);
    }
  });

  it("H3: a pipeline with no resolvable owner raises nothing", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    const events = workflowEventsService(db);
    // `bridge:act` is a real pipeline id with real accumulated events and no
    // owner. Routing it up the org chart is the failure mode, so it is not
    // routed at all.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const runId = randomUUID();
      await events.emit({
        companyId: seeded.company.id,
        pipelineId: "bridge:act",
        runId,
        stepKey: "execution",
        eventType: "escalation_expired",
        actorKind: "system",
        durationMs: 60_000,
        payload: { taskClass: "act", outcome: "expired", requeued: false },
      });
    }
    expect((await svc.sweepRecommendations()).raised).toBe(0);
  });

  it("H3: the profile-only route answers 404 outside agentdash_mk", async () => {
    const seeded = await seed("default");
    const response = await call(
      recommendationApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl).get(`/api/companies/${seeded.company.id}/workflow-recommendations`),
    );
    expect(response.status).toBe(404);
  });

  it("H3: an agent key is refused; a recommendation is a human's to read", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    await svc.sweepRecommendations();

    const response = await call(
      createApp((app) => app.use("/api", workflowRecommendationRoutes(db)), {
        type: "agent",
        agentId: seeded.assembler.id,
        companyId: seeded.company.id,
        source: "agent_key",
        companyIds: [seeded.company.id],
      }),
      (baseUrl) =>
        request(baseUrl).get(`/api/companies/${seeded.company.id}/workflow-recommendations`),
    );
    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // H1 — advisory, through the approvals service, and it never acts
  // -------------------------------------------------------------------------

  it("H1: a raised recommendation opens an approval addressed to the pipeline owner", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    await svc.sweepRecommendations();

    const rows = await db.select().from(workflowRecommendations);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.approvalId).not.toBeNull();
      const approval = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, row.approvalId!))
        .then((found) => found[0]!);
      expect(approval.type).toBe("workflow_recommendation");
      expect(approval.status).toBe("pending");
      // Not the requesting agent's steward: who reads this is a property of the
      // pipeline, and the approvals service is the only decision boundary.
      expect((approval.payload as Record<string, unknown>).approverUserId).toBe(
        seeded.approverOne.principalId,
      );
      expect(approval.requestedByAgentId).toBeNull();
    }
  });

  it("H1 adversarial: only the addressed owner may decide it", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    await svc.sweepRecommendations();
    const row = (await db.select().from(workflowRecommendations))[0]!;

    for (const stranger of [seeded.approverTwo, seeded.bystander]) {
      const refused = await call(
        approvalApp(boardActor(seeded.company.id, stranger.principalId)),
        (baseUrl) =>
          request(baseUrl)
            .post(`/api/approvals/${row.approvalId}/approve`)
            .send({ ...decision() }),
      );
      expect(refused.status).toBe(403);
    }
  });

  it("H1: approving accepts the recommendation and changes nothing else", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    await svc.sweepRecommendations();
    const row = (
      await db
        .select()
        .from(workflowRecommendations)
        .where(eq(workflowRecommendations.kind, "recurring_correction"))
    )[0]!;

    const before = {
      deliverable: await db
        .select()
        .from(deliverables)
        .where(eq(deliverables.id, seeded.deliverable.id))
        .then((rows) => rows[0]!),
      facts: await db
        .select()
        .from(deliverableFacts)
        .where(eq(deliverableFacts.deliverableId, seeded.deliverable.id)),
      corrections: await db.select().from(factCorrections),
      values: await db.select().from(factValues),
    };

    const approved = await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/approvals/${row.approvalId}/approve`)
          .send({ ...decision() }),
    );
    expect(approved.status).toBe(200);

    const after = await db
      .select()
      .from(workflowRecommendations)
      .where(eq(workflowRecommendations.id, row.id))
      .then((rows) => rows[0]!);
    expect(after.status).toBe("accepted");
    expect(after.decidedAt).not.toBeNull();

    // "Accepted" is a record of a human agreeing, and nothing more. The
    // encoding change it suggests is an implementer's to make.
    expect(
      await db
        .select()
        .from(deliverables)
        .where(eq(deliverables.id, seeded.deliverable.id))
        .then((rows) => rows[0]!),
    ).toEqual(before.deliverable);
    expect(
      await db
        .select()
        .from(deliverableFacts)
        .where(eq(deliverableFacts.deliverableId, seeded.deliverable.id)),
    ).toEqual(before.facts);
    expect(await db.select().from(factCorrections)).toEqual(before.corrections);
    expect(await db.select().from(factValues)).toEqual(before.values);
  });

  it("H1: rejecting declines it, and the same evidence does not come back", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    await svc.sweepRecommendations();
    const row = (
      await db
        .select()
        .from(workflowRecommendations)
        .where(eq(workflowRecommendations.kind, "recurring_correction"))
    )[0]!;

    const rejected = await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/approvals/${row.approvalId}/reject`)
          .send({ ...decision(), decisionNote: "the derivation is being rewritten already" }),
    );
    expect(rejected.status).toBe(200);
    expect(
      await db
        .select()
        .from(workflowRecommendations)
        .where(eq(workflowRecommendations.id, row.id))
        .then((rows) => rows[0]!.status),
    ).toBe("declined");

    // Sweeping again on the same evidence must not re-ask. A surface that
    // repeats a declined suggestion every tick is a surface people stop reading.
    await svc.sweepRecommendations();
    expect(
      await db
        .select()
        .from(workflowRecommendations)
        .where(
          and(
            eq(workflowRecommendations.kind, "recurring_correction"),
            eq(workflowRecommendations.status, "open"),
          ),
        ),
    ).toHaveLength(0);
  });

  it("H1: a declined recommendation returns only when the evidence has grown", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    await svc.sweepRecommendations();
    const row = (
      await db
        .select()
        .from(workflowRecommendations)
        .where(eq(workflowRecommendations.kind, "recurring_correction"))
    )[0]!;
    await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/approvals/${row.approvalId}/reject`)
          .send({ ...decision(), decisionNote: "not now" }),
    );

    // A fourth cycle corrects the same fact again: the condition did not go
    // away, it got worse, and that is a new thing to say.
    await accumulate(seeded, 1);
    await svc.sweepRecommendations();
    const open = await db
      .select()
      .from(workflowRecommendations)
      .where(
        and(
          eq(workflowRecommendations.kind, "recurring_correction"),
          eq(workflowRecommendations.status, "open"),
        ),
      );
    expect(open).toHaveLength(1);
    expect(open[0]!.evidenceCycles).toBe(4);
  });

  it("H1: sweeping twice raises one recommendation, not one per tick", async () => {
    const seeded = await seed();
    const svc = workflowRecommendationService(db);
    await accumulate(seeded, 3);
    const first = await svc.sweepRecommendations();
    const second = await svc.sweepRecommendations();
    expect(second.raised).toBe(0);
    expect(await db.select().from(workflowRecommendations)).toHaveLength(first.raised);
  });
});
