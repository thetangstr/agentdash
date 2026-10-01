// AgentDash: operator settings (spec §3.2, §5.1). A missing row means the
// launch default. Values are validated per key on write.
import { eq, sql } from "drizzle-orm";
import type { CloudDb } from "./db/client.js";
import { capabilities } from "./capabilities.js";
import { operatorAudit, settings } from "./db/schema.js";
import { isTimeZone, WINDOW_RE } from "./jobs/upgrade-window.js";
import { MIN_BOX_RELEASE, releaseMeetsBoxFloor } from "./jobs/claim.js";

export const SETTING_DEFAULTS = {
  // Kill switch. Off on a fresh deploy: nothing is provisioned until an
  // operator turns it on (signups still land on the waitlist).
  provisioning_enabled: false,
  waitlist_mode: true,
  daily_cap: 10,
  max_concurrent_jobs: 3,
  target_release: null as string | null,
  rollout_paused: false,
  // SC-2 (GH #763): when the target release has no GHCR image, build the
  // release tag's commit on Railway instead. Off by default: boxes are
  // image-only unless an operator allows the slower fallback.
  allow_source_fallback: false,
  // AgentDash (SC-10, GH #771): the Free idle policy (spec §5.2). Both OFF
  // until an operator turns them on: with suspend off no Free box is warned
  // or paused; with delete off no paused box is warned about deletion or
  // moved into the deletion flow. Each email is sent only when the step it
  // announces is enabled, so no customer is told about a step that will not happen.
  idle_suspend_enabled: false,
  idle_delete_enabled: false,
  // The spend alarm (spec §5.1): above this monthly figure (USD) the kill
  // switch is tripped and ops is paged. Null: no alarm.
  spend_alarm_usd: null as number | null,
  // The monthly cost of one running and one suspended box (USD), for the
  // spend estimate while no Railway usage reading is wired. Null: the spend
  // reading is "not available" (no number is invented).
  spend_estimate_box_usd: null as number | null,
  spend_estimate_suspended_box_usd: null as number | null,
  // AgentDash (SC-12, GH #773): the nightly window rollout waves start in
  // (spec §6.1). "HH:MM-HH:MM" in upgrade_window_tz, or null for always open.
  upgrade_window: "02:00-05:00" as string | null,
  upgrade_window_tz: "America/Los_Angeles",
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
    case "allow_source_fallback":
    case "idle_suspend_enabled":
    case "idle_delete_enabled":
      return asBool(raw);
    case "spend_alarm_usd":
    case "spend_estimate_box_usd":
    case "spend_estimate_suspended_box_usd": {
      if (raw === null || raw === "" || raw === "null") return null;
      const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new SettingValidationError(`${key} must be a dollar amount from 0 to 1000000, or null`);
      return n;
    }
    case "daily_cap":
      return asInt(raw, 0, 1000);
    case "max_concurrent_jobs":
      return asInt(raw, 1, 20);
    case "target_release": {
      if (raw === null || raw === "" || raw === "null") return null;
      if (typeof raw !== "string" || !RELEASE_TAG_RE.test(raw)) {
        throw new SettingValidationError("target_release must be a stable tag like v2026.925.0, or null");
      }
      // AgentDash (PR #941 review): never point new boxes at a release that cannot report its claim.
      if (!releaseMeetsBoxFloor(raw)) {
        throw new SettingValidationError(`target_release must be ${MIN_BOX_RELEASE} or later (older releases do not report their claim state)`);
      }
      return raw;
    }
    // AgentDash (SC-12, GH #773).
    case "upgrade_window": {
      if (raw === null || raw === "" || raw === "null" || raw === "always") return null;
      if (typeof raw !== "string" || !WINDOW_RE.test(raw) || raw.slice(0, 5) === raw.slice(6)) {
        throw new SettingValidationError("upgrade_window must look like 02:00-05:00 (24-hour, may wrap midnight), or null for always open");
      }
      return raw;
    }
    case "upgrade_window_tz": {
      if (typeof raw !== "string" || !raw.includes("/") || !isTimeZone(raw)) {
        throw new SettingValidationError("upgrade_window_tz must be an IANA time zone like America/Los_Angeles");
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
      if (key === "provisioning_enabled" && value === true && !capabilities.claimTrackingReady) {
        throw new SettingValidationError(
          "provisioning cannot be turned on yet: boxes do not report their claim state (claimTrackingReady is false until SC-5 #766 and SC-6 #767 land), so unclaimed-box cleanup could not tell a box in use from an abandoned one",
        );
      }
      await db.transaction(async (tx) => {
        const [prev] = await tx.select().from(settings).where(eq(settings.key, key)).for("update");
        const oldValue = prev ? prev.value : SETTING_DEFAULTS[key];
        // JSON null is stored as a jsonb null (no DELETE: the runtime role has none, GH #799).
        const stored = value === null ? sql`'null'::jsonb` : value;
        await tx
          .insert(settings)
          .values({ key, value: stored, updatedBy: actor })
          .onConflictDoUpdate({ target: settings.key, set: { value: stored, updatedBy: actor, updatedAt: new Date() } });
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
