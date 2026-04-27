// AgentDash (AGE-55): unit tests for the FRE Plan B email-domain helper.
import { describe, it, expect } from "vitest";
import { deriveCompanyEmailDomain, FREE_MAIL_DOMAINS } from "./constants.js";

describe("deriveCompanyEmailDomain", () => {
  it("returns the bare domain for corp email addresses", () => {
    expect(deriveCompanyEmailDomain("alice@acme.com")).toBe("acme.com");
    expect(deriveCompanyEmailDomain("bob@beta.io")).toBe("beta.io");
    expect(deriveCompanyEmailDomain("carla@some-corp.co.uk")).toBe("some-corp.co.uk");
  });

  it("returns the full lowercased email for free-mail addresses", () => {
    expect(deriveCompanyEmailDomain("me@gmail.com")).toBe("me@gmail.com");
    expect(deriveCompanyEmailDomain("user@yahoo.com")).toBe("user@yahoo.com");
    expect(deriveCompanyEmailDomain("user@proton.me")).toBe("user@proton.me");
  });

  it("normalizes case", () => {
    expect(deriveCompanyEmailDomain("Alice@ACME.com")).toBe("acme.com");
    expect(deriveCompanyEmailDomain("Me@GMAIL.com")).toBe("me@gmail.com");
  });

  it("trims whitespace", () => {
    expect(deriveCompanyEmailDomain("  alice@acme.com  ")).toBe("acme.com");
    expect(deriveCompanyEmailDomain("\tme@gmail.com\n")).toBe("me@gmail.com");
  });

  it("strips plus-addressing from the local part on free-mail", () => {
    expect(deriveCompanyEmailDomain("me+work@gmail.com")).toBe("me@gmail.com");
    expect(deriveCompanyEmailDomain("alice+spam@yahoo.com")).toBe("alice@yahoo.com");
  });

  it("does not affect corp emails when plus-addressing is used", () => {
    // Corp domains return only the domain, so plus-addressing is irrelevant.
    expect(deriveCompanyEmailDomain("alice+work@acme.com")).toBe("acme.com");
  });

  it("rejects malformed inputs", () => {
    expect(() => deriveCompanyEmailDomain("not-an-email")).toThrow();
    expect(() => deriveCompanyEmailDomain("@acme.com")).toThrow();
    expect(() => deriveCompanyEmailDomain("alice@")).toThrow();
    expect(() => deriveCompanyEmailDomain("")).toThrow();
    expect(() => deriveCompanyEmailDomain("   ")).toThrow();
    // Domain must contain a dot.
    expect(() => deriveCompanyEmailDomain("alice@localhost")).toThrow();
  });

  it("includes a sane initial set of free-mail domains", () => {
    // Spot-check a few high-confidence entries to catch accidental deletions.
    for (const d of [
      "gmail.com",
      "outlook.com",
      "yahoo.com",
      "icloud.com",
      "proton.me",
    ]) {
      expect(FREE_MAIL_DOMAINS.has(d)).toBe(true);
    }
  });
});
