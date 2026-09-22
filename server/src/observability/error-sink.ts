import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { serverErrors } from "@paperclipai/db";
import { emitSignal } from "./signals.js";
import { redactUrlQuery } from "../middleware/redact-sensitive.js";

/**
 * The local half of the 2026-08-16 observability decision: errors persist
 * HERE, on the box, in Postgres — the alerter carries only a one-line summary
 * off-box. This replaces a Sentry transport that was measured to drop every
 * event (`if (!target) return`) because nothing ever configured it.
 *
 * Fingerprinting strips the volatile parts — uuids, ids, numbers — so
 * "project 7f3a… not found" is ONE row counted 4,000 times, not 4,000 rows.
 * An error loop overnight must not fill the disk with copies of itself.
 */

const ID_LIKE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{16,}\b|\b\d{3,}\b/gi;

export function fingerprintError(name: string, message: string, stack?: string | null): string {
  const template = message.replace(ID_LIKE, "<id>").slice(0, 500);
  // Top in-repo frame only: deeper frames shift with unrelated refactors and
  // would split one defect into many rows.
  const topFrame =
    stack
      ?.split("\n")
      .slice(1)
      .find((line) => line.includes("/src/")) // first frame in our code
      ?.replace(ID_LIKE, "<id>")
      .replace(/:\d+:\d+/g, "") // line numbers shift; the function+file is the identity
      .trim() ?? "";
  return createHash("sha256").update(`${name}\n${template}\n${topFrame}`).digest("hex").slice(0, 32);
}

export interface ErrorSinkContext {
  method?: string;
  url?: string;
  status?: number;
  kind?: string;
}

let sinkDb: Db | null = null;

export function initErrorSink(db: Db): void {
  sinkDb = db;
}

/** Test seam. */
export function resetErrorSinkForTest(): void {
  sinkDb = null;
}

/**
 * Persist one error occurrence and emit a `server_error` signal.
 *
 * Never throws and never awaits in the caller's path — an error-reporting
 * failure on top of a real error must degrade to "only the original
 * problem". If the database itself is down, stderr is the sink of last
 * resort; that case is precisely when the DB-backed sink cannot help.
 *
 * Context is method/url/status ONLY — request bodies are deliberately not
 * accepted by this signature, so a future caller cannot leak one by accident.
 */
export function recordServerError(err: unknown, context?: ErrorSinkContext): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const fingerprint = fingerprintError(error.name, error.message, error.stack);

  // AGE-83: scrub credential-bearing query values from the URL at this
  // boundary — defense in depth, same posture as the signature above: even
  // if a future caller hands us a raw `req.originalUrl`, the URL that
  // reaches Postgres cannot carry a `?token=`/`?code=` value. fingerprintError
  // does not include the URL, so grouping is unaffected. Callers keep
  // passing `req.originalUrl` unchanged.
  const safeContext = context
    ? { ...context, url: context.url === undefined ? undefined : redactUrlQuery(context.url) }
    : context;

  const db = sinkDb;
  if (!db) {
    console.error(`[error-sink] not initialised; dropping ${error.name}: ${error.message}`);
    return;
  }

  void db
    .insert(serverErrors)
    .values({
      fingerprint,
      name: error.name.slice(0, 200),
      message: error.message.slice(0, 2000),
      stack: error.stack?.slice(0, 8000) ?? null,
      lastContext: safeContext ? { ...safeContext } : null,
    })
    .onConflictDoUpdate({
      target: serverErrors.fingerprint,
      set: {
        count: sql`${serverErrors.count} + 1`,
        lastSeen: sql`now()`,
        lastContext: safeContext ? { ...safeContext } : null,
        // message/stack refresh so the row shows the latest occurrence's shape
        message: error.message.slice(0, 2000),
        stack: error.stack?.slice(0, 8000) ?? null,
      },
    })
    .then(() => {
      emitSignal({
        kind: "server_error",
        summary: `${error.name}: ${error.message.replace(ID_LIKE, "<id>").slice(0, 140)}`,
        detail: { fingerprint, ...(safeContext ?? {}) },
      });
    })
    .catch((sinkErr) => {
      console.error("[error-sink] failed to persist error:", sinkErr);
      console.error("[error-sink] original error was:", error);
    });
}
