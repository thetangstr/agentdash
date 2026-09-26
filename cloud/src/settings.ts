// AgentDash: operator settings (spec §3.2, §5.1). A missing row means the
// launch default. Values are validated per key on write.
import { eq } from "drizzle-orm";
import type { CloudDb } from "./db/client.js";
import { operatorAudit, settings } from "./db/schema.js";

export const SETTING_DEFAULTS = {
  // Kill switch. Off on a fresh deploy: nothing is provisioned until an
  // operator turns it on (signups still land on the waitlist).
  provisioning_enabled: false,
  waitlist_mode: true,
  daily_cap: 10,
  max_concurrent_jobs: 3,
  target_release: null as string | null,
  rollout_paused: false,
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings = { [K in SettingKey]: (typeof SETTING_DEFAULTS)[K] };
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

export class SettingValidationError extends Error {}

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as string[]).includes(key);
}

const RELEASE_TAG_RE = /^v\d{4}\.\d{3,4}\.\d+$/;

/** Parse and validate a value for a key. Accepts JSON values or CLI strings. */
export function parseSettingValue(key: SettingKey, raw: unknown): Settings[SettingKey] {
  const asBool = (v: unknown) => {
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
    throw new SettingValidationError(`${key} must be true or false`);
  };
  const asInt = (v: unknown, min: number, max: number) => {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new SettingValidationError(`${key} must be an integer from ${min} to ${max}`);
    }
    return n;
  };
  switch (key) {
    case "provisioning_enabled":
    case "waitlist_mode":
    case "rollout_paused":
      return asBool(raw);
    case "daily_cap":
      return asInt(raw, 0, 1000);
    case "max_concurrent_jobs":
      return asInt(raw, 1, 20);
    case "target_release": {
      if (raw === null || raw === "" || raw === "null") return null;
      if (typeof raw !== "string" || !RELEASE_TAG_RE.test(raw)) {
        throw new SettingValidationError("target_release must be a stable tag like v2026.925.0, or null");
      }
      return raw;
    }
  }
}

export function settingsService(db: CloudDb) {
  return {
    async getAll(): Promise<Settings> {
      const rows = await db.select().from(settings);
      const out: Settings = { ...SETTING_DEFAULTS };
      for (const row of rows) {
        if (isSettingKey(row.key)) (out as Record<string, unknown>)[row.key] = row.value;
      }
      return out;
    },
    async get<K extends SettingKey>(key: K): Promise<Settings[K]> {
      const [row] = await db.select().from(settings).where(eq(settings.key, key));
      return (row ? row.value : SETTING_DEFAULTS[key]) as Settings[K];
    },
    /**
     * Validate and store a setting. The change and its audit row (old and new
     * value, actor, caller IP) commit together or not at all (GH #778).
     */
    async set(
      key: SettingKey,
      raw: unknown,
      actor: string,
      opts: { ip?: string | null } = {},
    ): Promise<Settings[SettingKey]> {
      const value = parseSettingValue(key, raw);
      await db.transaction(async (tx) => {
        const [prev] = await tx.select().from(settings).where(eq(settings.key, key)).for("update");
        const oldValue = prev ? prev.value : SETTING_DEFAULTS[key];
        if (value === null) {
          // JSON null is stored as "no row": the default for nullable keys is null.
          await tx.delete(settings).where(eq(settings.key, key));
        } else {
          await tx
            .insert(settings)
            .values({ key, value, updatedBy: actor })
            .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: actor, updatedAt: new Date() } });
        }
        await tx.insert(operatorAudit).values({
          kind: "setting_changed",
          actor,
          ip: opts.ip ?? null,
          detail: { setting: key, from: oldValue, to: value },
        });
      });
      return value;
    },
  };
}
