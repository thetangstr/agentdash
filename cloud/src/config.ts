// AgentDash: control-plane configuration, from the environment only.
// Every credential is wrapped in a Secret at load time, so logging the config
// object (or any error that captured it) cannot print a credential.
import { BlockList, isIP } from "node:net";
import { parseDataKey } from "./crypto.js";
import { Secret } from "./secret.js";

export type ClientIpSource = "socket" | "x-real-ip";

export interface CloudConfig {
  port: number;
  databaseUrl: Secret;
  dataKey: Secret;
  adminToken: Secret;
  adminAllowList: BlockList;
  adminAllowListSize: number;
  clientIpSource: ClientIpSource;
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
export function parseAllowList(raw: string | undefined): { list: BlockList; size: number } {
  const list = new BlockList();
  let size = 0;
  for (const entry of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [addr, prefix] = entry.split("/") as [string, string | undefined];
    const family = isIP(addr);
    if (!family) throw new ConfigError(`CLOUD_ADMIN_ALLOWED_IPS: not an IP or CIDR: ${entry}`);
    const type = family === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) list.addAddress(addr, type);
    else {
      const bits = Number(prefix);
      const max = family === 6 ? 128 : 32;
      if (!Number.isInteger(bits) || bits < 0 || bits > max) {
        throw new ConfigError(`CLOUD_ADMIN_ALLOWED_IPS: bad prefix in ${entry}`);
      }
      list.addSubnet(addr, bits, type);
    }
    size += 1;
  }
  return { list, size };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const adminToken = required(env, "CLOUD_ADMIN_TOKEN");
  if (adminToken.length < 32) throw new ConfigError("CLOUD_ADMIN_TOKEN must be at least 32 characters");
  const { list, size } = parseAllowList(env.CLOUD_ADMIN_ALLOWED_IPS);
  const source = (env.CLOUD_CLIENT_IP_SOURCE ?? "socket").trim() as ClientIpSource;
  if (source !== "socket" && source !== "x-real-ip") {
    throw new ConfigError("CLOUD_CLIENT_IP_SOURCE must be 'socket' or 'x-real-ip'");
  }
  const port = Number(env.PORT ?? "3200");
  if (!Number.isInteger(port) || port <= 0) throw new ConfigError("PORT must be a positive integer");
  const railway = env.RAILWAY_API_TOKEN?.trim();
  return {
    port,
    databaseUrl: new Secret(required(env, "DATABASE_URL")),
    dataKey: parseDataKey(required(env, "CLOUD_DATA_KEY")),
    adminToken: new Secret(adminToken),
    adminAllowList: list,
    adminAllowListSize: size,
    clientIpSource: source,
    railwayToken: railway ? new Secret(railway) : null,
    release: env.CLOUD_CONTROL_RELEASE?.trim() || env.RAILWAY_GIT_COMMIT_SHA?.trim() || null,
  };
}
