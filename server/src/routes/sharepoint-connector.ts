import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { requireProductProfile } from "../services/companies.js";
import {
  sharepointConnectorService,
  type WorkbookTarget,
} from "../services/sharepoint-connector.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * AgentDash-MK: SharePoint, read as the acting person.
 *
 * Two surfaces with deliberately different authentication:
 *
 * - `/me/connections/sharepoint` is board-user only and always binds to the
 *   authenticated caller. There is no `userId` parameter, for the same reason
 *   the HubSpot and channel routes have none: a personal identity a colleague
 *   can attach on your behalf is not a personal identity.
 * - `/sharepoint/...` is agent-authenticated only. A board user reading through
 *   an agent's ceiling would produce a result the ceiling never authorized, and
 *   would read using a principal that is not their own — which is precisely the
 *   confusion on-behalf-of exists to eliminate.
 *
 * Profile-gated: outside `agentdash_mk` every route here answers 404, not 403.
 */
export function sharepointConnectorRoutes(db: Db) {
  const router = Router();
  const sharepoint = sharepointConnectorService(db);
  const access = accessService(db);

  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  function requireBoardUser(req: Request) {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user access required");
    return req.actor.userId;
  }

  function requireAgent(req: Request, companyId: string) {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    return req.actor.agentId;
  }

  function requireAssertion(req: Request): string {
    const assertion =
      typeof req.body?.userAssertion === "string" ? req.body.userAssertion.trim() : "";
    if (!assertion) throw badRequest("A Microsoft Entra user assertion is required");
    return assertion;
  }

  async function isAdministrator(req: Request, companyId: string) {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return access.canUser(companyId, req.actor.userId, "agents:create");
  }

  /**
   * Run context, when the caller has one.
   *
   * All three parts or none. A partial context would emit an event keyed to a
   * run that does not exist, which is worse than no measurement at all: it puts
   * a wrong number in the one place the labour curve is read from.
   */
  function runContext(req: Request) {
    const pipelineId = typeof req.query.pipelineId === "string" ? req.query.pipelineId : "";
    const runId = typeof req.query.runId === "string" ? req.query.runId : "";
    const stepKey = typeof req.query.stepKey === "string" ? req.query.stepKey : "";
    if (!pipelineId || !runId || !stepKey) return undefined;
    return { pipelineId, runId, stepKey };
  }

  // -- the person's own identity -------------------------------------------

  /** Health for the caller's own identity. Never returns the assertion. */
  router.get("/companies/:companyId/me/connections/sharepoint", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    const connection = await sharepoint.activeConnectionFor(companyId, userId);
    if (!connection) {
      res.json({ connection: null });
      return;
    }
    res.json({
      connection: {
        id: connection.id,
        account: connection.accountLabel,
        scopes: connection.scopes,
        status: connection.status,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      },
    });
  });

  router.post("/companies/:companyId/me/connections/sharepoint", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const assertion = requireAssertion(req);

    const { connectionId, account, grantedScopes } = await sharepoint.connect(
      companyId,
      userId,
      assertion,
    );
    res.status(201).json({ connectionId, account, grantedScopes });
  });

  router.post("/companies/:companyId/me/connections/sharepoint/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const connectionId = await sharepoint.revoke(
      companyId,
      userId,
      userId,
      await isAdministrator(req, companyId),
    );
    res.json({ connectionId, revoked: true });
  });

  // -- agent-facing reads ---------------------------------------------------

  /**
   * A refusal is a normal outcome, not a fault to retry.
   *
   * `details.reason` is a stable string the agent's prompt knows how to read —
   * the difference between "the owner ceiling refused this" and "nobody has
   * connected an identity you may use" is actionable, and a bare 403 is not.
   */
  function respond(
    res: Parameters<Parameters<typeof router.get>[1]>[1],
    result: { ok: true } | { ok: false; reason: string; message: string },
    body: () => Record<string, unknown>,
  ) {
    if (!result.ok) {
      res.status(403).json({ error: result.message, details: { reason: result.reason } });
      return;
    }
    res.json(body());
  }

  router.get("/companies/:companyId/sharepoint/sites/:siteId/files", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const agentId = requireAgent(req, companyId);

    const result = await sharepoint.readSiteFiles({
      companyId,
      agentId,
      siteId: req.params.siteId as string,
      folderPath: typeof req.query.path === "string" ? req.query.path : undefined,
      runContext: runContext(req),
    });
    respond(res, result, () => ({ items: result.ok ? result.items : [] }));
  });

  router.get(
    "/companies/:companyId/sharepoint/sites/:siteId/lists/:listId/items",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await requireProfileCompany(req, companyId);
      const agentId = requireAgent(req, companyId);

      const result = await sharepoint.readListItems({
        companyId,
        agentId,
        siteId: req.params.siteId as string,
        listId: req.params.listId as string,
        runContext: runContext(req),
      });
      respond(res, result, () => ({ items: result.ok ? result.items : [] }));
    },
  );

  /**
   * A workbook range, addressed by NAME.
   *
   * There is no default and no "just give me the sheet" affordance, because the
   * answer to that question is a wrong cell. A caller with no named target gets
   * a 400 telling it to name one.
   */
  router.get(
    "/companies/:companyId/sharepoint/sites/:siteId/workbooks/:itemId/range",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await requireProfileCompany(req, companyId);
      const agentId = requireAgent(req, companyId);

      const table = typeof req.query.table === "string" ? req.query.table.trim() : "";
      const namedRange = typeof req.query.namedRange === "string" ? req.query.namedRange.trim() : "";
      const worksheet = typeof req.query.worksheet === "string" ? req.query.worksheet.trim() : "";

      let target: WorkbookTarget;
      if (table) target = { kind: "table", name: table };
      else if (namedRange) target = { kind: "namedRange", name: namedRange };
      else if (worksheet) target = { kind: "worksheet", name: worksheet };
      else {
        throw badRequest(
          "Name what to read: table, namedRange, or worksheet. This connector will not guess at a cell range.",
        );
      }

      const result = await sharepoint.readWorkbookRange({
        companyId,
        agentId,
        siteId: req.params.siteId as string,
        itemId: req.params.itemId as string,
        target,
        runContext: runContext(req),
      });
      respond(res, result, () => ({
        target: result.ok ? result.target : null,
        address: result.ok ? result.address : null,
        values: result.ok ? result.values : [],
        rowCount: result.ok ? result.rowCount : 0,
        columnCount: result.ok ? result.columnCount : 0,
      }));
    },
  );

  return router;
}
