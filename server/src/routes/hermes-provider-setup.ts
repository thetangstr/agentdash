// AgentDash (MVL 1.0, #725): `POST /api/onboarding/setup-adapter` with
// `preset: "hermes"` and a `provider` takes the customer's provider key and
// writes it into Hermes (services/hermes-provider-setup.ts).
//
// Instance admin only (it rewrites the Hermes template every agent profile is
// cloned from; on a hosted box the admin is the claimant, as after #714), and
// company-scoped: the key is stored as that company's secret, only that
// company's agent profiles are touched, and the activity entry lands in that
// company. The key is never logged, returned or put in the activity entry.

import type { Request, Response } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/activity-log.js";
import { readAdapterStatus } from "../services/adapter-presets.js";
import {
  configureHermesProvider,
  HERMES_PROVIDER_SPECS,
  parseHermesProviderInput,
  type HermesProviderSetupDeps,
} from "../services/hermes-provider-setup.js";
import { advisoryLock, companySecretStore, listCompanyHermesAgentIds } from "../services/hermes-provider-db.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

export interface HermesProviderSetupHandlerDeps {
  setup?: HermesProviderSetupDeps;
  logActivity?: typeof logActivity;
  listAgentIds?: (companyId: string) => Promise<string[]>;
}

export function createHermesProviderSetupHandler(db: Db, deps: HermesProviderSetupHandlerDeps = {}) {
  const log = deps.logActivity ?? logActivity;
  const listAgentIds = deps.listAgentIds ?? ((companyId: string) => listCompanyHermesAgentIds(db, companyId));
  return async (req: Request, res: Response) => {
    assertInstanceAdmin(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
    if (!companyId) throw badRequest("companyId required with a Hermes provider");
    assertCompanyAccess(req, companyId);

    const input = parseHermesProviderInput(body);
    const actorUserId = req.actor.userId ?? null;
    const result = await configureHermesProvider(
      companyId,
      input,
      actorUserId,
      { agentIds: await listAgentIds(companyId) },
      { secrets: companySecretStore(db), lock: advisoryLock(db), ...deps.setup },
    );

    const details = { provider: result.provider, model: result.model, profilesUpdated: result.profilesUpdated };
    await log(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId ?? "unknown",
      action: "hermes_provider.configured",
      entityType: "company",
      entityId: companyId,
      details,
    });
    logger.info({ ...details, companyId, actor: actorUserId }, "[setup-adapter] hermes provider configured");

    // The default adapter is read from the deployment's configuration
    // (AGENTDASH_DEFAULT_ADAPTER, hermes_local in the hosted image); this route
    // does not change process-wide settings.
    res.status(201).json({
      status: readAdapterStatus(),
      hermesProvider: {
        configured: true,
        provider: result.provider,
        label: HERMES_PROVIDER_SPECS[result.provider].label,
        model: result.model,
      },
      profilesUpdated: result.profilesUpdated,
      // Names only, never values.
      applied: [HERMES_PROVIDER_SPECS[result.provider].envVar, "model.provider", "model.default"],
    });
  };
}
