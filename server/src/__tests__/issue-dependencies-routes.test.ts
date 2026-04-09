import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueDependencyRoutes } from "../routes/issue-dependencies.js";
import { errorHandler } from "../middleware/index.js";

const mockDeps = vi.hoisted(() => ({
  addDependency: vi.fn(async () => ({ id: "dep-1", issueId: "issue-1", blockedByIssueId: "issue-2" })),
  removeDependency: vi.fn(async () => true),
  getBlockers: vi.fn(async () => [{ id: "issue-2", title: "Blocker issue" }]),
  getDependents: vi.fn(async () => [{ id: "issue-3", title: "Dependent issue" }]),
  getFullDag: vi.fn(async () => ({ nodes: [], edges: [] })),
  detectCycle: vi.fn(async () => false),
  processCompletionUnblock: vi.fn(async () => ({ unblocked: [] })),
  getReadyToStart: vi.fn(async () => []),
}));

vi.mock("../services/task-dependencies.js", () => ({
  taskDependencyService: () => mockDeps,
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
  app.use(issueDependencyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("issue dependency routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeps.addDependency.mockImplementation(async () => ({ id: "dep-1", issueId: "issue-1", blockedByIssueId: "issue-2" }));
    mockDeps.removeDependency.mockImplementation(async () => true);
    mockDeps.getBlockers.mockImplementation(async () => [{ id: "issue-2", title: "Blocker issue" }]);
    mockDeps.getDependents.mockImplementation(async () => [{ id: "issue-3", title: "Dependent issue" }]);
    mockDeps.getFullDag.mockImplementation(async () => ({ nodes: [], edges: [] }));
    mockDeps.detectCycle.mockImplementation(async () => false);
    mockDeps.processCompletionUnblock.mockImplementation(async () => ({ unblocked: [] }));
    mockDeps.getReadyToStart.mockImplementation(async () => []);
  });

  describe("add/remove dependencies", () => {
    it("POST /companies/:cid/issues/:issueId/dependencies returns 201 with new dependency", async () => {
      const res = await request(createApp())
        .post("/companies/company-1/issues/issue-1/dependencies")
        .send({ blockedByIssueId: "issue-2", dependencyType: "blocks" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        id: "dep-1",
        issueId: "issue-1",
        blockedByIssueId: "issue-2",
      });
    });

    it("POST calls addDependency with companyId, issueId, blockedByIssueId and options", async () => {
      await request(createApp())
        .post("/companies/company-1/issues/issue-1/dependencies")
        .send({ blockedByIssueId: "issue-2", dependencyType: "blocks" });

      expect(mockDeps.addDependency).toHaveBeenCalledWith(
        "company-1",
        "issue-1",
        "issue-2",
        expect.objectContaining({ dependencyType: "blocks" }),
      );
    });

    it("DELETE /companies/:cid/issues/:issueId/dependencies/:blockedByIssueId returns 200 with success", async () => {
      const res = await request(createApp())
        .delete("/companies/company-1/issues/issue-1/dependencies/issue-2");

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it("DELETE calls removeDependency with companyId, issueId, blockedByIssueId", async () => {
      await request(createApp())
        .delete("/companies/company-1/issues/issue-1/dependencies/issue-2");

      expect(mockDeps.removeDependency).toHaveBeenCalledWith(
        "company-1",
        "issue-1",
        "issue-2",
      );
    });
  });

  describe("query blockers/dependents", () => {
    it("GET /companies/:cid/issues/:issueId/blockers returns 200 with array", async () => {
      const res = await request(createApp())
        .get("/companies/company-1/issues/issue-1/blockers");

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toEqual([{ id: "issue-2", title: "Blocker issue" }]);
    });

    it("GET blockers calls getBlockers with companyId and issueId", async () => {
      await request(createApp())
        .get("/companies/company-1/issues/issue-1/blockers");

      expect(mockDeps.getBlockers).toHaveBeenCalledWith("company-1", "issue-1");
    });

    it("GET /companies/:cid/issues/:issueId/dependents returns 200 with array", async () => {
      const res = await request(createApp())
        .get("/companies/company-1/issues/issue-1/dependents");

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toEqual([{ id: "issue-3", title: "Dependent issue" }]);
    });

    it("GET dependents calls getDependents with companyId and issueId", async () => {
      await request(createApp())
        .get("/companies/company-1/issues/issue-1/dependents");

      expect(mockDeps.getDependents).toHaveBeenCalledWith("company-1", "issue-1");
    });
  });

  describe("dependency graph", () => {
    it("GET /companies/:cid/projects/:projectId/dependency-graph returns 200 with graph object", async () => {
      const res = await request(createApp())
        .get("/companies/company-1/projects/project-1/dependency-graph");

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ nodes: [], edges: [] });
    });

    it("GET dependency-graph calls getFullDag with companyId and projectId", async () => {
      await request(createApp())
        .get("/companies/company-1/projects/project-1/dependency-graph");

      expect(mockDeps.getFullDag).toHaveBeenCalledWith("company-1", "project-1");
    });
  });
});
