import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { recordServerError } from "../observability/error-sink.js";
import { unwrapPgError } from "../lib/pg-error.js";

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
    reqBody: req.body,
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
    res.status(400).json({ error: "Invalid identifier" });
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
