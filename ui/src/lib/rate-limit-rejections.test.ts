// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { installRateLimitRejectionGuard, isUnhandledRateLimit } from "./rate-limit-rejections";

function rejectionEvent(reason: unknown) {
  const event = new Event("unhandledrejection", { cancelable: true }) as PromiseRejectionEvent;
  Object.defineProperty(event, "reason", { value: reason });
  return event;
}

describe("rate-limit rejection guard", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
    vi.restoreAllMocks();
  });

  it("recognises only a 429 ApiError", () => {
    expect(isUnhandledRateLimit(new ApiError("Rate limited", 429, null))).toBe(true);
    expect(isUnhandledRateLimit(new ApiError("Boom", 500, null))).toBe(false);
    expect(isUnhandledRateLimit(new Error("Rate limited"))).toBe(false);
  });

  it("swallows an unhandled 429 with one warning, however many arrive", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    uninstall = installRateLimitRejectionGuard(window);
    const first = rejectionEvent(new ApiError("Rate limited", 429, null));
    const second = rejectionEvent(new ApiError("Rate limited", 429, null));
    window.dispatchEvent(first);
    window.dispatchEvent(second);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("leaves every other rejection alone", () => {
    uninstall = installRateLimitRejectionGuard(window);
    const serverError = rejectionEvent(new ApiError("Boom", 500, null));
    const plain = rejectionEvent(new Error("bug"));
    window.dispatchEvent(serverError);
    window.dispatchEvent(plain);
    expect(serverError.defaultPrevented).toBe(false);
    expect(plain.defaultPrevented).toBe(false);
  });
});
