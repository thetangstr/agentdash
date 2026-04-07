import { describe, it, expect } from "vitest";
import { encryptTokens, decryptTokens } from "../connectors.js";

describe("connectors token encryption", () => {
  const secret = "test-secret-key-for-encryption-32b";

  it("round-trips tokens through encrypt/decrypt", () => {
    const tokens = {
      access_token: "access_123",
      refresh_token: "refresh_456",
      expires_at: 1700000000,
    };
    const encrypted = encryptTokens(tokens, secret);
    expect(encrypted).not.toEqual(tokens);
    expect(encrypted).toHaveProperty("ciphertext");
    expect(encrypted).toHaveProperty("iv");
    expect(encrypted).toHaveProperty("salt");
    expect(encrypted).toHaveProperty("tag");

    const decrypted = decryptTokens(encrypted, secret);
    expect(decrypted).toEqual(tokens);
  });

  it("produces different ciphertext for same input (random salt)", () => {
    const tokens = { access_token: "same" };
    const a = encryptTokens(tokens, secret);
    const b = encryptTokens(tokens, secret);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("throws on tampered ciphertext", () => {
    const tokens = { access_token: "test" };
    const encrypted = encryptTokens(tokens, secret);
    encrypted.ciphertext = "tampered" + encrypted.ciphertext;
    expect(() => decryptTokens(encrypted, secret)).toThrow();
  });
});
