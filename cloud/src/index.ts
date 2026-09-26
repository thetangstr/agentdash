// AgentDash: cloud-control entry point. Loads config from env, applies the
// control plane's own migrations, and serves. No provisioning yet (SC-2, #763).
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createCloudDb, migrateCloudDb } from "./db/client.js";
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
  await migrateCloudDb(config.databaseUrl.reveal());
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
