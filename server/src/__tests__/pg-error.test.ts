import { describe, expect, it } from "vitest";
import {
  isUniqueViolation,
  PG_UNIQUE_VIOLATION,
  pgConstraintName,
  unwrapPgError,
} from "../lib/pg-error.js";

// Regression guard for the drizzle-orm 0.38 -> 0.45 bump: 0.45 wraps driver
// errors in a `DrizzleQueryError` whose original pg error lives on `.cause`.
// These helpers must unwrap that chain so unique-violation idempotency keeps
// working. See server/src/lib/pg-error.ts.
describe("pg-error helpers", () => {
  const rawPgError = Object.assign(new Error("duplicate key value"), {
    code: PG_UNIQUE_VIOLATION,
    constraint: "some_unique_idx",
  });

  it("detects a unique violation on a bare pg error (pre-0.45 shape)", () => {
    expect(isUniqueViolation(rawPgError)).toBe(true);
    expect(pgConstraintName(rawPgError)).toBe("some_unique_idx");
  });

  it("detects a unique violation when wrapped in a DrizzleQueryError (>=0.45 shape)", () => {
    const wrapped = Object.assign(new Error("Failed query: insert ..."), {
      query: "insert into ...",
      cause: rawPgError,
    });
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(pgConstraintName(wrapped)).toBe("some_unique_idx");
    expect(unwrapPgError(wrapped).code).toBe(PG_UNIQUE_VIOLATION);
  });

  it("unwraps a nested cause chain", () => {
    const wrapped = { cause: { cause: rawPgError } };
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(pgConstraintName(wrapped)).toBe("some_unique_idx");
  });

  it("reads constraint_name as a fallback", () => {
    const err = { code: PG_UNIQUE_VIOLATION, constraint_name: "alt_idx" };
    expect(pgConstraintName(err)).toBe("alt_idx");
  });

  it("returns false for non-unique-violation errors", () => {
    expect(isUniqueViolation(new Error("nope"))).toBe(false);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
