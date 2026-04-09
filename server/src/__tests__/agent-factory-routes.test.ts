import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentTemplateRoutes } from "../routes/agent-templates.js";
import { errorHandler } from "../middleware/index.js";

const mockFactory = vi.hoisted(() => ({
  listTemplates: vi.fn(async () => []),
  getTemplateById: vi.fn(async () => null),
  getTemplateBySlug: vi.fn(async () => null),
  createTemplate: vi.fn(async () => ({ id: "tpl-1", slug: "eng", name: "Engineer", role: "engineer" })),
  updateTemplate: vi.fn(async () => ({ id: "tpl-1", slug: "eng", name: "Engineer v2" })),
  archiveTemplate: vi.fn(async () => ({ id: "tpl-1", archived: true })),
}));

vi.mock("../services/agent-factory.js", () => ({
  agentFactoryService: () => mockFactory,
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
  app.use("/api", agentTemplateRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agent template routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFactory.listTemplates.mockResolvedValue([]);
    mockFactory.getTemplateById.mockResolvedValue(null);
    mockFactory.getTemplateBySlug.mockResolvedValue(null);
    mockFactory.createTemplate.mockResolvedValue({ id: "tpl-1", slug: "eng", name: "Engineer", role: "engineer" });
    mockFactory.updateTemplate.mockResolvedValue({ id: "tpl-1", slug: "eng", name: "Engineer v2" });
    mockFactory.archiveTemplate.mockResolvedValue({ id: "tpl-1", archived: true });
  });

  describe("list templates", () => {
    it("returns 200 with empty array when no templates exist", async () => {
      const res = await request(createApp())
        .get("/api/companies/company-1/agent-templates");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mockFactory.listTemplates).toHaveBeenCalledWith("company-1", {
        role: undefined,
        archived: false,
      });
    });

    it("returns 200 with populated list when templates exist", async () => {
      mockFactory.listTemplates.mockResolvedValue([
        { id: "tpl-1", slug: "eng", name: "Engineer", role: "engineer" },
        { id: "tpl-2", slug: "pm", name: "Product Manager", role: "pm" },
      ]);

      const res = await request(createApp())
        .get("/api/companies/company-1/agent-templates");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ id: "tpl-1", slug: "eng", name: "Engineer" });
      expect(res.body[1]).toMatchObject({ id: "tpl-2", slug: "pm", name: "Product Manager" });
    });

    it("passes role filter to service when provided", async () => {
      mockFactory.listTemplates.mockResolvedValue([
        { id: "tpl-1", slug: "eng", name: "Engineer", role: "engineer" },
      ]);

      const res = await request(createApp())
        .get("/api/companies/company-1/agent-templates?role=engineer");

      expect(res.status).toBe(200);
      expect(mockFactory.listTemplates).toHaveBeenCalledWith("company-1", {
        role: "engineer",
        archived: false,
      });
    });

    it("passes archived flag to service when provided", async () => {
      const res = await request(createApp())
        .get("/api/companies/company-1/agent-templates?archived=true");

      expect(res.status).toBe(200);
      expect(mockFactory.listTemplates).toHaveBeenCalledWith("company-1", {
        role: undefined,
        archived: true,
      });
    });
  });

  describe("create template", () => {
    it("returns 201 with created template", async () => {
      const body = {
        slug: "eng",
        name: "Engineer",
        role: "engineer",
        adapterType: "claude_local",
        budgetMonthlyCents: 5000,
      };

      const res = await request(createApp())
        .post("/api/companies/company-1/agent-templates")
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: "tpl-1", slug: "eng", name: "Engineer", role: "engineer" });
    });

    it("calls createTemplate with companyId and request body", async () => {
      const body = {
        slug: "eng",
        name: "Engineer",
        role: "engineer",
        adapterType: "claude_local",
        budgetMonthlyCents: 5000,
      };

      await request(createApp())
        .post("/api/companies/company-1/agent-templates")
        .send(body);

      expect(mockFactory.createTemplate).toHaveBeenCalledWith("company-1", body);
    });
  });

  describe("get template by id", () => {
    it("returns 404 when template not found", async () => {
      mockFactory.getTemplateById.mockResolvedValue(null);

      const res = await request(createApp())
        .get("/api/companies/company-1/agent-templates/tpl-missing");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Agent template not found" });
    });

    it("returns 200 with template when found", async () => {
      mockFactory.getTemplateById.mockResolvedValue({
        id: "tpl-1",
        slug: "eng",
        name: "Engineer",
        role: "engineer",
        companyId: "company-1",
      });

      const res = await request(createApp())
        .get("/api/companies/company-1/agent-templates/tpl-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "tpl-1", slug: "eng", name: "Engineer" });
      expect(mockFactory.getTemplateById).toHaveBeenCalledWith("tpl-1");
    });
  });

  describe("update template", () => {
    it("returns 200 with updated template", async () => {
      const res = await request(createApp())
        .patch("/api/companies/company-1/agent-templates/tpl-1")
        .send({ name: "Engineer v2" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "tpl-1", name: "Engineer v2" });
    });

    it("calls updateTemplate with id and patch body", async () => {
      const patch = { name: "Engineer v2", budgetMonthlyCents: 10000 };

      await request(createApp())
        .patch("/api/companies/company-1/agent-templates/tpl-1")
        .send(patch);

      expect(mockFactory.updateTemplate).toHaveBeenCalledWith("tpl-1", patch);
    });

    it("returns 404 when template not found", async () => {
      mockFactory.updateTemplate.mockResolvedValue(null);

      const res = await request(createApp())
        .patch("/api/companies/company-1/agent-templates/tpl-missing")
        .send({ name: "Ghost" });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Agent template not found" });
    });
  });

  describe("archive template", () => {
    it("returns 200 with archived template", async () => {
      const res = await request(createApp())
        .post("/api/companies/company-1/agent-templates/tpl-1/archive");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "tpl-1", archived: true });
    });

    it("calls archiveTemplate with the template id", async () => {
      await request(createApp())
        .post("/api/companies/company-1/agent-templates/tpl-1/archive");

      expect(mockFactory.archiveTemplate).toHaveBeenCalledWith("tpl-1");
    });

    it("returns 404 when template not found", async () => {
      mockFactory.archiveTemplate.mockResolvedValue(null);

      const res = await request(createApp())
        .post("/api/companies/company-1/agent-templates/tpl-missing/archive");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Agent template not found" });
    });
  });
});
