// scripts/news-ingest/run-digest.ts
// Queries today's news_events for the Atlas Wire company, builds per-agent
// and atlas-level daily digest issues (status="done"), and inserts them directly.
// Run once per day (see deploy/launchd plist in Task 13).
import { createDb, companies, agents, issues } from "../../packages/db/src/index.js";
import { newsEvents } from "../../packages/db/src/index.js";
import { and, eq, gte } from "drizzle-orm";
import { loadConfig } from "../../server/src/config.js";
import { buildDigests } from "../../server/src/services/news-ingest/digest.js";
import { COS_AGENT_NAME } from "../../server/src/services/news-ingest/feeds.js";

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

  // Today's events (UTC midnight).
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({
      agentId: newsEvents.agentId,
      title: newsEvents.title,
      beat: newsEvents.beat,
    })
    .from(newsEvents)
    .where(and(eq(newsEvents.companyId, companyId), gte(newsEvents.ingestedAt, todayUtc)));

  // Resolve agent names for each agentId in the result set.
  const agentIds = [...new Set(rows.map((r) => r.agentId))];
  const agentRows = agentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId))
    : [];
  const agentNameById = new Map(agentRows.map((a) => [a.id, a.name]));

  const digestRows = rows.map((r) => ({
    agentId: r.agentId,
    agentName: agentNameById.get(r.agentId) ?? r.agentId,
    title: r.title,
    beat: r.beat,
  }));

  // Find Atlas CoS agent id.
  const atlasAgent = agentRows.find((a) => a.name === COS_AGENT_NAME);
  if (!atlasAgent) throw new Error(`Atlas CoS agent "${COS_AGENT_NAME}" not found — run news:provision first`);

  const digests = buildDigests(digestRows, { atlasAgentId: atlasAgent.id, atlasName: atlasAgent.name });

  if (has("--dry-run")) {
    console.log(JSON.stringify(digests.map((d) => ({ agentId: d.agentId, title: d.title, count: d.count })), null, 2));
    console.log("dry-run complete");
    return;
  }

  const now = new Date();
  const inserted = await db.insert(issues).values(
    digests.map((d) => ({
      companyId,
      title: d.title,
      description: d.body,
      status: "done" as const,
      priority: "low" as const,
      assigneeAgentId: d.agentId,
      createdByAgentId: d.agentId,
      completedAt: now,
      originKind: "atlas_wire_digest" as const,
      originFingerprint: `${d.agentId}:${todayUtc.toISOString().slice(0, 10)}`,
    }))
  ).returning({ id: issues.id });

  console.log(JSON.stringify({ created: inserted.length, digests: digests.map((d) => ({ agentId: d.agentId, count: d.count, title: d.title })) }, null, 2));
}

void main().catch((e) => { console.error(e); process.exit(1); });
