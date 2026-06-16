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
  // Deduplicate by link within a single cycle (cross-cycle dedup is done by the DB unique index).
  const seen = new Set<string>();
  const deduped = items.filter((i) => {
    if (seen.has(i.link)) return false;
    seen.add(i.link);
    return true;
  });
  result.fetched = deduped.length;
  for (const item of deduped) {
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
