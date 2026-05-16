import { describe, it, expect } from "vitest";
import { buildManifest, canonicalize, hashDetails, sha256Hex } from "./manifest.js";
import type { ActivityEntryInput } from "./types.js";

const FIXED_DATE = new Date("2026-05-13T12:00:00.000Z");

function entry(overrides: Partial<ActivityEntryInput> = {}): ActivityEntryInput {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    createdAt: FIXED_DATE,
    action: "issue_created",
    entityType: "issue",
    entityId: "22222222-2222-2222-2222-222222222222",
    actorType: "user",
    actorId: "user-1",
    details: { title: "Hello" },
    ...overrides,
  };
}

describe("canonicalize", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles primitives and null", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(7)).toBe("7");
    expect(canonicalize("a")).toBe('"a"');
    expect(canonicalize(false)).toBe("false");
  });
});

describe("hashDetails", () => {
  it("is stable across key reorderings", () => {
    expect(hashDetails({ a: 1, b: 2 })).toBe(hashDetails({ b: 2, a: 1 }));
  });

  it("treats null/undefined as the null hash", () => {
    expect(hashDetails(null)).toBe(sha256Hex("null"));
  });
});

describe("buildManifest", () => {
  it("produces a stable payload hash for the same input", () => {
    const a = buildManifest({
      companyId: "co-1",
      prevPayloadHash: null,
      entries: [entry({ details: { a: 1, b: 2 } })],
    });
    const b = buildManifest({
      companyId: "co-1",
      prevPayloadHash: null,
      entries: [entry({ details: { b: 2, a: 1 } })],
    });
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  it("changes hash when any field changes", () => {
    const base = buildManifest({
      companyId: "co-1",
      prevPayloadHash: null,
      entries: [entry()],
    });
    const mutated = buildManifest({
      companyId: "co-1",
      prevPayloadHash: null,
      entries: [entry({ action: "issue_closed" })],
    });
    expect(mutated.payloadHash).not.toBe(base.payloadHash);
  });

  it("chains via prevPayloadHash so the same entries yield different anchors", () => {
    const a = buildManifest({ companyId: "co-1", prevPayloadHash: null, entries: [entry()] });
    const b = buildManifest({
      companyId: "co-1",
      prevPayloadHash: a.payloadHash,
      entries: [entry()],
    });
    expect(b.payloadHash).not.toBe(a.payloadHash);
  });

  it("normalizes createdAt to ISO regardless of Date|string input", () => {
    const asDate = buildManifest({
      companyId: "co-1",
      prevPayloadHash: null,
      entries: [entry({ createdAt: FIXED_DATE })],
    });
    const asString = buildManifest({
      companyId: "co-1",
      prevPayloadHash: null,
      entries: [entry({ createdAt: FIXED_DATE.toISOString() })],
    });
    expect(asString.payloadHash).toBe(asDate.payloadHash);
  });
});
