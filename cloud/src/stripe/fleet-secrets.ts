// AgentDash (SC-8, GH #769): secrets shared by the whole fleet, encrypted
// under CLOUD_DATA_KEY in fleet_secrets. A change and its operator_audit row
// (name, version, fingerprint prefix; never the value) commit together.
import { eq } from "drizzle-orm";
import { decryptField, encryptField, sha256Hex, type DataKeyring } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { fleetSecrets, operatorAudit } from "../db/schema.js";

export const BOX_STRIPE_KEY = "stripe_box_restricted_key";
export const STRIPE_ENDPOINT_SECRET = "stripe_account_webhook_secret";
export type FleetSecretName = typeof BOX_STRIPE_KEY | typeof STRIPE_ENDPOINT_SECRET;

const aad = (name: FleetSecretName) => `fleet_secrets.value:${name}`;

export interface FleetSecretInfo {
  version: number;
  /** First 12 hex characters of the value's sha256: enough to compare, useless to an attacker. */
  fingerprint: string;
  updatedAt: Date;
}

export function fleetSecretStore(db: CloudDb, keys: DataKeyring) {
  return {
    async info(name: FleetSecretName): Promise<FleetSecretInfo | null> {
      const [row] = await db.select().from(fleetSecrets).where(eq(fleetSecrets.name, name));
      return row ? { version: row.version, fingerprint: row.fingerprint.slice(0, 12), updatedAt: row.updatedAt } : null;
    },
    /** The plaintext, for in-memory use only (never logged, never returned by an API). */
    async reveal(name: FleetSecretName): Promise<{ value: string; version: number } | null> {
      const [row] = await db.select().from(fleetSecrets).where(eq(fleetSecrets.name, name));
      return row ? { value: decryptField(keys, row.valueEnc, aad(name)), version: row.version } : null;
    },
    /** True when `value` is what is stored now (compared by fingerprint). */
    async matches(name: FleetSecretName, value: string): Promise<boolean> {
      const [row] = await db.select({ fp: fleetSecrets.fingerprint }).from(fleetSecrets).where(eq(fleetSecrets.name, name));
      return row?.fp === sha256Hex(value);
    },
    /** Store a new value (version + 1). Storing the value already there changes nothing. */
    async set(name: FleetSecretName, value: string, actor: string, ip: string | null = null): Promise<{ version: number; changed: boolean }> {
      const fingerprint = sha256Hex(value);
      return await db.transaction(async (tx) => {
        const [prev] = await tx.select().from(fleetSecrets).where(eq(fleetSecrets.name, name)).for("update");
        if (prev?.fingerprint === fingerprint) return { version: prev.version, changed: false };
        const version = (prev?.version ?? 0) + 1;
        const valueEnc = encryptField(keys, value, aad(name));
        await tx
          .insert(fleetSecrets)
          .values({ name, valueEnc, fingerprint, version, updatedBy: actor })
          .onConflictDoUpdate({ target: fleetSecrets.name, set: { valueEnc, fingerprint, version, updatedBy: actor, updatedAt: new Date() } });
        await tx.insert(operatorAudit).values({
          kind: "fleet_secret_changed",
          actor,
          ip,
          detail: { name, from: prev ? { version: prev.version, fingerprint: prev.fingerprint.slice(0, 12) } : null, to: { version, fingerprint: fingerprint.slice(0, 12) } },
        });
        return { version, changed: true };
      });
    },
  };
}

export type FleetSecretStore = ReturnType<typeof fleetSecretStore>;
