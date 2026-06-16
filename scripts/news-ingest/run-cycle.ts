// scripts/news-ingest/run-cycle.ts
import { createDb, companies } from "../../packages/db/src/index.js";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../server/src/config.js";
import { runCycle } from "../../server/src/services/news-ingest/runtime.js";

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}
const has = (name: string) => process.argv.includes(name);

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const companyName = process.env.ATLAS_WIRE_COMPANY || "Atlas Wire";
  const companyId = flag("--company")
    || (await db.select({ id: companies.id }).from(companies).where(eq(companies.name, companyName)))[0]?.id;
  if (!companyId) throw new Error(`Company "${companyName}" not found — run news:provision first`);

  const results = await runCycle(db, {
    companyId,
    dryRun: has("--dry-run"),
    onlyBeat: flag("--beat") ?? undefined,
    maxPerBeat: flag("--max") ? Number(flag("--max")) : undefined,
  });
  const total = results.reduce((n, r) => n + r.newEvents, 0);
  console.log(JSON.stringify({ total, results }, null, 2));
}

void main().catch((e) => { console.error(e); process.exit(1); });
