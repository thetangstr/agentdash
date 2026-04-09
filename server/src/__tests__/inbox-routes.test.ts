import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inboxRoutes } from "../routes/inbox.js";
import { errorHandler } from "../middleware/index.js";

const mockInbox = vi.hoisted(() => ({
  listRecent: vi.fn(async () => [{ id: "item-1", type: "approval", status: "pending" }]),
  listPending: vi.fn(async () => []),
  pendingCount: vi.fn(async () => 5),
  getDetail: vi.fn(async () => null),
  approve: vi.fn(async () => ({ id: "item-1", status: "approved" })),
  reject: vi.fn(async () => ({ id: "item-1", status: "rejected" })),
}));

vi.mock("../services/inbox.js", () => ({
  inboxService: () => mockInbox,
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
  app.use("/api", inboxRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("inbox routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInbox.listRecent.mockResolvedValue([{ id: "item-1", type: "approval", status: "pending" }]);
    mockInbox.listPending.mockResolvedValue([]);
    mockInbox.pendingCount.mockResolvedValue(5);
    mockInbox.getDetail.mockResolvedValue(null);
    mockInbox.approve.mockResolvedValue({ id: "item-1", status: "approved" });
    mockInbox.reject.mockResolvedValue({ id: "item-1", status: "rejected" });
  });

  describe("list", () => {
    it("returns 200 with inbox items array", async () => {
      const res = await request(createApp()).get("/api/companies/company-1/inbox");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toEqual([{ id: "item-1", type: "approval", status: "pending" }]);
      expect(mockInbox.listRecent).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ status: "all", limit: 50, offset: 0 }),
      );
    });

    it("passes status filter to listRecent", async () => {
      mockInbox.listRecent.mockResolvedValue([]);

      const res = await request(createApp()).get("/api/companies/company-1/inbox?status=pending");

      expect(res.status).toBe(200);
      expect(mockInbox.listRecent).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ status: "pending" }),
      );
    });

    it("passes agentId filter to listRecent", async () => {
      mockInbox.listRecent.mockResolvedValue([]);

      const res = await request(createApp()).get(
        "/api/companies/company-1/inbox?agentId=agent-42",
      );

      expect(res.status).toBe(200);
      expect(mockInbox.listRecent).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ agentId: "agent-42" }),
      );
    });

    it("defaults invalid status to all", async () => {
      mockInbox.listRecent.mockResolvedValue([]);

      const res = await request(createApp()).get(
        "/api/companies/company-1/inbox?status=unknown",
      );

      expect(res.status).toBe(200);
      expect(mockInbox.listRecent).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ status: "all" }),
      );
    });
  });

  describe("count", () => {
    it("returns 200 with pending count", async () => {
      const res = await request(createApp()).get("/api/companies/company-1/inbox/count");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 5 });
      expect(mockInbox.pendingCount).toHaveBeenCalledWith("company-1");
    });
  });

  describe("detail", () => {
    it("returns 404 when item not found", async () => {
      const res = await request(createApp()).get(
        "/api/companies/company-1/inbox/action-999",
      );

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Action not found" });
      expect(mockInbox.getDetail).toHaveBeenCalledWith("company-1", "action-999");
    });

    it("returns 200 with item when found", async () => {
      mockInbox.getDetail.mockResolvedValue({
        id: "action-1",
        type: "approval",
        status: "pending",
      });

      const res = await request(createApp()).get(
        "/api/companies/company-1/inbox/action-1",
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "action-1", type: "approval", status: "pending" });
      expect(mockInbox.getDetail).toHaveBeenCalledWith("company-1", "action-1");
    });
  });

  describe("approve/reject", () => {
    it("approve returns 200 with approved item", async () => {
      const res = await request(createApp())
        .post("/api/companies/company-1/inbox/action-1/approve")
        .send({ decisionNote: "Looks good" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "item-1", status: "approved" });
      expect(mockInbox.approve).toHaveBeenCalledWith(
        "company-1",
        "action-1",
        "local-board",
        "Looks good",
      );
    });

    it("approve passes actorId from board actor", async () => {
      const res = await request(createApp())
        .post("/api/companies/company-1/inbox/action-1/approve")
        .send({});

      expect(res.status).toBe(200);
      expect(mockInbox.approve).toHaveBeenCalledWith(
        "company-1",
        "action-1",
        "local-board",
        undefined,
      );
    });

    it("reject returns 200 with rejected item", async () => {
      const res = await request(createApp())
        .post("/api/companies/company-1/inbox/action-1/reject")
        .send({ reason: "Not authorized" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "item-1", status: "rejected" });
      expect(mockInbox.reject).toHaveBeenCalledWith(
        "company-1",
        "action-1",
        "local-board",
        "Not authorized",
      );
    });

    it("reject passes actorId from board actor", async () => {
      const res = await request(createApp())
        .post("/api/companies/company-1/inbox/action-1/reject")
        .send({});

      expect(res.status).toBe(200);
      expect(mockInbox.reject).toHaveBeenCalledWith(
        "company-1",
        "action-1",
        "local-board",
        undefined,
      );
    });
  });
});
