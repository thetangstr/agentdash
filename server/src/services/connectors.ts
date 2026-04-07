import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { companyConnectors } from "@agentdash/db";
import type { ConnectorProvider } from "@agentdash/shared";
import { notFound } from "../errors.js";

// ── Token encryption (AES-256-GCM + HKDF-SHA256) ───────────────────

interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  salt: string;
  tag: string;
  [key: string]: unknown;
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, salt, "agentdash-connector-tokens", 32),
  );
}

export function encryptTokens(
  tokens: Record<string, unknown>,
  secret: string,
): EncryptedPayload {
  const salt = randomBytes(16);
  const key = deriveKey(secret, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(tokens);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptTokens(
  payload: EncryptedPayload,
  secret: string,
): Record<string, unknown> {
  const salt = Buffer.from(payload.salt, "base64");
  const key = deriveKey(secret, salt);
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

// ── Service ─────────────────────────────────────────────────────────

function getEncryptionSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for connector token encryption");
  return secret;
}

export function connectorService(db: Db) {
  return {
    async list(companyId: string) {
      return db
        .select()
        .from(companyConnectors)
        .where(eq(companyConnectors.companyId, companyId));
    },

    async getByProvider(companyId: string, provider: string) {
      const [row] = await db
        .select()
        .from(companyConnectors)
        .where(
          and(
            eq(companyConnectors.companyId, companyId),
            eq(companyConnectors.provider, provider),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async connect(
      companyId: string,
      provider: ConnectorProvider,
      displayName: string,
      tokens: Record<string, unknown>,
      scopes: string[],
      connectedBy: string,
    ) {
      const secret = getEncryptionSecret();
      const encrypted = encryptTokens(tokens, secret);

      const [row] = await db
        .insert(companyConnectors)
        .values({
          companyId,
          provider,
          displayName,
          status: "connected",
          encryptedTokens: encrypted,
          scopes,
          connectedBy,
          connectedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [companyConnectors.companyId, companyConnectors.provider],
          set: {
            displayName,
            status: "connected",
            encryptedTokens: encrypted,
            scopes,
            connectedBy,
            connectedAt: new Date(),
            errorMessage: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    async disconnect(companyId: string, connectorId: string) {
      const [row] = await db
        .update(companyConnectors)
        .set({
          status: "disconnected",
          encryptedTokens: null,
          connectedAt: null,
          connectedBy: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(companyConnectors.id, connectorId),
            eq(companyConnectors.companyId, companyId),
          ),
        )
        .returning();
      if (!row) throw notFound("Connector not found");
      return row;
    },

    async getTokens(companyId: string, provider: string) {
      const connector = await this.getByProvider(companyId, provider);
      if (!connector?.encryptedTokens) return null;
      const secret = getEncryptionSecret();
      return decryptTokens(
        connector.encryptedTokens as unknown as EncryptedPayload,
        secret,
      );
    },

    async setError(companyId: string, provider: string, errorMessage: string) {
      await db
        .update(companyConnectors)
        .set({ status: "error", errorMessage, updatedAt: new Date() })
        .where(
          and(
            eq(companyConnectors.companyId, companyId),
            eq(companyConnectors.provider, provider),
          ),
        );
    },
  };
}
