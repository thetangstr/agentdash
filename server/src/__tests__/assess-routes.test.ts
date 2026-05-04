import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAssess = vi.hoisted(() => ({
  research: vi.fn(async () => ({
    companyName: "Test Corp",
    suggestedIndustry: "Healthcare",
    summary: "A hospital company",
    webContent: "healthcare hospital patient",
    allIndustries: ["Healthcare", "Tech/SaaS"],
  })),
  runAssessment: vi.fn(async () => ({
    stream: new ReadableStream({
      start(c) {
        // The legacy /assess route parses SSE-style `data: { ... }` lines
        // for content_block_delta.text — emit one matching frame.
        const frame =
          'data: {"type":"content_block_delta","delta":{"text":"# Report"}}\n\n';
        c.enqueue(new TextEncoder().encode(frame));
        c.close();
      },
    }),
    onComplete: vi.fn(),
  })),
  getAssessment: vi.fn(async () => ({
    markdown: "# Report",
    jumpstart: "# Jumpstart",
    assessmentInput: {},
  })),
}));

const mockProjectAssess = vi.hoisted(() => ({
  generateClarifyQuestions: vi.fn(async () => ({
    rephrased: "rephrased",
    questions: [{ id: "q1", question: "Legacy q?", hint: "", options: [] }],
  })),
  generateFollowUp: vi.fn(async () => ({
    rephrased: "",
    questions: [{ id: "f1", question: "Legacy followup?", hint: "", options: [] }],
  })),
  runProjectAssessment: vi.fn(async () => ({
    stream: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("# Project Report")); c.close(); } }),
    slug: "project",
    onComplete: vi.fn(),
  })),
  listProjectAssessments: vi.fn(async () => []),
  getProjectAssessment: vi.fn(async () => null),
}));

// AgentDash (Phase D): engine + dispatchLLM mocks for the flag-on path.
const mockEngine = vi.hoisted(() => ({
  nextTurn: vi.fn(async () => ({
    kind: "question" as const,
    stateId: "state-test",
    round: 1,
    question: "What outcomes matter most to you?",
    ambiguityScore: 0.7,
    dimensions: { goal: 0.3, constraints: 0.1, criteria: 0.1, context: 0.1 },
    challengeMode: null,
    ontologyStability: null,
  })),
  crystallize: vi.fn(),
  getInProgress: vi.fn(async () => null),
}));

vi.mock("../services/assess.js", () => ({
  assessService: () => mockAssess,
}));

vi.mock("../services/assess-project.js", () => ({
  assessProjectService: () => mockProjectAssess,
}));

vi.mock("../services/deep-interview-engine.js", () => ({
  deepInterviewEngine: () => mockEngine,
}));

vi.mock("../services/dispatch-llm.js", () => ({
  dispatchLLM: vi.fn(async () => "stub"),
}));

import express from "express";
import request from "supertest";
import { assessRoutes } from "../routes/assess.js";
import { errorHandler } from "../middleware/index.js";

function createApp(actor?: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", assessRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("Assess routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("POST /companies/:cid/assess/research", () => {
    it("returns research results", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/assess/research")
        .send({ companyUrl: "https://example.com", companyName: "Test Corp" })
        .expect(200);

      expect(res.body.suggestedIndustry).toBe("Healthcare");
      expect(mockAssess.research).toHaveBeenCalledWith("https://example.com", "Test Corp");
    });

    it("rejects without board auth", async () => {
      const app = createApp({ type: "none", companyIds: [] });
      await request(app)
        .post("/api/companies/company-1/assess/research")
        .send({ companyUrl: "https://example.com" })
        .expect(403);
    });
  });

  describe("GET /companies/:cid/assess", () => {
    it("returns stored assessment", async () => {
      const app = createApp();
      const res = await request(app)
        .get("/api/companies/company-1/assess")
        .expect(200);

      expect(res.body.markdown).toBe("# Report");
      expect(res.body.jumpstart).toBe("# Jumpstart");
    });

    it("returns 404 when no assessment", async () => {
      mockAssess.getAssessment.mockResolvedValueOnce(null);
      const app = createApp();
      await request(app).get("/api/companies/company-1/assess").expect(404);
    });

    it("rejects wrong company access", async () => {
      const app = createApp({
        type: "board",
        userId: "user-1",
        companyIds: ["other-company"],
        source: "jwt",
        isInstanceAdmin: false,
      });
      await request(app).get("/api/companies/company-1/assess").expect(403);
    });
  });

  // AgentDash (Phase D): flag-OFF behavior — legacy path, unchanged.
  describe("flag OFF — legacy assess path", () => {
    beforeEach(() => {
      delete process.env.AGENTDASH_DEEP_INTERVIEW_ASSESS;
    });

    it("POST /companies/:cid/assess streams legacy assessService output", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/assess")
        .send({ description: "Build a CRM" })
        .expect(200);

      expect(res.text).toBe("# Report");
      expect(mockAssess.runAssessment).toHaveBeenCalled();
      expect(mockEngine.nextTurn).not.toHaveBeenCalled();
    });

    it("POST /assess/project/clarify returns legacy questions", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/assess/project/clarify")
        .send({ intake: { projectName: "X", description: "Y", oneLineGoal: "Z", sponsor: "S" } })
        .expect(200);

      expect(res.body.rephrased).toBe("rephrased");
      expect(res.body.questions[0].question).toBe("Legacy q?");
      expect(mockProjectAssess.generateClarifyQuestions).toHaveBeenCalled();
      expect(mockEngine.nextTurn).not.toHaveBeenCalled();
    });
  });

  // AgentDash (Phase D): flag-ON behavior — engine path.
  describe("flag ON — deep-interview engine path", () => {
    beforeEach(() => {
      process.env.AGENTDASH_DEEP_INTERVIEW_ASSESS = "true";
    });

    afterEach(() => {
      delete process.env.AGENTDASH_DEEP_INTERVIEW_ASSESS;
    });

    it("POST /companies/:cid/assess routes through engine.nextTurn", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/assess")
        .send({ description: "Build a CRM", userAnswer: "Top of funnel growth" })
        .expect(200);

      expect(res.text).toBe("What outcomes matter most to you?");
      expect(mockEngine.nextTurn).toHaveBeenCalledTimes(1);
      const callArg = mockEngine.nextTurn.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.scope).toBe("cos_onboarding");
      expect(callArg.scopeRefId).toBe("company-1");
      expect(callArg.companyId).toBe("company-1");
      expect(callArg.userAnswer).toBe("Top of funnel growth");
      // Legacy MUST NOT have been invoked.
      expect(mockAssess.runAssessment).not.toHaveBeenCalled();
    });

    it("POST /assess/project/clarify routes through engine.nextTurn with assess_project scope", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/assess/project/clarify")
        .send({ intake: { projectName: "Robotics", description: "Stuff", oneLineGoal: "Build", sponsor: "Chris" } })
        .expect(200);

      expect(res.body.questions).toHaveLength(1);
      expect(res.body.questions[0].question).toBe("What outcomes matter most to you?");
      expect(mockEngine.nextTurn).toHaveBeenCalledTimes(1);
      const callArg = mockEngine.nextTurn.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.scope).toBe("assess_project");
      expect(String(callArg.scopeRefId)).toContain("company-1:");
      expect(mockProjectAssess.generateClarifyQuestions).not.toHaveBeenCalled();
    });

    it("POST /assess/project/followup forwards the most recent answer", async () => {
      const app = createApp();
      await request(app)
        .post("/api/companies/company-1/assess/project/followup")
        .send({
          intake: { projectName: "Robotics", description: "X", oneLineGoal: "Y", sponsor: "Z" },
          answers: [
            { questionId: "r1", text: "First answer" },
            { questionId: "r2", text: "Latest answer" },
          ],
          rephrased: "rephrased text",
        })
        .expect(200);

      const callArg = mockEngine.nextTurn.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.userAnswer).toBe("Latest answer");
    });

    it("ready_to_crystallize result is streamed as a marker (graceful)", async () => {
      mockEngine.nextTurn.mockResolvedValueOnce({
        kind: "ready_to_crystallize",
        stateId: "state-test",
        round: 12,
        ambiguityScore: 0.18,
        dimensions: { goal: 0.95, constraints: 0.9, criteria: 0.9, context: 0.85 },
      });
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/assess")
        .send({ description: "Build a CRM" })
        .expect(200);
      expect(res.text).toContain("[deep-interview] Ready to crystallize");
      expect(res.text).toContain("0.180");
    });
  });

  // AgentDash (Phase D): GET /onboarding/in-progress — resume support.
  describe("GET /onboarding/in-progress", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns 200 with the row when an in-progress state exists", async () => {
      mockEngine.getInProgress.mockResolvedValueOnce({
        id: "state-aaaa",
        scope: "cos_onboarding",
        scopeRefId: "company-1",
        status: "in_progress",
        currentRound: 3,
        ambiguityScore: 0.6,
        dimensionScores: { goal: 0.5, constraints: 0.4, criteria: 0.4, context: 0.3 },
        ontologySnapshots: [],
        challengeModesUsed: [],
        transcript: [],
        initialIdea: "",
        brownfield: false,
      } as any);

      const app = createApp();
      const res = await request(app)
        .get("/api/onboarding/in-progress")
        .query({ scope: "cos_onboarding", scopeRefId: "company-1" })
        .expect(200);

      expect(res.body.state).not.toBeNull();
      expect(res.body.state.currentRound).toBe(3);
      expect(res.body.resumeUrl).toBe("/assess?onboarding=1");
    });

    it("returns 200 with state=null when nothing in progress", async () => {
      mockEngine.getInProgress.mockResolvedValueOnce(null);
      const app = createApp();
      const res = await request(app)
        .get("/api/onboarding/in-progress")
        .query({ scope: "cos_onboarding", scopeRefId: "company-1" })
        .expect(200);
      expect(res.body.state).toBeNull();
      expect(res.body.resumeUrl).toBeNull();
    });

    it("returns 400 on bad scope", async () => {
      const app = createApp();
      await request(app)
        .get("/api/onboarding/in-progress")
        .query({ scope: "bogus", scopeRefId: "company-1" })
        .expect(400);
    });

    it("returns 400 when scopeRefId missing", async () => {
      const app = createApp();
      await request(app)
        .get("/api/onboarding/in-progress")
        .query({ scope: "cos_onboarding" })
        .expect(400);
    });

    it("rejects when caller lacks company access", async () => {
      const app = createApp({
        type: "board",
        userId: "user-1",
        companyIds: ["other-company"],
        source: "jwt",
        isInstanceAdmin: false,
      });
      await request(app)
        .get("/api/onboarding/in-progress")
        .query({ scope: "cos_onboarding", scopeRefId: "company-1" })
        .expect(403);
    });

    it("extracts companyId from synthetic assess_project scopeRefId for authz", async () => {
      mockEngine.getInProgress.mockResolvedValueOnce(null);
      const app = createApp();
      await request(app)
        .get("/api/onboarding/in-progress")
        .query({ scope: "assess_project", scopeRefId: "company-1:robotics" })
        .expect(200);
    });
  });
});
