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
