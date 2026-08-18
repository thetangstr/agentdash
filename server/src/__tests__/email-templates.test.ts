// Pure unit tests for the email template helpers — no Resend, no DB.
//
// The phishing-payload assertions exist because `inviterName` is read
// from `authUsers.name`, which the user controls at signup. Without
// sanitization an attacker could set their name to
// "Microsoft Security <security@microsoft.com>" and the resulting subject
// + plaintext body would impersonate a trusted brand using AgentDash's
// verified-domain DKIM/SPF as cover.
import { describe, it, expect } from "vitest";
import { sanitizeDisplayName, inviteEmailTemplate, resetPasswordEmailTemplate } from "../auth/email.ts";
import { formatTokenLifetime } from "../auth/better-auth.ts";

describe("sanitizeDisplayName", () => {
  it("returns null for null/undefined/empty", () => {
    expect(sanitizeDisplayName(null)).toBe(null);
    expect(sanitizeDisplayName(undefined)).toBe(null);
    expect(sanitizeDisplayName("")).toBe(null);
    expect(sanitizeDisplayName("   ")).toBe(null);
  });

  it("strips control characters and quote / angle / @ glyphs", () => {
    // CR/LF/quotes/angles/@ are removed (not replaced) — that's the
    // safest default for an attribute the user controls. Adjacent
    // surviving whitespace is collapsed by the second pass.
    expect(sanitizeDisplayName("Carol\r\nBcc: spam@x.com")).toBe("CarolBcc: spamx.com");
    expect(sanitizeDisplayName('Microsoft Security <security@microsoft.com>')).toBe(
      "Microsoft Security securitymicrosoft.com",
    );
    expect(sanitizeDisplayName('Carol "the boss"')).toBe("Carol the boss");
    expect(sanitizeDisplayName("Carol's team")).toBe("Carols team");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeDisplayName("  Carol   Q.   Smith  ")).toBe("Carol Q. Smith");
  });

  it("caps at 60 chars", () => {
    const long = "a".repeat(120);
    expect(sanitizeDisplayName(long)).toHaveLength(60);
  });

  it("returns null when sanitization eats the whole string", () => {
    expect(sanitizeDisplayName('<<<>>>"""')).toBe(null);
    expect(sanitizeDisplayName("\r\n\r\n")).toBe(null);
  });
});

describe("inviteEmailTemplate", () => {
  it("falls back to neutral copy when names are null", () => {
    const t = inviteEmailTemplate({
      inviteUrl: "https://app.example.com/invite/tok",
      companyName: null,
      inviterName: null,
    });
    expect(t.subject).toBe("your teammate invited you to AgentDash on AgentDash");
    expect(t.text).toContain("your teammate invited you to join AgentDash");
    expect(t.html).toContain("your teammate");
    expect(t.html).toContain("https://app.example.com/invite/tok");
  });

  it("escapes HTML in the rendered body when names contain special chars", () => {
    // Even after sanitization, HTML special chars like & should still
    // round-trip through escapeHtml in the HTML part.
    const t = inviteEmailTemplate({
      inviteUrl: "https://app.example.com/invite/tok",
      companyName: "Bob & Co",
      inviterName: "Carol",
    });
    expect(t.html).toContain("Bob &amp; Co");
    expect(t.html).not.toContain("Bob & Co"); // raw & must be escaped
  });

  it("strips phishing payloads from the inviter name (subject + plaintext + html)", () => {
    const t = inviteEmailTemplate({
      inviteUrl: "https://app.example.com/invite/tok",
      companyName: null,
      inviterName: 'Microsoft Security <security@microsoft.com>',
    });
    // The hostile substring must not appear anywhere in the body — not
    // in subject, not in plaintext, not in HTML (escaped or otherwise).
    for (const part of [t.subject, t.text, t.html]) {
      expect(part).not.toContain("<security");
      expect(part).not.toContain("@microsoft.com");
      expect(part).not.toContain("security@");
    }
    expect(t.subject).toContain("Microsoft Security");
    expect(t.subject).toContain("securitymicrosoft.com");
  });

  it("strips CRLF from display names so they can't break the subject or smuggle headers", () => {
    const t = inviteEmailTemplate({
      inviteUrl: "https://app.example.com/invite/tok",
      companyName: "Acme\r\nBcc: leak@x.com",
      inviterName: "Carol\nFwd: spam",
    });
    // Subject lives in a real mail header — no CRLF allowed.
    expect(t.subject).not.toMatch(/[\r\n]/);
    // The plaintext body has its own newlines (from the template), so we
    // can't blanket-reject \n there. What we DO reject is the inviter
    // string smuggling its OWN newline into the subject, which would
    // create a second header line in some MTAs. The CRLF-free subject
    // assertion above covers that case.
    expect(t.text).toContain("CarolFwd: spam invited"); // CR/LF dropped, words remain plaintext
  });
});

// The reset-link lifetime is configurable per deployment
// (AGENTDASH_RESET_TOKEN_TTL_SECONDS), because an on-premise box gets its link
// minted before it is physically relocated. The risk these tests guard is copy
// drift: an email that claims "1 hour" while the token lives a week teaches the
// recipient the message is untrustworthy.
describe("formatTokenLifetime", () => {
  it("renders whole days, hours and minutes in the largest exact unit", () => {
    expect(formatTokenLifetime(3600)).toBe("1 hour");
    expect(formatTokenLifetime(7200)).toBe("2 hours");
    expect(formatTokenLifetime(86_400)).toBe("1 day");
    expect(formatTokenLifetime(604_800)).toBe("7 days");
    expect(formatTokenLifetime(5400)).toBe("90 minutes");
    expect(formatTokenLifetime(90)).toBe("90 seconds");
  });

  it("singularises exactly at one", () => {
    expect(formatTokenLifetime(60)).toBe("1 minute");
    expect(formatTokenLifetime(1)).toBe("1 second");
  });
});

describe("resetPasswordEmailTemplate lifetime copy", () => {
  it("defaults to 1 hour when no lifetime is passed", () => {
    const t = resetPasswordEmailTemplate({ resetUrl: "https://example.test/reset?token=abc" });
    expect(t.text).toContain("expires in 1 hour");
    expect(t.html).toContain("expires in 1 hour");
  });

  it("uses the configured lifetime in both the text and html parts", () => {
    const t = resetPasswordEmailTemplate({
      resetUrl: "https://example.test/reset?token=abc",
      lifetime: formatTokenLifetime(604_800),
    });
    expect(t.text).toContain("expires in 7 days");
    expect(t.html).toContain("expires in 7 days");
    // The stale hardcoded string must be gone, not merely accompanied.
    expect(t.text).not.toContain("1 hour");
    expect(t.html).not.toContain("1 hour");
  });

  it("keeps the reset URL in both parts so a mangled link is recoverable", () => {
    const url = "https://example.test/reset?token=abc&x=1";
    const t = resetPasswordEmailTemplate({ resetUrl: url, lifetime: "7 days" });
    expect(t.text).toContain(url);
    expect(t.html).toContain("&amp;x=1"); // html-escaped, same URL
  });
});
