import { isPrivateHumanInputRoute, redactHumanRequestBody } from "./redact-sensitive.js";
import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { recordServerError } from "../observability/error-sink.js";
import { unwrapPgError } from "../lib/pg-error.js";
import { logger } from "./logger.js";

/** SQLSTATE invalid_text_representation — a value Postgres could not cast. */
const PG_INVALID_TEXT_REPRESENTATION = "22P02";

/**
 * AgentDash: a malformed id that reached a uuid column is the caller's error.
 * Routes should validate ids before querying; this is the backstop for the
 * ones that do not. Only the uuid cast is mapped: 22P02 also covers enum and
 * json casts, where the bad value is more often the server's own bug and
 * should stay a recorded 500.
 */
function isInvalidUuidInput(err: unknown): boolean {
  const pg = unwrapPgError(err);
  return (
    pg.code === PG_INVALID_TEXT_REPRESENTATION &&
    typeof pg.message === "string" &&
    /invalid input syntax for type uuid/i.test(pg.message)
  );
}

/** SQLSTATE foreign_key_violation — the write named a row that does not exist. */
const PG_FOREIGN_KEY_VIOLATION = "23503";

function isForeignKeyViolation(err: unknown): boolean {
  return unwrapPgError(err).code === PG_FOREIGN_KEY_VIOLATION;
}

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * AgentDash (GH #863 item 4): the 400 above also hides the server's own bugs
 * that pass a bad uuid (a name where an id belongs, a stale variable). Keep a
 * warn-level trail: the route pattern, the method, and which path/query
 * parameters are not uuid-shaped. Names only, never values: a parameter can
 * be a secret (`/invites/:token`).
 */
function nonUuidParamNames(source: unknown): string[] {
  if (!source || typeof source !== "object") return [];
  const names: string[] = [];
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0 && !UUID_SHAPE_RE.test(value)) names.push(name);
  }
  return names;
}

export function invalidUuidLogFields(req: Request) {
  const routePath = (req as Request & { route?: { path?: unknown } }).route?.path;
  return {
    method: req.method,
    route: typeof routePath === "string" ? `${req.baseUrl ?? ""}${routePath}` : null,
    path: redactPathForLog(req.originalUrl ?? ""),
    nonUuidParams: nonUuidParamNames(req.params),
    nonUuidQuery: nonUuidParamNames(req.query),
  };
}

/** Drop the query string; it can carry tokens and is summarised by name above. */
function redactPathForLog(url: string): string {
  return url.split("?")[0] ?? "";
}

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: redactHumanRequestBody(req.originalUrl, req.body),
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  // AgentDash: database/adapter exceptions can embed source text in their
  // message or query. The error sink receives only a safe error on private paths.
  if (isPrivateHumanInputRoute(req.originalUrl) && !(err instanceof ZodError)) {
    if (err instanceof HttpError) {
      if (err.status >= 500) err = new HttpError(err.status, 'Private human operation failed');
    } else {
      err = new Error('Private human operation failed');
    }
  }
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
      // Local error sink (2026-08-16) — persists on the box, alerts by signal.
      recordServerError(err, { method: req.method, url: req.originalUrl, status: err.status });
    }
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  if (isInvalidUuidInput(err)) {
    logger.warn(
      invalidUuidLogFields(req),
      "invalid uuid reached the database; answered 400 (caller error, or a server bug if no listed parameter explains it)",
    );
    res.status(400).json({ error: "Invalid identifier" });
    return;
  }

  // AgentDash (GH #921): a foreign-key violation means the write referenced a
  // row that does not exist or cannot hold the reference — a client error on
  // any public route, never a recorded 500. Warn-logged for the same reason
  // as the uuid case: an FK failure the route did not expect is often a server
  // bug and should leave a trail.
  if (isForeignKeyViolation(err)) {
    logger.warn(
      invalidUuidLogFields(req),
      "foreign-key violation reached the error handler; answered 422 (caller referenced a missing row, or a server bug)",
    );
    res.status(422).json({ error: "Request references a resource that does not exist" });
    return;
  }

  // AgentDash (GH #921): express's body parsers (and other upstream
  // middleware) reject bad requests with an error that already carries a 4xx
  // status — `entity.parse.failed` for malformed JSON, `entity.too.large` for
  // an over-limit body. These used to fall through to a recorded 500. Any
  // error that arrives pre-tagged with a 4xx status is a client error and
  // answers that status; `expose` (body-parser's own marker for
  // client-safe text) decides whether the message goes out.
  const upstreamStatus = (err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  if (typeof upstreamStatus === "number" && upstreamStatus >= 400 && upstreamStatus < 500) {
    const expose = (err as { expose?: unknown }).expose;
    res.status(upstreamStatus).json({
      error: expose === true && err instanceof Error ? err.message : "Request failed",
    });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });
  // Local error sink (2026-08-16) — persists on the box, alerts by signal.
  recordServerError(rootError, { method: req.method, url: req.originalUrl, status: 500 });

  res.status(500).json({ error: "Internal server error" });
}
