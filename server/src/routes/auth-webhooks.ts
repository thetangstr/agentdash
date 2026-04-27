// AgentDash (AGE-58): WorkOS webhook ingestion route.
// Mounted OUTSIDE the boardMutationGuard + company auth middleware at
// POST /api/auth/webhooks/workos (see app.ts).
//
// Responsibilities:
//   1. Validate HMAC signature from WorkOS (reject 401 on failure).
//   2. On user.created / user.updated: idempotent upsert into authUsers.
//   3. Log every delivery to activity_log with actorType='system'.
//   4. Replay protection: ignore duplicate eventId (same-id upsert is harmless).

import { createHmac, timingSafeEqual } from "node:crypto";
import { type Request, type Response } from "express";
import type { Db } from "@agentdash/db";
import { authUsers } from "@agentdash/db";
import { eq } from "drizzle-orm";
import { logActivity } from "../services/activity-log.js";

// ---------------------------------------------------------------------------
// Types for WorkOS webhook payloads (subset we care about)
// ---------------------------------------------------------------------------

interface WorkOSWebhookUser {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
}

interface WorkOSWebhookEvent {
  id: string;
  event: string;
  data: WorkOSWebhookUser;
}

// ---------------------------------------------------------------------------
// HMAC signature validation
// ---------------------------------------------------------------------------

/**
 * Validate the WorkOS webhook signature.
 * WorkOS sends: `t=<timestamp>,v1=<hmac-sha256-hex>`
 * Payload to sign: `<timestamp>.<raw-body>`
 */
function validateWorkOSSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const idx = part.indexOf("=");
      return [part.slice(0, idx), part.slice(idx + 1)];
    }),
  );

  const timestamp = parts["t"];
  const v1 = parts["v1"];
  if (!timestamp || !v1) return false;

  const payload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(v1, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Webhook handler factory
// ---------------------------------------------------------------------------

export function workosWebhookHandler(db: Db, webhookSecret: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "Missing raw body" });
      return;
    }

    const signatureHeader = req.headers["workos-signature"] as string | undefined;

    if (!validateWorkOSSignature(rawBody, signatureHeader, webhookSecret)) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    let event: WorkOSWebhookEvent;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as WorkOSWebhookEvent;
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    const { id: eventId, event: eventType, data: userData } = event;

    // Handle user.created and user.updated — idempotent upsert into authUsers.
    if (eventType === "user.created" || eventType === "user.updated") {
      const name =
        [userData.first_name, userData.last_name].filter(Boolean).join(" ").trim() || userData.email;

      const now = new Date();

      // Upsert keyed on WorkOS user id (the id column is a text PK).
      const existing = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, userData.id))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        await db
          .update(authUsers)
          .set({ email: userData.email, name, updatedAt: now })
          .where(eq(authUsers.id, userData.id));
      } else {
        await db.insert(authUsers).values({
          id: userData.id,
          email: userData.email,
          name,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        });
      }

      // JIT auto-join: when sign-up completes for a verified-domain email AND
      // the org has allowJitProvisioning=true, WorkOS creates the membership
      // server-side; we mirror it to companyMemberships.
      // TODO(AGE-61): replace `false` with actual allowJitProvisioning check
      // once the column is added by AGE-61.
      const allowJitProvisioning = false;
      if (eventType === "user.created" && allowJitProvisioning) {
        // AGE-61 will implement the JIT mirror logic here.
      }
    }

    // Log every delivery to activity_log.
    // We use a synthetic "system" companyId sentinel since webhooks are
    // global (not company-scoped) and the activity_log schema requires a
    // non-null companyId. Callers can filter by actorType='system' +
    // action='workos_webhook_received' to find these entries.
    try {
      await logActivity(db, {
        companyId: "system",
        actorType: "system",
        actorId: "workos",
        action: "workos_webhook_received",
        entityType: "workos_event",
        entityId: eventId,
        details: { eventType, workosUserId: userData.id },
      });
    } catch {
      // Activity logging is best-effort; do not fail the webhook response.
    }

    res.json({ received: true });
  };
}
