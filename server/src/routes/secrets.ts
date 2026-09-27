import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  SECRET_PROVIDERS,
  type SecretProvider,
  createSecretSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, assertCompanyAdministrator } from "./authz.js";
import { accessService } from "../services/access.js";
import { isReservedManagedSecretName } from "../services/secrets.js";
import { unprocessable } from "../errors.js";
import { logActivity, secretService } from "../services/index.js";

export function secretRoutes(db: Db) {
  const router = Router();
  const svc = secretService(db);
  const access = accessService(db);
  // AgentDash (GH #782 review): a secret owned by a connection (the GitHub
  // token) is rotated or deleted here only by a company owner/admin, and the
  // reserved names cannot be created or taken by rename by anyone.
  async function assertMayChangeSecret(req: Parameters<typeof assertCompanyAccess>[0], secret: { id: string; name: string; companyId: string }) {
    if (await svc.isManaged(secret)) {
      await assertCompanyAdministrator(
        access,
        req,
        secret.companyId,
        "This secret belongs to a connection (for example GitHub). Only a workspace owner or admin can change it; reconnect from the project's settings instead.",
      );
    }
  }
  function assertNameNotReserved(name: unknown) {
    if (isReservedManagedSecretName(name)) {
      throw unprocessable("Secret names starting with github-token- are reserved for connections.");
    }
  }
  const configuredDefaultProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const defaultProvider = (
    configuredDefaultProvider && SECRET_PROVIDERS.includes(configuredDefaultProvider as SecretProvider)
      ? configuredDefaultProvider
      : "local_encrypted"
  ) as SecretProvider;

  router.get("/companies/:companyId/secret-providers", (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(svc.listProviders());
  });

  router.get("/companies/:companyId/secrets", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const secrets = await svc.list(companyId);
    // AgentDash (GH #782 review): connection-owned secrets are not listed, so
    // their ids are not offered for binding (binding them is refused anyway).
    const visible = [];
    for (const secret of secrets) if (!(await svc.isManaged(secret))) visible.push(secret);
    res.json(visible);
  });

  router.post("/companies/:companyId/secrets", validate(createSecretSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNameNotReserved(req.body.name);

    const created = await svc.create(
      companyId,
      {
        name: req.body.name,
        provider: req.body.provider ?? defaultProvider,
        value: req.body.value,
        description: req.body.description,
        externalRef: req.body.externalRef,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider: created.provider },
    });

    res.status(201).json(created);
  });

  router.post("/secrets/:id/rotate", validate(rotateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await assertMayChangeSecret(req, existing);

    const rotated = await svc.rotate(
      id,
      {
        value: req.body.value,
        externalRef: req.body.externalRef,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
      // Managed secrets reach this line only after assertMayChangeSecret (company admin).
      { companyId: existing.companyId, allowManaged: true },
    );

    await logActivity(db, {
      companyId: rotated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.rotated",
      entityType: "secret",
      entityId: rotated.id,
      details: { version: rotated.latestVersion },
    });

    res.json(rotated);
  });

  router.patch("/secrets/:id", validate(updateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await assertMayChangeSecret(req, existing);

    if (req.body.name !== undefined && req.body.name !== existing.name) assertNameNotReserved(req.body.name);
    const updated = await svc.update(id, {
      name: req.body.name,
      description: req.body.description,
      externalRef: req.body.externalRef,
    }, { companyId: existing.companyId, allowManaged: true });

    if (!updated) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.updated",
      entityType: "secret",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
  });

  router.delete("/secrets/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await assertMayChangeSecret(req, existing);

    const removed = await svc.remove(id, { companyId: existing.companyId, allowManaged: true });
    if (!removed) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  return router;
}
