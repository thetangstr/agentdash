import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { companyService } from "../services/companies.js";
import { readAdapterStatus } from "../services/adapter-presets.js";
import { serverVersion } from "../version.js";

// AgentDash: self-serve-bootstrap — gate the first-user self-serve company
// creation + instance-admin promotion behind an env flag so existing
// deployments are unaffected. Default OFF.
function isSelfServeBootstrapEnabled(): boolean {
  return process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP === "true";
}

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

function hasDevServerStatusToken(providedToken: string | undefined) {
  const expectedToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN?.trim();
  const token = providedToken?.trim();
  if (!expectedToken || !token) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * The address this instance calls itself, when its operator has said one.
 *
 * Exposed so the UI can generate harness configuration against a stable host
 * rather than `window.location.origin`. That origin is whatever URL happened to
 * be in the browser when someone pressed Copy — so a command copied from a LAN
 * address bakes that address into `~/.codex/config.toml` on a colleague's
 * laptop, and silently stops working the moment they are on a different
 * network. A config that persists on someone else's machine is the worst place
 * for that footgun.
 *
 * Not a secret: it is by definition the address people are told to use, and
 * this endpoint already reports deployment mode and bootstrap state. Absent
 * when unset, and callers fall back to their own origin.
 */
function configuredPublicBaseUrl(): string | undefined {
  const raw =
    process.env.PAPERCLIP_PUBLIC_URL?.trim()
    || process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );
    const exposeDevServerDetails =
      exposeFullDetails || hasDevServerStatusToken(req.get("x-paperclip-dev-server-status-token"));

    if (!db) {
      res.json(
        exposeFullDetails
          ? { status: "ok", version: serverVersion }
          : { status: "ok", deploymentMode: opts.deploymentMode },
      );
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        error: "database_unreachable"
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (exposeDevServerDetails && persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    // AgentDash: self-serve-bootstrap — expose whether the flag is on and
    // whether any non-archived company already exists, so the CloudAccessGate
    // UI can route the first user to the onboarding wizard instead of the CLI
    // bootstrap page or a dead-end "No company access" screen. Computed AFTER
    // the bootstrap + dev-server queries above so it doesn't perturb their
    // (order-sensitive) DB access.
    const selfServeBootstrap = isSelfServeBootstrapEnabled();
    const instanceHasCompany =
      typeof (db as { select?: unknown }).select === "function"
        ? await companyService(db).hasActiveCompany()
        : false;

    // AgentDash: adapter readiness — the MCP onboarding journey gates plan
    // proposal on a configured model. Read from process.env; cheap + sync.
    const adapter = readAdapterStatus();

    if (!exposeFullDetails) {
      res.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        bootstrapStatus,
        bootstrapInviteActive,
        selfServeBootstrap,
        instanceHasCompany,
        adapterReady: adapter.ready,
        adapterPreset: adapter.preset,
        ...(configuredPublicBaseUrl() ? { publicBaseUrl: configuredPublicBaseUrl() } : {}),
        ...(devServer ? { devServer } : {}),
      });
      return;
    }

    res.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      selfServeBootstrap,
      instanceHasCompany,
      adapterReady: adapter.ready,
      adapterPreset: adapter.preset,
      adapterReason: adapter.reason,
      ...(configuredPublicBaseUrl() ? { publicBaseUrl: configuredPublicBaseUrl() } : {}),
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      ...(devServer ? { devServer } : {}),
    });
  });

  return router;
}
