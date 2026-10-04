// The UI display path re-exports the shared redactor; an astral char before a
// secret used to shift every later position map entry, leaking the secret and
// duplicating the surrounding text in transcripts/comments/chat.
import { describe, expect, it } from "vitest";
import { displayMaskedSecrets, redactSecrets, SECRET_MASK_DISPLAY } from "./redactSecrets";

describe("redactSecrets (UI display path)", () => {
  it("redacts a secret after an emoji without duplicating text", () => {
    const secret = "f3b9c2d1e4a5968778a1b2c3.Qz9XyW8vU7tS";
    const out = redactSecrets(`\u{1F680} Deployed! API_KEY=${secret}`);
    expect(out).toBe(`\u{1F680} Deployed! API_KEY=${SECRET_MASK_DISPLAY}`);
  });

  it("returns secret-free emoji text byte-for-byte", () => {
    const clean = "\u{1F680} shipped \u{1F389} cafe\u0301";
    expect(redactSecrets(clean)).toBe(clean);
  });
});

// AgentDash (c3-a11y): every mask spelling baked into stored text renders as
// the one display mask — the UI never shows "***REDACTED***", "[REDACTED…]"
// or "***SECRET_REF***".
describe("displayMaskedSecrets", () => {
  it.each([
    ["run list marker", "***REDACTED***"],
    ["server feedback marker", "[REDACTED]"],
    ["typed server markers", "[REDACTED_API_KEY]"],
    ["typed server markers", "[REDACTED_PEM_BLOCK]"],
    ["typed server markers", "[REDACTED_JWT]"],
    ["git helper marker", "[redacted-github-token]"],
    ["env secret-ref", "***SECRET_REF***"],
  ])("shows one mask for a stored %s", (_label, marker) => {
    expect(displayMaskedSecrets(`token=${marker}`)).toBe(`token=${SECRET_MASK_DISPLAY}`);
  });

  it("leaves non-mask text alone", () => {
    const text = "redacted credentials are hidden; nothing masked here";
    expect(displayMaskedSecrets(text)).toBe(text);
  });
});
