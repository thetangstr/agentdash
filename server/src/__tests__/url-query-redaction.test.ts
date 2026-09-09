import { describe, expect, it } from "vitest";
import { redactQueryObject, redactSensitive, redactUrlQuery } from "../middleware/redact-sensitive.js";

/**
 * AGE-83 — credential-bearing query strings were reaching disk through four
 * channels: the serialized `req.url` field, the interpolated 4xx/5xx log
 * message (4xx via customSuccessMessage — pino-http only routes err/>=500 to
 * customErrorMessage), the structured `reqQuery` object, and the error
 * sink's `lastContext.url` in Postgres.
 *
 * The redactUrlQuery cases mirror the probe shape from AGE-80
 * (2026-09-05T07:41Z): an OAuth callback whose `?code=` and `?state=` landed
 * in server.log verbatim. Raw-string operation, no decode/re-encode, first-
 * `=` split, `[UNPARSEABLE_URL]` on anything non-string — per Theo's scope.
 */
describe("redactUrlQuery", () => {
  it.each([
    // [input, expected, why]
    ["/api/callback?code=abc123", "/api/callback?code=[REDACTED]", "OAuth code param"],
    ["/api/verify?token=secret&next=/dash", "/api/verify?token=[REDACTED]&next=/dash", "token redacted, next preserved"],
    ["/reset?state=st9&email=a@b.c", "/reset?state=[REDACTED]&email=a@b.c", "OAuth state is a credential channel"],
    ["/key?api_key=sk-123", "/key?api_key=[REDACTED]", "api_key"],
    ["/login?Token=abc", "/login?Token=[REDACTED]", "case-insensitive key match"],
    ["/login?auth_token=abc", "/login?auth_token=[REDACTED]", "suffix rule _token"],
    ["/cb?code=a&code=b", "/cb?code=[REDACTED]&code=[REDACTED]", "multi-value redacts each occurrence"],
    ["/cb?code=a&code=b&next=/x", "/cb?code=[REDACTED]&code=[REDACTED]&next=/x", "multi-value, order preserved"],
    ["/path?code=a=b", "/path?code=[REDACTED]", "first-=-only split: whole remainder is the value"],
    ["/settings?tab=billing", "/settings?tab=billing", "benign param untouched"],
    ["/settings?flags&tab=mail", "/settings?flags&tab=mail", "bare flag param untouched"],
    ["/no-query", "/no-query", "absent query unchanged"],
    ["/empty?", "/empty?", "empty query unchanged"],
    ["/sp?x=%2Froute%3Ftoken%3Dzz", "/sp?x=%2Froute%3Ftoken%3Dzz", "raw bytes verbatim: encoded ? not re-split"],
    ["/sp?token=%2Fzz%3D1", "/sp?token=[REDACTED]", "encoded value on a sensitive key is replaced whole"],
  ] as const)("scrubs %s", (input, expected) => {
    expect(redactUrlQuery(input)).toBe(expected);
  });

  it("boundary per spec: camelCase authToken does NOT match the _token suffix rule", () => {
    // Literal spec reading (lowercased endsWith "_token"): "authtoken" has no
    // underscore, so it is NOT a suffix match. Recorded as an observation for
    // Theo rather than a silent spec extension.
    expect(redactUrlQuery("/login?authToken=abc")).toBe("/login?authToken=abc");
  });

  it("preserves the absolute-form origin verbatim", () => {
    // pino-http usually hands us path+query, but absolute-form can appear
    // (proxies); everything before the first `?` is preserved untouched.
    expect(redactUrlQuery("https://host/api/cb?code=z")).toBe("https://host/api/cb?code=[REDACTED]");
  });

  it.each([
    [undefined, "[UNPARSEABLE_URL]"],
    [null, "[UNPARSEABLE_URL]"],
    [42, "[UNPARSEABLE_URL]"],
    [{ evil: "object" }, "[UNPARSEABLE_URL]"],
  ])("non-string input %p returns the placeholder", (input, expected) => {
    expect(redactUrlQuery(input)).toBe(expected);
  });
});

describe("redactQueryObject", () => {
  it("redacts query-secret keys, keeps diagnostic keys intact", () => {
    const out = redactQueryObject({ code: "c1", token: "t1", next: "/dashboard", page: "2" }) as Record<string, unknown>;
    expect(out.code).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.next).toBe("/dashboard");
    expect(out.page).toBe("2");
  });

  it("applies the suffix rule and case-insensitivity", () => {
    const out = redactQueryObject({ authCode: "z", ACCESS_TOKEN: "t", keepMe: "1" }) as Record<string, unknown>;
    // suffix rule is on raw-key lowercase endsWith
    expect(out.authCode).toBe("[REDACTED]");
    expect(out.ACCESS_TOKEN).toBe("[REDACTED]");
    expect(out.keepMe).toBe("1");
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactQueryObject({
      filter: { token: "deep" },
      list: [{ code: "x" }, { safe: "y" }],
    }) as Record<string, unknown>;
    expect((out.filter as Record<string, unknown>).token).toBe("[REDACTED]");
    expect(out.list).toEqual([{ code: "[REDACTED]" }, { safe: "y" }]);
  });

  it("keeps the MAX_DEPTH cap — a cycle must not pin the logger", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    // Must terminate and return undefined at the depth cap, like redactSensitive.
    expect(() => redactQueryObject(cycle)).not.toThrow();
    expect(redactQueryObject(cycle)).toBeDefined(); // shallow copy at depth 0
  });

  it("non-object scalars pass through unchanged", () => {
    expect(redactQueryObject("plain")).toBe("plain");
    expect(redactQueryObject(5)).toBe(5);
    expect(redactQueryObject(null)).toBeNull();
  });
});

/**
 * reqBody regression: the body list (SENSITIVE_KEYS) is unchanged by AGE-83.
 * A body key named `code` is NOT newly redacted; `password` still is.
 */
describe("reqBody regression — body list unchanged", () => {
  it("body key `code` is NOT redacted; password still is", () => {
    const out = redactSensitive({ code: "RAW_BODY_CODE", password: "hunter2", name: "kai" }) as Record<string, unknown>;
    expect(out.code).toBe("RAW_BODY_CODE");
    expect(out.password).toBe("[REDACTED]");
    expect(out.name).toBe("kai");
  });
});
