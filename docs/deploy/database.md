---
title: Database
summary: Embedded PostgreSQL by default, or your own PostgreSQL through DATABASE_URL
---

AgentDash stores everything in PostgreSQL, through Drizzle ORM. The schema lives in `packages/db/src/schema/` and the migrations in `packages/db/src/migrations/`. It is the same schema whichever way you run the database.

There are two ways to run it. `DATABASE_URL` decides which.

| `DATABASE_URL` | Database |
|---|---|
| Not set | Embedded PostgreSQL, started by the server |
| Set | Your PostgreSQL server |

A `database.connectionString` in the instance config (with `database.mode: "postgres"`) works the same as `DATABASE_URL`; the environment variable wins. Source: `server/src/config.ts`.

## Embedded PostgreSQL (default)

No setup. If `DATABASE_URL` is not set, the server starts PostgreSQL itself, from the `embedded-postgres` package (major version 18, per `server/package.json`).

On first start the server:

1. creates the data directory, `~/.paperclip/instances/default/db/` by default;
2. starts PostgreSQL on port `54329`, or the next free port if that one is taken;
3. creates the `paperclip` database;
4. applies all migrations.

Data persists across restarts. The Docker quickstart uses this mode too, with the data under the container's `/paperclip`.

The data directory and port can be changed in the instance config (`database.embeddedPostgresDataDir`, `database.embeddedPostgresPort`). Set `PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE=true` to log PostgreSQL's own output. Source: `server/src/index.ts`.

## Your own PostgreSQL

Set `DATABASE_URL` to a standard connection string:

```sh
DATABASE_URL=postgres://user:password@db-host:5432/agentdash
```

To try it locally, `docker/docker-compose.yml` runs PostgreSQL 17 next to the server (see [Docker](/deploy/docker)).

The client (`packages/db/src/client.ts`) uses postgres.js with its defaults, which include prepared statements. Point `DATABASE_URL` at a direct or session-mode connection, not a transaction-mode pooler.

Set `DATABASE_MIGRATION_URL` if migrations need different credentials (for example, a role that owns the schema). The server uses it for migrations and `DATABASE_URL` for everything else.

## Migrations

At startup the server checks for pending migrations before it serves anything:

- `PAPERCLIP_MIGRATION_AUTO_APPLY=true`: apply them.
- Otherwise, `PAPERCLIP_MIGRATION_PROMPT=never`: refuse to start.
- Otherwise, in an interactive terminal: ask.
- Otherwise (launchd, Docker, systemd): apply them.

A fresh embedded database is always migrated. To apply migrations by hand from a clone:

```sh
pnpm db:migrate
```

Source: `server/src/index.ts`, `packages/db/src/migrate.ts`.

## Backups

The server backs up its own database on a schedule. It is on by default: every 60 minutes, kept for 7 days, written to `~/.paperclip/instances/default/data/backups`.

| Variable | Default |
|---|---|
| `PAPERCLIP_DB_BACKUP_ENABLED` | `true` |
| `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES` | `60` |
| `PAPERCLIP_DB_BACKUP_RETENTION_DAYS` | `7` |
| `PAPERCLIP_DB_BACKUP_DIR` | `<instance>/data/backups` |

For a one-off backup from a clone:

```sh
pnpm paperclipai db:backup
```

A database backup does not include uploaded files or the secrets master key. Back those up too; see [Storage](/deploy/storage) and [Secrets](/deploy/secrets).
