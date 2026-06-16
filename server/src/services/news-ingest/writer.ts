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
    .onConflictDoNothing()
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
