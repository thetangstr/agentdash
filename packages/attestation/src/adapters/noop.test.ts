import { describe, it, expect } from "vitest";
import { createNoopAdapter } from "./noop.js";

describe("createNoopAdapter", () => {
  it("returns a deterministic externalLogId derived from the payload hash", async () => {
    const adapter = createNoopAdapter();
    const a = await adapter.anchorBatch("hash-1", {
      companyId: "co",
      manifestSha256: "hash-1",
      batchStartActivityId: "a",
      batchEndActivityId: "b",
      batchActivityCount: 1,
      prevAnchorId: null,
    });
    const b = await adapter.anchorBatch("hash-1", {
      companyId: "co",
      manifestSha256: "hash-1",
      batchStartActivityId: "a",
      batchEndActivityId: "b",
      batchActivityCount: 1,
      prevAnchorId: null,
    });
    expect(a.externalLogId).toBe(b.externalLogId);
    expect(a.externalLogId.startsWith("noop:")).toBe(true);
  });

  it("verifyAnchor round-trips a payload it anchored", async () => {
    const adapter = createNoopAdapter();
    const result = await adapter.anchorBatch("payload-x", {
      companyId: "co",
      manifestSha256: "payload-x",
      batchStartActivityId: "a",
      batchEndActivityId: "b",
      batchActivityCount: 1,
      prevAnchorId: null,
    });
    const verified = await adapter.verifyAnchor(result.externalLogId, "payload-x");
    expect(verified.ok).toBe(true);
  });

  it("verifyAnchor rejects a payload it did not anchor", async () => {
    const adapter = createNoopAdapter();
    const verified = await adapter.verifyAnchor("noop:zzz", "payload-y");
    expect(verified.ok).toBe(false);
  });
});
