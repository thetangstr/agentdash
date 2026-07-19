import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { corpEmailSignupGuard } from "./middleware/corp-email-signup-guard.js";
// AgentDash (#160): tiered API rate limiting — auth/billing tighter than default.
import {
  createAuthRateLimiter,
  createBillingRateLimiter,
  createDefaultApiRateLimiter,
  createInviteRateLimiter,
  createTrialRateLimiter,
} from "./middleware/rate-limit.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { issueTreeControlRoutes } from "./routes/issue-tree-control.js";
import { routineRoutes } from "./routes/routines.js";
import { environmentRoutes } from "./routes/environments.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { mandatedActionRoutes } from "./routes/mandated-actions.js";
import { mandateRoutes } from "./routes/mandates.js";
import { mandateAttestationRoutes } from "./routes/mandate-attestations.js";
import { zkPermissionProofRoutes } from "./routes/zk-permission-proofs.js";
import { handshakeDemoRoutes } from "./routes/handshake-demo.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { mspRoutes } from "./routes/msp.js";
import { userProfileRoutes } from "./routes/user-profiles.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "./routes/sidebar-preferences.js";
import { inboxDismissalRoutes } from "./routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import {
  instanceDatabaseBackupRoutes,
  type InstanceDatabaseBackupService,
} from "./routes/instance-database-backups.js";
import { llmRoutes } from "./routes/llms.js";
import { authRoutes } from "./routes/auth.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { pluginRoutes } from "./routes/plugins.js";
import { adapterRoutes } from "./routes/adapters.js";
import { pluginUiStaticRoutes, parsePluginUiAllowedOrigins } from "./routes/plugin-ui-static.js";
import { conversationRoutes } from "./routes/conversations.js";
import { onboardingV2Routes } from "./routes/onboarding-v2.js";
import { billingRoutes } from "./routes/billing.js";
import { assessRoutes } from "./routes/assess.js";
import { agentResearchRoutes } from "./routes/agent-research.js";
// AgentDash: Agent-run quota (AGE-120)
import { quotaRoutes } from "./routes/quota.js";
// AgentDash: Test Drive — no-signup anonymous trial (public, token-based)
import { trialRoutes } from "./routes/trial.js";
// AgentDash: Connectors (AGE-106)
import { connectorRoutes } from "./routes/connectors.js";
// AgentDash: Slack Connector (AGE-108)
import { slackConnectorRoutes } from "./routes/slack-connector.js";
// AgentDash: Gmail Connector (AGE-109)
import { gmailRoutes } from "./routes/gmail.js";
// AgentDash: goals-eval-hitl
import { verdictRoutes } from "./routes/verdicts.js";
import { featureFlagRoutes } from "./routes/feature-flags.js";
import { HttpError } from "./errors.js";
import { applyUiBranding } from "./ui-branding.js";
import { logger } from "./middleware/logger.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { createPluginWorkerManager, type PluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { buildHostServices, flushPluginLogBuffer } from "./services/plugin-host-services.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { setPluginEventBus } from "./services/activity-log.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { createPluginHostServiceCleanup } from "./services/plugin-host-service-cleanup.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
import { createCachedViteHtmlRenderer } from "./vite-html-renderer.js";

type UiMode = "none" | "static" | "vite-dev";
const FEEDBACK_EXPORT_FLUSH_INTERVAL_MS = 5_000;
const VITE_DEV_ASSET_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/assets/",
  "/node_modules/",
  "/src/",
];
const VITE_DEV_STATIC_PATHS = new Set([
  "/apple-touch-icon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon.ico",
  "/favicon.svg",
  "/site.webmanifest",
  "/sw.js",
]);

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export function shouldServeViteDevHtml(req: ExpressRequest): boolean {
  const pathname = req.path;
  if (VITE_DEV_STATIC_PATHS.has(pathname)) return false;
  if (VITE_DEV_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  return req.accepts(["html"]) === "html";
}

export function shouldEnablePrivateHostnameGuard(opts: {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
}): boolean {
  return (
    opts.deploymentExposure === "private" &&
    (opts.deploymentMode === "local_trusted" || opts.deploymentMode === "authenticated")
  );
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    serverPort: number;
    storageService: StorageService;
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    databaseBackupService?: InstanceDatabaseBackupService;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    instanceId?: string;
    hostVersion?: string;
    localPluginDir?: string;
    // AgentDash: instance public base URL used to derive the same-origin
    // default for plugin-UI CORS in authenticated mode.
    pluginUiPublicBaseUrl?: string;
    pluginMigrationDb?: Db;
    pluginWorkerManager?: PluginWorkerManager;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
    // AgentDash (AGE-60): when true, reject free-mail signups at the auth endpoint.
    requireCorpEmail?: boolean;
  },
) {
  const app = express();

  // AgentDash (trial-abuse-hardening): trust the single upstream proxy when the
  // deployment is internet-facing (Railway/Fly/etc. terminate TLS and forward
  // X-Forwarded-For). Without this, req.ip is the proxy's address for everyone,
  // collapsing the per-IP API rate limiter into one bucket and making the trial's
  // ipHash identical for all visitors. We set the hop count to 1 (the single
  // known proxy) rather than `true` — `true` trusts the whole XFF chain, lets
  // clients spoof their IP, AND trips express-rate-limit's permissive-trust-proxy
  // validation (ERR_ERL_PERMISSIVE_TRUST_PROXY). local_trusted (private dev /
  // loopback) keeps Express's default (off) so local tests are unaffected.
  const internetFacing =
    opts.deploymentMode === "authenticated" || opts.deploymentExposure === "public";
  if (internetFacing) {
    app.set("trust proxy", 1);
  }

  // AgentDash: capture the raw request body so downstream webhook/connector
  // routes (Stripe, Slack) can verify HMAC signatures. Shared by both the JSON
  // and urlencoded parsers so the captured bytes are identical regardless of
  // content-type. Each parser only handles its own content-type, so registering
  // both is safe and non-overlapping.
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };
  app.use(express.json({
    // Company import/export payloads can inline full portable packages.
    limit: "10mb",
    verify: captureRawBody,
  }));
  // AgentDash: Slack sends interactive-component callbacks as
  // application/x-www-form-urlencoded with a `payload` JSON field. Without this
  // parser req.body.payload and rawBody are undefined and every interaction 401s.
  app.use(express.urlencoded({
    extended: true,
    limit: "10mb",
    verify: captureRawBody,
  }));
  app.use(httpLogger);
  const privateHostnameGateEnabled = shouldEnablePrivateHostnameGuard({
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
  });
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  // AgentDash (#160): tighter rate limit on /api/auth/* (brute-force vector).
  app.use("/api/auth", createAuthRateLimiter({ deploymentMode: opts.deploymentMode }), authRoutes(db));
  if (opts.betterAuthHandler) {
    // AgentDash (AGE-104 follow-up): block free-mail signups on Pro at the
    // signup endpoint itself, not at company-creation time.
    app.use(
      corpEmailSignupGuard({ enabled: opts.requireCorpEmail ?? false }),
    );
    // AgentDash (#160): rate-limit better-auth handler too (same /api/auth path).
    app.use("/api/auth", createAuthRateLimiter({ deploymentMode: opts.deploymentMode }));
    app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  const hostServicesDisposers = new Map<string, () => void>();
  const workerManager = opts.pluginWorkerManager ?? createPluginWorkerManager();

  // Mount API routes
  const api = Router();
  // AgentDash (#160): default-tier rate limit covering everything under /api
  // (excluding /api/auth which has a tighter limiter mounted on `app` directly).
  api.use(createDefaultApiRateLimiter({ deploymentMode: opts.deploymentMode }));
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
    }),
  );
  api.use("/companies", companyRoutes(db, opts.storageService, {
    requireCorpEmail: opts.requireCorpEmail ?? false,
    allowMultiTenantPerDomain: true,
    deploymentMode: opts.deploymentMode,
    allowMultiCompany: process.env.AGENTDASH_ALLOW_MULTI_COMPANY === "true",
  }));
  api.use(companySkillRoutes(db));
  api.use(agentRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
    pluginWorkerManager: workerManager,
  }));
  api.use(issueTreeControlRoutes(db));
  api.use(routineRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(environmentRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(executionWorkspaceRoutes(db));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(mandatedActionRoutes(db));
  api.use(mandateRoutes(db));
  api.use(mandateAttestationRoutes(db));
  api.use(zkPermissionProofRoutes(db));
  api.use(handshakeDemoRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use("/msp", mspRoutes(db));
  api.use(userProfileRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(sidebarPreferenceRoutes(db));
  api.use(inboxDismissalRoutes(db));
  api.use(instanceSettingsRoutes(db));
  api.use("/conversations", conversationRoutes(db));
  // AgentDash: tighter cap on the invite endpoint specifically — fans
  // out to Resend (cost amplification + sender-domain reputation risk).
  // Default API limiter still covers the rest of /onboarding.
  api.use("/onboarding/invites", createInviteRateLimiter({ deploymentMode: opts.deploymentMode }));
  api.use("/onboarding", onboardingV2Routes(db));
  api.use(assessRoutes(db));
  api.use(agentResearchRoutes(db));
  // AgentDash: Agent-run quota (AGE-120)
  api.use(quotaRoutes(db));
  // AgentDash: Test Drive — no-signup anonymous trial. PUBLIC + token-based:
  // these routes validate the trial token themselves and never require
  // req.actor, so they are reachable without auth even in authenticated mode
  // (boardMutationGuard only gates board-session actors). A tighter per-IP
  // request limiter sits in front of the cost-amplifying entry points (session
  // mint + multi-agent design) on top of the default-tier API limiter; the
  // kill-switch + per-IP/day + global-spend caps live in trialRoutes/trialService.
  api.use("/trial", createTrialRateLimiter({ deploymentMode: opts.deploymentMode }), trialRoutes(db));
  // AgentDash: Connectors (AGE-106)
  api.use(connectorRoutes(db));
  // AgentDash: Slack Connector (AGE-108)
  api.use("/connectors", slackConnectorRoutes(db));
  // AgentDash: Gmail Connector (AGE-109)
  api.use(gmailRoutes(db));
  // AgentDash: goals-eval-hitl
  api.use(verdictRoutes(db));
  api.use(featureFlagRoutes(db));
  // AgentDash: billing — always mount so /api/billing/status responds with
  // sensible defaults in dev. When Stripe is configured (STRIPE_SECRET_KEY set)
  // checkout/portal/webhook do real work; otherwise those endpoints return 503
  // "Billing not configured" and the requireTier middleware bypasses caps.
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  // AgentDash: security — when Stripe is enabled, STRIPE_WEBHOOK_SECRET must
  // be set. An empty string causes constructEvent to accept all signatures,
  // allowing forged webhook events. Fail fast at startup rather than silently
  // accepting all webhooks. Obtain the value via:
  //   stripe listen --print-secret
  if (stripeKey) {
    const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
    if (!webhookSecret) {
      throw new Error(
        "STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set. " +
          "An empty or missing webhook secret allows forged Stripe webhook events. " +
          "Set it to the signing secret for your webhook endpoint. " +
          "To get your local secret, run: stripe listen --print-secret",
      );
    }
  }
  let stripeSdk: any = stripeStubForDev();
  if (stripeKey) {
    const { default: Stripe } = await import("stripe");
    // AgentDash (P0.3): pin the API version so a stripe-package upgrade can't
    // silently shift webhook payload shapes underneath us (e.g. the
    // current_period_end relocation in 2025-03-31). Matches the installed
    // stripe@22 LatestApiVersion.
    stripeSdk = new Stripe(stripeKey, { apiVersion: "2026-04-22.dahlia" });
  }
  // AgentDash (#160): tighter rate limit on /billing/* (abuse vector). The
  // /billing/webhook subpath is hit by Stripe's servers, not users, and must
  // bypass — Stripe can send bursts during retries / high-traffic events.
  const billingLimiter = createBillingRateLimiter({ deploymentMode: opts.deploymentMode });
  api.use(
    "/billing",
    (req, res, next) => {
      if (req.path === "/webhook") return next();
      return billingLimiter(req, res, next);
    },
    billingRoutes(db, {
    stripe: stripeSdk,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    proPriceId: process.env.STRIPE_PRO_PRICE_ID ?? "",
    trialDays: parseInt(process.env.STRIPE_TRIAL_DAYS ?? "14", 10),
    publicBaseUrl: process.env.BILLING_PUBLIC_BASE_URL ?? "",
  }));
  if (opts.databaseBackupService) {
    api.use(instanceDatabaseBackupRoutes(opts.databaseBackupService));
  }
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = createPluginEventBus();
  setPluginEventBus(eventBus);
  const jobStore = pluginJobStore(db);
  const lifecycle = pluginLifecycleManager(db, { workerManager });
  const scheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
  });
  const toolDispatcher = createPluginToolDispatcher({
    workerManager,
    lifecycleManager: lifecycle,
    db,
  });
  const jobCoordinator = createPluginJobCoordinator({
    db,
    lifecycle,
    scheduler,
    jobStore,
  });
  const hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  let viteHtmlRenderer: ReturnType<typeof createCachedViteHtmlRenderer> | null = null;
  const loader = pluginLoader(
    db,
    {
      localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
      migrationDb: opts.pluginMigrationDb,
    },
    {
      workerManager,
      eventBus,
      jobScheduler: scheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager: lifecycle,
      instanceInfo: {
        instanceId: opts.instanceId ?? "default",
        hostVersion: opts.hostVersion ?? "0.0.0",
      },
      buildHostHandlers: (pluginId, manifest) => {
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker, {
          pluginWorkerManager: workerManager,
        });
        hostServicesDisposers.set(pluginId, () => services.dispose());
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler, jobStore },
      { workerManager },
      { toolDispatcher },
      { workerManager },
    ),
  );
  api.use(adapterRoutes());
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.use(pluginUiStaticRoutes(db, {
    localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
    deploymentMode: opts.deploymentMode,
    // AgentDash: restrict plugin-UI CORS in authenticated mode to an explicit
    // allowlist (AGENTDASH_PLUGIN_UI_ALLOWED_ORIGINS) plus the instance's own
    // public origin; local_trusted stays permissive for plugin dev.
    allowedOrigins: parsePluginUiAllowedOrigins(
      process.env.AGENTDASH_PLUGIN_UI_ALLOWED_ORIGINS,
    ),
    publicBaseUrl: opts.pluginUiPublicBaseUrl,
  }));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      const indexHtml = applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
      // Hashed asset files (Vite emits them under /assets/<name>.<hash>.<ext>)
      // never change once built, so they can be cached aggressively.
      app.use(
        "/assets",
        express.static(path.join(uiDist, "assets"), {
          maxAge: "1y",
          immutable: true,
        }),
      );
      // Non-hashed static files (favicon.ico, manifest, robots.txt, etc.):
      // short cache so operators who swap them out see the new version
      // reasonably fast. Override for `index.html` specifically — it is
      // served by this middleware for `/` and `/index.html`, and it must
      // never outlive the asset hashes it points at.
      app.use(
        express.static(uiDist, {
          maxAge: "1h",
          setHeaders(res, filePath) {
            if (path.basename(filePath) === "index.html") {
              res.set("Cache-Control", "no-cache");
            }
          },
        }),
      );
      // SPA fallback. Only for non-asset routes — if the browser asks for
      // /assets/something.js that doesn't exist, we must NOT serve the HTML
      // shell: the browser would try to load it as a JavaScript module, fail
      // with a MIME-type error, and cache that broken response. Return 404
      // instead. The index.html response itself is no-cache so a subsequent
      // deploy's updated asset hashes are picked up on next load.
      app.get(/.*/, (req, res) => {
        if (req.path.startsWith("/assets/")) {
          res.status(404).end();
          return;
        }
        res
          .status(200)
          .set("Content-Type", "text/html")
          .set("Cache-Control", "no-cache")
          .end(indexHtml);
      });
    } else {
      console.warn("[paperclip] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const publicUiRoot = path.resolve(uiRoot, "public");
    const hmrPort = resolveViteHmrPort(opts.serverPort);
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          host: opts.bindHost,
          port: hmrPort,
          clientPort: hmrPort,
        },
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });
    viteHtmlRenderer = createCachedViteHtmlRenderer({
      vite,
      uiRoot,
      brandHtml: applyUiBranding,
    });
    const renderViteHtml = viteHtmlRenderer;

    if (fs.existsSync(publicUiRoot)) {
      app.use(express.static(publicUiRoot, { index: false }));
    }
    app.get(/.*/, async (req, res, next) => {
      if (!shouldServeViteDevHtml(req)) {
        next();
        return;
      }
      try {
        const html = await renderViteHtml.render(req.originalUrl);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  }

  app.use(errorHandler);

  jobCoordinator.start();
  scheduler.start();
  const feedbackExportTimer = opts.feedbackExportService
    ? setInterval(() => {
      void opts.feedbackExportService?.flushPendingFeedbackTraces().catch((err) => {
        logger.error({ err }, "Failed to flush pending feedback exports");
      });
    }, FEEDBACK_EXPORT_FLUSH_INTERVAL_MS)
    : null;
  feedbackExportTimer?.unref?.();
  if (opts.feedbackExportService) {
    void opts.feedbackExportService.flushPendingFeedbackTraces().catch((err) => {
      logger.error({ err }, "Failed to flush pending feedback exports");
    });
  }
  void toolDispatcher.initialize().catch((err) => {
    logger.error({ err }, "Failed to initialize plugin tool dispatcher");
  });
  const devWatcher = opts.uiMode === "vite-dev"
    ? createPluginDevWatcher(
      lifecycle,
      async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
    )
    : null;
  void loader.loadAll().then((result) => {
    if (!result) return;
    for (const loaded of result.results) {
      if (devWatcher && loaded.success && loaded.plugin.packagePath) {
        devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
      }
    }
  }).catch((err) => {
    logger.error({ err }, "Failed to load ready plugins on startup");
  });
  process.once("exit", () => {
    if (feedbackExportTimer) clearInterval(feedbackExportTimer);
    devWatcher?.close();
    viteHtmlRenderer?.dispose();
    hostServiceCleanup.disposeAll();
    hostServiceCleanup.teardown();
  });
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  return app;
}

// Dev-mode stub for the Stripe SDK so billingRoutes can mount even when
// STRIPE_SECRET_KEY isn't set. Endpoints that exercise the real SDK
// (checkout-session, portal-session, webhook constructEvent) throw a
// typed "Billing not configured" error that the routes translate to 503.
// Read-only endpoints (status) work via the DB unchanged.
function stripeStubForDev() {
  const notConfigured = () => {
    throw new HttpError(503, "Billing not configured. Set STRIPE_SECRET_KEY to enable checkout/portal/webhook.");
  };
  return {
    customers: { create: notConfigured, retrieve: notConfigured },
    checkout: { sessions: { create: notConfigured } },
    billingPortal: { sessions: { create: notConfigured } },
    subscriptions: { update: notConfigured, retrieve: notConfigured },
    webhooks: { constructEvent: notConfigured },
  };
}
