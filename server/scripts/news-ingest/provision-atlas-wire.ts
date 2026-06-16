// scripts/news-ingest/provision-atlas-wire.ts
import { createDb, companies, agents, goals } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { loadConfig } from "../../src/config.js";
import { BEATS, COS_AGENT_NAME, COS_CLOCKCHAIN_TOOL } from "../../src/services/news-ingest/feeds.js";

const has = (n: string) => process.argv.includes(n);

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  const dryRun = has("--dry-run");
  const name = process.env.ATLAS_WIRE_COMPANY || "Atlas Wire";

  // 1. Company (idempotent by name).
  let company = (await db.select().from(companies).where(eq(companies.name, name)))[0];
  if (!company) {
    if (dryRun) { console.log(`[dry] would create company ${name}`); }
    else company = (await db.insert(companies).values({ name }).returning())[0];
  }
  const companyId = company?.id ?? null;
  // In dry-run before the company exists, companyId is null — skip DB lookups
  // (a string placeholder would crash the uuid-typed columns) and just preview.
  const companyMissingInDryRun = dryRun && !companyId;
  console.log(`company: ${companyId ?? "(dry-run, not yet created)"}`);

  // 2. CoS (Atlas) — paused. reportsTo = null.
  async function upsertAgent(input: { name: string; title: string; tool: string; reportsTo: string | null }) {
    const existing = companyMissingInDryRun
      ? undefined
      : (await db.select().from(agents).where(and(eq(agents.companyId, companyId!), eq(agents.name, input.name))))[0];
    if (existing) return existing.id;
    if (dryRun) { console.log(`[dry] would create agent ${input.name} (paused)`); return "(dry)"; }
    const row = (await db.insert(agents).values({
      companyId: companyId!,
      name: input.name,
      title: input.title,
      role: "general",
      status: "paused",
      pauseReason: "atlas-wire: data-driven agent, executed by ingestion pipeline not heartbeat",
      pausedAt: new Date(),
      reportsTo: input.reportsTo,
      adapterType: "hermes_local",
      adapterConfig: {},
      metadata: { atlasWire: true, clockchainTool: input.tool },
    }).returning())[0];
    return row.id;
  }

  const atlasId = await upsertAgent({ name: COS_AGENT_NAME, title: "Editor-in-Chief (Chief of Staff)", tool: COS_CLOCKCHAIN_TOOL, reportsTo: null });

  // 3. Company vision goal + per-desk goals + beat agents.
  async function upsertGoal(input: { title: string; level: string; parentId: string | null; ownerAgentId: string | null }) {
    const existing = companyMissingInDryRun
      ? undefined
      : (await db.select().from(goals).where(and(eq(goals.companyId, companyId!), eq(goals.title, input.title))))[0];
    if (existing) return existing.id;
    if (dryRun) { console.log(`[dry] would create goal ${input.title}`); return "(dry)"; }
    return (await db.insert(goals).values({ companyId: companyId!, title: input.title, level: input.level, status: "active", parentId: input.parentId, ownerAgentId: input.ownerAgentId }).returning())[0].id;
  }

  const visionId = await upsertGoal({ title: "A verifiable public ledger of significant world events", level: "company", parentId: null, ownerAgentId: atlasId });

  for (const beat of BEATS) {
    const agentId = await upsertAgent({ name: beat.agentName, title: `${beat.agentName} desk`, tool: beat.clockchainTool, reportsTo: atlasId });
    await upsertGoal({ title: `${beat.agentName}: log every inflection point with a court-grade receipt`, level: "team", parentId: visionId, ownerAgentId: agentId });
  }
  console.log(dryRun ? "dry-run complete" : "provisioned Atlas Wire (19 paused agents + goal tree)");
}

void main().catch((e) => { console.error(e); process.exit(1); });
