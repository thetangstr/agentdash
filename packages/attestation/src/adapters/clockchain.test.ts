import { describe, it, expect, vi } from "vitest";
import { createClockchainAdapter } from "./clockchain.js";

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(typeof input === "string" ? input : input.toString(), init ?? {}),
  ) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createClockchainAdapter", () => {
  it("rejects an empty apiKey", () => {
    expect(() => createClockchainAdapter({ apiKey: "" })).toThrow(/apiKey/);
    expect(() => createClockchainAdapter({ apiKey: "  " })).toThrow(/apiKey/);
  });

  it("getVerifiedTime returns the response's latestBlockTime + height", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("https://node.clockchain.network/api/time/time");
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
      return json({
        success: true,
        data: { latestBlockTime: "2026-05-13T12:00:00.123Z", latestBlockHeight: "777" },
      });
    });
    const adapter = createClockchainAdapter({ apiKey: "k", fetch: fetchImpl });
    const result = await adapter.getVerifiedTime();
    expect(result.time).toBe("2026-05-13T12:00:00.123Z");
    expect(result.blockHeight).toBe("777");
  });

  it("anchorBatch POSTs to /log with the manifest hash + metadata", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("https://node.clockchain.network/log");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.clientId).toBe("co-1");
      expect(body.assetHash).toBe("deadbeef");
      expect(body.metadata.batchActivityCount).toBe(3);
      return json({
        success: true,
        data: { logId: "log-abc", blockHeight: "1234", timestamp: "2026-05-13T12:00:00Z" },
      });
    });
    const adapter = createClockchainAdapter({ apiKey: "k", fetch: fetchImpl });
    const result = await adapter.anchorBatch("deadbeef", {
      companyId: "co-1",
      manifestSha256: "deadbeef",
      batchStartActivityId: "a1",
      batchEndActivityId: "a3",
      batchActivityCount: 3,
      prevAnchorId: null,
    });
    expect(result.externalLogId).toBe("log-abc");
    expect(result.externalBlockHeight).toBe("1234");
  });

  it("anchorBatch falls back to txHash or block: prefix when logId missing", async () => {
    const fetchImpl = fakeFetch(() =>
      json({ success: true, data: { txHash: "tx-xyz", blockHeight: "42" } }),
    );
    const adapter = createClockchainAdapter({ apiKey: "k", fetch: fetchImpl });
    const result = await adapter.anchorBatch("deadbeef", {
      companyId: "co-1",
      manifestSha256: "deadbeef",
      batchStartActivityId: "a",
      batchEndActivityId: "b",
      batchActivityCount: 1,
      prevAnchorId: null,
    });
    expect(result.externalLogId).toBe("tx-xyz");
  });

  it("anchorBatch surfaces HTTP errors with a helpful message", async () => {
    const fetchImpl = fakeFetch(() => new Response("rate limited", { status: 429 }));
    const adapter = createClockchainAdapter({ apiKey: "k", fetch: fetchImpl });
    await expect(
      adapter.anchorBatch("hash", {
        companyId: "co",
        manifestSha256: "hash",
        batchStartActivityId: "x",
        batchEndActivityId: "y",
        batchActivityCount: 1,
        prevAnchorId: null,
      }),
    ).rejects.toThrow(/429/);
  });

  it("verifyAnchor returns ok=false when search response missing", async () => {
    const fetchImpl = fakeFetch(() => json({ success: true }));
    const adapter = createClockchainAdapter({ apiKey: "k", fetch: fetchImpl });
    const result = await adapter.verifyAnchor("log-1", "hash-1");
    expect(result.ok).toBe(false);
  });

  it("verifyAnchor returns ok=true when assetHash matches", async () => {
    const fetchImpl = fakeFetch(() =>
      json({ success: true, data: { assetHash: "hash-1", logId: "log-1" } }),
    );
    const adapter = createClockchainAdapter({ apiKey: "k", fetch: fetchImpl });
    const result = await adapter.verifyAnchor("log-1", "hash-1");
    expect(result.ok).toBe(true);
  });

  it("verifyAnchor returns ok=false on hash mismatch", async () => {
    const fetchImpl = fakeFetch(() =>
      json({ success: true, data: { assetHash: "OTHER", logId: "log-1" } }),
    );
    const adapter = createClockchainAdapter({ apiKey: "k", fetch: fetchImpl });
    const result = await adapter.verifyAnchor("log-1", "hash-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("asset_hash_mismatch");
  });

  it("normalizes base URL with or without trailing slash", async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe("https://example.test/api/time/time");
      return json({ data: { latestBlockTime: "2026-01-01T00:00:00Z" } });
    });
    const adapter = createClockchainAdapter({
      apiKey: "k",
      apiBase: "https://example.test/",
      fetch: fetchImpl,
    });
    await adapter.getVerifiedTime();
  });
});
