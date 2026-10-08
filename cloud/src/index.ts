// AgentDash: cloud-control entry point. Loads config from env, checks the
// database (split role mode, GH #763), serves, and runs the job runner and
// the cleanup sweep when a Railway token is configured (GH #764).
import { createApp, mailerFromConfig } from "./app.js";
import { frontDoor as makeFrontDoor } from "./front-door/service.js";
import { pruneRateEvents } from "./front-door/rate-limit.js";
import { ConfigError, loadConfig } from "./config.js";
import { createCloudDb, migrateCloudDb, verifyRuntimeDb } from "./db/client.js";
import { type Alerter, combineAlerters, logAlerter, resendEmailAlerter, webhookAlerter } from "./jobs/alerts.js";
import { deleteHandler, sweepCleanup } from "./jobs/cleanup.js";
import { closeSignupHandler } from "./jobs/close-signup.js";
import { JobRunner } from "./jobs/runner.js";
import { capabilities } from "./capabilities.js";
import { createLogger } from "./logger.js";
import { RailwayClient } from "./railway/client.js";
import { provisionHandler } from "./railway/provisioner.js";
import { loadMonitorConfig, startMonitor } from "./monitor/service.js";
import { resumeHandler, suspendHandler } from "./monitor/suspend.js";
import { tickRollout } from "./jobs/rollout.js";
import { upgradeHandler } from "./jobs/upgrade.js";
import { setupBackups, startBackupScheduler } from "./backups/setup.js";
import { billingAndMailExtras } from "./railway/box-extras.js";
import { resendKeysClient } from "./email/resend-keys.js";
import { loadBillingConfig } from "./stripe/config.js";
import { startBillingPromotionPass } from "./stripe/box-billing.js";
import { fleetSecretStore } from "./stripe/fleet-secrets.js";
import { stripeForwarder } from "./stripe/forwarder.js";

const log = createLogger({ base: { service: "cloud-control" } });
const SWEEP_MS = 10 * 60_000;
const READY_MAIL_MS = 20_000;
const RELEASE_MS = 60_000;
const PRUNE_MS = 60 * 60_000;
const ROLLOUT_TICK_MS = 60_000;
const STRIPE_DELIVERY_MS = 15_000;

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

  // AgentDash (SC-10, GH #771): named, so `admin alerts test` can report each transport.
  const transports: Array<{ name: string; alerter: Alerter }> = [{ name: "log", alerter: logAlerter(log) }];
  if (config.alertWebhookUrl) transports.push({ name: "webhook", alerter: webhookAlerter(config.alertWebhookUrl, { log }) });
  if (config.resendApiKey && config.alertEmailFrom && config.alertEmailTo.length) {
    transports.push({ name: "email", alerter: resendEmailAlerter({ apiKey: config.resendApiKey, from: config.alertEmailFrom, to: config.alertEmailTo }) });
  }
  const alerter = combineAlerters(log, transports.map((t) => t.alerter));

  // AgentDash (SC-8, GH #769): Stripe fan-out, the shared box key and per-box Resend keys.
  const billing = config.billing ?? loadBillingConfig({});
  const fleetStore = fleetSecretStore(db, config.dataKeys);
  const forwarder = stripeForwarder({ db, log, keys: config.dataKeys, billing, store: fleetStore, alerter });
  // The Stripe routes and the billing-rev promotion pass share one client.
  const stripeRailway = config.railwayToken ? new RailwayClient({ token: config.railwayToken, log }) : null;
  const resendKeys = billing.resendAdminKey ? resendKeysClient({ apiKey: billing.resendAdminKey }) : null;
  if (!billing.stripeWebhookSecrets.length) log.warn("CLOUD_STRIPE_WEBHOOK_SECRET is not set: the Stripe webhook answers 503 unless the endpoint secret is stored (admin stripe endpoint ensure)");
  if (!billing.stripeProPriceId) log.warn("CLOUD_STRIPE_PRO_PRICE_ID is not set: new boxes get no Stripe variables");
  if (!resendKeys) log.warn("CLOUD_RESEND_ADMIN_API_KEY is not set: new boxes get no Resend key, and box keys cannot be revoked");

  let runner: JobRunner | null = null;
  let sweep: NodeJS.Timeout | null = null;
  let rolloutTimer: NodeJS.Timeout | null = null;
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
      boxExtras: billingAndMailExtras({ keys: config.dataKeys, billing, store: fleetStore, resend: resendKeys }),
    });
    if (!config.escrowPublicKey) log.warn("CLOUD_ESCROW_PUBLIC_KEY is not set: every provision job will refuse to start");
    if (!capabilities.claimTrackingReady) log.warn("claim tracking is not ready (SC-5, SC-6): provisioning stays off whatever the setting says");
    runner = new JobRunner({ db, log, alerter, handlers: [
        provision,
        deleteHandler({ client, workspaceId: config.railwayWorkspaceId, resend: resendKeys }),
        closeSignupHandler({ client, workspaceId: config.railwayWorkspaceId }),
        // AgentDash (SC-10, GH #771): suspend (web deployment removed) and wake.
        suspendHandler({ client, workspaceId: config.railwayWorkspaceId }),
        resumeHandler({ client, workspaceId: config.railwayWorkspaceId }),
        // AgentDash (SC-12, GH #773): fleet upgrades.
        upgradeHandler({
          client,
          workspaceId: config.railwayWorkspaceId,
          edgeDomain: config.edgeDomain,
          imageRepo: config.boxImageRepo,
          sourceRepo: config.boxSourceRepo,
          edgeLive: config.edgeLive,
          alerter,
          backupLimit: config.volumeBackupLimit,
        }),
      ] });
    runner.start();
    // AgentDash (SC-12, GH #773): the rollout orchestrator, once a minute; all its state is in the database.
    rolloutTimer = setInterval(() => void tickRollout(db, { log }).catch((err: unknown) => log.error("rollout tick failed", { err })), ROLLOUT_TICK_MS);
    rolloutTimer.unref();
    const runSweep = () => void sweepCleanup(db, log, { alerter }).catch((err: unknown) => log.error("cleanup sweep failed", { err }));
    sweep = setInterval(runSweep, SWEEP_MS);
    sweep.unref();
    runSweep();
  } else {
    log.info("RAILWAY_API_TOKEN not set: the job runner and cleanup sweep are idle");
  }

  // AgentDash (SC-7, GH #768): the front door, plus its two background passes:
  // the ready email (claim link) for boxes that reached awaiting_claim, and
  // the release of approved waitlist entries once provisioning is open.
  if (config.frontDoor.mailTransport === "log") log.warn("CLOUD_MAIL_TRANSPORT=log: front-door emails (with their links) go to the log; local development only");
  else if (!config.resendApiKey) log.warn("CLOUD_RESEND_API_KEY is not set: /start and /find answer 503 until it is");
  if (!config.frontDoor.turnstileSecret) log.warn("Turnstile is not configured: signups need operator or verified hosted invitation approval");
  const frontDoor = makeFrontDoor({ db, log, config, mailer: mailerFromConfig(config, log) });

  // AgentDash (GH #733): nightly encrypted off-box database backups. The
  // events are logged here; SC-10's alerting subscribes through onEvent.
  const backups = setupBackups({
    db,
    log,
    dataKeys: config.dataKeys,
    railway:
      config.railwayToken && config.railwayWorkspaceId
        ? { client: new RailwayClient({ token: config.railwayToken, log }), workspaceId: config.railwayWorkspaceId }
        : null,
    onEvent: (e) => {
      if (e.kind === "backup_gave_up") log.error("backup event", { event: e });
      else log.info("backup event", { event: e });
    },
  });
  let stopBackups: (() => void) | null = null;
  if (!backups) log.warn("off-box backups are not configured (CLOUD_BACKUP_S3_*): hosted boxes have only Railway snapshots");
  else {
    if (backups.config.usingEscrowKey) log.warn("CLOUD_BACKUP_PUBLIC_KEY is not set: backups are sealed to the escrow key");
    if (backups.service) stopBackups = startBackupScheduler(backups.service, log);
    else log.warn("off-box backups are configured but RAILWAY_API_TOKEN is not: the scheduler is idle");
  }
  const passes = [
    setInterval(() => void frontDoor.sendReadyEmails().catch((err: unknown) => log.error("ready email pass failed", { err })), READY_MAIL_MS),
    setInterval(() => void frontDoor.releaseApproved().catch((err: unknown) => log.error("waitlist release pass failed", { err })), RELEASE_MS),
    // GH #836 review: rate_events is pruned hourly.
    setInterval(() => void pruneRateEvents(db).catch((err: unknown) => log.error("rate_events prune failed", { err })), PRUNE_MS),
    // AgentDash (SC-8, GH #769): retries and parked Stripe events.
    setInterval(() => void forwarder.deliverDue().catch((err: unknown) => log.error("Stripe delivery pass failed", { err })), STRIPE_DELIVERY_MS),
  ];
  // AgentDash (GH #923): a box adopts the billing config it was sent once a
  // deploy after the send succeeds. This used to run inside GET
  // /internal/stripe/status — a read that wrote — so it is a background pass
  // now (once a minute, never overlapping; see BILLING_PROMOTION_MS); the
  // status endpoint stays read-only and reports the count.
  const billingPromotion = startBillingPromotionPass({ db, client: stripeRailway, log });
  for (const t of passes) t.unref();

  // AgentDash (SC-10, GH #771): fleet health, alerts, the Free idle policy and the spend alarm.
  const monitor = startMonitor({
    db,
    log,
    alerter,
    mailer: mailerFromConfig(config, log),
    edgeDomain: config.edgeDomain,
    edgeLive: config.edgeLive,
    config: loadMonitorConfig(process.env, config),
  });

  const server = createApp({ db, config, log, frontDoor, alertTransports: transports, alerter, stripe: { forwarder, railway: stripeRailway }, ...(backups ? { backups: backups.routeDeps } : {}) }).listen(config.port, () => {
    log.info("listening", { port: config.port, release: config.release, railwayApi: config.railwayToken ? "configured" : "not configured" });
  });
  const shutdown = () => {
    if (sweep) clearInterval(sweep);
    if (rolloutTimer) clearInterval(rolloutTimer);
    stopBackups?.();
    for (const t of passes) clearInterval(t);
    billingPromotion.stop();
    monitor.stop();
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
