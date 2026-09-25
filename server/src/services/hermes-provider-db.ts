// AgentDash (#725): the database side of the Hermes provider key: the company
// secret (create or rotate, with an undo), the company's Hermes agents, and a
// Postgres advisory lock that serialises setups across server processes.

import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { SECRET_PROVIDERS, type SecretProvider } from "@paperclipai/shared";
import {
  withLocalLock,
  type HermesProviderSecretStore,
  type HermesProviderSetupDeps,
} from "./hermes-provider-setup.js";
import { secretService } from "./secrets.js";

/** The company secrets service: create or rotate by name, with an undo. */
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
        const previous = await svc.resolveSecretValue(companyId, existing.id, "latest");
        await svc.rotate(existing.id, { value }, { userId: actorUserId });
        return {
          restore: async () => {
            await svc.rotate(existing.id, { value: previous }, { userId: actorUserId });
          },
        };
      }
      const created = await svc.create(companyId, { name, provider, value, description }, { userId: actorUserId });
      return {
        restore: async () => {
          await svc.remove(created.id);
        },
      };
    },
    async get(companyId, name) {
      const existing = await svc.getByName(companyId, name);
      if (!existing) return null;
      return svc.resolveSecretValue(companyId, existing.id, "latest");
    },
  };
}

/** The company's Hermes agents. Only these profiles are ever touched for it. */
export async function listCompanyHermesAgentIds(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, "hermes_local"), ne(agents.status, "terminated")));
  return rows.map((row) => row.id);
}

/**
 * Serialise across server processes: a Postgres advisory lock held for the
 * setup, inside the in-process queue.
 */
export function advisoryLock(db: Db): NonNullable<HermesProviderSetupDeps["lock"]> {
  return (key, fn) =>
    withLocalLock(key, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
        return fn();
      }),
    );
}

