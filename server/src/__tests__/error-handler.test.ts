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

  // AgentDash (GH #921): a foreign-key violation means the caller referenced a
  // row that does not exist (or cannot hold the reference) — a 4xx, not a 500.
  // Warn-logged like the uuid case: an unexpected FK failure is often a server
  // bug and should leave a trail.
  it("maps a 23503 foreign-key violation to 422 with a warn log, not a recorded 500", () => {
    const req = makeReq();
    const res = makeRes() as any;
    vi.mocked(recordServerError).mockClear();
    vi.mocked(logger.warn).mockClear();

    errorHandler(
      drizzleWrapped("23503", 'insert or update on table "goals" violates foreign key constraint "goals_parent_id_goals_id_fk"'),
      req,
      res,
      vi.fn() as unknown as NextFunction,
    );

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({ error: "Request references a resource that does not exist" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(recordServerError).not.toHaveBeenCalled();
  });

  // AgentDash (GH #921): express.json() rejects malformed bodies with an error
  // carrying `status: 400`/`type: 'entity.parse.failed'`. It fell through to a
  // recorded 500. Any upstream error that already carries a 4xx status is a
  // client error and answers that status.
  it("answers a malformed JSON body with 400 instead of a recorded 500", () => {
    const req = makeReq();
    const res = makeRes() as any;
    vi.mocked(recordServerError).mockClear();
    const parseError = Object.assign(
      new SyntaxError("Unexpected token } in JSON at position 12"),
      { status: 400, statusCode: 400, type: "entity.parse.failed", expose: true },
    );

    errorHandler(parseError, req, res, vi.fn() as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(recordServerError).not.toHaveBeenCalled();
  });

  it("honours a 413 from the body-size limit the same way", () => {
    const req = makeReq();
    const res = makeRes() as any;
    vi.mocked(recordServerError).mockClear();
    const tooLarge = Object.assign(new Error("request entity too large"), {
      status: 413,
      statusCode: 413,
      type: "entity.too.large",
      expose: true,
    });

    errorHandler(tooLarge, req, res, vi.fn() as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(recordServerError).not.toHaveBeenCalled();
  });

  it("answers a real malformed JSON POST with 400 through an express app", async () => {
    vi.mocked(recordServerError).mockClear();
    const app = express();
    app.use(express.json());
    app.post("/api/goals", (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"title": ',
      });
      expect(response.status).toBe(400);
      expect(vi.mocked(recordServerError)).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
