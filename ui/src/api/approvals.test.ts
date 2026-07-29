// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("./client", () => ({ api: mockApi }));

const { approvalsApi } = await import("./approvals");

describe("approvalsApi decision metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits decision metadata entirely when no revision is supplied", async () => {
    await approvalsApi.approve("approval-1");

    // Default-profile companies must keep the pre-existing contract byte for
    // byte: sending revision/idempotencyKey/channel would be a new contract.
    expect(mockApi.post).toHaveBeenCalledWith("/approvals/approval-1/approve", {
      decisionNote: undefined,
    });
  });

  it("sends the supplied revision with a channel and a fresh idempotency key", async () => {
    await approvalsApi.approve("approval-1", { revision: 7 });

    const body = mockApi.post.mock.calls[0][1];
    expect(body.revision).toBe(7);
    expect(body.channel).toBe("web");
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });

  it("generates a new idempotency key per attempt so a retry is not deduped away", async () => {
    await approvalsApi.approve("approval-1", { revision: 1 });
    await approvalsApi.approve("approval-1", { revision: 1 });

    const first = mockApi.post.mock.calls[0][1].idempotencyKey;
    const second = mockApi.post.mock.calls[1][1].idempotencyKey;
    expect(first).not.toBe(second);
  });

  it("still works where crypto.randomUUID is unavailable", async () => {
    // Secure-context-only API: over plain HTTP an unguarded call would throw
    // before any request, killing every approve and reject button.
    vi.stubGlobal("crypto", {});

    await approvalsApi.reject("approval-1", { revision: 2 });

    const body = mockApi.post.mock.calls[0][1];
    expect(body.revision).toBe(2);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });

  it("always sends a reason on override and never sends metadata without a revision", async () => {
    await approvalsApi.override("approval-1", {
      decision: "approved",
      overrideReason: "Steward unreachable",
    });

    expect(mockApi.post).toHaveBeenCalledWith("/approvals/approval-1/override", {
      decision: "approved",
      overrideReason: "Steward unreachable",
    });
  });
});
