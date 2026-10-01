// AgentDash (GH #733): the off-box backup settings, read from the
// control plane's environment. All of the object-store settings together, or
// none (backups off); a partial set refuses to start, so a typo cannot quietly
// leave the fleet without backups.
import { ConfigError } from "../config.js";
import { escrowKeyId, parseEscrowPublicKey } from "../railway/secrets.js";
import { Secret } from "../secret.js";

export interface BackupConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: Secret;
  prefix: string;
  virtualHosted: boolean;
  /** The OFFLINE backup public key every backup is sealed to. */
  publicKey: Uint8Array;
  publicKeyId: string;
  /** True when no CLOUD_BACKUP_PUBLIC_KEY was set and the escrow key is used. */
  usingEscrowKey: boolean;
  /** UTC hour from which the day's scheduled backups start. */
  hourUtc: number;
  retainDaily: number;
  retainWeekly: number;
  concurrency: number;
  /** Attempts per box per day for the scheduled backup. */
  maxAttempts: number;
  /** A box whose newest good backup is older than this is "stale" (status and the alert hook). */
  staleHours: number;
}

const STORE_VARS = [
  "CLOUD_BACKUP_S3_ENDPOINT",
  "CLOUD_BACKUP_S3_BUCKET",
  "CLOUD_BACKUP_S3_ACCESS_KEY_ID",
  "CLOUD_BACKUP_S3_SECRET_ACCESS_KEY",
] as const;

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

/** Null when backups are not configured at all. Throws ConfigError on a partial or invalid set. */
export function loadBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig | null {
  const present = STORE_VARS.filter((n) => env[n]?.trim());
  if (present.length === 0) return null;
  if (present.length !== STORE_VARS.length) {
    const missing = STORE_VARS.filter((n) => !env[n]?.trim());
    throw new ConfigError(`off-box backups are partly configured: set ${missing.join(", ")} too, or none of the CLOUD_BACKUP_S3_* variables`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(env.CLOUD_BACKUP_S3_ENDPOINT!.trim());
  } catch {
    throw new ConfigError("CLOUD_BACKUP_S3_ENDPOINT is not a valid URL");
  }
  if (endpoint.username || endpoint.password) throw new ConfigError("CLOUD_BACKUP_S3_ENDPOINT must not carry credentials");
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:")) {
    throw new ConfigError("CLOUD_BACKUP_S3_ENDPOINT must be https");
  }
  const bucket = env.CLOUD_BACKUP_S3_BUCKET!.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new ConfigError("CLOUD_BACKUP_S3_BUCKET is not a valid bucket name");
  const prefix = (env.CLOUD_BACKUP_S3_PREFIX ?? "boxes").trim().replace(/^\/+|\/+$/g, "");
  if (prefix && !/^[A-Za-z0-9._\-/]+$/.test(prefix)) throw new ConfigError("CLOUD_BACKUP_S3_PREFIX may hold only letters, digits, '.', '_', '-' and '/'");
  const region = (env.CLOUD_BACKUP_S3_REGION ?? "auto").trim();
  if (!/^[a-z0-9-]+$/.test(region)) throw new ConfigError("CLOUD_BACKUP_S3_REGION is not a region name");

  const rawKey = env.CLOUD_BACKUP_PUBLIC_KEY?.trim() || env.CLOUD_ESCROW_PUBLIC_KEY?.trim();
  if (!rawKey) {
    throw new ConfigError("off-box backups need CLOUD_BACKUP_PUBLIC_KEY (or CLOUD_ESCROW_PUBLIC_KEY): backups are encrypted to an offline key");
  }
  let publicKey: Uint8Array;
  try {
    publicKey = parseEscrowPublicKey(rawKey);
  } catch {
    throw new ConfigError("CLOUD_BACKUP_PUBLIC_KEY must be a 32-byte X25519 public key (base64 or hex), e.g. from `escrow keygen`");
  }
  return {
    endpoint: endpoint.toString().replace(/\/+$/, ""),
    bucket,
    region,
    accessKeyId: env.CLOUD_BACKUP_S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: new Secret(env.CLOUD_BACKUP_S3_SECRET_ACCESS_KEY!.trim()),
    prefix,
    virtualHosted: (env.CLOUD_BACKUP_S3_VIRTUAL_HOSTED ?? "").trim().toLowerCase() === "true",
    publicKey,
    publicKeyId: escrowKeyId(publicKey),
    usingEscrowKey: !env.CLOUD_BACKUP_PUBLIC_KEY?.trim(),
    hourUtc: int(env, "CLOUD_BACKUP_HOUR_UTC", 8, 0, 23),
    retainDaily: int(env, "CLOUD_BACKUP_RETAIN_DAILY", 7, 1, 90),
    retainWeekly: int(env, "CLOUD_BACKUP_RETAIN_WEEKLY", 4, 0, 52),
    concurrency: int(env, "CLOUD_BACKUP_CONCURRENCY", 2, 1, 10),
    maxAttempts: int(env, "CLOUD_BACKUP_MAX_ATTEMPTS", 3, 1, 10),
    staleHours: int(env, "CLOUD_BACKUP_STALE_HOURS", 36, 1, 24 * 14),
  };
}
