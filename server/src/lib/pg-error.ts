// AgentDash: PostgreSQL driver-error helpers.
//
// drizzle-orm >=0.45 wraps every driver error in a `DrizzleQueryError`
// (pg-core/session) whose original pg/postgres error — the one carrying the
// SQLSTATE `code`, `constraint`, and `constraint_name` fields — lives on
// `.cause` (potentially nested). Pre-0.45 code read `err.code` / `err.constraint`
// directly off the thrown error, so the bump silently breaks unique-violation
// (23505) idempotency handling across the server unless callers unwrap the
// cause chain. `unwrapPgError` returns the first object in the chain that looks
// like a driver error (has a string `code`), so existing checks keep working
// regardless of whether drizzle wrapped the error.

export interface PgErrorLike {
  code?: string;
  constraint?: string;
  constraint_name?: string;
  message?: string;
}

/**
 * Walk the `cause` chain of a thrown error and return the first object that
 * carries a SQLSTATE `code` (i.e. the underlying pg/postgres driver error),
 * or the original error if none is found. Bounded depth guards against cycles.
 */
export function unwrapPgError(error: unknown): PgErrorLike {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (typeof (current as { code?: unknown }).code === "string") {
      return current as PgErrorLike;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return (typeof error === "object" && error !== null ? error : {}) as PgErrorLike;
}

/** SQLSTATE for unique_violation. */
export const PG_UNIQUE_VIOLATION = "23505";

/** True when the (possibly drizzle-wrapped) error is a Postgres unique violation. */
export function isUniqueViolation(error: unknown): boolean {
  return unwrapPgError(error).code === PG_UNIQUE_VIOLATION;
}

/** Constraint name from a (possibly drizzle-wrapped) pg error, if present. */
export function pgConstraintName(error: unknown): string | undefined {
  const pg = unwrapPgError(error);
  return pg.constraint ?? pg.constraint_name;
}
