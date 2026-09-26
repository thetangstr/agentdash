// AgentDash: the control plane's migrate command (GH #763 role split). Runs
// as its own short-lived Railway service, `cloud-migrate`, with a superuser
// DATABASE_URL, so the long-lived cloud-control service never holds owner or
// superuser credentials. Service settings (set through the API; Railway does
// not apply an uploaded railway.json to a service created after its
// config-as-code deprecation): dockerfilePath cloud/Dockerfile, startCommand
// `node dist/migrate.js`, restartPolicyType NEVER, no health check, no domain.
// Deploy it before cloud-control on every release that adds a migration;
// cloud-control refuses to start on an unmigrated schema.
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
