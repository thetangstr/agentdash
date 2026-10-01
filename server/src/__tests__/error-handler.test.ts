import express, { type NextFunction, type Request, type Response } from "express";
import { recordServerError } from "../observability/error-sink.js";
vi.mock("../observability/error-sink.js", () => ({ recordServerError: vi.fn() }));
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { recordServerError } from "../observability/error-sink.js";

vi.mock("../observability/error-sink.js", () => ({ recordServerError: vi.fn() }));

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
