import { describe, expect, it, vi } from "vitest";
import { dispatchErrorHint, postDispatchFailure, shortDispatchReason } from "../services/cos-dispatch-failure.js";

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
});
