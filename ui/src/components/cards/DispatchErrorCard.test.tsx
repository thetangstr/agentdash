// @vitest-environment jsdom
// AgentDash (P0, v2026.1002.0): a failed CoS reply shows its reason and a Retry.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardRenderer } from "./index";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("cos_dispatch_error_v1 card", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says why the CoS could not reply and retries the original message", async () => {
    const onDispatchRetry = vi.fn().mockResolvedValue(undefined);
    act(() =>
      root.render(
        <CardRenderer
          cardKind="cos_dispatch_error_v1"
          payload={{ reason: "hermes_local: HTTP 429: Insufficient balance", retryMessageId: "u1" }}
          context={{ onDispatchRetry }}
        />,
      ),
    );
    const card = container.querySelector('[data-testid="cos-dispatch-error"]');
    expect(card?.textContent).toContain("CoS couldn't reply:");
    expect(card?.textContent).toContain("HTTP 429: Insufficient balance");
    const button = card?.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Retry");
    await act(async () => {
      button.click();
    });
    expect(onDispatchRetry).toHaveBeenCalledWith("u1");
  });

  it("tells the person when the retry itself could not start", async () => {
    const onDispatchRetry = vi.fn().mockRejectedValue(new Error("offline"));
    act(() =>
      root.render(
        <CardRenderer cardKind="cos_dispatch_error_v1" payload={{ reason: "x", retryMessageId: "u1" }} context={{ onDispatchRetry }} />,
      ),
    );
    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain("Retry failed to start");
  });

  it("hides Retry when this viewer did not write the message, and shows the hint", () => {
    act(() =>
      root.render(
        <CardRenderer
          cardKind="cos_dispatch_error_v1"
          payload={{ reason: "x", retryMessageId: "u1", hint: "Open Settings and re-save your model key." }}
          context={{ onDispatchRetry: vi.fn(), canDispatchRetry: () => false }}
        />,
      ),
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-testid="cos-dispatch-error-hint"]')?.textContent).toContain("re-save your model key");
  });
});
