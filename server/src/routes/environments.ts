import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  AGENT_ADAPTER_TYPES,
  createEnvironmentSchema,
  getEnvironmentCapabilities,
  probeEnvironmentConfigSchema,
  updateEnvironmentSchema,
} from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  issueService,
  logActivity,
  projectService,
} from "../services/index.js";
import {
  normalizeEnvironmentConfigForPersistence,
  prepareExternalEnvironmentConfigPersistence,
  normalizeEnvironmentConfigForProbe,
  parseEnvironmentDriverConfig,
  readSshEnvironmentPrivateKeySecretId,
  type ParsedEnvironmentConfig,
} from "../services/environment-config.js";
import { insertActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { probeEnvironment } from "../services/environment-probe.js";
import { secretService } from "../services/secrets.js";
import { listReadyPluginEnvironmentDrivers } from "../services/plugin-environment-driver.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { environmentService } from "../services/environments.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { assertCanPinHermesSsh, assertHermesSshEnvironmentPermitted, hermesSshEnabled, hermesSshTargetIdentity, withHermesSshCompanyLock } from "../services/hermes-ssh-policy.js";

export function environmentRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = environmentService(db);
  const executionWorkspaces = executionWorkspaceService(db);
  const issues = issueService(db);
  const projects = projectService(db);
  const secrets = secretService(db);

  function parseObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  function canCreateAgents(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanMutateEnvironments(req: Request, companyId: string, executor: Db = db) {
    const access = accessService(executor);
    const agents = agentService(executor);
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "environments:manage");
      if (!allowed) {
        throw forbidden("Missing permission: environments:manage");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "environments:manage");
    if (allowedByGrant || canCreateAgents(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: environments:manage");
  }

  async function actorCanReadEnvironmentConfigurations(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
      return access.canUser(companyId, req.actor.userId, "environments:manage");
    }

    if (!req.actor.agentId) return false;
    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) return false;
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "environments:manage");
    return allowedByGrant || canCreateAgents(actorAgent);
  }

  function redactEnvironmentForRestrictedView<T extends {
    config: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
  }>(environment: T): T & { configRedacted: true; metadataRedacted: true } {
    return {
      ...environment,
      config: {},
      metadata: null,
      configRedacted: true,
      metadataRedacted: true,
    };
  }

  function summarizeEnvironmentUpdate(
    patch: Record<string, unknown>,
    environment: {
      name: string;
      driver: string;
      status: string;
    },
  ): Record<string, unknown> {
    const details: Record<string, unknown> = {
      changedFields: Object.keys(patch).sort(),
    };

    if (patch.name !== undefined) details.name = environment.name;
    if (patch.driver !== undefined) details.driver = environment.driver;
    if (patch.status !== undefined) details.status = environment.status;
    if (patch.description !== undefined) details.descriptionChanged = true;
    if (patch.config !== undefined) {
      details.configChanged = true;
      details.configTopLevelKeyCount =
        patch.config && typeof patch.config === "object" && !Array.isArray(patch.config)
          ? Object.keys(patch.config as Record<string, unknown>).length
          : 0;
    }
    if (patch.metadata !== undefined) {
      details.metadataChanged = true;
      details.metadataTopLevelKeyCount =
        patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata)
          ? Object.keys(patch.metadata as Record<string, unknown>).length
          : 0;
    }

    return details;
  }

  router.get("/companies/:companyId/environments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.list(companyId, {
      status: req.query.status as string | undefined,
      driver: req.query.driver as string | undefined,
    });
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(req, companyId);
    if (canReadConfigs) {
      res.json(rows);
      return;
    }
    res.json(rows.map((environment) => redactEnvironmentForRestrictedView(environment)));
  });

  router.get("/companies/:companyId/environments/capabilities", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const pluginDrivers = await listReadyPluginEnvironmentDrivers({
      db,
      workerManager: options.pluginWorkerManager,
    });
    res.json(getEnvironmentCapabilities(
      AGENT_ADAPTER_TYPES,
      {
        // AgentDash: instance switch; off by default (services/hermes-ssh-policy.ts).
        hermesSshEnabled: hermesSshEnabled(),
        sandboxProviders: Object.fromEntries(pluginDrivers.map((driver) => [
          driver.driverKey,
          {
            status: "supported" as const,
            supportsSavedProbe: true,
            supportsUnsavedProbe: true,
            supportsRunExecution: true,
            supportsReusableLeases: true,
            displayName: driver.displayName,
            description: driver.description,
            source: "plugin" as const,
            pluginKey: driver.pluginKey,
            pluginId: driver.pluginId,
            configSchema: driver.configSchema,
          },
        ])),
      },
    ));
  });

  router.post("/companies/:companyId/environments", validate(createEnvironmentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanMutateEnvironments(req, companyId);
    const actor = getActorInfo(req);
    const input = {
      ...req.body,
      config: await normalizeEnvironmentConfigForPersistence({
        db,
        companyId,
        environmentName: req.body.name,
        driver: req.body.driver,
        config: req.body.config,
        actor: {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
        pluginWorkerManager: options.pluginWorkerManager,
      }),
    };
    const environment = await svc.create(companyId, input);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.created",
      entityType: "environment",
      entityId: environment.id,
      details: {
        name: environment.name,
        driver: environment.driver,
        status: environment.status,
      },
    });
    res.status(201).json(environment);
  });

  router.get("/environments/:id", async (req, res) => {
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    assertCompanyAccess(req, environment.companyId);
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(req, environment.companyId);
    if (canReadConfigs) {
      res.json(environment);
      return;
    }
    res.json(redactEnvironmentForRestrictedView(environment));
  });

  router.get("/environments/:id/leases", async (req, res) => {
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    assertCompanyAccess(req, environment.companyId);
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(req, environment.companyId);
    if (!canReadConfigs) {
      throw forbidden("Missing permission: environments:manage");
    }
    const leases = await svc.listLeases(environment.id, {
      status: req.query.status as string | undefined,
    });
    res.json(leases);
  });

  router.get("/environment-leases/:leaseId", async (req, res) => {
    const lease = await svc.getLeaseById(req.params.leaseId as string);
    if (!lease) {
      res.status(404).json({ error: "Environment lease not found" });
      return;
    }
    assertCompanyAccess(req, lease.companyId);
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(req, lease.companyId);
    if (!canReadConfigs) {
      throw forbidden("Missing permission: environments:manage");
    }
    res.json(lease);
  });

  router.patch("/environments/:id", validate(updateEnvironmentSchema), async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    await assertCanMutateEnvironments(req, existing.companyId);
    const actor = getActorInfo(req);
    const configSourceFor = (current: typeof existing) =>
      req.body.driver !== undefined && req.body.driver !== current.driver
        ? req.body.config ?? {}
        : req.body.config !== undefined
          ? { ...parseObject(current.config), ...parseObject(req.body.config) }
          : current.config;
    // Plugin validation can call a worker. Do it before the transaction and
    // reject a stale snapshot instead of holding company locks during I/O.
    const initialDriver = req.body.driver ?? existing.driver;
    const needsConfig = req.body.config !== undefined || req.body.driver !== undefined;
    const preparedConfig = needsConfig && initialDriver !== "ssh" && initialDriver !== "local"
      ? await prepareExternalEnvironmentConfigPersistence({ db, companyId: existing.companyId,
          environmentName: req.body.name ?? existing.name, driver: initialDriver,
          config: configSourceFor(existing), actor: { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
          pluginWorkerManager: options.pluginWorkerManager })
      : undefined;
    const publications: ActivityPublication[] = [];
    const environment = await withHermesSshCompanyLock(db, existing.companyId, async tx => {
      const txSvc = environmentService(tx);
      const current = await txSvc.getById(existing.id);
      if (!current) return null;
      await assertCanMutateEnvironments(req, current.companyId, tx);
      if (preparedConfig && current.updatedAt.getTime() !== existing.updatedAt.getTime()) {
        throw conflict("Environment changed while validating its config; reload and retry.");
      }
      const nextDriver = req.body.driver ?? current.driver;
      if (needsConfig && nextDriver !== "ssh" && nextDriver !== "local" && !preparedConfig) {
        throw conflict("Environment driver changed while validating its config; reload and retry.");
      }
      const configSource = configSourceFor(current);
      const identityChanged = hermesSshTargetIdentity(current.driver, current.config) !== hermesSshTargetIdentity(nextDriver, configSource);
      const affectedAgents = identityChanged
        ? (await agentService(tx).list(current.companyId)).filter(agent =>
            agent.companyId === current.companyId && agent.adapterType === "hermes_local" && agent.defaultEnvironmentId === current.id)
        : [];
      let newPin: { target: string; port: number } | null = null;
      if (affectedAgents.length > 0) {
        // Before any secret persistence, and after concurrent pins commit.
        await assertCanPinHermesSsh(req, current.companyId, accessService(tx));
        if (nextDriver === "ssh") newPin = assertHermesSshEnvironmentPermitted({ companyId: current.companyId, config: configSource });
      }
      const patch = {
        ...req.body,
        ...(needsConfig ? { config: preparedConfig ? await preparedConfig(tx) : await normalizeEnvironmentConfigForPersistence({
          db: tx, companyId: current.companyId, environmentName: req.body.name ?? current.name,
          driver: nextDriver, config: configSource,
          actor: { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
          pluginWorkerManager: options.pluginWorkerManager,
        }) } : {}),
      };
      const updated = await txSvc.update(current.id, patch);
      if (!updated) return null;
      publications.push(await insertActivity(tx, {
        companyId: current.companyId, actorType: actor.actorType, actorId: actor.actorId,
        agentId: actor.agentId, runId: actor.runId, action: "environment.updated",
        entityType: "environment", entityId: current.id,
        details: summarizeEnvironmentUpdate(patch as Record<string, unknown>, updated),
      }));
      for (const agent of affectedAgents) {
        publications.push(await insertActivity(tx, {
          companyId: current.companyId, actorType: actor.actorType, actorId: actor.actorId,
          agentId: actor.agentId, runId: actor.runId, action: "agent.ssh_environment_pinned",
          entityType: "agent", entityId: agent.id,
          details: { environmentId: current.id, adapterType: "hermes_local", sshTarget: newPin?.target ?? null, port: newPin?.port ?? null, driver: nextDriver },
        }));
      }
      return updated;
    });
    for (const publication of publications) publishActivity(publication);
    if (!environment) { res.status(404).json({ error: "Environment not found" }); return; }
    res.json(environment);
  });

  router.delete("/environments/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    await assertCanMutateEnvironments(req, existing.companyId);
    await Promise.all([
      executionWorkspaces.clearEnvironmentSelection(existing.companyId, existing.id),
      issues.clearExecutionWorkspaceEnvironmentSelection(existing.companyId, existing.id),
      projects.clearExecutionWorkspaceEnvironmentSelection(existing.companyId, existing.id),
    ]);
    const removed = await svc.remove(existing.id);
    if (!removed) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    const secretId = readSshEnvironmentPrivateKeySecretId(existing);
    if (secretId) {
      // Scoped to this environment's company; a managed secret (the GitHub
      // token) is never deleted from here (GH #782 re-review).
      await secrets.remove(secretId, { companyId: existing.companyId }).catch(() => null);
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.deleted",
      entityType: "environment",
      entityId: removed.id,
      details: {
        name: removed.name,
        driver: removed.driver,
        status: removed.status,
      },
    });
    res.json(removed);
  });

  router.post("/environments/:id/probe", async (req, res) => {
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    await assertCanMutateEnvironments(req, environment.companyId);
    const actor = getActorInfo(req);
    const probe = await probeEnvironment(db, environment, {
      pluginWorkerManager: options.pluginWorkerManager,
    });
    await logActivity(db, {
      companyId: environment.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.probed",
      entityType: "environment",
      entityId: environment.id,
      details: {
        driver: environment.driver,
        ok: probe.ok,
        summary: probe.summary,
      },
    });
    res.json(probe);
  });

  router.post(
    "/companies/:companyId/environments/probe-config",
    validate(probeEnvironmentConfigSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateEnvironments(req, companyId);
      const actor = getActorInfo(req);
      const normalizedConfig = await normalizeEnvironmentConfigForProbe({
        db,
        driver: req.body.driver,
        config: req.body.config,
        pluginWorkerManager: options.pluginWorkerManager,
      });
      const environment = {
        id: "unsaved",
        companyId,
        name: req.body.name?.trim() || "Unsaved environment",
        description: req.body.description ?? null,
        driver: req.body.driver,
        status: "active" as const,
        config: normalizedConfig,
        metadata: req.body.metadata ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const probe = await probeEnvironment(db, environment, {
        pluginWorkerManager: options.pluginWorkerManager,
        resolvedConfig: {
          driver: req.body.driver,
          config: normalizedConfig,
        } as ParsedEnvironmentConfig,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "environment.probed_unsaved",
        entityType: "environment",
        entityId: "unsaved",
        details: {
          driver: environment.driver,
          ok: probe.ok,
          summary: probe.summary,
          configTopLevelKeyCount: Object.keys(environment.config).length,
        },
      });
      res.json(probe);
    },
  );

  return router;
}
