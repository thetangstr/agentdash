#!/usr/bin/env tsx
// Create (or reuse) an isolated database inside the already-running embedded
// Postgres, so another server instance can boot against it without touching the
// developer's own instance data.
//
//   pnpm exec tsx scripts/dryrun-createdb.ts            # -> "dryrun"
//   NEW_DB=fresh2 pnpm exec tsx scripts/dryrun-createdb.ts
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";

const name = process.env.NEW_DB ?? "dryrun";

// A database name cannot be a bound parameter — `create database $1` is not
// valid SQL — so this string is interpolated, and an unvalidated one would be
// straightforward SQL injection from the environment. Restrict it to the shape
// an unquoted Postgres identifier can take and refuse anything else.
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
  console.error(
    `Refusing to create database ${JSON.stringify(name)}: NEW_DB must match /^[a-z_][a-z0-9_]{0,62}$/.`,
  );
  process.exit(1);
}

const admin = createDb("postgres://paperclip:paperclip@127.0.0.1:54329/postgres");
const existing = await admin.execute(sql`select 1 from pg_database where datname = ${name}`);
const rows = (existing as unknown as { rows?: unknown[] }).rows ?? (existing as unknown as unknown[]);
if (Array.isArray(rows) && rows.length > 0) {
  console.log(`database ${name} already exists — reusing`);
} else {
  await admin.execute(sql.raw(`create database "${name}"`));
  console.log(`created database: ${name}`);
}
process.exit(0);
