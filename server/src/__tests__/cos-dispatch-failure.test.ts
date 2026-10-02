import { describe, expect, it, vi } from "vitest";
import { isNoBalanceFailure, isRateLimitFailure, dispatchErrorHint, postDispatchFailure, shortDispatchReason } from "../services/cos-dispatch-failure.js";

describe("cos dispatch failure card", () => {
  it("unwraps the adapter refusal into the inner reason", () => {
    const err = new Error(
      'Adapter "hermes_local" failed ([dispatch-llm] /usr/local/bin/hermes exited 1: HTTP 429: Insufficient balance or no resource package) and the adapter/model invariant forbids a fallback.',
    );
    expect(shortDispatchReason(err)).toBe(
      "hermes_local: hermes exited 1: HTTP 429: Insufficient balance or no resource package",
    );
  });

  it("tells the person to re-save the model key when the balance is exhausted", () => {
    expect(dispatchErrorHint("hermes exited 1: HTTP 429: Insufficient balance or no resource package")).toMatch(
      /re-save your model key/,
    );
    expect(dispatchErrorHint("timed out")).toBeUndefined();
  });

  it("posts the card with the companyId, the retry target and the hint", async () => {
    const postMessage = vi.fn().mockResolvedValue({});
    await postDispatchFailure(
      { postMessage },
      {
        conversationId: "c1",
        companyId: "co1",
        authorId: "cos1",
        retryMessageId: "u1",
        err: new Error("HTTP 429: Insufficient balance"),
      },
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co1",
        cardKind: "cos_dispatch_error_v1",
        cardPayload: expect.objectContaining({ retryMessageId: "u1", hint: expect.stringContaining("re-save") }),
      }),
    );
  });

  it("tells a rate limit apart from no balance", () => {
    expect(isNoBalanceFailure("HTTP 429: Insufficient balance or no resource package (code 1113)")).toBe(true);
    expect(isNoBalanceFailure("HTTP 429: Rate limit reached for requests (code 1302)")).toBe(false);
    expect(isRateLimitFailure("HTTP 429: Rate limit reached for requests (code 1302)")).toBe(true);
    expect(dispatchErrorHint("HTTP 429: Rate limit reached (code 1302)")).toMatch(/limiting requests/);
  });

  it("scrubs keys the provider echoed back from the reason shown in the chat", () => {
    const err = new Error(
      'Adapter "hermes_local" failed (hermes exited 1: Incorrect API key provided: sk-abcdef1234567890. Authorization: Bearer abcdefgh12345678 token 0123456789abcdef0123456789abcdef9 ) and the adapter/model invariant refuses.',
    );
    const reason = shortDispatchReason(err);
    expect(reason).not.toMatch(/sk-abcdef|abcdefgh12345678|0123456789abcdef0123456789abcdef9/);
    expect(reason).toContain("[redacted]");
  });

  it("scrubs the exact keys this process was started with", () => {
    process.env.ZAI_TEST_API_KEY = "plainkey-not-key-shaped";
    try {
      expect(shortDispatchReason(new Error("401 for plainkey-not-key-shaped"))).toBe("401 for [redacted]");
    } finally {
      delete process.env.ZAI_TEST_API_KEY;
    }
  });
});
