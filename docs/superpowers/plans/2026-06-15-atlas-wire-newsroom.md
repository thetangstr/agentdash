# Atlas Wire — World-Events Newsroom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic news-ingestion pipeline inside AgentDash that staffs a new "Atlas Wire" company (19 paused agents) and logs ~300 real world events/day to the Clockchain, each authored by the right beat agent.

**Architecture:** A launchd timer on the mini runs a CLI entrypoint that executes one ingest cycle and exits — never the AgentDash heartbeat. The cycle: per-beat RSS fetch → dedupe → extract (heuristics + one MiniMax call) → Clockchain attest/log → in-process DB writes (a `news_events` row + an activity-feed entry authored by the beat agent). Agents are real records kept `paused` (heartbeat definitively skips `paused` agents — `heartbeat.ts:3978/4316/4825/6719`), so the pipeline acting as them via in-process writes cannot trigger the adapter crash-loop. Daily, each agent gets one "digest" issue and Atlas gets a wire-digest issue, keeping the issue board realistic.

**Tech Stack:** TypeScript/Node 20, Drizzle ORM + embedded Postgres, `@anthropic-ai/sdk` (pointed at MiniMax's Anthropic-compatible endpoint), `@modelcontextprotocol/sdk` (Clockchain MCP client over Streamable HTTP), `fast-xml-parser` (RSS/Atom), Vitest, tsx (scripts), launchd (scheduling).

---

## Grounding facts (verified against the codebase)

- **Heartbeat safety:** `server/src/services/heartbeat.ts` early-returns for `agent.status === "paused" | "terminated" | "pending_approval"` (lines 3978, 4316, 4825, 6719). Agents created `paused` are never spawned. Default agent status is `idle`.
- **Schemas:** `packages/db/src/schema/agents.ts` (`status`, `reportsTo`, `adapterConfig` jsonb, `metadata` jsonb, `pauseReason`, `pausedAt`), `issues.ts` (`createdByAgentId`, `assigneeAgentId`, `status`, `completedAt`, `goalId`, `originKind`/`originId`/`originFingerprint`, `definitionOfDone`), `activity_log.ts` (`actorType`, `actorId`, `action`, `entityType`, `entityId`, `agentId`, `details` jsonb), `goals.ts` (`level`, `status`, `parentId`, `ownerAgentId`).
- **logActivity helper:** `server/src/services/activity-log.ts:65` → `logActivity(db, input)`.
- **Schema export pattern:** add `export { newsEvents } from "./news_events.js";` to `packages/db/src/schema/index.ts`; then `pnpm db:generate` && `pnpm db:migrate`.
- **Standalone script + DB bootstrap template:** `scripts/backfill-issue-reference-mentions.ts` — `import { createDb } from "../packages/db/src/index.js"; import { loadConfig } from "../server/src/config.js";` then `createDb(dbUrl)`. Run via `tsx`. Register a root `package.json` script.
- **LLM call pattern:** `server/src/services/anthropic-llm.ts` uses `new Anthropic({ apiKey })` + `client.messages.create(...)`. For MiniMax: `new Anthropic({ apiKey: process.env.MINIMAX_CN_API_KEY, baseURL: "https://api.minimaxi.com/anthropic" })`, model `MiniMax-M2.7-highspeed`.
- **Clockchain MCP:** `https://mcp.clockchain.network/mcp`, HTTP (Streamable) MCP, header `x-api-key: <CLOCKCHAIN_MCP_TOKEN>`. Tools: `get_time`, `log_action`, `attest_action`, `build_evidence_package`, `verify_cross_party`, `mint_identity`, `get_timestamp`, `verify_receipt`, `generate_audit_trail`, `tsa_attest`, `tsa_checkpoint`, `generate_compliance_report`. `@modelcontextprotocol/sdk@^1.29.0` is already a dep of `packages/mcp-server`.
- **In-process writes:** the engine lives in `server/src/services/news-ingest/` with the `db` handle; it does NOT call HTTP. (The activity POST route is board-only; `createdByAgentId` is taken from the authed actor — both reasons in-process writes are simpler.)

## File structure

```
packages/db/src/schema/news_events.ts            # new table (source of truth + receipt + fields)
packages/db/src/schema/index.ts                   # +1 export line
server/src/services/news-ingest/
  types.ts          # NewsItem, ExtractedEvent, BeatConfig, IngestResult
  feeds.ts          # BEATS: 18 beats → {feeds[], clockchainTool, agentName, goalSlug}
  feed-parser.ts    # parseFeed(xml) -> NewsItem[]
  event-hash.ts     # canonicalEventHash(core) -> sha256 hex; sourceUrlHash(url)
  extractor.ts      # extractEvent(item, beat, deps) -> ExtractedEvent  (MiniMax)
  clockchain-client.ts # createClockchainClient(env) -> { callTool, getTime }
  writer.ts         # recordEvent(db, {...}) -> insert news_events (idempotent) + logActivity
  guard.ts          # assertNoActiveNewsAgents(db, companyId)
  ingest.ts         # ingestBeat(...), runCycle(...)  (rate-limit, caps, failure isolation)
  digest.ts         # runDailyDigest(...) -> per-agent digest issue + Atlas wire digest
  *.test.ts         # Vitest unit tests colocated
scripts/news-ingest/
  provision-atlas-wire.ts   # run-once: company + 19 paused agents + goal tree (idempotent, --dry-run)
  run-cycle.ts              # cron entrypoint: one cycle then exit (--dry-run, --beat, --max)
package.json                # + "news:provision", "news:ingest", "news:digest" scripts
deploy/launchd/com.agentdash.atlaswire.ingest.plist   # timer (added in final task)
```

---

## Task 1: `news_events` table

**Files:**
- Create: `packages/db/src/schema/news_events.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the schema file**

```typescript
// packages/db/src/schema/news_events.ts
import { pgTable, uuid, text, timestamp, jsonb, real, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// AgentDash: Atlas Wire world-events newsroom. One row per logged world event.
// Source of truth for research data + the Clockchain receipt. Deduped on
// (companyId, sourceUrlHash). Authored by the beat agent (agentId).
export const newsEvents = pgTable(
  "news_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    beat: text("beat").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    sourceUrl: text("source_url").notNull(),
    sourceUrlHash: text("source_url_hash").notNull(),
    sourceOutlet: text("source_outlet"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    clockchainTime: text("clockchain_time"),
    eventHash: text("event_hash").notNull(),
    ledgerId: text("ledger_id"),
    blockHeight: text("block_height"),
    clockchainTool: text("clockchain_tool"),
    entities: jsonb("entities").$type<string[]>(),
    geo: jsonb("geo").$type<{ country?: string; region?: string }>(),
    confidence: real("confidence"),
    inflection: jsonb("inflection").$type<Record<string, unknown>>(),
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIngestedIdx: index("news_events_company_ingested_idx").on(table.companyId, table.ingestedAt),
    companyBeatIdx: index("news_events_company_beat_idx").on(table.companyId, table.beat),
    dedupeIdx: uniqueIndex("news_events_company_source_hash_uq").on(table.companyId, table.sourceUrlHash),
  }),
);
```

- [ ] **Step 2: Export it** — add to `packages/db/src/schema/index.ts` (end of file, with the AgentDash-marked exports):

```typescript
// AgentDash: Atlas Wire world-events newsroom
export { newsEvents } from "./news_events.js";
```

- [ ] **Step 3: Generate + apply the migration**

Run: `pnpm db:generate && pnpm -r typecheck`
Expected: a new migration SQL file under `packages/db/...migrations`, typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/news_events.ts packages/db/src/schema/index.ts packages/db/**/migrations/*
git commit -m "feat(news): news_events table for Atlas Wire"
```

---

## Task 2: Beat config (`feeds.ts` + `types.ts`)

**Files:**
- Create: `server/src/services/news-ingest/types.ts`
- Create: `server/src/services/news-ingest/feeds.ts`
- Test: `server/src/services/news-ingest/feeds.test.ts`

- [ ] **Step 1: Write types**

```typescript
// server/src/services/news-ingest/types.ts
export interface BeatConfig {
  slug: string;            // "armed-conflict"
  agentName: string;       // "Armed Conflict & War"
  goalSlug: string;        // links to the per-desk goal
  clockchainTool: string;  // "attest_action"
  feeds: string[];         // RSS/Atom URLs
}

export interface NewsItem {
  title: string;
  link: string;
  summary: string | null;
  publishedAt: Date | null;
  outlet: string | null;
}

export interface ExtractedEvent {
  entities: string[];
  geo: { country?: string; region?: string };
  confidence: number;       // 0..1
  inflection: Record<string, unknown>; // beat-specific fields
}

export interface IngestResult {
  beat: string;
  fetched: number;
  newEvents: number;
  skippedDuplicates: number;
  errors: string[];
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// server/src/services/news-ingest/feeds.test.ts
import { describe, it, expect } from "vitest";
import { BEATS } from "./feeds.js";

describe("BEATS", () => {
  it("defines 18 beats", () => {
    expect(BEATS).toHaveLength(18);
  });
  it("has unique slugs and at least one feed each", () => {
    const slugs = new Set(BEATS.map((b) => b.slug));
    expect(slugs.size).toBe(18);
    for (const b of BEATS) {
      expect(b.feeds.length).toBeGreaterThan(0);
      for (const url of b.feeds) expect(url).toMatch(/^https?:\/\//);
      expect(b.clockchainTool).toMatch(/^[a-z_]+$/);
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/news-ingest/feeds.test.ts`
Expected: FAIL — cannot find `./feeds.js`.

- [ ] **Step 4: Write `feeds.ts`** (18 beats; feeds are official RSS/Atom endpoints — adjust if a feed 404s during smoke):

```typescript
// server/src/services/news-ingest/feeds.ts
import type { BeatConfig } from "./types.js";

export const BEATS: BeatConfig[] = [
  { slug: "armed-conflict", agentName: "Armed Conflict & War", goalSlug: "conflict", clockchainTool: "attest_action",
    feeds: ["https://feeds.bbci.co.uk/news/world/rss.xml", "https://www.aljazeera.com/xml/rss/all.xml"] },
  { slug: "geopolitics", agentName: "Geopolitics & Diplomacy", goalSlug: "geopolitics", clockchainTool: "verify_cross_party",
    feeds: ["https://feeds.bbci.co.uk/news/world/rss.xml", "https://rss.dw.com/rdf/rss-en-world"] },
  { slug: "elections", agentName: "Elections & Governance", goalSlug: "elections", clockchainTool: "log_action",
    feeds: ["https://feeds.bbci.co.uk/news/politics/rss.xml"] },
  { slug: "science", agentName: "Science & Research", goalSlug: "science", clockchainTool: "build_evidence_package",
    feeds: ["https://www.sciencedaily.com/rss/all.xml", "http://export.arxiv.org/rss/physics"] },
  { slug: "health", agentName: "Health & Medicine", goalSlug: "health", clockchainTool: "attest_action",
    feeds: ["https://feeds.bbci.co.uk/news/health/rss.xml", "https://www.sciencedaily.com/rss/health_medicine.xml"] },
  { slug: "space", agentName: "Space & Astronomy", goalSlug: "space", clockchainTool: "get_timestamp",
    feeds: ["https://www.sciencedaily.com/rss/space_time.xml", "https://www.nasa.gov/feed/"] },
  { slug: "climate", agentName: "Climate & Environment", goalSlug: "climate", clockchainTool: "log_action",
    feeds: ["https://feeds.bbci.co.uk/news/science_and_environment/rss.xml"] },
  { slug: "tech-ai", agentName: "Technology & AI", goalSlug: "tech", clockchainTool: "mint_identity",
    feeds: ["https://feeds.bbci.co.uk/news/technology/rss.xml", "https://www.sciencedaily.com/rss/computers_math/artificial_intelligence.xml"] },
  { slug: "markets", agentName: "Markets & Finance", goalSlug: "markets", clockchainTool: "tsa_attest",
    feeds: ["https://feeds.bbci.co.uk/news/business/rss.xml"] },
  { slug: "crypto", agentName: "Crypto & Web3", goalSlug: "crypto", clockchainTool: "verify_receipt",
    feeds: ["https://www.coindesk.com/arc/outboundfeeds/rss/"] },
  { slug: "energy", agentName: "Energy & Commodities", goalSlug: "energy", clockchainTool: "log_action",
    feeds: ["https://feeds.bbci.co.uk/news/business/rss.xml"] },
  { slug: "sports", agentName: "Sports — Major Events", goalSlug: "sports", clockchainTool: "attest_action",
    feeds: ["https://feeds.bbci.co.uk/sport/rss.xml", "https://www.espn.com/espn/rss/news"] },
  { slug: "disasters", agentName: "Disasters & Humanitarian", goalSlug: "disasters", clockchainTool: "build_evidence_package",
    feeds: ["https://reliefweb.int/updates/rss.xml"] },
  { slug: "law-justice", agentName: "Law & Justice", goalSlug: "law", clockchainTool: "generate_audit_trail",
    feeds: ["https://feeds.bbci.co.uk/news/world/rss.xml"] },
  { slug: "business", agentName: "Business & Corporate", goalSlug: "business", clockchainTool: "attest_action",
    feeds: ["https://feeds.bbci.co.uk/news/business/rss.xml"] },
  { slug: "culture", agentName: "Culture & Entertainment", goalSlug: "culture", clockchainTool: "log_action",
    feeds: ["https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml"] },
  { slug: "migration", agentName: "Migration & Society", goalSlug: "migration", clockchainTool: "verify_cross_party",
    feeds: ["https://feeds.bbci.co.uk/news/world/rss.xml"] },
  { slug: "macro", agentName: "Macro & Central Banks", goalSlug: "macro", clockchainTool: "tsa_checkpoint",
    feeds: ["https://feeds.bbci.co.uk/news/business/rss.xml"] },
];

export const COS_AGENT_NAME = "Atlas";
export const COS_CLOCKCHAIN_TOOL = "generate_compliance_report";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/news-ingest/feeds.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/news-ingest/types.ts server/src/services/news-ingest/feeds.ts server/src/services/news-ingest/feeds.test.ts
git commit -m "feat(news): beat config + types for Atlas Wire"
```

---

## Task 3: Feed parser

**Files:**
- Create: `server/src/services/news-ingest/feed-parser.ts`
- Test: `server/src/services/news-ingest/feed-parser.test.ts`
- Modify: `server/package.json` (add `fast-xml-parser`)

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @paperclipai/server add fast-xml-parser`

- [ ] **Step 2: Write the failing test**

```typescript
// server/src/services/news-ingest/feed-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseFeed } from "./feed-parser.js";

const RSS = `<?xml version="1.0"?><rss><channel>
<title>Example Wire</title>
<item><title>War breaks out in Country X</title>
<link>https://ex.com/a</link>
<description>Fighting began today.</description>
<pubDate>Sun, 14 Jun 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Wire</title>
<entry><title>New particle discovered</title>
<link href="https://ex.com/b"/>
<summary>Physicists report a find.</summary>
<updated>2026-06-14T09:00:00Z</updated></entry></feed>`;

describe("parseFeed", () => {
  it("parses RSS items", () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("War breaks out in Country X");
    expect(items[0].link).toBe("https://ex.com/a");
    expect(items[0].outlet).toBe("Example Wire");
    expect(items[0].publishedAt?.getUTCFullYear()).toBe(2026);
  });
  it("parses Atom entries", () => {
    const items = parseFeed(ATOM);
    expect(items[0].title).toBe("New particle discovered");
    expect(items[0].link).toBe("https://ex.com/b");
  });
  it("returns [] on garbage", () => {
    expect(parseFeed("not xml")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/news-ingest/feed-parser.test.ts`
Expected: FAIL — `./feed-parser.js` not found.

- [ ] **Step 4: Implement**

```typescript
// server/src/services/news-ingest/feed-parser.ts
import { XMLParser } from "fast-xml-parser";
import type { NewsItem } from "./types.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return text((v as Record<string, unknown>)["#text"]);
  }
  return null;
}

function atomLink(link: unknown): string | null {
  if (typeof link === "string") return link.trim() || null;
  if (Array.isArray(link)) {
    const alt = link.find((l) => l?.["@_rel"] === "alternate") ?? link[0];
    return alt?.["@_href"] ?? null;
  }
  if (link && typeof link === "object") return (link as Record<string, string>)["@_href"] ?? null;
  return null;
}

function parseDate(v: unknown): Date | null {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function parseFeed(xml: string): NewsItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }
  const rss = (doc.rss as { channel?: Record<string, unknown> })?.channel;
  if (rss) {
    const outlet = text(rss.title);
    return toArray(rss.item as Record<string, unknown>[]).map((it) => ({
      title: text(it.title) ?? "(untitled)",
      link: text(it.link) ?? "",
      summary: text(it.description),
      publishedAt: parseDate(it.pubDate),
      outlet,
    })).filter((i) => i.link);
  }
  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed) {
    const outlet = text(feed.title);
    return toArray(feed.entry as Record<string, unknown>[]).map((e) => ({
      title: text(e.title) ?? "(untitled)",
      link: atomLink(e.link) ?? "",
      summary: text(e.summary) ?? text(e.content),
      publishedAt: parseDate(e.updated) ?? parseDate(e.published),
      outlet,
    })).filter((i) => i.link);
  }
  return [];
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/news-ingest/feed-parser.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/news-ingest/feed-parser.ts server/src/services/news-ingest/feed-parser.test.ts server/package.json pnpm-lock.yaml
git commit -m "feat(news): RSS/Atom feed parser"
```

---

## Task 4: Event hashing

**Files:**
- Create: `server/src/services/news-ingest/event-hash.ts`
- Test: `server/src/services/news-ingest/event-hash.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/services/news-ingest/event-hash.test.ts
import { describe, it, expect } from "vitest";
import { canonicalEventHash, sourceUrlHash } from "./event-hash.js";

describe("event-hash", () => {
  it("sourceUrlHash normalizes tracking params + case", () => {
    const a = sourceUrlHash("https://Ex.com/a?utm_source=x&id=1");
    const b = sourceUrlHash("https://ex.com/a?id=1");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("canonicalEventHash is stable regardless of key order", () => {
    const h1 = canonicalEventHash({ title: "T", beat: "x", sourceUrl: "u", occurredAt: "2026-06-14" });
    const h2 = canonicalEventHash({ occurredAt: "2026-06-14", sourceUrl: "u", beat: "x", title: "T" });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/news-ingest/event-hash.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// server/src/services/news-ingest/event-hash.ts
import { createHash } from "node:crypto";

const TRACKING = /^(utm_|fbclid|gclid|ref$|ref_)/i;

export function sourceUrlHash(url: string): string {
  let normalized = url.trim().toLowerCase();
  try {
    const u = new URL(normalized);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hash = "";
    normalized = u.toString();
  } catch {
    /* fall back to raw lowercase string */
  }
  return createHash("sha256").update(normalized).digest("hex");
}

export function canonicalEventHash(core: Record<string, unknown>): string {
  const canonical = JSON.stringify(core, Object.keys(core).sort());
  return createHash("sha256").update(canonical).digest("hex");
}
```

- [ ] **Step 4: Run to verify it passes** → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/news-ingest/event-hash.ts server/src/services/news-ingest/event-hash.test.ts
git commit -m "feat(news): event + source-url hashing"
```

---

## Task 5: Extractor (heuristics + MiniMax)

**Files:**
- Create: `server/src/services/news-ingest/extractor.ts`
- Test: `server/src/services/news-ingest/extractor.test.ts`

- [ ] **Step 1: Write the failing test** (MiniMax client injected so we test without network)

```typescript
// server/src/services/news-ingest/extractor.test.ts
import { describe, it, expect } from "vitest";
import { extractEvent } from "./extractor.js";
import { BEATS } from "./feeds.js";

const beat = BEATS[0]; // armed-conflict
const item = { title: "Ceasefire signed in Country X", link: "https://ex.com/a",
  summary: "Both sides agreed to halt fighting.", publishedAt: new Date("2026-06-14"), outlet: "BBC" };

describe("extractEvent", () => {
  it("uses the MiniMax JSON when available", async () => {
    const fakeLlm = async () => JSON.stringify({
      entities: ["Country X"], geo: { country: "Country X" }, confidence: 0.9,
      inflection: { phase: "ceasefire", parties: ["A", "B"] },
    });
    const out = await extractEvent(item, beat, { llm: fakeLlm });
    expect(out.inflection.phase).toBe("ceasefire");
    expect(out.entities).toContain("Country X");
    expect(out.confidence).toBeCloseTo(0.9);
  });
  it("falls back to heuristics when the LLM throws", async () => {
    const fakeLlm = async () => { throw new Error("minimax down"); };
    const out = await extractEvent(item, beat, { llm: fakeLlm });
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(out.entities)).toBe(true);
  });
  it("falls back when the LLM returns non-JSON", async () => {
    const out = await extractEvent(item, beat, { llm: async () => "sorry, no json here" });
    expect(out.confidence).toBeLessThan(0.6);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// server/src/services/news-ingest/extractor.ts
import type { BeatConfig, ExtractedEvent, NewsItem } from "./types.js";

export type LlmFn = (system: string, user: string) => Promise<string>;

const BEAT_FIELDS: Record<string, string> = {
  "armed-conflict": "phase (outbreak|escalation|ceasefire|resolution), parties[], casualtyEstimate, territoryChange",
  science: "field, discoveryType (paper|breakthrough|replication|retraction), institution, doi",
  markets: "instrument, direction (up|down), magnitude, catalyst",
  macro: "instrument, direction (up|down), magnitude, catalyst",
  sports: "event, stage (final|record|upset), result",
};

function heuristic(item: NewsItem): ExtractedEvent {
  // Capitalized multi-word phrases as a rough entity guess.
  const text = `${item.title}. ${item.summary ?? ""}`;
  const entities = [...new Set((text.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})\b/g) ?? []))].slice(0, 8);
  return { entities, geo: {}, confidence: 0.4, inflection: { magnitude: null, noveltyScore: null } };
}

export async function extractEvent(
  item: NewsItem,
  beat: BeatConfig,
  deps: { llm: LlmFn },
): Promise<ExtractedEvent> {
  const fields = BEAT_FIELDS[beat.slug] ?? "magnitude, noveltyScore, relatedTo";
  const system =
    "You extract structured, research-grade metadata from a news headline+summary. " +
    "Return ONLY a JSON object, no prose.";
  const user =
    `Beat: ${beat.agentName}\nTitle: ${item.title}\nSummary: ${item.summary ?? ""}\n` +
    `Return JSON: {"entities":string[],"geo":{"country"?:string,"region"?:string},` +
    `"confidence":number(0..1),"inflection":{${fields}}}`;
  try {
    const raw = await deps.llm(system, user);
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return heuristic(item);
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities.slice(0, 12).map(String) : heuristic(item).entities,
      geo: parsed.geo && typeof parsed.geo === "object" ? parsed.geo : {},
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      inflection: parsed.inflection && typeof parsed.inflection === "object" ? parsed.inflection : {},
    };
  } catch {
    return heuristic(item);
  }
}

// Real MiniMax-backed LlmFn used by the orchestrator (not exercised in unit tests).
export function createMinimaxLlm(): LlmFn {
  return async (system, user) => {
    const key = process.env.MINIMAX_CN_API_KEY || process.env.MINIMAX_API_KEY;
    if (!key) throw new Error("MINIMAX_CN_API_KEY unset");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: key, baseURL: "https://api.minimaxi.com/anthropic" });
    const resp = await client.messages.create({
      model: process.env.MINIMAX_MODEL || "MiniMax-M2.7-highspeed",
      max_tokens: 512,
      system,
      messages: [{ role: "user", content: user }],
    });
    return resp.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n");
  };
}
```

- [ ] **Step 4: Run to verify it passes** → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/news-ingest/extractor.ts server/src/services/news-ingest/extractor.test.ts
git commit -m "feat(news): event extractor (MiniMax + heuristic fallback)"
```

---

## Task 6: Clockchain MCP client

**Files:**
- Create: `server/src/services/news-ingest/clockchain-client.ts`
- Test: `server/src/services/news-ingest/clockchain-client.test.ts`
- Modify: `server/package.json` (add `@modelcontextprotocol/sdk`)

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @paperclipai/server add @modelcontextprotocol/sdk`

- [ ] **Step 2: Write the failing test** (inject a fake low-level caller so no network)

```typescript
// server/src/services/news-ingest/clockchain-client.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeClockchainClient } from "./clockchain-client.js";

describe("clockchain client", () => {
  it("calls a tool and parses the JSON text result", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ ledgerId: "abc", blockHeight: "100" }) }],
    });
    const client = makeClockchainClient({ callTool });
    const out = await client.attest("attest_action", { action: "log", data: { a: 1 } });
    expect(callTool).toHaveBeenCalledWith({ name: "attest_action", arguments: { action: "log", data: { a: 1 } } });
    expect(out.ledgerId).toBe("abc");
    expect(out.blockHeight).toBe("100");
  });
  it("returns {} when result has no parseable text", async () => {
    const client = makeClockchainClient({ callTool: async () => ({ content: [] }) });
    expect(await client.attest("log_action", {})).toEqual({});
  });
});
```

- [ ] **Step 3: Run to verify it fails** → Expected: FAIL.

- [ ] **Step 4: Implement** (pure wrapper `makeClockchainClient` is unit-tested; `connectClockchain` does the real MCP handshake and is used only by the orchestrator)

```typescript
// server/src/services/news-ingest/clockchain-client.ts
interface LowLevelCaller {
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

export interface ClockchainClient {
  attest(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function parseToolResult(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const textBlock = result.content?.find((b) => b.type === "text" && typeof b.text === "string");
  if (!textBlock?.text) return {};
  try {
    const parsed = JSON.parse(textBlock.text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function makeClockchainClient(caller: LowLevelCaller): ClockchainClient {
  return {
    attest: async (tool, args) => parseToolResult(await caller.callTool({ name: tool, arguments: args })),
  };
}

// Real connection (Streamable HTTP MCP). Used by the orchestrator only.
export async function connectClockchain(): Promise<{ client: ClockchainClient; close: () => Promise<void> }> {
  const url = process.env.CLOCKCHAIN_MCP_URL || "https://mcp.clockchain.network/mcp";
  const token = process.env.CLOCKCHAIN_MCP_TOKEN;
  if (!token) throw new Error("CLOCKCHAIN_MCP_TOKEN unset");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { "x-api-key": token } },
  });
  const mcp = new Client({ name: "atlas-wire", version: "1.0.0" });
  await mcp.connect(transport);
  return {
    client: makeClockchainClient({ callTool: (req) => mcp.callTool(req) as never }),
    close: () => mcp.close(),
  };
}
```

- [ ] **Step 5: Run to verify it passes** → Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/news-ingest/clockchain-client.ts server/src/services/news-ingest/clockchain-client.test.ts server/package.json pnpm-lock.yaml
git commit -m "feat(news): Clockchain MCP client"
```

---

## Task 7: Writer (idempotent DB write + activity)

**Files:**
- Create: `server/src/services/news-ingest/writer.ts`
- Test: `server/src/services/news-ingest/writer.test.ts`

- [ ] **Step 1: Write the failing test** (db + logActivity injected)

```typescript
// server/src/services/news-ingest/writer.test.ts
import { describe, it, expect, vi } from "vitest";
import { recordEvent } from "./writer.js";

function fakeDb(insertedRows: unknown[]) {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => insertedRows,
        }),
      }),
    }),
  } as never;
}

describe("recordEvent", () => {
  const base = {
    companyId: "c1", agentId: "a1", beat: "armed-conflict", clockchainTool: "attest_action",
    item: { title: "T", link: "https://ex.com/a", summary: "s", publishedAt: new Date(), outlet: "BBC" },
    extracted: { entities: ["X"], geo: {}, confidence: 0.8, inflection: {} },
    receipt: { ledgerId: "l1", blockHeight: "5", clockchainTime: "t" },
  };
  it("logs activity authored by the agent when a row is inserted", async () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const res = await recordEvent(fakeDb([{ id: "e1" }]) , base, { logActivity: log });
    expect(res.inserted).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    const arg = log.mock.calls[0][1];
    expect(arg.actorType).toBe("agent");
    expect(arg.actorId).toBe("a1");
    expect(arg.agentId).toBe("a1");
    expect(arg.action).toBe("news.event.logged");
    expect(arg.entityType).toBe("news_event");
  });
  it("does not log activity on duplicate (no row returned)", async () => {
    const log = vi.fn();
    const res = await recordEvent(fakeDb([]), base, { logActivity: log });
    expect(res.inserted).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails** → Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// server/src/services/news-ingest/writer.ts
import type { Db } from "@paperclipai/db";
import { newsEvents } from "@paperclipai/db";
import { logActivity as realLogActivity } from "../activity-log.js";
import { canonicalEventHash, sourceUrlHash } from "./event-hash.js";
import type { ExtractedEvent, NewsItem } from "./types.js";

export interface RecordEventInput {
  companyId: string;
  agentId: string;
  beat: string;
  clockchainTool: string;
  item: NewsItem;
  extracted: ExtractedEvent;
  receipt: { ledgerId?: string; blockHeight?: string; clockchainTime?: string } & Record<string, unknown>;
}

export async function recordEvent(
  db: Db,
  input: RecordEventInput,
  deps: { logActivity?: typeof realLogActivity } = {},
): Promise<{ inserted: boolean; id?: string }> {
  const log = deps.logActivity ?? realLogActivity;
  const urlHash = sourceUrlHash(input.item.link);
  const eventHash = canonicalEventHash({
    title: input.item.title, beat: input.beat, sourceUrl: input.item.link,
    occurredAt: input.item.publishedAt?.toISOString() ?? "",
  });
  const rows = await db
    .insert(newsEvents)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      beat: input.beat,
      title: input.item.title,
      summary: input.item.summary,
      sourceUrl: input.item.link,
      sourceUrlHash: urlHash,
      sourceOutlet: input.item.outlet,
      occurredAt: input.item.publishedAt,
      clockchainTime: input.receipt.clockchainTime ?? null,
      eventHash,
      ledgerId: input.receipt.ledgerId ?? null,
      blockHeight: input.receipt.blockHeight ?? null,
      clockchainTool: input.clockchainTool,
      entities: input.extracted.entities,
      geo: input.extracted.geo,
      confidence: input.extracted.confidence,
      inflection: input.extracted.inflection,
      receipt: input.receipt,
    })
    .onConflictDoNothing({ target: [newsEvents.companyId, newsEvents.sourceUrlHash] })
    .returning({ id: newsEvents.id });

  const row = rows[0];
  if (!row) return { inserted: false };

  await log(db, {
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.agentId,
    agentId: input.agentId,
    action: "news.event.logged",
    entityType: "news_event",
    entityId: row.id,
    details: {
      beat: input.beat,
      title: input.item.title,
      sourceUrl: input.item.link,
      outlet: input.item.outlet,
      ledgerId: input.receipt.ledgerId ?? null,
      blockHeight: input.receipt.blockHeight ?? null,
    },
  });
  return { inserted: true, id: row.id };
}
```

- [ ] **Step 4: Run to verify it passes** → Expected: PASS. (If `logActivity`'s `LogActivityInput` type rejects any field, align the object to it — read `server/src/services/activity-log.ts:1-65`.)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/news-ingest/writer.ts server/src/services/news-ingest/writer.test.ts
git commit -m "feat(news): idempotent event writer + agent-authored activity"
```

---

## Task 8: Safety guard

**Files:**
- Create: `server/src/services/news-ingest/guard.ts`
- Test: `server/src/services/news-ingest/guard.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/services/news-ingest/guard.test.ts
import { describe, it, expect } from "vitest";
import { assertNoActiveNewsAgents } from "./guard.js";

function dbReturning(rows: { id: string; status: string }[]) {
  return { select: () => ({ from: () => ({ where: async () => rows }) }) } as never;
}

describe("assertNoActiveNewsAgents", () => {
  it("passes when all agents are paused", async () => {
    await expect(assertNoActiveNewsAgents(dbReturning([{ id: "a", status: "paused" }]), "c1")).resolves.toBeUndefined();
  });
  it("throws when any agent is not paused", async () => {
    await expect(assertNoActiveNewsAgents(dbReturning([{ id: "a", status: "active" }]), "c1"))
      .rejects.toThrow(/active/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// server/src/services/news-ingest/guard.ts
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";

// Mini safety: the ingest pipeline must never run while a news agent is in a
// heartbeat-spawnable state. Paused agents are skipped by the heartbeat
// (heartbeat.ts:3978 et al). Anything else risks the EPIPE crash-loop.
export async function assertNoActiveNewsAgents(db: Db, companyId: string): Promise<void> {
  const rows = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const offenders = rows.filter((r) => r.status !== "paused" && r.status !== "terminated");
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to ingest: ${offenders.length} Atlas Wire agent(s) not paused ` +
        `(${offenders.map((o) => `${o.id}:${o.status}`).join(", ")}). Pause them first.`,
    );
  }
}
```

- [ ] **Step 4: Run to verify it passes** → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/news-ingest/guard.ts server/src/services/news-ingest/guard.test.ts
git commit -m "feat(news): active-agent safety guard"
```

---

## Task 9: Orchestrator (`ingestBeat` + `runCycle`)

**Files:**
- Create: `server/src/services/news-ingest/ingest.ts`
- Test: `server/src/services/news-ingest/ingest.test.ts`

- [ ] **Step 1: Write the failing test** (all I/O injected)

```typescript
// server/src/services/news-ingest/ingest.test.ts
import { describe, it, expect, vi } from "vitest";
import { ingestBeat } from "./ingest.js";
import { BEATS } from "./feeds.js";

const beat = BEATS[0];

describe("ingestBeat", () => {
  it("fetches, extracts, attests, records — capped at maxPerBeat", async () => {
    const deps = {
      fetchText: vi.fn().mockResolvedValue("<rss><channel><title>BBC</title>" +
        "<item><title>A</title><link>https://ex.com/a</link></item>" +
        "<item><title>B</title><link>https://ex.com/b</link></item></channel></rss>"),
      extract: vi.fn().mockResolvedValue({ entities: [], geo: {}, confidence: 0.5, inflection: {} }),
      attest: vi.fn().mockResolvedValue({ ledgerId: "l", blockHeight: "1", clockchainTime: "t" }),
      record: vi.fn().mockResolvedValue({ inserted: true }),
    };
    const res = await ingestBeat(beat, { companyId: "c1", agentId: "a1", maxPerBeat: 1, ...deps });
    expect(res.fetched).toBe(2);
    expect(res.newEvents).toBe(1);            // capped
    expect(deps.attest).toHaveBeenCalledOnce();
  });
  it("isolates a feed failure and continues", async () => {
    const deps = {
      fetchText: vi.fn().mockRejectedValue(new Error("dns")),
      extract: vi.fn(), attest: vi.fn(), record: vi.fn(),
    };
    const res = await ingestBeat(beat, { companyId: "c1", agentId: "a1", maxPerBeat: 5, ...deps });
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.newEvents).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// server/src/services/news-ingest/ingest.ts
import type { BeatConfig, ExtractedEvent, IngestResult, NewsItem } from "./types.js";
import { parseFeed } from "./feed-parser.js";

export interface IngestBeatDeps {
  companyId: string;
  agentId: string;
  maxPerBeat: number;
  fetchText: (url: string) => Promise<string>;
  extract: (item: NewsItem, beat: BeatConfig) => Promise<ExtractedEvent>;
  attest: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  record: (item: NewsItem, extracted: ExtractedEvent, receipt: Record<string, unknown>) => Promise<{ inserted: boolean }>;
}

export async function ingestBeat(beat: BeatConfig, deps: IngestBeatDeps): Promise<IngestResult> {
  const result: IngestResult = { beat: beat.slug, fetched: 0, newEvents: 0, skippedDuplicates: 0, errors: [] };
  const items: NewsItem[] = [];
  for (const feed of beat.feeds) {
    try {
      items.push(...parseFeed(await deps.fetchText(feed)));
    } catch (err) {
      result.errors.push(`${feed}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  result.fetched = items.length;
  for (const item of items) {
    if (result.newEvents >= deps.maxPerBeat) break;
    try {
      const extracted = await deps.extract(item, beat);
      const receipt = await deps.attest(beat.clockchainTool, {
        action: "news.event",
        beat: beat.slug,
        title: item.title,
        sourceUrl: item.link,
        occurredAt: item.publishedAt?.toISOString() ?? null,
      });
      const { inserted } = await deps.record(item, extracted, receipt);
      if (inserted) result.newEvents += 1;
      else result.skippedDuplicates += 1;
    } catch (err) {
      result.errors.push(`${item.link}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run to verify it passes** → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/news-ingest/ingest.ts server/src/services/news-ingest/ingest.test.ts
git commit -m "feat(news): per-beat ingest orchestrator (caps + failure isolation)"
```

---

## Task 10: Cron entrypoint script

**Files:**
- Create: `server/src/services/news-ingest/runtime.ts` (wires real deps: fetch, MiniMax, Clockchain, writer, guard, agent lookup)
- Create: `scripts/news-ingest/run-cycle.ts`
- Modify: `package.json` (root) — add `"news:ingest"` script

- [ ] **Step 1: Implement `runtime.ts`** (composition root — no unit test; exercised by the live smoke in Task 13)

```typescript
// server/src/services/news-ingest/runtime.ts
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { BEATS } from "./feeds.js";
import { ingestBeat } from "./ingest.js";
import { assertNoActiveNewsAgents } from "./guard.js";
import { connectClockchain } from "./clockchain-client.js";
import { createMinimaxLlm, extractEvent } from "./extractor.js";
import { recordEvent } from "./writer.js";
import type { IngestResult } from "./types.js";

export interface RunCycleOptions {
  companyId: string;
  dryRun?: boolean;
  onlyBeat?: string;
  maxPerBeat?: number;          // default ~17 → ~300/day across 18 beats
  pacingMs?: number;            // delay between Clockchain writes (rate-limit)
}

export async function runCycle(db: Db, opts: RunCycleOptions): Promise<IngestResult[]> {
  await assertNoActiveNewsAgents(db, opts.companyId);
  const maxPerBeat = opts.maxPerBeat ?? 17;
  const pacingMs = opts.pacingMs ?? 250;
  const beats = opts.onlyBeat ? BEATS.filter((b) => b.slug === opts.onlyBeat) : BEATS;

  const agentRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.companyId, opts.companyId));
  const agentByName = new Map(agentRows.map((a) => [a.name, a.id]));

  const llm = createMinimaxLlm();
  const cc = opts.dryRun ? null : await connectClockchain();
  const fetchText = async (url: string) => {
    const r = await fetch(url, { headers: { "user-agent": "AtlasWire/1.0 (+clockchain)" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  };
  let lastWrite = 0;
  const pace = async () => {
    const wait = pacingMs - (Date.now() - lastWrite);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastWrite = Date.now();
  };

  const results: IngestResult[] = [];
  try {
    for (const beat of beats) {
      const agentId = agentByName.get(beat.agentName);
      if (!agentId) { results.push({ beat: beat.slug, fetched: 0, newEvents: 0, skippedDuplicates: 0, errors: ["agent not provisioned"] }); continue; }
      results.push(await ingestBeat(beat, {
        companyId: opts.companyId,
        agentId,
        maxPerBeat,
        fetchText,
        extract: (item, b) => extractEvent(item, b, { llm }),
        attest: async (tool, args) => {
          if (opts.dryRun || !cc) return { dryRun: true };
          await pace();
          return cc.client.attest(tool, args);
        },
        record: async (item, extracted, receipt) => {
          if (opts.dryRun) return { inserted: true };
          return recordEvent(db, { companyId: opts.companyId, agentId, beat: beat.slug, clockchainTool: beat.clockchainTool, item, extracted, receipt });
        },
      }));
    }
  } finally {
    await cc?.close();
  }
  return results;
}
```

- [ ] **Step 2: Implement the script** (mirrors `scripts/backfill-issue-reference-mentions.ts`)

```typescript
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
```

- [ ] **Step 3: Add root package.json script** — under `"scripts"`:

```json
"news:ingest": "tsx scripts/news-ingest/run-cycle.ts",
```

- [ ] **Step 4: Verify it compiles + dry-run help path**

Run: `pnpm -r typecheck`
Expected: PASS. (No live run yet — that's Task 13.)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/news-ingest/runtime.ts scripts/news-ingest/run-cycle.ts package.json
git commit -m "feat(news): runtime composition + cron entrypoint"
```

---

## Task 11: Provisioning script (company + 19 paused agents + goals)

**Files:**
- Create: `scripts/news-ingest/provision-atlas-wire.ts`
- Modify: `package.json` (root) — add `"news:provision"`

Provisioning is run-once and idempotent; it writes directly via the service/DB layer. No unit test — it is `--dry-run`-checkable and re-runnable.

- [ ] **Step 1: Implement** (uses `companyService`/`agentService` where available; falls back to direct inserts for fields the services don't expose — read `server/src/services/companies.ts` and `agents.ts` create signatures first, then adapt)

```typescript
// scripts/news-ingest/provision-atlas-wire.ts
import { createDb, companies, agents, goals } from "../../packages/db/src/index.js";
import { and, eq } from "drizzle-orm";
import { loadConfig } from "../../server/src/config.js";
import { BEATS, COS_AGENT_NAME, COS_CLOCKCHAIN_TOOL } from "../../server/src/services/news-ingest/feeds.js";

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
  const companyId = company?.id ?? "(dry-run)";
  console.log(`company: ${companyId}`);

  // 2. CoS (Atlas) — paused. reportsTo = null.
  async function upsertAgent(input: { name: string; title: string; tool: string; reportsTo: string | null }) {
    const existing = (await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, input.name))))[0];
    if (existing) return existing.id;
    if (dryRun) { console.log(`[dry] would create agent ${input.name} (paused)`); return "(dry)"; }
    const row = (await db.insert(agents).values({
      companyId,
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
    const existing = (await db.select().from(goals).where(and(eq(goals.companyId, companyId), eq(goals.title, input.title))))[0];
    if (existing) return existing.id;
    if (dryRun) { console.log(`[dry] would create goal ${input.title}`); return "(dry)"; }
    return (await db.insert(goals).values({ companyId, title: input.title, level: input.level, status: "active", parentId: input.parentId, ownerAgentId: input.ownerAgentId }).returning())[0].id;
  }

  const visionId = await upsertGoal({ title: "A verifiable public ledger of significant world events", level: "company", parentId: null, ownerAgentId: atlasId });

  for (const beat of BEATS) {
    const agentId = await upsertAgent({ name: beat.agentName, title: `${beat.agentName} desk`, tool: beat.clockchainTool, reportsTo: atlasId });
    await upsertGoal({ title: `${beat.agentName}: log every inflection point with a court-grade receipt`, level: "team", parentId: visionId, ownerAgentId: agentId });
  }
  console.log(dryRun ? "dry-run complete" : "provisioned Atlas Wire (19 paused agents + goal tree)");
}

void main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add root package.json script**

```json
"news:provision": "tsx scripts/news-ingest/provision-atlas-wire.ts",
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS. (If `companies`/`agents` insert requires extra non-null fields, the typecheck will flag them — add the minimal required values; do not invent optional config.)

- [ ] **Step 4: Commit**

```bash
git add scripts/news-ingest/provision-atlas-wire.ts package.json
git commit -m "feat(news): Atlas Wire provisioning script (paused agents + goals)"
```

---

## Task 12: Daily digest

**Files:**
- Create: `server/src/services/news-ingest/digest.ts`
- Test: `server/src/services/news-ingest/digest.test.ts`
- Create: `scripts/news-ingest/run-digest.ts`; Modify root `package.json` (`"news:digest"`)

- [ ] **Step 1: Write the failing test** (db query + issue creation injected)

```typescript
// server/src/services/news-ingest/digest.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildDigests } from "./digest.js";

describe("buildDigests", () => {
  it("makes one digest per agent that logged events, plus an Atlas summary", () => {
    const rows = [
      { agentId: "a1", agentName: "Armed Conflict & War", title: "X", beat: "armed-conflict" },
      { agentId: "a1", agentName: "Armed Conflict & War", title: "Y", beat: "armed-conflict" },
      { agentId: "a2", agentName: "Science & Research", title: "Z", beat: "science" },
    ];
    const digests = buildDigests(rows, { atlasAgentId: "atlas", atlasName: "Atlas" });
    expect(digests.find((d) => d.agentId === "a1")?.count).toBe(2);
    expect(digests.find((d) => d.agentId === "a2")?.count).toBe(1);
    const atlas = digests.find((d) => d.agentId === "atlas");
    expect(atlas?.count).toBe(3);
    expect(atlas?.title).toMatch(/wire digest/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → Expected: FAIL.

- [ ] **Step 3: Implement** (pure builder is unit-tested; the writer wrapper that turns digests into `issueService.create({status:"done", assigneeAgentId, createdByAgentId, goalId})` calls lives below it and is exercised in the live smoke)

```typescript
// server/src/services/news-ingest/digest.ts
export interface DigestRow { agentId: string; agentName: string; title: string; beat: string; }
export interface Digest { agentId: string; agentName: string; title: string; body: string; count: number; }

export function buildDigests(rows: DigestRow[], cos: { atlasAgentId: string; atlasName: string }): Digest[] {
  const byAgent = new Map<string, DigestRow[]>();
  for (const r of rows) {
    const list = byAgent.get(r.agentId) ?? [];
    list.push(r);
    byAgent.set(r.agentId, list);
  }
  const digests: Digest[] = [];
  for (const [agentId, list] of byAgent) {
    digests.push({
      agentId,
      agentName: list[0].agentName,
      title: `${list[0].agentName} — daily desk digest (${list.length} events)`,
      body: list.map((r) => `- ${r.title}`).join("\n"),
      count: list.length,
    });
  }
  digests.push({
    agentId: cos.atlasAgentId,
    agentName: cos.atlasName,
    title: `Atlas Wire — daily wire digest (${rows.length} events)`,
    body: digests.map((d) => `- ${d.agentName}: ${d.count}`).join("\n"),
    count: rows.length,
  });
  return digests;
}
```

The script `scripts/news-ingest/run-digest.ts`: query today's `news_events` for the company → `buildDigests` → for each digest call `issueService(db).create(companyId, { title, description: body, status: "done", assigneeAgentId: agentId, createdByAgentId: agentId, priority: "low" })`. (Read `issueService.create` signature in `server/src/services/issues.ts` to confirm it accepts `createdByAgentId`; if not, direct-insert into `issues` with `completedAt: new Date()`.)

- [ ] **Step 4: Run to verify it passes** → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/news-ingest/digest.ts server/src/services/news-ingest/digest.test.ts scripts/news-ingest/run-digest.ts package.json
git commit -m "feat(news): daily desk + wire digests"
```

---

## Task 13: Full gate, mini dry-run, live smoke, schedule

**Files:**
- Create: `deploy/launchd/com.agentdash.atlaswire.ingest.plist`
- Create: `deploy/launchd/com.agentdash.atlaswire.digest.plist`

This task runs on the **Mac mini** (never localhost with claude_local). Env required on the mini: `MINIMAX_CN_API_KEY`, `CLOCKCHAIN_MCP_TOKEN`, `DATABASE_URL` (or embedded PG defaults).

- [ ] **Step 1: Full regression gate (local or mini)**

Run: `pnpm -r typecheck && pnpm test:run && pnpm build`
Expected: typecheck PASS; all tests pass (report count, flag any flake); build PASS.

- [ ] **Step 2: Provision (dry-run, then real) on the mini**

Run: `pnpm news:provision -- --dry-run` → review output.
Then: `pnpm news:provision` → confirm in the AgentDash UI that "Atlas Wire" exists with Atlas + 18 paused beat agents and the goal tree. Verify every agent shows **paused**.

- [ ] **Step 3: Ingest dry-run (no Clockchain/DB writes)**

Run: `pnpm news:ingest -- --dry-run --beat armed-conflict --max 3`
Expected: JSON shows `fetched > 0`, no errors connecting to feeds.

- [ ] **Step 4: Single-beat live smoke (real Clockchain + DB)**

Run: `pnpm news:ingest -- --beat armed-conflict --max 3`
Expected: `total: 3` (or fewer if dups), each `news_events` row has a real `ledgerId`/`blockHeight`. Verify in the UI: 3 activity-feed entries authored by the Armed Conflict agent. **This is where we learn the testnet's real throughput** — if writes are rate-limited/rejected, lower `maxPerBeat`/raise `pacingMs` before scaling.

- [ ] **Step 5: Full cycle once**

Run: `pnpm news:ingest -- --max 17`
Expected: ~250–300 new events across 18 beats; note wall-clock + any feed errors; adjust `feeds.ts` for any dead feeds.

- [ ] **Step 6: Add launchd timers** (cadence ≈ every 30 min, `--max 1` ≈ trickle to ~300/day across beats; tune after Step 5). Plist runs the root `news:ingest`/`news:digest` scripts with the mini's env. Load with `launchctl load`. Daily digest fires once near end of day.

- [ ] **Step 7: Update memory + commit**

Update `project_meridian_clockchain_demo` memory (or a new `project_atlas_wire_newsroom` memory) with: company id, provisioning/ingest/digest commands, the safety invariant (agents stay paused; pipeline writes in-process), and the tuned cadence/throughput numbers.

```bash
git add deploy/launchd/com.agentdash.atlaswire.*.plist
git commit -m "feat(news): launchd timers for Atlas Wire ingest + digest"
```

---

## Self-review (against the spec)

- **Spec §3 architecture (cron, not heartbeat; in-process):** Tasks 9–11, 13. ✓ (refinement: in-process writes instead of x-agent-key HTTP — noted in plan header.)
- **Spec §4.1 company + 19 paused agents + tools:** Task 11. ✓
- **Spec §4.2 CoS-led goal tree:** Task 11. ✓
- **Spec §4.3 event schema (core + beat inflection) + core-hash attested:** Tasks 1, 4, 5, 7. ✓ (refinement: per-event = `news_events` row + activity entry; issues = daily digests, not per-event — noted in plan header to avoid issue-board bloat at 300/day; Task 12.)
- **Spec §4.4 RSS-first feed config:** Task 2. ✓
- **Spec §4.5 launchd scheduling:** Task 13. ✓
- **Spec §5 safety rails (active-agent guard, rate-limit, idempotency, feed isolation, caps):** Tasks 7 (idempotent), 8 (guard), 9 (caps + isolation), 10 (pacing). ✓
- **Spec §6 backfill:** the cron entrypoint is idempotent; running it repeatedly over available feed history is the backfill (RSS exposes limited history). A deeper historical backfill (archive APIs) is deferred — **logged here as a known limitation**, consistent with spec phase 5.
- **Spec §7 testing (typecheck/test/build, unit tests, dry-run, live smoke):** Tasks 3–9, 12 (unit), 10/13 (dry-run + smoke). ✓
- **Constraint: no claude_local; MiniMax only:** Task 5 uses MiniMax endpoint; Task 13 runs on the mini. ✓

**Known limitations (called out, not silently dropped):**
- Article full-text scraping (spec phase 4) is out of scope for this plan.
- Deep historical backfill beyond what RSS feeds expose is deferred.
- Feed URLs in `feeds.ts` are best-effort; Step 5 of Task 13 prunes any that 404.
