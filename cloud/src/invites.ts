// AgentDash (SC-9, GH #770): the self-hosted invite validator, moved off the
// old shared instance (spec §7). Fresh self-hosted installs call
// https://www.agentdash.cloud/api/invites/validate before creating their
// founding user (server/src/routes/onboarding-mcp-signup.ts); Vercel rewrites
// that URL here, so it never changes for them.
//
// Contract (identical to server/src/routes/invite-codes.ts):
//   POST {code}  → 200 {valid: boolean}; 400 {code: "invalid_body", error}
//   rate limited → 429 {error: "Rate limited", retryAfter} + Retry-After
//
// Codes are stored only as an HMAC-SHA256 under the data key (so a leaked
// table cannot be brute-forced offline, even for short codes). Lookup tries
// the HMAC under every key in the keyring, so rotating CLOUD_DATA_KEY keeps
// old codes valid while CLOUD_DATA_KEYS_PREVIOUS lists the old key.
import { createHmac, randomBytes } from "node:crypto";
import { Router, type Router as ExpressRouter } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { CloudConfig } from "./config.js";
import { constantTimeEqual, type DataKeyring } from "./crypto.js";
import type { CloudDb } from "./db/client.js";
import { inviteCodes, operatorAudit } from "./db/schema.js";
import type { Logger } from "./logger.js";
import { takeHit } from "./front-door/rate-limit.js";
import { visitorOf } from "./routes/public.js";

export const INVITE_WINDOW_MS = 15 * 60_000;
/** Same as the box's auth-tier limiter: 10 attempts per 15 minutes per client. */
export const INVITE_MAX_PER_IP = 10;
/** Ceiling per connecting address (Vercel, when the client IP comes from a header). */
export const INVITE_MAX_PER_PROXY = 600;
const CODE_MAX = 120;

function hmacUnder(key: { reveal(): string }, code: string): string {
  return createHmac("sha256", Buffer.from(key.reveal(), "hex")).update(`agentdash-invite-code:${code}`, "utf8").digest("hex");
}

export function inviteCodeHash(keys: DataKeyring, code: string): string {
  return hmacUnder(keys.current, code);
}

function candidateHashes(keys: DataKeyring, code: string): string[] {
  return keys.all().map((k) => hmacUnder(k, code));
}

/** A new code in the format the old instance used for its funnel codes. */
export function newInviteCode(): string {
  return `AGD-INV-${randomBytes(10).toString("hex").toUpperCase()}`;
}

/** Split stdin or a body into codes: commas, whitespace and newlines separate; blanks dropped. */
export function parseCodeList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean))];
}

export function inviteService(db: CloudDb, keys: DataKeyring) {
  return {
    async isValid(code: string): Promise<boolean> {
      const hashes = candidateHashes(keys, code);
      const rows = await db
        .select({ codeHash: inviteCodes.codeHash })
        .from(inviteCodes)
        .where(and(inArray(inviteCodes.codeHash, hashes), isNull(inviteCodes.revokedAt)));
      // Constant-time confirmation of whatever the index found.
      return rows.some((r) => hashes.some((h) => constantTimeEqual(r.codeHash, h)));
    },

    /** Import codes (only their HMACs are stored). Returns counts, never codes. */
    async importCodes(codes: string[], label: string | null, actor: string, ip: string | null): Promise<{ added: number; alreadyPresent: number; rejected: number }> {
      let added = 0;
      let alreadyPresent = 0;
      let rejected = 0;
      await db.transaction(async (tx) => {
        for (const code of codes) {
          if (code.length > CODE_MAX) {
            rejected += 1;
            continue;
          }
          const existing = await tx.select({ id: inviteCodes.id }).from(inviteCodes).where(inArray(inviteCodes.codeHash, candidateHashes(keys, code)));
          if (existing.length) {
            alreadyPresent += 1;
            continue;
          }
          await tx.insert(inviteCodes).values({ codeHash: inviteCodeHash(keys, code), label });
          added += 1;
        }
        await tx.insert(operatorAudit).values({ kind: "invite_codes_changed", actor, ip, detail: { action: "import", label, added, alreadyPresent, rejected } });
      });
      return { added, alreadyPresent, rejected };
    },

    async add(label: string | null, actor: string, ip: string | null): Promise<{ id: string; code: string }> {
      const code = newInviteCode();
      const [row] = await db.insert(inviteCodes).values({ codeHash: inviteCodeHash(keys, code), label }).returning({ id: inviteCodes.id });
      await db.insert(operatorAudit).values({ kind: "invite_codes_changed", actor, ip, detail: { action: "add", id: row!.id, label } });
      return { id: row!.id, code };
    },

    async revoke(id: string, actor: string, ip: string | null): Promise<boolean> {
      const rows = await db
        .update(inviteCodes)
        .set({ revokedAt: new Date() })
        .where(and(eq(inviteCodes.id, id), isNull(inviteCodes.revokedAt)))
        .returning({ id: inviteCodes.id });
      if (!rows.length) return false;
      await db.insert(operatorAudit).values({ kind: "invite_codes_changed", actor, ip, detail: { action: "revoke", id } });
      return true;
    },

    async list() {
      return await db
        .select({ id: inviteCodes.id, label: inviteCodes.label, createdAt: inviteCodes.createdAt, revokedAt: inviteCodes.revokedAt })
        .from(inviteCodes)
        .orderBy(inviteCodes.createdAt)
        .limit(1000);
    },
  };
}

/** POST /api/invites/validate, public. */
export function inviteValidateRoutes(opts: {
  db: CloudDb;
  log: Logger;
  config: Pick<CloudConfig, "clientIpSource" | "privateNetwork" | "frontDoor" | "dataKeys">;
}): ExpressRouter {
  const { db, log, config } = opts;
  const svc = inviteService(db, config.dataKeys);
  const router = Router();
  const limited = (res: import("express").Response) => {
    const retryAfter = Math.ceil(INVITE_WINDOW_MS / 1000);
    res.status(429).set("Retry-After", String(retryAfter)).json({ error: "Rate limited", retryAfter });
  };
  router.post("/invites/validate", async (req, res) => {
    const visitor = visitorOf(req, config);
    if (visitor.proxyIp && !(await takeHit(db, { bucket: "invite_proxy", limit: INVITE_MAX_PER_PROXY, windowMs: INVITE_WINDOW_MS }, visitor.proxyIp))) return limited(res);
    if (!(await takeHit(db, { bucket: "invite_ip", limit: INVITE_MAX_PER_IP, windowMs: INVITE_WINDOW_MS }, visitor.ip ?? "unknown"))) return limited(res);
    const raw = (req.body ?? {}).code;
    const code = typeof raw === "string" ? raw.trim() : "";
    if (!code || code.length > CODE_MAX) {
      res.status(400).json({ code: "invalid_body", error: "Body must be { code: 1-120 chars }." });
      return;
    }
    const valid = await svc.isValid(code);
    log.info("invite code checked", { valid });
    res.json({ valid });
  });
  return router;
}
