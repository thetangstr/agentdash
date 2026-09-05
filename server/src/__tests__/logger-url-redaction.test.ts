import { beforeEach, describe, expect, it, vi } from "vitest";
import { httpLogger } from "../middleware/logger.js";

/**
 * AGE-83 logger integration — drives the REAL pino-http 10.x middleware with
 * the REAL logger.ts option functions (only the destination is swapped for a
 * capture sink, and fs/config/home-paths are stubbed so importing logger.ts
 * does not touch the real log dir). This reproduces the AGE-80 probe shape
 * exactly: a 401 whose URL carries an OAuth code, plus a >=500 error line.
 *
 * TRAP this file pins (verified against pino-http 10.5.0 source in the
 * AGE-80 probe): pino-http wraps custom serializers with
 * wrapRequestSerializer, so the hook receives the ALREADY-SERIALIZED req
 * object ({id,method,url,headers,...}), not the Express request; and
 * pino-http routes ONLY err/res.err/>=500 through customErrorMessage — a 4xx
 * line carries its URL via customSuccessMessage, so both must scrub.
 */

const state = vi.hoisted(() => ({ lines: [] as string[] }));

// logger.ts calls pino.transport({targets:[...]}) at module scope; replace the
// worker transport with a synchronous capture sink so every emitted log line
// (main logger AND the pino-http child bound to it) lands in state.lines.
const mockTransport = vi.hoisted(() =>
  vi.fn(() => ({
    write: (chunk: string) => {
      state.lines.push(chunk);
    },
  })),
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn() };
});

vi.mock("pino", async () => {
  // Real pino for the sink; only the transport factory is stubbed.
  const mod = await vi.importActual<Record<string, unknown>>("pino");
  const actualPino = (mod.default ?? mod) as any;
  const stub: any = (opts: any, dest?: any) => actualPino(opts, dest);
  stub.transport = mockTransport;
  return { default: stub };
});

vi.mock("../config-file.js", () => ({
  readConfigFile: vi.fn(() => null),
}));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((p: string) => p),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/paperclip-age83-test-logs"),
}));

/** Minimal req double shaped the way pino-http consumes it. */
function makeReq(url: string, method = "GET", extra: Record<string, unknown> = {}) {
  return {
    method,
    url,
    headers: {} as Record<string, string>,
    ...extra,
  };
}

/**
 * Minimal res double. pino-http attaches its completion handler via res.on,
 * so we record listeners and re-emit them synchronously — the same contract
 * as a real http.ServerResponse for the 'finish' event.
 */
function makeRes(statusCode: number, err?: Error) {
  const listeners: Record<string, Array<() => void>> = {};
  const res: any = {
    statusCode,
    writableEnded: true,
    getHeaders: () => ({}),
    on(ev: string, fn: () => void) {
      (listeners[ev] ||= []).push(fn);
    },
    removeListener(ev: string, fn: () => void) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
    },
    once: vi.fn(),
  };
  if (err) res.err = err;
  res.emit = (ev: string) => {
    for (const fn of listeners[ev] ?? []) fn();
  };
  return res;
}

/** Drive the real middleware and return the JSON line it emitted on finish. */
function emitLine(req: ReturnType<typeof makeReq>, res: ReturnType<typeof makeRes>): any {
  const middleware = httpLogger as unknown as (
    req: unknown,
    res: unknown,
    next: () => void,
  ) => void;
  middleware(req, res, () => {});
  res.emit("finish");
  expect(state.lines.length).toBeGreaterThan(0);
  return JSON.parse(state.lines.at(-1)!);
}

describe("AGE-83 logger integration", () => {
  beforeEach(() => {
    state.lines.length = 0;
  });

  it("scrubs the URL in the serialized req field and the 401 message (customSuccessMessage path — the exact probe shape)", () => {
    const req = makeReq("/api/auth/callback?code=abc123&state=st9&next=/dashboard");
    const res = makeRes(401);

    const line = emitLine(req, res);

    expect(line.req?.url).toBe(
      "/api/auth/callback?code=[REDACTED]&state=[REDACTED]&next=/dashboard",
    );
    expect(line.msg).toBe(
      "GET /api/auth/callback?code=[REDACTED]&state=[REDACTED]&next=/dashboard 401",
    );
    expect(line.msg).not.toContain("abc123");
  });

  it("scrubs the >=500 message (customErrorMessage path)", () => {
    const req = makeReq("/api/broken?token=sekrit-value", "POST");
    const res = makeRes(500, new Error("boom"));

    const line = emitLine(req, res);

    expect(line.msg).toContain("token=[REDACTED]");
    expect(line.msg).not.toContain("sekrit-value");
    expect(line.req?.url).toBe("/api/broken?token=[REDACTED]");
  });

  it("routes reqQuery through the query list: code/token redacted, next/page intact", () => {
    const req = makeReq("/api/verify?code=c1&token=t1&next=/dashboard&page=2", "GET", {
      query: { code: "c1", token: "t1", next: "/dashboard", page: "2" },
    });
    const res = makeRes(400);

    const line = emitLine(req, res);

    expect(line.reqQuery).toMatchObject({
      code: "[REDACTED]",
      token: "[REDACTED]",
      next: "/dashboard",
      page: "2",
    });
  });

  it("reqBody regression at the middleware level: a body key named `code` is NOT newly redacted", () => {
    const req = makeReq("/api/thing", "POST", {
      body: { code: "RAW_BODY_CODE", password: "hunter2" },
    });
    const res = makeRes(400);

    const line = emitLine(req, res);

    expect(line.reqBody?.code).toBe("RAW_BODY_CODE");
    // password is censored — by pino's redact path (`[Redacted]`, pino's
    // default censor) and/or redactSensitive (`[REDACTED]`); either way it
    // must not appear in the clear.
    expect(String(line.reqBody?.password)).not.toBe("hunter2");
    expect(String(line.reqBody?.password)).toMatch(/^\[(Redacted|REDACTED)\]$/);
  });
});
