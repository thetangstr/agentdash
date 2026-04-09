import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock CRM service ────────────────────────────────────────────────────

const mockCrmService = vi.hoisted(() => ({
  listAccounts: vi.fn(async () => []),
  getAccountById: vi.fn(async () => null),
  createAccount: vi.fn(async () => ({ id: "acc-1", name: "Acme" })),
  updateAccount: vi.fn(async () => ({ id: "acc-1", name: "Acme Updated" })),
  listContacts: vi.fn(async () => []),
  getContactById: vi.fn(async () => null),
  createContact: vi.fn(async () => ({ id: "con-1", name: "John" })),
  updateContact: vi.fn(async () => ({ id: "con-1", name: "John Updated" })),
  listDeals: vi.fn(async () => []),
  getDealById: vi.fn(async () => null),
  createDeal: vi.fn(async () => ({ id: "deal-1", name: "Big Deal" })),
  updateDeal: vi.fn(async () => ({ id: "deal-1", name: "Big Deal Updated" })),
  listActivities: vi.fn(async () => []),
  createActivity: vi.fn(async () => ({ id: "act-1", type: "note" })),
  listLeads: vi.fn(async () => []),
  getLeadById: vi.fn(async () => null),
  createLead: vi.fn(async () => ({ id: "lead-1", name: "Jane Lead" })),
  updateLead: vi.fn(async () => ({ id: "lead-1", name: "Jane Updated" })),
  convertLead: vi.fn(async () => ({ accountId: "acc-2", contactId: "con-2" })),
  listPartners: vi.fn(async () => []),
  getPartnerById: vi.fn(async () => null),
  createPartner: vi.fn(async () => ({ id: "part-1", name: "Partner Co" })),
  updatePartner: vi.fn(async () => ({ id: "part-1", name: "Partner Updated" })),
  getPipelineSummary: vi.fn(async () => ({
    stages: [
      { stage: "lead", count: 5, totalAmountCents: 50000 },
      { stage: "qualification", count: 3, totalAmountCents: 120000 },
    ],
  })),
  buildContextForIssue: vi.fn(async () => ({
    account: { id: "acc-1", name: "Acme" },
    contacts: [],
    deals: [],
    activities: [],
    customerMetrics: {},
  })),
}));

vi.mock("../services/crm.js", () => ({
  crmService: () => mockCrmService,
}));

import express from "express";
import request from "supertest";
import { crmRoutes } from "../routes/crm.js";
import { errorHandler } from "../middleware/index.js";

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
  app.use("/api", crmRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("CRM routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ── Accounts ────────────────────────────────────────────────────────

  describe("accounts", () => {
    it("GET /companies/:cid/crm/accounts lists accounts", async () => {
      mockCrmService.listAccounts.mockResolvedValue([
        { id: "acc-1", name: "Acme", stage: "active" },
        { id: "acc-2", name: "Globex", stage: "prospect" },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/crm/accounts")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(mockCrmService.listAccounts).toHaveBeenCalledWith(
        "company-1",
        expect.any(Object),
      );
    });

    it("POST /companies/:cid/crm/accounts creates an account", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/crm/accounts")
        .send({ name: "Acme", industry: "tech" })
        .expect(201);

      expect(res.body.id).toBe("acc-1");
      expect(mockCrmService.createAccount).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ name: "Acme" }),
      );
    });

    it("GET /companies/:cid/crm/accounts/:id gets single account", async () => {
      mockCrmService.getAccountById.mockResolvedValue({
        id: "acc-1",
        name: "Acme",
      });

      const res = await request(app)
        .get("/api/companies/company-1/crm/accounts/acc-1")
        .expect(200);

      expect(res.body.id).toBe("acc-1");
    });

    it("GET /companies/:cid/crm/accounts/:id returns 200 with null when not found", async () => {
      mockCrmService.getAccountById.mockResolvedValue(null);

      const res = await request(app)
        .get("/api/companies/company-1/crm/accounts/nonexistent")
        .expect(200);

      expect(res.body).toBeNull();
    });

    it("PATCH /companies/:cid/crm/accounts/:id updates an account", async () => {
      const res = await request(app)
        .patch("/api/companies/company-1/crm/accounts/acc-1")
        .send({ name: "Acme Updated" })
        .expect(200);

      expect(res.body.name).toBe("Acme Updated");
    });
  });

  // ── Contacts ────────────────────────────────────────────────────────

  describe("contacts", () => {
    it("GET /companies/:cid/crm/contacts lists contacts", async () => {
      mockCrmService.listContacts.mockResolvedValue([
        { id: "con-1", name: "John", email: "john@acme.com" },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/crm/contacts")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
    });

    it("POST /companies/:cid/crm/contacts creates a contact", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/crm/contacts")
        .send({ name: "John", email: "john@acme.com" })
        .expect(201);

      expect(res.body.id).toBe("con-1");
    });

    it("GET /companies/:cid/crm/contacts/:id returns 200 with null when not found", async () => {
      mockCrmService.getContactById.mockResolvedValue(null);

      const res = await request(app)
        .get("/api/companies/company-1/crm/contacts/nonexistent")
        .expect(200);

      expect(res.body).toBeNull();
    });
  });

  // ── Deals ───────────────────────────────────────────────────────────

  describe("deals", () => {
    it("GET /companies/:cid/crm/deals lists deals", async () => {
      mockCrmService.listDeals.mockResolvedValue([
        { id: "deal-1", name: "Big Deal", stage: "lead", amountCents: 100000 },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/crm/deals")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it("POST /companies/:cid/crm/deals creates a deal", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/crm/deals")
        .send({ name: "Big Deal", stage: "lead", amountCents: 100000 })
        .expect(201);

      expect(res.body.id).toBe("deal-1");
    });

    it("GET /companies/:cid/crm/deals/:id returns 200 with null when not found", async () => {
      mockCrmService.getDealById.mockResolvedValue(null);

      const res = await request(app)
        .get("/api/companies/company-1/crm/deals/nonexistent")
        .expect(200);

      expect(res.body).toBeNull();
    });

    it("PATCH /companies/:cid/crm/deals/:id updates a deal", async () => {
      const res = await request(app)
        .patch("/api/companies/company-1/crm/deals/deal-1")
        .send({ name: "Big Deal Updated" })
        .expect(200);

      expect(res.body.name).toBe("Big Deal Updated");
    });
  });

  // ── Activities ──────────────────────────────────────────────────────

  describe("activities", () => {
    it("GET /companies/:cid/crm/activities lists activities", async () => {
      mockCrmService.listActivities.mockResolvedValue([]);

      const res = await request(app)
        .get("/api/companies/company-1/crm/activities")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it("POST /companies/:cid/crm/activities creates an activity", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/crm/activities")
        .send({ type: "note", description: "Called client" })
        .expect(201);

      expect(res.body.id).toBe("act-1");
    });
  });

  // ── Leads ───────────────────────────────────────────────────────────

  describe("leads", () => {
    it("GET /companies/:cid/crm/leads lists leads", async () => {
      mockCrmService.listLeads.mockResolvedValue([
        { id: "lead-1", name: "Jane", status: "new" },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/crm/leads")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it("POST /companies/:cid/crm/leads creates a lead", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/crm/leads")
        .send({ name: "Jane Lead", email: "jane@co.com" })
        .expect(201);

      expect(res.body.id).toBe("lead-1");
    });

    it("PATCH /companies/:cid/crm/leads/:id updates a lead", async () => {
      const res = await request(app)
        .patch("/api/companies/company-1/crm/leads/lead-1")
        .send({ status: "qualified" })
        .expect(200);

      expect(res.body.name).toBe("Jane Updated");
    });

    it("POST /companies/:cid/crm/leads/:id/convert converts a lead", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/crm/leads/lead-1/convert")
        .send({ accountId: "acc-2", contactId: "con-2" })
        .expect(200);

      expect(res.body.accountId).toBe("acc-2");
      expect(mockCrmService.convertLead).toHaveBeenCalled();
    });
  });

  // ── Partners ────────────────────────────────────────────────────────

  describe("partners", () => {
    it("GET /companies/:cid/crm/partners lists partners", async () => {
      mockCrmService.listPartners.mockResolvedValue([]);

      const res = await request(app)
        .get("/api/companies/company-1/crm/partners")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it("POST /companies/:cid/crm/partners creates a partner", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/crm/partners")
        .send({ name: "Partner Co", type: "technology" })
        .expect(201);

      expect(res.body.id).toBe("part-1");
    });
  });

  // ── Pipeline Summary ────────────────────────────────────────────────

  describe("pipeline summary", () => {
    it("GET /companies/:cid/crm/pipeline returns stage breakdown", async () => {
      const res = await request(app)
        .get("/api/companies/company-1/crm/pipeline")
        .expect(200);

      expect(res.body.stages).toHaveLength(2);
      expect(res.body.stages[0].stage).toBe("lead");
      expect(res.body.stages[0].count).toBe(5);
    });
  });

  // ── CRM Context ─────────────────────────────────────────────────────

  describe("CRM context", () => {
    it("GET /companies/:cid/crm/accounts/:aid/context returns full context", async () => {
      const res = await request(app)
        .get("/api/companies/company-1/crm/accounts/acc-1/context")
        .expect(200);

      expect(res.body.account).toBeDefined();
      expect(res.body.account.id).toBe("acc-1");
      expect(mockCrmService.buildContextForIssue).toHaveBeenCalledWith(
        "company-1",
        "acc-1",
      );
    });
  });
});
