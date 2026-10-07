import { describe, expect, it } from "vitest";
import type { RunLogChunk } from "../adapters/transcript";
import type { TranscriptEntry } from "../adapters";
import { appendRunLogLines, transcriptEntryIndexForSeq } from "./runLogSeq";

const parser = (line: string, ts: string): TranscriptEntry[] => [{ kind: "stdout", ts, text: line }];

const chunks: RunLogChunk[] = [
  { ts: "t1", stream: "stdout", chunk: "a\nb\n", seq: 1 },
  { ts: "t2", stream: "stderr", chunk: "warn", seq: 2 },
  { ts: "t3", stream: "stdout", chunk: "c\n", seq: 4 },
  { ts: "t4", stream: "stdout", chunk: "d\n", seq: 5 },
];

describe("transcriptEntryIndexForSeq", () => {
  it("finds the first Raw entry of the row with that seq", () => {
    expect(transcriptEntryIndexForSeq(chunks, 1, parser)).toEqual({ found: true, entryIndex: 0, exact: true });
    expect(transcriptEntryIndexForSeq(chunks, 2, parser)).toEqual({ found: true, entryIndex: 2, exact: true });
    expect(transcriptEntryIndexForSeq(chunks, 5, parser)).toEqual({ found: true, entryIndex: 4, exact: true });
  });

  it("falls back to the nearest earlier row when the exact row is missing", () => {
    expect(transcriptEntryIndexForSeq(chunks, 3, parser)).toEqual({ found: true, entryIndex: 2, exact: false });
  });

  it("reports rows that are not loaded yet, and logs without seq", () => {
    expect(transcriptEntryIndexForSeq(chunks, 99, parser)).toEqual({ found: false, reason: "not-loaded" });
    // Nothing loaded yet (the log is still loading) is not "no line numbers".
    expect(transcriptEntryIndexForSeq([], 1, parser)).toEqual({ found: false, reason: "not-loaded" });
    expect(
      transcriptEntryIndexForSeq(chunks.map(({ seq: _seq, ...rest }) => rest), 1, parser),
    ).toEqual({ found: false, reason: "no-seq" });
  });
});

describe("appendRunLogLines", () => {
  it("keeps seq order when a live row arrived before the fetched rows", () => {
    const live = [{ seq: 5, chunk: "e" }];
    const fetched = [1, 2, 3, 4].map((seq) => ({ seq, chunk: String(seq) }));
    expect(appendRunLogLines(live, fetched).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("leaves rows without seq in arrival order", () => {
    const rows = appendRunLogLines<{ chunk: string; seq?: number }>([{ chunk: "b" }], [{ chunk: "a" }]);
    expect(rows.map((row) => row.chunk)).toEqual(["b", "a"]);
  });
});
