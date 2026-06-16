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
    return resp.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("\n");
  };
}
