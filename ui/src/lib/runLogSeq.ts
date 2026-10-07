// AgentDash: map a heartbeat-run log row `seq` (the `source.ref = "seq=<n>"`
// of a milestone-timeline event) to the Raw transcript entry that row became.
import { buildTranscript, type RunLogChunk } from "../adapters/transcript";
import type { StdoutLineParser, TranscriptParserSource } from "../adapters/types";

export type SeqLookup =
  | { found: true; entryIndex: number; exact: boolean }
  | { found: false; reason: "no-seq" | "not-loaded" };

/**
 * Index of the first Raw entry produced by the log row with this `seq`.
 * Rows are replayed through the same parser up to that row, so the index
 * matches what the Raw view renders. When the exact row is missing (older
 * logs without `seq`, or a row merged into a neighbour) the nearest earlier
 * row is used; when the row is past what has been loaded, nothing is found.
 */
export function transcriptEntryIndexForSeq(
  chunks: readonly RunLogChunk[],
  seq: number,
  parser: StdoutLineParser | TranscriptParserSource,
  opts?: { censorUsernameInLogs?: boolean },
): SeqLookup {
  if (chunks.length === 0) return { found: false, reason: "not-loaded" };
  let rowIndex = -1;
  let exact = false;
  let anySeq = false;
  let beyond = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const value = chunks[i]!.seq;
    if (typeof value !== "number") continue;
    anySeq = true;
    if (value === seq) {
      rowIndex = i;
      exact = true;
      break;
    }
    if (value < seq) rowIndex = i;
    else {
      beyond = true;
      break;
    }
  }
  if (!anySeq) return { found: false, reason: "no-seq" };
  if (rowIndex < 0 || (!exact && !beyond)) return { found: false, reason: "not-loaded" };
  const before = buildTranscript(chunks.slice(0, rowIndex) as RunLogChunk[], parser, opts).length;
  const total = buildTranscript(chunks as RunLogChunk[], parser, opts).length;
  if (total === 0) return { found: false, reason: "not-loaded" };
  return { found: true, entryIndex: Math.min(before, total - 1), exact };
}

/**
 * Append run-log rows, keeping `seq` order when every row has one. The
 * WebSocket can deliver a row before the initial fetch returns the rows
 * before it; without this the late rows landed after the live one.
 */
export function appendRunLogLines<T extends { seq?: number }>(previous: readonly T[], incoming: readonly T[]): T[] {
  if (incoming.length === 0) return previous as T[];
  const merged = [...previous, ...incoming];
  let sorted = true;
  for (let i = 0; i < merged.length; i += 1) {
    const value = merged[i]!.seq;
    if (typeof value !== "number") return merged;
    if (i > 0 && value < (merged[i - 1]!.seq as number)) sorted = false;
  }
  return sorted ? merged : merged.sort((a, b) => (a.seq as number) - (b.seq as number));
}
