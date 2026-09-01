// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

/**
 * The bug: an on-prem instance served at `http://mkmini.local:3103` is not a
 * secure context, so `navigator.clipboard` does not exist at all. Every copy
 * button on the product did nothing, and said nothing, for exactly the
 * customers who self-host.
 *
 * So the case that matters most here is the insecure one — it is the default
 * for on-prem, not the exception.
 */

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setSecureContext(value: boolean) {
  Object.defineProperty(window, "isSecureContext", { value, configurable: true });
}

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

beforeEach(() => {
  document.execCommand = vi.fn().mockReturnValue(true);
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  vi.restoreAllMocks();
});

describe("copyToClipboard", () => {
  it("uses the Clipboard API in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setSecureContext(true);
    setClipboard({ writeText });

    await expect(copyToClipboard("KVTX-8F02")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("KVTX-8F02");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back when there is no clipboard at all — the on-prem HTTP case", async () => {
    setSecureContext(false);
    setClipboard(undefined);

    await expect(copyToClipboard("npx agentdash-connect KVTX-8F02")).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back when the API exists but is not permitted", async () => {
    // Some browsers expose the API and then reject on use — a denied
    // permission, or a page that never had focus.
    setSecureContext(true);
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });

    await expect(copyToClipboard("text")).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure rather than pretending, when nothing works", async () => {
    // The original `catch {}` swallowed this and left the button looking like
    // it had succeeded, which is how the bug survived.
    setSecureContext(false);
    setClipboard(undefined);
    document.execCommand = vi.fn().mockReturnValue(false);

    await expect(copyToClipboard("text")).resolves.toBe(false);
  });

  it("does not leave its scratch textarea behind", async () => {
    setSecureContext(false);
    setClipboard(undefined);
    const before = document.body.childElementCount;

    await copyToClipboard("text");

    expect(document.body.childElementCount).toBe(before);
  });

  it("cleans up even when the copy throws", async () => {
    setSecureContext(false);
    setClipboard(undefined);
    document.execCommand = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const before = document.body.childElementCount;

    await expect(copyToClipboard("text")).resolves.toBe(false);
    expect(document.body.childElementCount).toBe(before);
  });
});
