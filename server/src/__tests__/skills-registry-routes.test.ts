import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { skillsRegistryRoutes } from "../routes/skills-registry.js";
import { errorHandler } from "../middleware/index.js";

const mockRegistry = vi.hoisted(() => ({
  createVersion: vi.fn(async () => ({ id: "ver-1", versionNumber: 1, status: "draft" })),
  listVersions: vi.fn(async () => [{ id: "ver-1", versionNumber: 1 }]),
  getVersion: vi.fn(async () => ({ id: "ver-1", versionNumber: 1, status: "draft" })),
  submitForReview: vi.fn(async () => ({ id: "ver-1", status: "in_review" })),
  approveVersion: vi.fn(async () => ({ id: "ver-1", status: "approved" })),
  rejectVersion: vi.fn(async () => ({ id: "ver-1", status: "rejected" })),
  publishVersion: vi.fn(async () => ({ id: "ver-1", status: "published" })),
  deprecateVersion: vi.fn(async () => ({ id: "ver-1", status: "deprecated" })),
  getDependencies: vi.fn(async () => [{ skillId: "dep-1" }]),
  setDependencies: vi.fn(async () => [{ skillId: "dep-1" }]),
  resolveDependencyTree: vi.fn(async () => ({ skillId: "skill-1", dependencies: [] })),
}));

const mockAnalytics = vi.hoisted(() => ({
  usageBySkill: vi.fn(async () => [{ skillId: "skill-1", count: 10 }]),
  usageByAgent: vi.fn(async () => [{ agentId: "agent-1", count: 5 }]),
  outcomeCorrelation: vi.fn(async () => ({ skillId: "skill-1", successRate: 0.85 })),
  unusedSkills: vi.fn(async () => [{ skillId: "skill-2", lastUsedAt: null }]),
}));

vi.mock("../services/skills-registry.js", () => ({
  skillsRegistryService: () => mockRegistry,
}));

vi.mock("../services/skill-analytics.js", () => ({
  skillAnalyticsService: () => mockAnalytics,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use(skillsRegistryRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const cid = "company-1";
const skillId = "skill-1";
const versionId = "ver-1";
const versionNumber = 1;

describe("skills registry routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.createVersion.mockResolvedValue({ id: "ver-1", versionNumber: 1, status: "draft" });
    mockRegistry.listVersions.mockResolvedValue([{ id: "ver-1", versionNumber: 1 }]);
    mockRegistry.getVersion.mockResolvedValue({ id: "ver-1", versionNumber: 1, status: "draft" });
    mockRegistry.submitForReview.mockResolvedValue({ id: "ver-1", status: "in_review" });
    mockRegistry.approveVersion.mockResolvedValue({ id: "ver-1", status: "approved" });
    mockRegistry.rejectVersion.mockResolvedValue({ id: "ver-1", status: "rejected" });
    mockRegistry.publishVersion.mockResolvedValue({ id: "ver-1", status: "published" });
    mockRegistry.deprecateVersion.mockResolvedValue({ id: "ver-1", status: "deprecated" });
    mockRegistry.getDependencies.mockResolvedValue([{ skillId: "dep-1" }]);
    mockRegistry.setDependencies.mockResolvedValue([{ skillId: "dep-1" }]);
    mockRegistry.resolveDependencyTree.mockResolvedValue({ skillId: "skill-1", dependencies: [] });
    mockAnalytics.usageBySkill.mockResolvedValue([{ skillId: "skill-1", count: 10 }]);
    mockAnalytics.usageByAgent.mockResolvedValue([{ agentId: "agent-1", count: 5 }]);
    mockAnalytics.outcomeCorrelation.mockResolvedValue({ skillId: "skill-1", successRate: 0.85 });
    mockAnalytics.unusedSkills.mockResolvedValue([{ skillId: "skill-2", lastUsedAt: null }]);
  });

  describe("versions", () => {
    it("creates a skill version and returns 201", async () => {
      const res = await request(createApp())
        .post(`/companies/${cid}/skills/${skillId}/versions`)
        .send({ definition: { name: "my-skill" } });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ id: "ver-1", versionNumber: 1, status: "draft" });
      expect(mockRegistry.createVersion).toHaveBeenCalledWith(
        cid,
        skillId,
        expect.objectContaining({ definition: { name: "my-skill" } }),
      );
    });

    it("lists skill versions and returns 200", async () => {
      const res = await request(createApp())
        .get(`/companies/${cid}/skills/${skillId}/versions`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual([{ id: "ver-1", versionNumber: 1 }]);
      expect(mockRegistry.listVersions).toHaveBeenCalledWith(cid, skillId);
    });

    it("gets a specific skill version by number and returns 200", async () => {
      const res = await request(createApp())
        .get(`/companies/${cid}/skills/${skillId}/versions/${versionNumber}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: "ver-1", versionNumber: 1, status: "draft" });
      expect(mockRegistry.getVersion).toHaveBeenCalledWith(skillId, versionNumber);
    });
  });

  describe("review workflow", () => {
    it("submits a version for review and returns 200", async () => {
      const res = await request(createApp())
        .post(`/companies/${cid}/skills/${skillId}/versions/${versionId}/submit-review`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: "ver-1", status: "in_review" });
      expect(mockRegistry.submitForReview).toHaveBeenCalledWith(versionId);
    });

    it("approves a version and returns 200", async () => {
      const res = await request(createApp())
        .post(`/companies/${cid}/skills/${skillId}/versions/${versionId}/approve`)
        .send({ reviewedByUserId: "user-1" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: "ver-1", status: "approved" });
      expect(mockRegistry.approveVersion).toHaveBeenCalledWith(versionId, "user-1");
    });

    it("rejects a version and returns 200", async () => {
      const res = await request(createApp())
        .post(`/companies/${cid}/skills/${skillId}/versions/${versionId}/reject`)
        .send({ reviewedByUserId: "user-1" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: "ver-1", status: "rejected" });
      expect(mockRegistry.rejectVersion).toHaveBeenCalledWith(versionId, "user-1");
    });

    it("publishes a version and returns 200", async () => {
      const res = await request(createApp())
        .post(`/companies/${cid}/skills/${skillId}/versions/${versionId}/publish`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: "ver-1", status: "published" });
      expect(mockRegistry.publishVersion).toHaveBeenCalledWith(versionId);
    });

    it("deprecates a version and returns 200", async () => {
      const res = await request(createApp())
        .post(`/companies/${cid}/skills/${skillId}/versions/${versionId}/deprecate`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: "ver-1", status: "deprecated" });
      expect(mockRegistry.deprecateVersion).toHaveBeenCalledWith(versionId);
    });
  });

  describe("dependencies", () => {
    it("gets skill dependencies and returns 200", async () => {
      const res = await request(createApp())
        .get(`/companies/${cid}/skills/${skillId}/dependencies`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual([{ skillId: "dep-1" }]);
      expect(mockRegistry.getDependencies).toHaveBeenCalledWith(cid, skillId);
    });

    it("sets skill dependencies and returns 200", async () => {
      const deps = [{ skillId: "dep-1" }];
      const res = await request(createApp())
        .put(`/companies/${cid}/skills/${skillId}/dependencies`)
        .send(deps);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual([{ skillId: "dep-1" }]);
      expect(mockRegistry.setDependencies).toHaveBeenCalledWith(cid, skillId, deps);
    });

    it("resolves the dependency tree and returns 200", async () => {
      const res = await request(createApp())
        .get(`/companies/${cid}/skills/${skillId}/dependency-tree`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ skillId: "skill-1", dependencies: [] });
      expect(mockRegistry.resolveDependencyTree).toHaveBeenCalledWith(cid, skillId);
    });
  });

  describe("analytics", () => {
    it("returns usage by skill and returns 200", async () => {
      const res = await request(createApp())
        .get(`/companies/${cid}/skills/analytics/usage`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual([{ skillId: "skill-1", count: 10 }]);
      expect(mockAnalytics.usageBySkill).toHaveBeenCalledWith(cid, { days: undefined });
    });

    it("passes days query param to usageBySkill", async () => {
      const res = await request(createApp())
        .get(`/companies/${cid}/skills/analytics/usage?days=7`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAnalytics.usageBySkill).toHaveBeenCalledWith(cid, { days: 7 });
    });

    it("returns usage by agent for a specific skill and returns 200", async () => {
      const res = await request(createApp())
        .get(`/companies/${cid}/skills/analytics/usage/${skillId}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual([{ agentId: "agent-1", count: 5 }]);
      expect(mockAnalytics.usageByAgent).toHaveBeenCalledWith(cid, skillId);
    });

    it("returns outcome correlation for a specific skill and returns 200", async () => {
      const res = await request(createApp())
        .get(`/companies/${cid}/skills/analytics/outcomes/${skillId}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ skillId: "skill-1", successRate: 0.85 });
      expect(mockAnalytics.outcomeCorrelation).toHaveBeenCalledWith(cid, skillId);
    });

    it("returns unused skills and returns 200", async () => {
      const res = await request(createApp())
        .get(`/companies/${cid}/skills/analytics/unused`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual([{ skillId: "skill-2", lastUsedAt: null }]);
      expect(mockAnalytics.unusedSkills).toHaveBeenCalledWith(cid, 30);
    });

    it("passes days query param to unusedSkills", async () => {
      const res = await request(createApp())
        .get(`/companies/${cid}/skills/analytics/unused?days=14`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAnalytics.unusedSkills).toHaveBeenCalledWith(cid, 14);
    });
  });
});
