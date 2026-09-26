// AgentDash: cloud-control entry point. Loads config from env, applies the
// control plane's own migrations, and serves. No provisioning yet (SC-2, #763).
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createCloudDb, migrateCloudDb, verifyRuntimeDb } from "./db/client.js";
import { createLogger } from "./logger.js";

const log = createLogger({ base: { service: "cloud-control" } });

async function main() {
  const config = loadConfig();
  if (config.adminAllowListSize === 0) {
    log.warn("CLOUD_ADMIN_ALLOWED_IPS is empty: the operator surface refuses every request");
  }
  if (config.clientIpSource === "x-real-ip" && !config.privateNetwork) {
    log.warn("CLOUD_PRIVATE_NETWORK_CIDRS=none: X-Real-IP is trusted from any socket, including the private network");
  }
  if (config.dbRoleMode === "single") {
    log.warn("CLOUD_DB_ROLE_MODE=single: migrating on boot as the service's own role (local development only)");
    await migrateCloudDb(config.databaseUrl.reveal());
  } else {
    // GH #763: migrations run in the separate cloud-migrate service as the
    // owner; this process must be the runtime role on a migrated schema.
    const problems = await verifyRuntimeDb(config.databaseUrl.reveal());
    if (problems.length) {
      throw new ConfigError(`refusing to start (CLOUD_DB_ROLE_MODE=split): ${problems.join("; ")}`);
    }
  }
  const { db, close } = createCloudDb(config.databaseUrl.reveal());
  const server = createApp({ db, config, log }).listen(config.port, () => {
    log.info("listening", { port: config.port, release: config.release, railwayApi: config.railwayToken ? "configured" : "not configured" });
  });
  const shutdown = () => {
    server.close(() => void close().finally(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.error(err instanceof ConfigError ? "configuration error" : "startup failed", { err });
  process.exit(1);
});
