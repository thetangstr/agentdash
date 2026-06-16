// server/src/services/news-ingest/runtime.ts
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
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
