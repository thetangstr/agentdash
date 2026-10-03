// The UI display path re-exports the shared redactor; an astral char before a
// secret used to shift every later position map entry, leaking the secret and
// duplicating the surrounding text in transcripts/comments/chat.
import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "./redactSecrets";

describe("redactSecrets (UI display path)", () => {
  it("redacts a secret after an emoji without duplicating text", () => {
    const secret = "f3b9c2d1e4a5968778a1b2c3.Qz9XyW8vU7tS";
    const out = redactSecrets(`\u{1F680} Deployed! API_KEY=${secret}`);
    expect(out).toBe(`\u{1F680} Deployed! API_KEY=${REDACTED}`);
  });

  it("returns secret-free emoji text byte-for-byte", () => {
    const clean = "\u{1F680} shipped \u{1F389} cafe\u0301";
    expect(redactSecrets(clean)).toBe(clean);
  });
});
