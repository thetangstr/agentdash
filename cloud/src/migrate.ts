// AgentDash: the control plane's migrate command (GH #763 role split). Runs
// as its own short-lived Railway service (`cloud-migrate`, config
// cloud/railway.migrate.json) with a superuser DATABASE_URL, so the long-lived
// cloud-control service never holds owner or superuser credentials.
//
//   DATABASE_URL                 the migrator: superuser or CREATEROLE
//   CLOUD_RUNTIME_DB_PASSWORD    optional: create the roles if missing and
//                                (re)set cloud_app's password (as a SCRAM
//                                verifier; the plaintext never reaches Postgres)
//
// Exit 0 when the database is migrated and the grants are applied.
import { migrateWithRoles } from "./db/client.js";
import { createLogger } from "./logger.js";

const log = createLogger({ base: { service: "cloud-migrate" } });

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  const runtimePassword = process.env.CLOUD_RUNTIME_DB_PASSWORD?.trim() || undefined;
  const started = Date.now();
  const { transferred } = await migrateWithRoles(url, { runtimePassword });
  log.info("migrated", { ms: Date.now() - started, ownershipTransferred: transferred, rolesEnsured: Boolean(runtimePassword) });
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    log.error("migration failed", { err });
    process.exit(1);
  },
);
