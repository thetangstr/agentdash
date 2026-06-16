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
