import { describe, expect, it } from "vitest";
import { formatConnectCode, looksLikeConnectCode, normalizeConnectCode } from "./codes.mjs";

/**
 * These mirror `server/src/lib/connect-codes.ts` on purpose — the CLI has no
 * dependencies and cannot import it. If the two ever disagree, a code that the
 * server issues stops being recognised here and the flow silently falls back to
 * treating it as an agent key. That is the failure this file exists to catch.
 */

describe("recognising a connect code", () => {
  it("accepts the code exactly as the screen shows it", () => {
    expect(looksLikeConnectCode("KVTX-8F02")).toBe(true);
    expect(looksLikeConnectCode("kvtx-8f02")).toBe(true);
    expect(looksLikeConnectCode("KVTX8F02")).toBe(true);
    expect(looksLikeConnectCode(" KVTX-8F02 ")).toBe(true);
  });

  it("never mistakes an agent key for a code", () => {
    // A key taken as a code would be echoed to the screen and posted to an
    // endpoint that cannot use it — the exact leak this flow removes.
    expect(looksLikeConnectCode(`pcp_${"a".repeat(48)}`)).toBe(false);
    expect(looksLikeConnectCode("pcp_board_deadbeef")).toBe(false);
    expect(looksLikeConnectCode("PCP_ABCD1234")).toBe(false);
  });

  it("rejects anything of the wrong length", () => {
    expect(looksLikeConnectCode("KVTX8F0")).toBe(false);
    expect(looksLikeConnectCode("KVTX8F022")).toBe(false);
    expect(looksLikeConnectCode("")).toBe(false);
    expect(looksLikeConnectCode(null)).toBe(false);
    expect(looksLikeConnectCode(undefined)).toBe(false);
  });

  it("folds misread characters the same way the server does", () => {
    expect(normalizeConnectCode("KVTX-8FO2")).toBe("KVTX8F02");
    expect(normalizeConnectCode("IBCD2345")).toBe("1BCD2345");
    expect(normalizeConnectCode("LBCD2345")).toBe("1BCD2345");
    expect(normalizeConnectCode("UBCD2345")).toBe("VBCD2345");
  });

  it("formats for reading aloud", () => {
    expect(formatConnectCode("kvtx8f02")).toBe("KVTX-8F02");
  });

  it("does not treat a URL or a stray flag as a code", () => {
    expect(looksLikeConnectCode("http://mkmini.local:3103")).toBe(false);
    expect(looksLikeConnectCode("--check")).toBe(false);
  });
});
