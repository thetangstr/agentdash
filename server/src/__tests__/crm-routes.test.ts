import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { crmRoutes } from "../routes/crm.js";
import { errorHandler } from "../middleware/index.js";

const mockCrmService = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  createAccount: vi.fn(),
  getAccountById: vi.fn(),
  updateAccount: vi.fn(),
  listContacts: vi.fn(),
  createContact: vi.fn(),
  getContactById: vi.fn(),
  updateContact: vi.fn(),
  listDeals: vi.fn(),
  createDeal: vi.fn(),
  getDealById: vi.fn(),
  updateDeal: vi.fn(),
  listActivities: vi.fn(),
  createActivity: vi.fn(),
  getPipelineSummary: vi.fn(),
  listLeads: vi.fn(),
  createLead: vi.fn(),
  getLeadById: vi.fn(),
  updateLead: vi.fn(),
  convertLead: vi.fn(),
  listPartners: vi.fn(),
  createPartner: vi.fn(),
  getPartnerById: vi.fn(),
  updatePartner: vi.fn(),
}));

vi.mock("../services/crm.js", () => ({
  crmService: () => mockCrmService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as any;
    next();
  });
  app.use("/api", crmRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("crm routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes company scope into account detail lookups", async () => {
    mockCrmService.getAccountById.mockResolvedValue({ id: "account-1", companyId: "company-1", name: "Acme" });
    const app = createApp({ type: "board", userId: "user-1", source: "local_implicit" });

    const res = await request(app).get("/api/companies/company-1/crm/accounts/account-1");

    expect(res.status).toBe(200);
    expect(mockCrmService.getAccountById).toHaveBeenCalledWith("company-1", "account-1");
  });

  it("passes company scope into account updates", async () => {
    mockCrmService.updateAccount.mockResolvedValue({ id: "account-1", companyId: "company-1", stage: "customer" });
    const app = createApp({ type: "board", userId: "user-1", source: "local_implicit" });

    const res = await request(app)
      .patch("/api/companies/company-1/crm/accounts/account-1")
      .send({ stage: "customer" });

    expect(res.status).toBe(200);
    expect(mockCrmService.updateAccount).toHaveBeenCalledWith("company-1", "account-1", { stage: "customer" });
  });

  it("passes company scope into lead conversion", async () => {
    mockCrmService.convertLead.mockResolvedValue({ id: "lead-1", status: "converted" });
    const app = createApp({ type: "board", userId: "user-1", source: "local_implicit" });

    const res = await request(app)
      .post("/api/companies/company-1/crm/leads/lead-1/convert")
      .send({ accountId: "account-1", contactId: "contact-1" });

    expect(res.status).toBe(200);
    expect(mockCrmService.convertLead).toHaveBeenCalledWith("company-1", "lead-1", "account-1", "contact-1");
  });

  it("rejects board users outside the company", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app).get("/api/companies/company-1/crm/accounts/account-1");

    expect(res.status).toBe(403);
    expect(mockCrmService.getAccountById).not.toHaveBeenCalled();
  });
});
