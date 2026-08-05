#!/usr/bin/env tsx
// Create (or reuse) an isolated `dryrun` database inside the already-running
// embedded Postgres, so a second server instance can boot against it without
// touching the developer's own instance data.
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";

const admin = createDb("postgres://paperclip:paperclip@127.0.0.1:54329/postgres");
const existing = await admin.execute(sql`select 1 from pg_database where datname = 'dryrun'`);
const rows = (existing as unknown as { rows?: unknown[] }).rows ?? (existing as unknown as unknown[]);
if (Array.isArray(rows) && rows.length > 0) {
  console.log("database dryrun already exists — reusing");
} else {
  await admin.execute(sql`create database dryrun`);
  console.log("created database: dryrun");
}
process.exit(0);
