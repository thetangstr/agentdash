import express, { type NextFunction, type Request, type Response } from "express";
import { recordServerError } from "../observability/error-sink.js";
vi.mock("../observability/error-sink.js", () => ({ recordServerError: vi.fn() }));
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { recordServerError } from "../observability/error-sink.js";
import { logger } from "../middleware/logger.js";

vi.mock("../observability/error-sink.js", () => ({ recordServerError: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

/** The shape drizzle >=0.45 throws: the driver error sits on `.cause`. */
function drizzleWrapped(code: string, message: string): Error {
  const driverError = Object.assign(new Error(message), { code });
  return Object.assign(new Error(`Failed query: select ... params: x`), { cause: driverError });
}

function makeReq(): Request {
  return {
    method: "GET",
    originalUrl: "/api/test",
    body: { a: 1 },
    params: { id: "123" },
    query: { q: "x" },
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  it("attaches the original Error to res.err for 500s", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("boom");
  });

  it("attaches HttpError instances for 500 responses", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "db exploded" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("db exploded");
  });

  it("maps a uuid cast failure (22P02, drizzle-wrapped) to a 400 and records no server error", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    vi.mocked(recordServerError).mockClear();

    errorHandler(
      drizzleWrapped("22P02", 'invalid input syntax for type uuid: "not-a-uuid"'),
      req,
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid identifier" });
    expect(res.__errorContext).toBeUndefined();
    expect(recordServerError).not.toHaveBeenCalled();
  });

  it("logs the 400-mapped uuid cast at warn with the route and the names of the non-uuid parameters", () => {
    const req = {
      method: "GET",
      originalUrl: "/api/issues/ACME-12/comments?cursor=not-a-uuid",
      baseUrl: "/api",
      route: { path: "/issues/:id/comments" },
      params: { id: "ACME-12" },
      query: { cursor: "not-a-uuid", limit: "10" },
      body: {},
    } as unknown as Request;
    const res = makeRes() as any;
    vi.mocked(logger.warn).mockClear();

    errorHandler(
      drizzleWrapped("22P02", 'invalid input syntax for type uuid: "ACME-12"'),
      req,
      res,
      vi.fn() as unknown as NextFunction,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = vi.mocked(logger.warn).mock.calls[0]! as unknown as [Record<string, unknown>];
    expect(fields).toEqual({
      method: "GET",
      route: "/api/issues/:id/comments",
      path: "/api/issues/ACME-12/comments",
      nonUuidParams: ["id"],
      nonUuidQuery: ["cursor", "limit"],
    });
  });

  it("keeps other 22P02 casts a recorded 500, since those are usually the server's own bug", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    vi.mocked(recordServerError).mockClear();

    errorHandler(
      drizzleWrapped("22P02", 'invalid input value for enum issue_status: "bogus"'),
      req,
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(recordServerError).toHaveBeenCalledTimes(1);
  });

  it("answers body-parser's malformed-JSON error as 400, not a recorded 500", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    vi.mocked(recordServerError).mockClear();

    // The shape body-parser (http-errors) raises for `{"name": broken`.
    const err = Object.assign(
      new Error('Unexpected token \'b\', "{"name": broken" is not valid JSON'),
      { status: 400, statusCode: 400, type: "entity.parse.failed", expose: true },
    );

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    // The raw parse message echoes request bytes — never reflect it back.
    expect(res.json).toHaveBeenCalledWith({ error: "Bad Request" });
    expect(res.__errorContext).toBeUndefined();
    expect(recordServerError).not.toHaveBeenCalled();
  });

  it("answers an oversized body as 413, not a recorded 500", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    vi.mocked(recordServerError).mockClear();

    const err = Object.assign(new Error("request entity too large"), {
      status: 413,
      statusCode: 413,
      type: "entity.too.large",
      expose: true,
    });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: "Payload Too Large" });
    expect(recordServerError).not.toHaveBeenCalled();
  });

  it("keeps a 4xx-marked error without expose a recorded 500", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    vi.mocked(recordServerError).mockClear();

    const err = Object.assign(new Error("internal validator bug"), { status: 400 });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(recordServerError).toHaveBeenCalledTimes(1);
  });

  it("maps a NUL/invalid-UTF8 rejection (22021, drizzle-wrapped) to a 400 and records no server error", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    vi.mocked(recordServerError).mockClear();

    errorHandler(
      drizzleWrapped("22021", 'invalid byte sequence for encoding "UTF8": 0x00'),
      req,
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Text contains a byte sequence Postgres cannot store",
    });
    expect(res.__errorContext).toBeUndefined();
    expect(recordServerError).not.toHaveBeenCalled();
  });
});

describe('private human failure diagnostics', () => {
  it.each(['/api/human-control/prepare', '/API/Human-Control/PREPARE', '/api/Companies/c/Workforce/Brief', '/API/companies/c/workforce/PROPOSALS/p/review', '/api/Issues/i/Interactions/q/Respond'])('keeps private source and unexpected errors out of the sink at %s', url => {
    vi.mocked(recordServerError).mockClear();
    const req = makeReq(); req.originalUrl = url;
    req.body = { input: { sources: [{ content: 'PRIVATE_SOURCE' }] } };
    const res = makeRes() as any;
    errorHandler(new Error('DB rejected PRIVATE_SOURCE'), req, res, vi.fn());
    expect(JSON.stringify(res.__errorContext)).not.toContain('PRIVATE_SOURCE');
    expect(res.err.message).toBe('Private human operation failed');
    expect(vi.mocked(recordServerError).mock.calls[0][0]).toMatchObject({ message: 'Private human operation failed' });
  });
});

 it('sanitizes a real mixed-case Express route before its error sink', async () => {
   vi.mocked(recordServerError).mockClear();
   const app = express(); app.use(express.json());
   app.post('/api/human-control/prepare', () => { throw new Error('PRIVATE_ROUTED_SOURCE'); });
   app.use(errorHandler);
   const server = app.listen(0, '127.0.0.1');
   await new Promise<void>(resolve => server.once('listening', resolve));
   try {
     const port = (server.address() as { port: number }).port;
     const response = await fetch(`http://127.0.0.1:${port}/API/HUMAN-CONTROL/PREPARE`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { source: 'PRIVATE_ROUTED_SOURCE' } }) });
     expect(response.status).toBe(500);
     expect(JSON.stringify(await response.json())).not.toContain('PRIVATE_ROUTED_SOURCE');
     expect(vi.mocked(recordServerError).mock.calls[0][0]).toMatchObject({ message: 'Private human operation failed' });
   } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
 });
