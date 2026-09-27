// AgentDash (GH #765, SC-4): the edge router's entry point. Its own Railway
// service (`edge`, 2 replicas) in project agentdash-cloud, behind the
// *.agentdash.cloud wildcard. Service settings (through the API): Dockerfile
// cloud/Dockerfile, start command `node dist/edge/index.js`, health check
// /health, replicas 2.
//
//   DATABASE_URL              the cloud_edge role (SELECT on edge_routes only)
//   CLOUD_DATA_KEY            decrypts edge secrets (plus CLOUD_DATA_KEYS_PREVIOUS)
//   CLOUD_EDGE_DOMAIN         default agentdash.cloud
//   CLOUD_EDGE_CLIENT_IP_SOURCE  x-real-ip (default: Railway's edge sets it) or socket
//   CLOUD_FIND_URL            default https://www.agentdash.cloud/find
//   CLOUD_PRIVATE_NETWORK_CIDRS  sockets whose X-Real-IP is never believed (default 10.0.0.0/8,fc00::/7)
//   PORT                      default 8080
//
// Follow-up (GH #808 review, LOW): edge secrets are decrypted with the full
// CLOUD_DATA_KEY. A dedicated edge-secret key (the provisioner encrypting
// edge_secret_enc under it, existing rows re-encrypted) would keep the router
// from holding a key that also opens claim codes; tracked on #765.
import postgres from "postgres";
import { parseKeyring } from "../crypto.js";
import { edgeRoleProblems } from "../db/roles.js";
import { createLogger } from "../logger.js";
import { ActivityBuffer, type ClientIpSource, createEdgeServer } from "./proxy.js";
import { pgRouteSource, RouteTable } from "./routes.js";

const log = createLogger({ base: { service: "edge" } });
const REFRESH_MS = 5_000;
const ACTIVITY_FLUSH_MS = 30_000;

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  const dataKey = process.env.CLOUD_DATA_KEY?.trim();
  if (!url || !dataKey) throw new Error("DATABASE_URL and CLOUD_DATA_KEY are required");
  const edgeDomain = (process.env.CLOUD_EDGE_DOMAIN ?? "agentdash.cloud").trim().toLowerCase();
  const ipSource = (process.env.CLOUD_EDGE_CLIENT_IP_SOURCE ?? "x-real-ip").trim() as ClientIpSource;
  if (ipSource !== "x-real-ip" && ipSource !== "socket") throw new Error("CLOUD_EDGE_CLIENT_IP_SOURCE must be x-real-ip or socket");
  const dataKeys = parseKeyring(dataKey, process.env.CLOUD_DATA_KEYS_PREVIOUS);
  const sql = postgres(url, { max: 4, onnotice: () => {} });

  if ((process.env.CLOUD_DB_ROLE_MODE ?? "split").trim() !== "single") {
    const problems = await edgeRoleProblems(sql);
    if (problems.length) throw new Error(`refusing to start: ${problems.join("; ")}`);
  }

  const table = new RouteTable({ source: pgRouteSource(sql), dataKeys, log });
  await table.refresh();
  const refresh = setInterval(() => void table.refresh(), REFRESH_MS);
  refresh.unref();

  const activity = new ActivityBuffer(async (slugs) => {
    await sql`select edge_record_activity(${slugs}::text[])`;
  });
  const flush = setInterval(() => void activity.flush().catch((err: unknown) => log.warn("activity flush failed", { err })), ACTIVITY_FLUSH_MS);
  flush.unref();

  const server = createEdgeServer({
    routes: table,
    edgeDomain,
    log,
    clientIpSource: ipSource,
    findUrl: process.env.CLOUD_FIND_URL?.trim() || undefined,
    recordActivity: (slug) => activity.add(slug),
    requestResume: async (slug) => {
      await sql`select edge_request_resume(${slug})`;
    },
    routeAgeMs: () => table.ageMs,
    privateNetworkCidrs: (process.env.CLOUD_PRIVATE_NETWORK_CIDRS ?? "10.0.0.0/8,fc00::/7").split(",").map((c) => c.trim()).filter(Boolean),
    status: () => ({ routes: table.size, routeTableAgeMs: Number.isFinite(table.ageMs) ? table.ageMs : null }),
  });
  const port = Number(process.env.PORT ?? "8080");
  server.listen(port, "::", () => log.info("edge listening", { port, edgeDomain, routes: table.size }));

  const shutdown = () => {
    clearInterval(refresh);
    clearInterval(flush);
    server.close(() => void activity.flush().catch(() => {}).finally(() => void sql.end({ timeout: 5 }).finally(() => process.exit(0))));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  log.error("edge startup failed", { err });
  process.exit(1);
});
