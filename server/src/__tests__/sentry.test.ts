import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The module keeps DSN-derived state in module scope. We re-import a fresh copy
// per test via vi.resetModules() so each test starts uninitialized.
async function loadSentry() {
  return import("../observability/sentry.js");
}

describe("observability/sentry", () => {
  const originalDsn = process.env.SENTRY_DSN;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("initSentry() is a no-op and returns false when SENTRY_DSN is unset", async () => {
    const { initSentry, isSentryInitialized } = await loadSentry();
    expect(initSentry()).toBe(false);
    expect(isSentryInitialized()).toBe(false);
  });

  it("initSentry() returns false for an unparseable DSN", async () => {
    process.env.SENTRY_DSN = "not-a-valid-dsn";
    const { initSentry, isSentryInitialized } = await loadSentry();
    expect(initSentry()).toBe(false);
    expect(isSentryInitialized()).toBe(false);
  });

  it("captureServerError() does not throw and does not fetch when uninitialized", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { captureServerError, isSentryInitialized } = await loadSentry();
    expect(isSentryInitialized()).toBe(false);
    expect(() => captureServerError(new Error("boom"))).not.toThrow();
    expect(() =>
      captureServerError("string error", { method: "GET", url: "/x" }),
    ).not.toThrow();
    expect(() => captureServerError(undefined)).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("captureServerError() POSTs to the derived store URL with the auth header when initialized", async () => {
    process.env.SENTRY_DSN = "https://abc123@o42.ingest.sentry.io/777";
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { initSentry, captureServerError, isSentryInitialized } =
      await loadSentry();
    expect(initSentry()).toBe(true);
    expect(isSentryInitialized()).toBe(true);

    captureServerError(new Error("kaboom"), { method: "POST", url: "/things" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://o42.ingest.sentry.io/api/777/store/");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["X-Sentry-Auth"]).toBe(
      "Sentry sentry_version=7, sentry_key=abc123, sentry_client=agentdash/1.0",
    );
    expect(headers["Content-Type"]).toBe("application/json");

    const payload = JSON.parse(init.body as string);
    expect(payload.level).toBe("error");
    expect(payload.platform).toBe("node");
    expect(payload.exception.values[0]).toMatchObject({
      type: "Error",
      value: "kaboom",
    });
    expect(payload.extra).toEqual({ method: "POST", url: "/things" });
    expect(typeof payload.event_id).toBe("string");
    expect(payload.event_id).toHaveLength(32);
  });

  it("captureServerError() swallows transport errors and never throws when initialized", async () => {
    process.env.SENTRY_DSN = "https://key@host.example/1";
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { initSentry, captureServerError } = await loadSentry();
    expect(initSentry()).toBe(true);
    expect(() => captureServerError(new Error("boom"))).not.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
