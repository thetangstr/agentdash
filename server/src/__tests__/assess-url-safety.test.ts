import { describe, it, expect } from "vitest";
import { isSafeFetchUrl } from "../services/assess.js";
import { HttpError } from "../errors.js";

function rejectsWithCode(url: string) {
  try {
    isSafeFetchUrl(url);
    return false;
  } catch (err) {
    if (err instanceof HttpError) {
      expect((err.details as { code?: string })?.code).toBe("UNSAFE_FETCH_URL");
      // Must NOT leak the full URL — only the host is in details
      expect(JSON.stringify(err.details)).not.toContain("169.254.169.254/latest");
      expect(JSON.stringify(err.details)).not.toContain("10.0.0.1/secret");
      return true;
    }
    return false;
  }
}

describe("isSafeFetchUrl", () => {
  // --- Allowed: public domains and IPs ---
  it("allows a plain https domain", () => {
    const u = isSafeFetchUrl("https://example.com");
    expect(u.hostname).toBe("example.com");
  });

  it("allows a bare domain by prepending https://", () => {
    const u = isSafeFetchUrl("example.com");
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe("example.com");
  });

  it("allows http:// (non-https public URL)", () => {
    const u = isSafeFetchUrl("http://example.com");
    expect(u.hostname).toBe("example.com");
  });

  it("allows a public IPv4 address", () => {
    const u = isSafeFetchUrl("https://8.8.8.8");
    expect(u.hostname).toBe("8.8.8.8");
  });

  // --- Blocked: localhost ---
  it("rejects localhost by name", () => {
    expect(rejectsWithCode("http://localhost/")).toBe(true);
  });

  it("rejects 127.0.0.1", () => {
    expect(rejectsWithCode("http://127.0.0.1/")).toBe(true);
  });

  it("rejects ::1 (IPv6 loopback)", () => {
    expect(rejectsWithCode("http://[::1]/")).toBe(true);
  });

  // --- Blocked: RFC1918 private ranges ---
  it("rejects 10.x.x.x (RFC1918)", () => {
    expect(rejectsWithCode("http://10.0.0.1/secret")).toBe(true);
  });

  it("rejects 172.16.x.x (RFC1918)", () => {
    expect(rejectsWithCode("https://172.16.0.1/")).toBe(true);
  });

  it("rejects 172.31.255.255 (RFC1918 upper bound)", () => {
    expect(rejectsWithCode("https://172.31.255.255/")).toBe(true);
  });

  it("allows 172.15.x.x (just outside RFC1918)", () => {
    const u = isSafeFetchUrl("https://172.15.0.1/");
    expect(u.hostname).toBe("172.15.0.1");
  });

  it("allows 172.32.x.x (just outside RFC1918)", () => {
    const u = isSafeFetchUrl("https://172.32.0.1/");
    expect(u.hostname).toBe("172.32.0.1");
  });

  it("rejects 192.168.x.x (RFC1918)", () => {
    expect(rejectsWithCode("http://192.168.1.1/")).toBe(true);
  });

  // --- Blocked: link-local / cloud metadata ---
  it("rejects 169.254.169.254 (AWS/Azure IMDS)", () => {
    expect(rejectsWithCode("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });

  it("rejects metadata.google.internal (GCP metadata)", () => {
    expect(rejectsWithCode("http://metadata.google.internal/")).toBe(true);
  });

  // --- Blocked: IPv6 link-local and ULA ---
  it("rejects fe80:: (IPv6 link-local)", () => {
    expect(rejectsWithCode("http://[fe80::1]/")).toBe(true);
  });

  it("rejects fc00:: (IPv6 ULA)", () => {
    expect(rejectsWithCode("http://[fc00::1]/")).toBe(true);
  });

  it("rejects fd00:: (IPv6 ULA fd-range)", () => {
    expect(rejectsWithCode("http://[fd00::1]/")).toBe(true);
  });

  // --- Blocked: non-http protocols ---
  it("rejects ftp:// protocol", () => {
    expect(rejectsWithCode("ftp://example.com/file")).toBe(true);
  });

  it("rejects javascript: URI", () => {
    expect(rejectsWithCode("javascript:alert(1)")).toBe(true);
  });

  it("rejects file:// URI", () => {
    expect(rejectsWithCode("file:///etc/passwd")).toBe(true);
  });

  // --- Blocked: malformed URLs ---
  it("rejects a completely malformed URL", () => {
    expect(rejectsWithCode("not a url at all!!!")).toBe(true);
  });

  // --- Details must not leak full URL path ---
  it("does not include the URL path in error details", () => {
    try {
      isSafeFetchUrl("http://169.254.169.254/latest/meta-data/iam/credentials");
    } catch (err) {
      if (err instanceof HttpError) {
        const detailsStr = JSON.stringify(err.details);
        expect(detailsStr).not.toContain("/latest/meta-data");
        expect(detailsStr).toContain("169.254.169.254");
      } else {
        throw err;
      }
    }
  });
});
