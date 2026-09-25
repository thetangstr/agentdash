// AgentDash (MVL 1.0, #725): `POST /api/onboarding/setup-adapter` with
// `preset: "hermes"` and a `provider` takes the customer's provider key and
// writes it into Hermes (services/hermes-provider-setup.ts).
//
// Instance admin only (it rewrites the Hermes template every agent profile is
// cloned from; on a hosted box the admin is the claimant, as after #714), and
// company-scoped: the key is stored as that company's secret and the activity
// entry lands in that company. The key is never logged, returned or put in the
// activity entry.

import type { Request, Response } from "express";
import type { Db } from "@paperclipai/db";
import { SECRET_PROVIDERS, type SecretProvider } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/activity-log.js";
import { readAdapterStatus } from "../services/adapter-presets.js";
import {
  configureHermesProvider,
  HERMES_PROVIDER_SPECS,
  parseHermesProviderInput,
  type HermesProviderSecretStore,
  type HermesProviderSetupDeps,
} from "../services/hermes-provider-setup.js";
import { secretService } from "../services/secrets.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

/** The company secrets service, create-or-rotate by name. */
export function companySecretStore(db: Db): HermesProviderSecretStore {
  const svc = secretService(db);
  const configured = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const provider = (
    configured && SECRET_PROVIDERS.includes(configured as SecretProvider) ? configured : "local_encrypted"
  ) as SecretProvider;
  return {
    async put(companyId, name, value, description, actorUserId) {
      const existing = await svc.getByName(companyId, name);
      if (existing) {
        await svc.rotate(existing.id, { value }, { userId: actorUserId });
      } else {
        await svc.create(companyId, { name, provider, value, description }, { userId: actorUserId });
      }
    },
  };
}

export interface HermesProviderSetupHandlerDeps {
  setup?: HermesProviderSetupDeps;
  logActivity?: typeof logActivity;
}

export function createHermesProviderSetupHandler(db: Db, deps: HermesProviderSetupHandlerDeps = {}) {
  const log = deps.logActivity ?? logActivity;
  return async (req: Request, res: Response) => {
    assertInstanceAdmin(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
    if (!companyId) throw badRequest("companyId required with a Hermes provider");
    assertCompanyAccess(req, companyId);

    const input = parseHermesProviderInput(body);
    const actorUserId = req.actor.userId ?? null;
    const result = await configureHermesProvider(companyId, input, actorUserId, {
      secrets: companySecretStore(db),
      ...deps.setup,
    });

    // Hermes is now the brain for CoS chat and new agents, as the hermes preset
    // always meant; stub mode (if it was on) ends here.
    process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";
    delete process.env.PAPERCLIP_E2E_SKIP_LLM;

    const details = {
      provider: result.provider,
      model: result.model,
      profilesUpdated: result.profilesUpdated,
      profilesFailed: result.profilesFailed.length,
    };
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

    res.status(201).json({
      status: readAdapterStatus(),
      hermesProvider: {
        configured: true,
        provider: result.provider,
        label: HERMES_PROVIDER_SPECS[result.provider].label,
        model: result.model,
      },
      profilesUpdated: result.profilesUpdated,
      profilesFailed: result.profilesFailed,
      // Names only, never values.
      applied: [HERMES_PROVIDER_SPECS[result.provider].envVar, "model.provider", "model.default"],
    });
  };
}
