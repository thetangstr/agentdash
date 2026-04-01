/**
 * AgentDash CUJ Route Tests
 *
 * Tests the 10 Critical User Journeys from the PRD at the HTTP route level.
 * Uses mock services + supertest (matching the existing test pattern).
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

// ---------------------------------------------------------------------------
// CUJ-1: Onboarding
// ---------------------------------------------------------------------------

const mockOnboardingService = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
  ingestSource: vi.fn(),
  listSources: vi.fn(),
  updateSource: vi.fn(),
  extractContext: vi.fn(),
  listContext: vi.fn(),
  updateContext: vi.fn(),
  suggestTeam: vi.fn(),
  applyTeam: vi.fn(),
  completeSession: vi.fn(),
}));

vi.mock("../services/onboarding.js", () => ({
  onboardingService: () => mockOnboardingService,
}));

// ---------------------------------------------------------------------------
// CUJ-3: Agent Factory (Templates + Spawn)
// ---------------------------------------------------------------------------

const mockAgentFactoryService = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  getTemplateById: vi.fn(),
  getTemplateBySlug: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  archiveTemplate: vi.fn(),
  requestSpawn: vi.fn(),
  fulfillSpawnRequest: vi.fn(),
  listSpawnRequests: vi.fn(),
  getSpawnRequestById: vi.fn(),
  setAgentOkrs: vi.fn(),
  updateKeyResult: vi.fn(),
  getAgentOkrSummary: vi.fn(),
}));

vi.mock("../services/agent-factory.js", () => ({
  agentFactoryService: () => mockAgentFactoryService,
}));

// ---------------------------------------------------------------------------
// CUJ-5: Security / Kill Switch
// ---------------------------------------------------------------------------

const mockPolicyEngineService = vi.hoisted(() => ({
  createPolicy: vi.fn(),
  listPolicies: vi.fn(),
  getPolicyById: vi.fn(),
  updatePolicy: vi.fn(),
  deactivatePolicy: vi.fn(),
  evaluatePolicy: vi.fn(),
  listEvaluations: vi.fn(),
  activateKillSwitch: vi.fn(),
  resumeFromKillSwitch: vi.fn(),
  getKillSwitchStatus: vi.fn(),
  configureSandbox: vi.fn(),
  getSandbox: vi.fn(),
}));

vi.mock("../services/policy-engine.js", () => ({
  policyEngineService: () => mockPolicyEngineService,
}));

// ---------------------------------------------------------------------------
// CUJ-6: CRM
// ---------------------------------------------------------------------------

const mockCrmService = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  getAccount: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  listContacts: vi.fn(),
  getContact: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  listDeals: vi.fn(),
  getDeal: vi.fn(),
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  listLeads: vi.fn(),
  getLead: vi.fn(),
  createLead: vi.fn(),
  updateLead: vi.fn(),
  convertLead: vi.fn(),
  listPartners: vi.fn(),
  getPartner: vi.fn(),
  createPartner: vi.fn(),
  updatePartner: vi.fn(),
  listActivities: vi.fn(),
  createActivity: vi.fn(),
  getActivity: vi.fn(),
  updateActivity: vi.fn(),
  getPipelineSummary: vi.fn(),
}));

vi.mock("../services/crm.js", () => ({
  crmService: () => mockCrmService,
}));

// ---------------------------------------------------------------------------
// CUJ-7: AutoResearch
// ---------------------------------------------------------------------------

const mockAutoresearchService = vi.hoisted(() => ({
  createCycle: vi.fn(),
  listCycles: vi.fn(),
  getCycle: vi.fn(),
  updateCycle: vi.fn(),
  createHypothesis: vi.fn(),
  listHypotheses: vi.fn(),
  getHypothesis: vi.fn(),
  createExperiment: vi.fn(),
  listExperiments: vi.fn(),
  getExperiment: vi.fn(),
  updateExperiment: vi.fn(),
  startExperiment: vi.fn(),
  createMetricDefinition: vi.fn(),
  listMetricDefinitions: vi.fn(),
  getMetricDefinition: vi.fn(),
  recordMeasurement: vi.fn(),
  listMeasurements: vi.fn(),
  getMeasurement: vi.fn(),
  createEvaluation: vi.fn(),
  listEvaluations: vi.fn(),
  getEvaluation: vi.fn(),
}));

vi.mock("../services/autoresearch.js", () => ({
  autoresearchService: () => mockAutoresearchService,
}));

// ---------------------------------------------------------------------------
// CUJ-9: Skills Registry
// ---------------------------------------------------------------------------

const mockSkillsRegistryService = vi.hoisted(() => ({
  createVersion: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  submitForReview: vi.fn(),
  approveVersion: vi.fn(),
  publishVersion: vi.fn(),
  deprecateVersion: vi.fn(),
  getVersionDiff: vi.fn(),
  setDependencies: vi.fn(),
  getDependencies: vi.fn(),
  getDependentsOf: vi.fn(),
}));

vi.mock("../services/skills-registry.js", () => ({
  skillsRegistryService: () => mockSkillsRegistryService,
}));

// ---------------------------------------------------------------------------
// CUJ-10: Budget & Capacity
// ---------------------------------------------------------------------------

const mockBudgetForecastService = vi.hoisted(() => ({
  createDepartment: vi.fn(),
  listDepartments: vi.fn(),
  getDepartment: vi.fn(),
  createAllocation: vi.fn(),
  listAllocations: vi.fn(),
  createForecast: vi.fn(),
  listForecasts: vi.fn(),
  computeBurnRate: vi.fn(),
  recordResourceUsage: vi.fn(),
  listResourceUsage: vi.fn(),
  getResourceUsageSummary: vi.fn(),
}));

vi.mock("../services/budget-forecasts.js", () => ({
  budgetForecastService: () => mockBudgetForecastService,
}));

const mockCapacityService = vi.hoisted(() => ({
  getWorkforceSnapshot: vi.fn(),
  getTaskPipeline: vi.fn(),
  getAvailability: vi.fn(),
  getProjectSummary: vi.fn(),
  getDepartmentSummary: vi.fn(),
}));

vi.mock("../services/capacity-planning.js", () => ({
  capacityPlanningService: () => mockCapacityService,
}));

// ---------------------------------------------------------------------------
// Route imports (after mocks are set up)
// ---------------------------------------------------------------------------

import { onboardingRoutes } from "../routes/onboarding.js";
import { agentTemplateRoutes } from "../routes/agent-templates.js";
import { spawnRequestRoutes } from "../routes/spawn-requests.js";
import { agentOkrRoutes } from "../routes/agent-okrs.js";
import { securityRoutes } from "../routes/security.js";
import { crmRoutes } from "../routes/crm.js";
import { autoresearchRoutes } from "../routes/autoresearch.js";
import { skillsRegistryRoutes } from "../routes/skills-registry.js";
import { budgetExtendedRoutes } from "../routes/budget-extended.js";

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

const CID = "company-1";

function createApp() {
  const app = express();
  app.use(express.json());
  // Inject actor middleware (board user with company access)
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [CID],
      source: "session",
      isInstanceAdmin: true,
    };
    next();
  });
  const db = {} as any;
  app.use("/api", onboardingRoutes(db));
  app.use("/api", agentTemplateRoutes(db));
  app.use("/api", spawnRequestRoutes(db));
  app.use("/api", agentOkrRoutes(db));
  app.use("/api", securityRoutes(db));
  app.use("/api", crmRoutes(db));
  app.use("/api", autoresearchRoutes(db));
  app.use("/api", skillsRegistryRoutes(db));
  app.use("/api", budgetExtendedRoutes(db));
  app.use(errorHandler);
  return app;
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentDash CUJ Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // CUJ-1: Onboarding
  // --------------------------------------------------------------------------
  describe("CUJ-1: Onboarding", () => {
    it("creates an onboarding session", async () => {
      mockOnboardingService.createSession.mockResolvedValue({
        id: "session-1",
        companyId: CID,
        status: "in_progress",
        currentStep: "discovery",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/onboarding/sessions`)
        .send({ createdByUserId: "user-1" });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("session-1");
      expect(res.body.status).toBe("in_progress");
    });

    it("ingests a source", async () => {
      mockOnboardingService.ingestSource.mockResolvedValue({
        id: "source-1",
        sourceType: "text_paste",
        status: "pending",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/onboarding/sessions/session-1/sources`)
        .send({
          sourceType: "text_paste",
          sourceLocator: "inline",
          rawContent: "We are a B2B SaaS company.",
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("source-1");
    });

    it("extracts context from sources", async () => {
      mockOnboardingService.extractContext.mockResolvedValue([
        { id: "ctx-1", contextType: "domain", key: "industry", value: "SaaS" },
      ]);

      const res = await request(createApp())
        .post(`/api/companies/${CID}/onboarding/sessions/session-1/extract`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].contextType).toBe("domain");
    });

    it("suggests team from templates", async () => {
      mockOnboardingService.suggestTeam.mockResolvedValue([
        { id: "tmpl-1", name: "Engineer", relevanceScore: 0.9, reason: "Core need" },
      ]);

      const res = await request(createApp())
        .post(`/api/companies/${CID}/onboarding/sessions/session-1/suggest-team`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it("completes the session", async () => {
      mockOnboardingService.completeSession.mockResolvedValue({
        id: "session-1",
        status: "completed",
        completedAt: new Date().toISOString(),
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/onboarding/sessions/session-1/complete`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("completed");
    });
  });

  // --------------------------------------------------------------------------
  // CUJ-3: Agent Factory (Templates + Spawn)
  // --------------------------------------------------------------------------
  describe("CUJ-3: Agent Factory", () => {
    it("creates a template with OKRs", async () => {
      const tmpl = {
        id: "tmpl-1",
        slug: "fe",
        name: "Frontend Dev",
        role: "engineer",
        adapterType: "opencode_local",
        budgetMonthlyCents: 3000,
      };
      mockAgentFactoryService.createTemplate.mockResolvedValue(tmpl);

      const res = await request(createApp())
        .post(`/api/companies/${CID}/agent-templates`)
        .send({
          slug: "fe",
          name: "Frontend Dev",
          role: "engineer",
          adapterType: "opencode_local",
          budgetMonthlyCents: 3000,
          okrs: [{ objective: "Ship UI", keyResults: [{ metric: "pages", target: 5 }] }],
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("tmpl-1");
    });

    it("lists templates", async () => {
      mockAgentFactoryService.listTemplates.mockResolvedValue([
        { id: "tmpl-1", name: "Engineer" },
        { id: "tmpl-2", name: "QA" },
      ]);

      const res = await request(createApp())
        .get(`/api/companies/${CID}/agent-templates`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it("creates a spawn request with approval", async () => {
      mockAgentFactoryService.requestSpawn.mockResolvedValue({
        spawnRequest: { id: "sr-1", status: "pending" },
        approval: { id: "apr-1", type: "spawn_agents" },
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/spawn-requests`)
        .send({
          templateId: "tmpl-1",
          quantity: 2,
          reason: "Need frontend help",
        });

      expect(res.status).toBe(201);
      expect(res.body.spawnRequest.status).toBe("pending");
      expect(res.body.approval.id).toBe("apr-1");
    });

    it("retrieves a spawn request", async () => {
      mockAgentFactoryService.getSpawnRequestById.mockResolvedValue({
        id: "sr-1",
        status: "fulfilled",
        spawnedAgentIds: ["a-1", "a-2"],
      });

      const res = await request(createApp())
        .get(`/api/companies/${CID}/spawn-requests/sr-1`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("fulfilled");
      expect(res.body.spawnedAgentIds).toHaveLength(2);
    });

    it("sets agent OKRs", async () => {
      mockAgentFactoryService.setAgentOkrs.mockResolvedValue([
        { id: "okr-1", objective: "Ship responsive dashboard" },
      ]);

      const res = await request(createApp())
        .post(`/api/companies/${CID}/agents/agent-1/okrs`)
        .send([
          {
            objective: "Ship responsive dashboard",
            keyResults: [{ metric: "components", targetValue: "10", unit: "count" }],
          },
        ]);

      expect(res.status).toBe(201);
      expect(res.body).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // CUJ-5: Security & Kill Switch
  // --------------------------------------------------------------------------
  describe("CUJ-5: Security & Kill Switch", () => {
    it("creates a security policy", async () => {
      mockPolicyEngineService.createPolicy.mockResolvedValue({
        id: "pol-1",
        name: "Block prod deploys",
        policyType: "action_limit",
        effect: "deny",
        isActive: true,
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/security-policies`)
        .send({
          name: "Block prod deploys",
          policyType: "action_limit",
          targetType: "company",
          rules: [{ action: "deploy_prod", maxPerHour: 0 }],
          effect: "deny",
          priority: 10,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("pol-1");
    });

    it("lists policies", async () => {
      mockPolicyEngineService.listPolicies.mockResolvedValue([
        { id: "pol-1", name: "Block prod deploys" },
      ]);

      const res = await request(createApp())
        .get(`/api/companies/${CID}/security-policies`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it("returns kill switch status", async () => {
      mockPolicyEngineService.getKillSwitchStatus.mockResolvedValue({
        companyHalted: false,
      });

      const res = await request(createApp())
        .get(`/api/companies/${CID}/kill-switch/status`);

      expect(res.status).toBe(200);
      expect(res.body.companyHalted).toBe(false);
    });

    it("activates kill switch", async () => {
      mockPolicyEngineService.activateKillSwitch.mockResolvedValue({
        id: "ks-1",
        scope: "company",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/kill-switch`)
        .send({ scope: "company", scopeId: CID, reason: "Test halt" });

      expect(res.status).toBe(201);
    });

    it("resumes from kill switch", async () => {
      mockPolicyEngineService.resumeFromKillSwitch.mockResolvedValue({
        resumed: true,
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/kill-switch/resume`)
        .send({ scope: "company", scopeId: CID });

      expect(res.status).toBe(200);
    });

    it("configures agent sandbox", async () => {
      mockPolicyEngineService.configureSandbox.mockResolvedValue({
        isolationLevel: "container",
        networkPolicy: { allowOutbound: ["api.openai.com"] },
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/agents/agent-1/sandbox`)
        .send({
          isolationLevel: "container",
          networkPolicy: { allowOutbound: ["api.openai.com"] },
          resourceLimits: { maxMemoryMb: 2048 },
        });

      expect(res.status).toBe(200);
      expect(res.body.isolationLevel).toBe("container");
    });

    it("deactivates a policy", async () => {
      mockPolicyEngineService.deactivatePolicy.mockResolvedValue({
        id: "pol-1",
        isActive: false,
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/security-policies/pol-1/deactivate`);

      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // CUJ-6: CRM Pipeline
  // --------------------------------------------------------------------------
  describe("CUJ-6: CRM Pipeline", () => {
    it("creates a CRM account", async () => {
      mockCrmService.createAccount.mockResolvedValue({
        id: "acc-1",
        name: "Acme Corp",
        domain: "acme.com",
        stage: "customer",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/crm/accounts`)
        .send({ name: "Acme Corp", domain: "acme.com", industry: "SaaS", stage: "customer" });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("acc-1");
    });

    it("creates a CRM contact", async () => {
      mockCrmService.createContact.mockResolvedValue({
        id: "con-1",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@acme.com",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/crm/contacts`)
        .send({
          accountId: "acc-1",
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@acme.com",
          title: "CTO",
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("con-1");
    });

    it("creates a CRM deal", async () => {
      mockCrmService.createDeal.mockResolvedValue({
        id: "deal-1",
        name: "Enterprise License",
        stage: "qualified",
        amountCents: "250000",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/crm/deals`)
        .send({
          accountId: "acc-1",
          name: "Enterprise License",
          stage: "qualified",
          amountCents: "250000",
          currency: "USD",
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("deal-1");
    });

    it("creates a lead", async () => {
      mockCrmService.createLead.mockResolvedValue({
        id: "lead-1",
        firstName: "Bob",
        status: "new",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/crm/leads`)
        .send({
          firstName: "Bob",
          lastName: "Smith",
          email: "bob@startup.io",
          company: "StartupIO",
          source: "website",
          status: "new",
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("lead-1");
    });

    it("creates a partner", async () => {
      mockCrmService.createPartner.mockResolvedValue({
        id: "part-1",
        name: "TechPartner Inc",
        type: "referral",
        status: "active",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/crm/partners`)
        .send({
          name: "TechPartner Inc",
          type: "referral",
          contactEmail: "partner@tech.com",
          status: "active",
          tier: "gold",
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("part-1");
    });

    it("logs CRM activity", async () => {
      mockCrmService.createActivity.mockResolvedValue({
        id: "act-1",
        activityType: "note",
        subject: "Initial call",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/crm/activities`)
        .send({
          accountId: "acc-1",
          dealId: "deal-1",
          activityType: "note",
          subject: "Initial call",
          body: "Discussed enterprise needs",
          occurredAt: new Date().toISOString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("act-1");
    });

    it("gets pipeline summary", async () => {
      mockCrmService.getPipelineSummary.mockResolvedValue({
        totalDeals: 1,
        totalPipelineValueCents: 250000,
        stages: [{ stage: "qualified", count: 1, valueCents: 250000 }],
      });

      const res = await request(createApp())
        .get(`/api/companies/${CID}/crm/pipeline`);

      expect(res.status).toBe(200);
      expect(res.body.totalDeals).toBe(1);
      expect(res.body.totalPipelineValueCents).toBe(250000);
    });

    it("converts a lead", async () => {
      mockCrmService.convertLead.mockResolvedValue({
        id: "lead-1",
        status: "converted",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/crm/leads/lead-1/convert`)
        .send({ accountId: "acc-1", contactId: "con-1" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("converted");
    });
  });

  // --------------------------------------------------------------------------
  // CUJ-7: AutoResearch
  // --------------------------------------------------------------------------
  describe("CUJ-7: AutoResearch", () => {
    it("creates a research cycle", async () => {
      mockAutoresearchService.createCycle.mockResolvedValue({
        id: "rc-1",
        title: "User Acquisition Research",
        status: "active",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/research-cycles`)
        .send({
          goalId: "goal-1",
          title: "User Acquisition Research",
          maxIterations: 3,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("rc-1");
    });

    it("creates a hypothesis", async () => {
      mockAutoresearchService.createHypothesis.mockResolvedValue({
        id: "hyp-1",
        title: "Social sharing increases signups",
        source: "human",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/research-cycles/rc-1/hypotheses`)
        .send({
          title: "Social sharing increases signups",
          rationale: "Viral loops drive growth",
          source: "human",
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("hyp-1");
    });

    it("creates an experiment with budget cap", async () => {
      mockAutoresearchService.createExperiment.mockResolvedValue({
        id: "exp-1",
        title: "Build social share feature",
        budgetCapCents: 10000,
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/research-cycles/rc-1/experiments`)
        .send({
          hypothesisId: "hyp-1",
          title: "Build social share feature",
          successCriteria: [{ metricKey: "signup_rate", comparator: "gte", targetValue: 20 }],
          budgetCapCents: 10000,
          timeLimitHours: 168,
        });

      expect(res.status).toBe(201);
      expect(res.body.budgetCapCents).toBe(10000);
    });

    it("creates a metric definition", async () => {
      mockAutoresearchService.createMetricDefinition.mockResolvedValue({
        id: "met-1",
        key: "signup_rate",
        unit: "percent",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/metric-definitions`)
        .send({
          key: "signup_rate",
          displayName: "Daily Signup Rate",
          unit: "percent",
          dataSourceType: "manual",
          collectionMethod: "manual",
        });

      expect(res.status).toBe(201);
      expect(res.body.key).toBe("signup_rate");
    });

    it("records a measurement", async () => {
      mockAutoresearchService.recordMeasurement.mockResolvedValue({
        id: "meas-1",
        value: 22.5,
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/experiments/exp-1/measurements`)
        .send({
          metricDefinitionId: "met-1",
          value: 22.5,
          collectedAt: new Date().toISOString(),
          collectionMethod: "manual",
        });

      expect(res.status).toBe(201);
      expect(res.body.value).toBe(22.5);
    });

    it("creates an evaluation with verdict", async () => {
      mockAutoresearchService.createEvaluation.mockResolvedValue({
        id: "eval-1",
        verdict: "validated",
        summary: "Hypothesis validated at 22.5%",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/experiments/exp-1/evaluations`)
        .send({
          experimentId: "exp-1",
          cycleId: "rc-1",
          hypothesisId: "hyp-1",
          verdict: "validated",
          summary: "Social sharing increased signups by 22.5%",
          analysis: [{ metricKey: "signup_rate", baseline: 15, final: 22.5, delta: 7.5 }],
          nextAction: "continue",
          costTotalCents: 8500,
        });

      expect(res.status).toBe(201);
      expect(res.body.verdict).toBe("validated");
    });
  });

  // --------------------------------------------------------------------------
  // CUJ-8: Security Policies (covered in CUJ-5 above)
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // CUJ-9: Skills Registry
  // --------------------------------------------------------------------------
  describe("CUJ-9: Skills Registry", () => {
    it("creates a skill version", async () => {
      mockSkillsRegistryService.createVersion.mockResolvedValue({
        id: "ver-1",
        versionNumber: 2,
        status: "draft",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/skills/skill-1/versions`)
        .send({
          markdown: "# Test Skill v2\nImproved instructions.",
          changeSummary: "Better docs",
        });

      expect(res.status).toBe(201);
      expect(res.body.versionNumber).toBeGreaterThanOrEqual(1);
    });

    it("lists skill versions", async () => {
      mockSkillsRegistryService.listVersions.mockResolvedValue([
        { id: "ver-1", versionNumber: 1 },
        { id: "ver-2", versionNumber: 2 },
      ]);

      const res = await request(createApp())
        .get(`/api/companies/${CID}/skills/skill-1/versions`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it("sets skill dependencies", async () => {
      mockSkillsRegistryService.setDependencies.mockResolvedValue([]);

      const res = await request(createApp())
        .put(`/api/companies/${CID}/skills/skill-1/dependencies`)
        .send([]);

      expect(res.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // CUJ-10: Budget & Capacity
  // --------------------------------------------------------------------------
  describe("CUJ-10: Budget & Capacity", () => {
    it("creates a department", async () => {
      mockBudgetForecastService.createDepartment.mockResolvedValue({
        id: "dept-1",
        name: "Engineering",
        description: "Core engineering team",
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/departments`)
        .send({ name: "Engineering", description: "Core engineering team" });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("dept-1");
    });

    it("gets workforce snapshot", async () => {
      mockCapacityService.getWorkforceSnapshot.mockResolvedValue({
        totalAgents: 5,
        byStatus: { idle: 3, running: 2 },
      });

      const res = await request(createApp())
        .get(`/api/companies/${CID}/capacity/workforce`);

      expect(res.status).toBe(200);
      expect(res.body.totalAgents).toBe(5);
    });

    it("gets task pipeline", async () => {
      mockCapacityService.getTaskPipeline.mockResolvedValue({
        totalIssues: 10,
        byStatus: { todo: 5, in_progress: 3, done: 2 },
      });

      const res = await request(createApp())
        .get(`/api/companies/${CID}/capacity/pipeline`);

      expect(res.status).toBe(200);
      expect(res.body.totalIssues).toBe(10);
    });

    it("records resource usage", async () => {
      mockBudgetForecastService.recordResourceUsage.mockResolvedValue({
        id: "ru-1",
        resourceType: "compute_hours",
        quantity: "12.5",
        costCents: 450,
      });

      const res = await request(createApp())
        .post(`/api/companies/${CID}/resource-usage`)
        .send({
          resourceType: "compute_hours",
          resourceProvider: "aws",
          quantity: "12.5",
          unit: "hours",
          costCents: 450,
          occurredAt: new Date().toISOString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("ru-1");
    });

    it("gets resource usage summary", async () => {
      mockBudgetForecastService.getResourceUsageSummary.mockResolvedValue([
        { resourceType: "compute_hours", totalCostCents: 450, count: 1 },
      ]);

      const res = await request(createApp())
        .get(`/api/companies/${CID}/resource-usage/summary`);

      expect(res.status).toBe(200);
      expect(res.body).toBeInstanceOf(Array);
    });
  });
});
