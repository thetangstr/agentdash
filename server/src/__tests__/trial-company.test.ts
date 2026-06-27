// AgentDash (Test Drive): integration tests for the autonomous-COMPANY flow.
//
// Covers trialService.designCompany / runAgentFirstTask / getCompany with an
// injected dispatch seam, plus the public routes (design -> run each agent ->
// getCompany) with a module-mocked dispatch so no test hits the network.

import express from "express";
import request from "supertest";
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Module-mock the LLM dispatch so the route's internal trialService never calls
// out. The mock branches on the system prompt: a design call returns a company
// design JSON; an agent first-task call returns markdown.
const mockDispatch = vi.hoisted(() => vi.fn());
vi.mock("../services/dispatch-llm.js", () => ({
  dispatchLLM: mockDispatch,
}));

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createDb, trialSessions, trialArtifacts, agents as agentsTable } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  trialService,
  TrialCreditExhaustedError,
  TrialAgentNotFoundError,
} from "../services/trial.ts";
import { trialRoutes } from "../routes/trial.ts";
import { errorHandler } from "../middleware/index.js";

const DESIGN_PAYLOAD = {
  companyName: "FreightPilot",
  mission: "Help freight brokers move faster with autonomous ops.",
  agents: [
    {
      ref: "outbound-gtm",
      name: "Scout",
      role: "outbound_sales",
      category: "outbound · gtm",
      charter: "Owns finding and opening conversations with target brokers.",
      firstTaskTitle: "Draft the first outbound sequence",
      firstTaskBrief: "Define the ICP and write a 3-touch sequence.",
    },
    {
      ref: "market-research",
      name: "Atlas",
      role: "market_research",
      category: "research · market",
      charter: "Owns market and competitor intelligence.",
      firstTaskTitle: "Map the landscape",
      firstTaskBrief: "Produce a concise market landscape.",
    },
    {
      ref: "content",
      name: "Quill",
      role: "content",
      category: "content · brand",
      charter: "Owns the story and content.",
      firstTaskTitle: "Draft a launch narrative",
      firstTaskBrief: "Write positioning + 3 content ideas.",
    },
  ],
};

const AGENT_MARKDOWN = "# Outbound Sequence Plan\n\nHere is a concrete, sendable plan.\n\n- Touch 1\n- Touch 2";

const INTAKE = {
  whatYouDo: "We run a logistics SaaS for freight brokers",
  goal: "land 20 design partners",
  blocker: "no outbound yet",
};

/** Branch on the prompt: design calls get the design JSON, runs get markdown. */
function smartDispatch(input: { system: string }): Promise<string> {
  if (input.system.includes("Chief of Staff")) {
    return Promise.resolve(JSON.stringify(DESIGN_PAYLOAD));
  }
  return Promise.resolve(AGENT_MARKDOWN);
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres trial-company tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Test Drive autonomous company (integration)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-vitest-trial-company-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation((input: { system: string }) => smartDispatch(input));
  });

  // -------------------------------------------------------------------------
  // Service
  // -------------------------------------------------------------------------

  it("designCompany provisions 3-4 agents, returns the plan, persists it, and deducts credit", async () => {
    const dispatch = vi.fn((input: { system: string }) => smartDispatch(input));
    const svc = trialService(db, { dispatch });
    const session = await svc.createSession();

    const result = await svc.designCompany(session.token, INTAKE);

    expect(result.company.name).toBe("FreightPilot");
    expect(result.agents.length).toBeGreaterThanOrEqual(3);
    expect(result.agents.length).toBeLessThanOrEqual(4);
    for (const a of result.agents) {
      expect(a.id).toBeTruthy();
      expect(a.status).toBe("idle");
    }
    // Credit deducted for the design.
    expect(result.spentCents).toBeGreaterThan(0);
    expect(result.creditRemainingCents).toBe(session.creditCents - result.spentCents);

    // Dispatch forced onto minimax with a meter.
    const [, meter, options] = dispatch.mock.calls[0];
    expect(options).toMatchObject({ adapter: "minimax" });
    expect(meter).toMatchObject({ companyId: session.companyId });

    // Agents provisioned in the DB under the trial company (the hero agent + 3).
    const provisioned = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.companyId, session.companyId));
    // hero agent from createSession + the 3 designed agents.
    expect(provisioned.length).toBeGreaterThanOrEqual(4);

    // Plan persisted on the session.
    const row = await db
      .select()
      .from(trialSessions)
      .where(eq(trialSessions.token, session.token))
      .then((rows) => rows[0]);
    expect(row?.companyPlan).toBeTruthy();
    expect((row?.companyPlan as { agents: unknown[] }).agents.length).toBe(result.agents.length);
  });

  it("runAgentFirstTask persists a per-agent deliverable and deducts credit", async () => {
    const dispatch = vi.fn((input: { system: string }) => smartDispatch(input));
    const svc = trialService(db, { dispatch });
    const session = await svc.createSession();
    const design = await svc.designCompany(session.token, INTAKE);
    const agent = design.agents[0];

    const run = await svc.runAgentFirstTask(session.token, agent.id);
    expect(run.artifact.title).toBeTruthy();
    expect((run.artifact.content as { markdown: string }).markdown).toContain("Outbound Sequence Plan");
    expect(run.spentCents).toBeGreaterThan(design.spentCents);

    // Artifact persisted with the agentId + agent_deliverable use case.
    const arts = await db
      .select()
      .from(trialArtifacts)
      .where(eq(trialArtifacts.agentId, agent.id));
    expect(arts).toHaveLength(1);
    expect(arts[0].useCase).toBe("agent_deliverable");
    expect((arts[0].content as { markdown: string }).markdown).toContain("sendable plan");
  });

  it("runAgentFirstTask throws 402 when credit is exhausted", async () => {
    const dispatch = vi.fn((input: { system: string }) => smartDispatch(input));
    const svc = trialService(db, { dispatch });
    const session = await svc.createSession();
    const design = await svc.designCompany(session.token, INTAKE);

    await db
      .update(trialSessions)
      .set({ spentCents: session.creditCents })
      .where(eq(trialSessions.token, session.token));

    await expect(
      svc.runAgentFirstTask(session.token, design.agents[0].id),
    ).rejects.toBeInstanceOf(TrialCreditExhaustedError);
  });

  it("runAgentFirstTask throws 404 for an agent not in the trial", async () => {
    const dispatch = vi.fn((input: { system: string }) => smartDispatch(input));
    const svc = trialService(db, { dispatch });
    const session = await svc.createSession();
    await svc.designCompany(session.token, INTAKE);

    await expect(
      svc.runAgentFirstTask(session.token, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toBeInstanceOf(TrialAgentNotFoundError);
  });

  it("designCompany rejects an invalid intake (400)", async () => {
    const svc = trialService(db, { dispatch: vi.fn() });
    const session = await svc.createSession();
    await expect(svc.designCompany(session.token, {})).rejects.toMatchObject({ status: 400 });
    await expect(
      svc.designCompany(session.token, { whatYouDo: "x" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("getCompany returns the fleet with status + deliverable flags", async () => {
    const dispatch = vi.fn((input: { system: string }) => smartDispatch(input));
    const svc = trialService(db, { dispatch });
    const session = await svc.createSession();
    const design = await svc.designCompany(session.token, INTAKE);
    await svc.runAgentFirstTask(session.token, design.agents[0].id);

    const fleet = await svc.getCompany(session.token);
    expect(fleet).not.toBeNull();
    expect(fleet!.company?.name).toBe("FreightPilot");
    expect(fleet!.agents.length).toBe(design.agents.length);

    const ran = fleet!.agents.find((a) => a.id === design.agents[0].id)!;
    expect(ran.hasArtifact).toBe(true);
    expect(ran.artifactId).toBeTruthy();
    const notRan = fleet!.agents.find((a) => a.id === design.agents[1].id)!;
    expect(notRan.hasArtifact).toBe(false);

    expect(fleet!.artifacts.length).toBe(1);
  });

  it("getCompany returns a null company before any design", async () => {
    const svc = trialService(db, { dispatch: vi.fn() });
    const session = await svc.createSession();
    const fleet = await svc.getCompany(session.token);
    expect(fleet).not.toBeNull();
    expect(fleet!.company).toBeNull();
    expect(fleet!.agents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Routes: design -> run each agent -> getCompany
  // -------------------------------------------------------------------------

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/trial", trialRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("POST /:token/design -> run each agent -> GET /:token/company shows agents + artifacts", async () => {
    const app = makeApp();

    const created = await request(app).post("/api/trial/session").send({});
    const token = created.body.token as string;

    const designed = await request(app)
      .post(`/api/trial/${token}/design`)
      .send({ intake: INTAKE });
    expect(designed.status).toBe(201);
    expect(designed.body.company.name).toBe("FreightPilot");
    expect(designed.body.agents.length).toBeGreaterThanOrEqual(3);

    const agentIds = designed.body.agents.map((a: { id: string }) => a.id);
    for (const id of agentIds) {
      const run = await request(app).post(`/api/trial/${token}/agents/${id}/run`).send({});
      expect(run.status).toBe(201);
      expect(run.body.artifact.content.markdown).toContain("Outbound Sequence Plan");
    }

    const company = await request(app).get(`/api/trial/${token}/company`);
    expect(company.status).toBe(200);
    expect(company.body.company.name).toBe("FreightPilot");
    expect(company.body.agents).toHaveLength(agentIds.length);
    expect(company.body.agents.every((a: { hasArtifact: boolean }) => a.hasArtifact)).toBe(true);
    expect(company.body.artifacts.length).toBe(agentIds.length);
  });

  it("POST /:token/design returns 400 for a missing intake and 404 for a bad token", async () => {
    const app = makeApp();
    const created = await request(app).post("/api/trial/session").send({});
    const token = created.body.token as string;

    const bad = await request(app).post(`/api/trial/${token}/design`).send({ intake: {} });
    expect(bad.status).toBe(400);

    const badToken = await request(app)
      .post(`/api/trial/nope/design`)
      .send({ intake: INTAKE });
    expect(badToken.status).toBe(404);
  });

  it("POST /:token/agents/:agentId/run returns 404 for an agent not in the trial", async () => {
    const app = makeApp();
    const created = await request(app).post("/api/trial/session").send({});
    const token = created.body.token as string;
    await request(app).post(`/api/trial/${token}/design`).send({ intake: INTAKE });

    const run = await request(app)
      .post(`/api/trial/${token}/agents/00000000-0000-0000-0000-000000000000/run`)
      .send({});
    expect(run.status).toBe(404);
  });

  it("GET /:token/company returns 404 for an unknown token", async () => {
    const app = makeApp();
    const res = await request(app).get("/api/trial/does-not-exist/company");
    expect(res.status).toBe(404);
  });
});
