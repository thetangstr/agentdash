// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * Copying an invite URL over plain HTTP.
 *
 * The browser Clipboard API only exists in a SECURE CONTEXT. This instance is
 * reached over plain `http://` on the client's LAN and HTTPS is not available
 * to them, so `navigator.clipboard` is simply absent.
 *
 * CompanyInvites called `navigator.clipboard.writeText` directly, found
 * nothing, and reported "Clipboard unavailable" every single time — on the one
 * screen whose entire purpose is handing a person a URL. Meanwhile
 * `copyToClipboard` already carried a hidden-textarea + `execCommand`
 * fallback written for exactly this situation. The page just never called it.
 *
 * These cases pin the fallback itself, in a simulated insecure context,
 * because that is the environment the client actually runs in.
 */
describe("copying a URL without a secure context", () => {
  const originalExec = document.execCommand;

  beforeEach(() => {
    // No Clipboard API at all — what plain HTTP really looks like.
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  afterEach(() => {
    document.execCommand = originalExec;
    vi.restoreAllMocks();
  });

  it("still copies, via the legacy path", async () => {
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec as unknown as typeof document.execCommand;

    await expect(copyToClipboard("http://mkmini.local:3102/invite/abc")).resolves.toBe(true);
    expect(exec, "the fallback is the whole point on plain HTTP").toHaveBeenCalledWith("copy");
  });

  it("reports failure honestly when even the fallback is refused", async () => {
    // Then, and only then, is "Clipboard unavailable" the truthful message —
    // paired with the URL shown on screen so it can be selected by hand.
    document.execCommand = vi.fn().mockReturnValue(false) as unknown as typeof document.execCommand;
    await expect(copyToClipboard("http://mkmini.local:3102/invite/abc")).resolves.toBe(false);
  });

  it("leaves nothing behind in the DOM either way", async () => {
    document.execCommand = vi.fn().mockReturnValue(true) as unknown as typeof document.execCommand;
    await copyToClipboard("http://mkmini.local:3102/invite/abc");
    expect(document.querySelectorAll("textarea").length).toBe(0);
  });
});
