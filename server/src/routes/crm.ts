import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { crmService } from "../services/crm.js";
import { assertCompanyAccess } from "./authz.js";

export function crmRoutes(db: Db) {
  const router = Router();
  const svc = crmService(db);

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/crm/accounts", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.listAccounts(companyId, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
        stage: req.query.stage as string | undefined,
        ownerAgentId: req.query.ownerAgentId as string | undefined,
      });
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/crm/accounts", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createAccount(companyId, req.body);
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/crm/accounts/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.getAccountById(req.params.id as string);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.patch("/companies/:companyId/crm/accounts/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.updateAccount(req.params.id as string, req.body);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/crm/contacts", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.listContacts(companyId, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
        accountId: req.query.accountId as string | undefined,
        ownerAgentId: req.query.ownerAgentId as string | undefined,
      });
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/crm/contacts", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createContact(companyId, req.body);
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/crm/contacts/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.getContactById(req.params.id as string);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.patch("/companies/:companyId/crm/contacts/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.updateContact(req.params.id as string, req.body);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // Deals
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/crm/deals", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.listDeals(companyId, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
        accountId: req.query.accountId as string | undefined,
        stage: req.query.stage as string | undefined,
        ownerAgentId: req.query.ownerAgentId as string | undefined,
      });
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/crm/deals", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createDeal(companyId, req.body);
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/crm/deals/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.getDealById(req.params.id as string);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.patch("/companies/:companyId/crm/deals/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.updateDeal(req.params.id as string, req.body);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // Activities
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/crm/activities", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.listActivities(companyId, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
        accountId: req.query.accountId as string | undefined,
        dealId: req.query.dealId as string | undefined,
      });
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/crm/activities", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createActivity(companyId, req.body);
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // Pipeline Dashboard
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/crm/pipeline", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.getPipelineSummary(companyId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Leads ---------------

  router.get("/companies/:companyId/crm/leads", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { status, source, limit, offset } = req.query as Record<string, string | undefined>;
      const result = await svc.listLeads(companyId, { status, source, limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined });
      res.status(200).json(result);
    } catch (err: unknown) {
      const s = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(s).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  router.post("/companies/:companyId/crm/leads", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createLead(companyId, req.body);
      res.status(201).json(result);
    } catch (err: unknown) {
      const s = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(s).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  router.get("/companies/:companyId/crm/leads/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.getLeadById(req.params.id as string);
      res.status(200).json(result);
    } catch (err: unknown) {
      const s = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(s).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  router.patch("/companies/:companyId/crm/leads/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.updateLead(req.params.id as string, req.body);
      res.status(200).json(result);
    } catch (err: unknown) {
      const s = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(s).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  router.post("/companies/:companyId/crm/leads/:id/convert", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { accountId, contactId } = req.body;
      const result = await svc.convertLead(req.params.id as string, accountId, contactId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const s = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(s).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  // --------------- Partners ---------------

  router.get("/companies/:companyId/crm/partners", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { type, status, limit, offset } = req.query as Record<string, string | undefined>;
      const result = await svc.listPartners(companyId, { type, status, limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined });
      res.status(200).json(result);
    } catch (err: unknown) {
      const s = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(s).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  router.post("/companies/:companyId/crm/partners", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createPartner(companyId, req.body);
      res.status(201).json(result);
    } catch (err: unknown) {
      const s = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(s).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  router.get("/companies/:companyId/crm/partners/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.getPartnerById(req.params.id as string);
      res.status(200).json(result);
    } catch (err: unknown) {
      const s = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(s).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  router.patch("/companies/:companyId/crm/partners/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.updatePartner(req.params.id as string, req.body);
      res.status(200).json(result);
    } catch (err: unknown) {
      const s = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(s).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  return router;
}
