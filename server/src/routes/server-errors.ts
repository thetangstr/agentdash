import { Router, type Request } from "express";
import { desc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { serverErrors } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { alerterStatus } from "../observability/alerter.js";
import { computeHealthChecks } from "../observability/health-checks.js";

/**
 * O2 (2026-08-16): somewhere to READ the error sink.
 *
 * O1 records every 5xx and unhandled rejection to Postgres. Without this the
 * result is a table nobody opens — which is a quieter version of the failure
 * O1 replaced, where errors were formatted and dropped. The point of the
 * whole exercise is that a person finds out.
 *
 * Instance-admin only. Error messages and stacks name internal paths, ids and
 * query shapes; that is the right trade for the person who has to fix it and
 * the wrong one for everybody else.
 */
function assertCanReadServerErrors(req: Request) {
  if (req.actor.type !== "board") throw forbidden("Board access required");
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  throw forbidden("Instance admin access required");
}

export function serverErrorRoutes(db: Db) {
  const router = Router();

  router.get("/instance/errors", async (req, res) => {
    assertCanReadServerErrors(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await db
      .select()
      .from(serverErrors)
      .orderBy(desc(serverErrors.lastSeen))
      .limit(limit);

    // The health checks and alerter status ride along so one page answers
    // "what broke" and "would anyone have been told" together. The second
    // question is the one this project kept getting wrong.
    const [checks, alerter] = [await computeHealthChecks(db).catch(() => null), alerterStatus()];

    res.json({
      errors: rows.map((row) => ({
        id: row.id,
        fingerprint: row.fingerprint,
        name: row.name,
        message: row.message,
        stack: row.stack,
        lastContext: row.lastContext,
        count: row.count,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
      })),
      alerter,
      checks,
    });
  });

  /**
   * Clear one fingerprint after it is fixed. Deliberately a DELETE of a
   * single row rather than a "mark resolved" flag: if it happens again the
   * row comes back with a fresh first-seen, which is the honest signal that
   * the fix did not hold.
   */
  router.delete("/instance/errors/:fingerprint", async (req, res) => {
    assertCanReadServerErrors(req);
    const fingerprint = req.params.fingerprint as string;
    const deleted = await db
      .delete(serverErrors)
      .where(sql`${serverErrors.fingerprint} = ${fingerprint}`)
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "No such error fingerprint" });
      return;
    }
    res.json({ cleared: deleted.length });
  });

  return router;
}
