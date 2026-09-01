import { describe, expect, it } from "vitest";
import {
  CONNECT_CODE_ALPHABET,
  CONNECT_CODE_LENGTH,
  createConnectCode,
  formatConnectCode,
  hashConnectCode,
  isWellFormedConnectCode,
  normalizeConnectCode,
  sanitizeDeviceName,
} from "./connect-codes.js";

describe("connect code generation", () => {
  it("draws only from the Crockford alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = createConnectCode();
      expect(code).toHaveLength(CONNECT_CODE_LENGTH);
      for (const char of code) expect(CONNECT_CODE_ALPHABET).toContain(char);
    }
  });

  it("excludes the characters people misread", () => {
    // I, L, O and U are absent by design; that is the whole reason for
    // choosing this alphabet over plain base32.
    for (const excluded of ["I", "L", "O", "U"]) {
      expect(CONNECT_CODE_ALPHABET).not.toContain(excluded);
    }
  });

  it("does not repeat itself in any realistic run", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) seen.add(createConnectCode());
    expect(seen.size).toBe(2_000);
  });
});

describe("normalizing what a person actually types", () => {
  it("accepts the code as displayed, hyphen and all", () => {
    expect(normalizeConnectCode("KVTX-8F02")).toBe("KVTX8F02");
  });

  it("survives case, spaces and a stray copy-paste newline", () => {
    expect(normalizeConnectCode(" kvtx 8f02 \n")).toBe("KVTX8F02");
  });

  it("folds the misread characters onto what was meant", () => {
    // Someone reading "0" aloud says "oh"; someone reading "1" writes "l".
    // Both must land on the same code, or the flow fails for the exact reason
    // the alphabet was chosen to prevent.
    expect(normalizeConnectCode("KVTX-8FO2")).toBe(normalizeConnectCode("KVTX-8F02"));
    expect(normalizeConnectCode("1BCD2345")).toBe(normalizeConnectCode("IBCD2345"));
    expect(normalizeConnectCode("LBCD2345")).toBe(normalizeConnectCode("1BCD2345"));
    expect(normalizeConnectCode("VBCD2345")).toBe(normalizeConnectCode("UBCD2345"));
  });

  it("hashes the same however it was typed", () => {
    const canonical = hashConnectCode("KVTX8F02");
    for (const variant of ["kvtx-8f02", "KVTX 8F02", "kvtx8fo2", " KVTX-8F02 "]) {
      expect(hashConnectCode(variant)).toBe(canonical);
    }
  });

  it("never stores the code itself", () => {
    // A hash that contains its input would defeat the point of hashing.
    const code = "KVTX8F02";
    expect(hashConnectCode(code)).not.toContain(code);
    expect(hashConnectCode(code)).toHaveLength(64);
  });
});

describe("well-formedness", () => {
  it("accepts a freshly generated code in every display form", () => {
    const code = createConnectCode();
    expect(isWellFormedConnectCode(code)).toBe(true);
    expect(isWellFormedConnectCode(formatConnectCode(code))).toBe(true);
    expect(isWellFormedConnectCode(formatConnectCode(code).toLowerCase())).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(isWellFormedConnectCode("KVTX8F0")).toBe(false);
    expect(isWellFormedConnectCode("KVTX8F022")).toBe(false);
    expect(isWellFormedConnectCode("")).toBe(false);
  });

  it("rejects an agent key, which must never be treated as a code", () => {
    expect(isWellFormedConnectCode(`pcp_${"a".repeat(48)}`)).toBe(false);
  });

  it("formats as four-and-four for reading aloud", () => {
    expect(formatConnectCode("KVTX8F02")).toBe("KVTX-8F02");
  });
});

describe("device names", () => {
  it("keeps an ordinary hostname intact", () => {
    expect(sanitizeDeviceName("titus-macbook.local")).toBe("titus-macbook.local");
  });

  it("degrades to something honest rather than an empty key name", () => {
    // This lands in a key name an administrator reads when deciding what to
    // revoke. A blank one is worse than useless.
    expect(sanitizeDeviceName("")).toBe("unnamed device");
    expect(sanitizeDeviceName("   ")).toBe("unnamed device");
    expect(sanitizeDeviceName(null)).toBe("unnamed device");
    expect(sanitizeDeviceName(undefined)).toBe("unnamed device");
  });

  it("strips control characters a hostile client could send", () => {
    // Terminal escapes in a device name would be rendered by whatever CLI
    // prints the device list later.
    const nasty = "laptop[31mRED[0m";
    const cleaned = sanitizeDeviceName(nasty);
    expect(cleaned).not.toContain("");
    expect(cleaned).not.toContain("");
  });

  it("caps the length so one device cannot flood the key list", () => {
    expect(sanitizeDeviceName("x".repeat(500))).toHaveLength(64);
  });
});
