// AgentDash: cloud-control entry point. Loads config from env, checks the
// database (split role mode, GH #763), serves, and runs the job runner and
// the cleanup sweep when a Railway token is configured (GH #764).
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createCloudDb, migrateCloudDb, verifyRuntimeDb } from "./db/client.js";
import { type Alerter, combineAlerters, logAlerter, resendEmailAlerter, webhookAlerter } from "./jobs/alerts.js";
import { deleteHandler, sweepCleanup } from "./jobs/cleanup.js";
import { JobRunner } from "./jobs/runner.js";
import { createLogger } from "./logger.js";
import { RailwayClient } from "./railway/client.js";
import { provisionHandler } from "./railway/provisioner.js";

const log = createLogger({ base: { service: "cloud-control" } });
const SWEEP_MS = 10 * 60_000;

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

  const alerters: Alerter[] = [logAlerter(log)];
  if (config.alertWebhookUrl) alerters.push(webhookAlerter(config.alertWebhookUrl, { log }));
  if (config.resendApiKey && config.alertEmailFrom && config.alertEmailTo.length) {
    alerters.push(resendEmailAlerter({ apiKey: config.resendApiKey, from: config.alertEmailFrom, to: config.alertEmailTo }));
  }
  const alerter = combineAlerters(log, alerters);

  let runner: JobRunner | null = null;
  let sweep: NodeJS.Timeout | null = null;
  if (config.railwayToken && config.railwayWorkspaceId) {
    const client = new RailwayClient({ token: config.railwayToken, log });
    const provision = provisionHandler({
      client,
      workspaceId: config.railwayWorkspaceId,
      dataKeys: config.dataKeys,
      escrowPublicKey: config.escrowPublicKey,
      edgeDomain: config.edgeDomain,
      imageRepo: config.boxImageRepo,
      sourceRepo: config.boxSourceRepo,
      edgeLive: config.edgeLive,
    });
    if (!config.escrowPublicKey) log.warn("CLOUD_ESCROW_PUBLIC_KEY is not set: every provision job will refuse to start");
    runner = new JobRunner({ db, log, alerter, handlers: [provision, deleteHandler({ client, workspaceId: config.railwayWorkspaceId })] });
    runner.start();
    const runSweep = () => void sweepCleanup(db, log).catch((err: unknown) => log.error("cleanup sweep failed", { err }));
    sweep = setInterval(runSweep, SWEEP_MS);
    sweep.unref();
    runSweep();
  } else {
    log.info("RAILWAY_API_TOKEN not set: the job runner and cleanup sweep are idle");
  }

  const server = createApp({ db, config, log }).listen(config.port, () => {
    log.info("listening", { port: config.port, release: config.release, railwayApi: config.railwayToken ? "configured" : "not configured" });
  });
  const shutdown = () => {
    if (sweep) clearInterval(sweep);
    void (runner?.stop() ?? Promise.resolve()).finally(() => {
      server.close(() => void close().finally(() => process.exit(0)));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.error(err instanceof ConfigError ? "configuration error" : "startup failed", { err });
  process.exit(1);
});
