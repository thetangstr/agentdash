// AgentDash: control-plane configuration, from the environment only.
// Every credential is wrapped in a Secret at load time, so logging the config
// object (or any error that captured it) cannot print a credential.
import { BlockList, isIP } from "node:net";
import { type DataKeyring, parseKeyring } from "./crypto.js";
import { Secret } from "./secret.js";

export type ClientIpSource = "socket" | "x-real-ip";

export interface CloudConfig {
  port: number;
  databaseUrl: Secret;
  /** The current data key (encrypts) plus previous keys (decrypt only). */
  dataKeys: DataKeyring;
  adminToken: Secret;
  adminAllowList: BlockList;
  adminAllowListSize: number;
  clientIpSource: ClientIpSource;
  /**
   * Socket addresses that must never be trusted to carry X-Real-IP: the
   * project's private network (GH #778). Only consulted when
   * clientIpSource is "x-real-ip". Null means the check is off ("none").
   */
  privateNetwork: BlockList | null;
  /** Failed /internal attempts per client IP before a lockout. */
  adminMaxFailures: number;
  /** Failure window and lockout length, in milliseconds. */
  adminLockoutMs: number;
  /** Workspace token for the dedicated boxes workspace. Unused until SC-2; optional here. */
  railwayToken: Secret | null;
  release: string | null;
}

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v || !v.trim()) throw new ConfigError(`${name} is required`);
  return v.trim();
}

/**
 * Parse a comma-separated list of IPs and CIDRs (IPv4 or IPv6) into a
 * BlockList used as an allow-list. An empty list allows nobody.
 */
export function parseAllowList(
  raw: string | undefined,
  name = "CLOUD_ADMIN_ALLOWED_IPS",
): { list: BlockList; size: number } {
  const list = new BlockList();
  let size = 0;
  for (const entry of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [addr, prefix] = entry.split("/") as [string, string | undefined];
    const family = isIP(addr);
    if (!family) throw new ConfigError(`${name}: not an IP or CIDR: ${entry}`);
    const type = family === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) list.addAddress(addr, type);
    else {
      const bits = Number(prefix);
      const max = family === 6 ? 128 : 32;
      if (!Number.isInteger(bits) || bits < 0 || bits > max) {
        throw new ConfigError(`${name}: bad prefix in ${entry}`);
      }
      list.addSubnet(addr, bits, type);
    }
    size += 1;
  }
  return { list, size };
}

/**
 * Railway's private network and the other non-public ranges a sibling service
 * could connect from. Railway does not publish its private ranges; legacy
 * environments are IPv6 ULA (fd00::/8) and new ones add an internal IPv4
 * address. A request whose SOCKET address is in this list did not come
 * through Railway's public edge, so its X-Real-IP is whatever the sender
 * wrote. Loopback is not listed: it is the local host, not the network.
 */
export const DEFAULT_PRIVATE_NETWORK_CIDRS = "fc00::/7,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16,fe80::/10";

/** Characters a CSPRNG-generated token is written in (hex, base64, base64url). */
const TOKEN_ALPHABET_RE = /^[A-Za-z0-9+/=_\-.~]+$/;

/**
 * Refuse an admin token that was not plausibly produced by a CSPRNG
 * (GH #778): at least 32 characters, only token characters, at least 128
 * bits by alphabet size, at least 10 distinct characters, and no run of more
 * than 5 identical characters. `openssl rand -hex 32` and
 * `openssl rand -base64 32` both pass; a password or a padded phrase does not.
 */
export function checkAdminTokenStrength(token: string): string | null {
  if (token.length < 32) return "must be at least 32 characters";
  if (!TOKEN_ALPHABET_RE.test(token)) return "must use only hex, base64 or base64url characters";
  const alphabet = /^[0-9a-fA-F]+$/.test(token) ? 16 : /^[A-Za-z0-9]+$/.test(token) ? 62 : 64;
  if (token.length * Math.log2(alphabet) < 128) return "must carry at least 128 bits (e.g. 32 hex or 22 base64 characters of CSPRNG output)";
  if (new Set(token).size < 10) return "has too few distinct characters to be random";
  if (/(.)\1{5,}/.test(token)) return "repeats one character too many times to be random";
  return null;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const adminToken = required(env, "CLOUD_ADMIN_TOKEN");
  const weak = checkAdminTokenStrength(adminToken);
  if (weak) throw new ConfigError(`CLOUD_ADMIN_TOKEN ${weak}; generate one with \`openssl rand -hex 32\``);
  const { list, size } = parseAllowList(env.CLOUD_ADMIN_ALLOWED_IPS);
  const source = (env.CLOUD_CLIENT_IP_SOURCE ?? "socket").trim() as ClientIpSource;
  if (source !== "socket" && source !== "x-real-ip") {
    throw new ConfigError("CLOUD_CLIENT_IP_SOURCE must be 'socket' or 'x-real-ip'");
  }
  const port = Number(env.PORT ?? "3200");
  if (!Number.isInteger(port) || port <= 0) throw new ConfigError("PORT must be a positive integer");
  const railway = env.RAILWAY_API_TOKEN?.trim();
  const privateRaw = (env.CLOUD_PRIVATE_NETWORK_CIDRS ?? DEFAULT_PRIVATE_NETWORK_CIDRS).trim();
  let privateNetwork: BlockList | null = null;
  if (privateRaw.toLowerCase() !== "none") {
    if (!privateRaw) throw new ConfigError("CLOUD_PRIVATE_NETWORK_CIDRS must list CIDRs, or be 'none'");
    privateNetwork = parseAllowList(privateRaw, "CLOUD_PRIVATE_NETWORK_CIDRS").list;
  }
  let dataKeys: DataKeyring;
  try {
    dataKeys = parseKeyring(required(env, "CLOUD_DATA_KEY"), env.CLOUD_DATA_KEYS_PREVIOUS);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  return {
    port,
    databaseUrl: new Secret(required(env, "DATABASE_URL")),
    dataKeys,
    adminToken: new Secret(adminToken),
    adminAllowList: list,
    adminAllowListSize: size,
    clientIpSource: source,
    privateNetwork,
    adminMaxFailures: positiveInt(env, "CLOUD_ADMIN_MAX_FAILURES", 5),
    adminLockoutMs: positiveInt(env, "CLOUD_ADMIN_LOCKOUT_SECONDS", 900) * 1000,
    railwayToken: railway ? new Secret(railway) : null,
    release: env.CLOUD_CONTROL_RELEASE?.trim() || env.RAILWAY_GIT_COMMIT_SHA?.trim() || null,
  };
}
