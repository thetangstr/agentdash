import pino from "pino";
import { describe, expect, it } from "vitest";
import { LOG_REDACT_PATHS } from "../middleware/logger.js";

/**
 * Every response >= 400 gets the request body attached to its log line — that
 * is deliberate and useful. A failed sign-in is a >= 400 response whose body
 * is the attempted password, so without redaction the log file collects
 * near-miss passwords in cleartext (found in the wild 2026-08-17, in a
 * world-readable file that survives rotation).
 *
 * This test does not go through the HTTP middleware; it proves the exported
 * redact paths, applied to a pino logger the way logger.ts applies them,
 * actually scrub a log line shaped like the ones customProps produces. If
 * someone renames the `reqBody` property or drops a path, this fails.
 */
describe("log redaction", () => {
  function logLineWith(props: Record<string, unknown>): Record<string, unknown> {
    const lines: string[] = [];
    const sink = { write: (line: string) => void lines.push(line) };
    const log = pino({ redact: LOG_REDACT_PATHS }, sink as pino.DestinationStream);
    log.warn(props, "POST /api/auth/sign-in/email 401");
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  }

  it("scrubs the attempted password from a failed sign-in line", () => {
    const line = logLineWith({
      reqBody: { email: "titus@mkthink.com", password: "hunter2-almost" },
    });
    const body = line.reqBody as Record<string, unknown>;
    expect(body.password).toBe("[Redacted]");
    // The email stays — it is what makes the log line diagnosable.
    expect(body.email).toBe("titus@mkthink.com");
  });

  it("scrubs the other credential-bearing body fields", () => {
    const line = logLineWith({
      reqBody: {
        currentPassword: "old",
        newPassword: "new",
        token: "XXPWkabbY80e2B5wie0mta5M",
      },
    });
    const body = line.reqBody as Record<string, unknown>;
    expect(body.currentPassword).toBe("[Redacted]");
    expect(body.newPassword).toBe("[Redacted]");
    expect(body.token).toBe("[Redacted]");
  });

  it("still redacts the authorization header", () => {
    const line = logLineWith({
      req: { headers: { authorization: "Bearer sk-live-something" } },
    });
    const req = line.req as { headers: Record<string, unknown> };
    expect(req.headers.authorization).toBe("[Redacted]");
  });
});
