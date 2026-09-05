// Redaction for HTTP log payloads.
//
// `customProps` in logger.ts copies `req.body` / `req.params` / `req.query`
// verbatim into the 4xx/5xx log lines so operators can diagnose. That means
// Better Auth's `POST /api/auth/sign-in/email` body (which has the user's
// plaintext password) and similar payloads (sign-up, reset-password, API
// keys via Authorization header equivalents) end up on disk.
//
// This walker returns a shallow copy of the input with values for sensitive
// keys replaced with the literal string "[REDACTED]". Recurses into nested
// objects/arrays. Caps depth so a hostile or accidental cycle can't pin
// the logger.

const SENSITIVE_KEYS = new Set<string>([
  "password",
  "currentpassword",
  "newpassword",
  "passwordconfirmation",
  "password_confirmation",
  "passwordconfirm",
  "password_confirm",
  "confirmpassword",
  "confirm_password",
  "secret",
  "client_secret",
  "clientsecret",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "api_key",
  "apikey",
  "authorization",
  "auth_token",
  "authtoken",
  "session_token",
  "sessiontoken",
  "private_key",
  "privatekey",
]);

const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_DEPTH) return undefined;
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSensitive(entry, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query-string credential scrubbing (AGE-83, dispositioned fix on AGE-82).
//
// #603 covered HTTP bodies and the session cookie, but request URLs still
// carried credential-bearing query values onto disk in four places: the raw
// `req.url` field pino-http serializes, the human-readable log message both
// success and error lines interpolate, the structured `reqQuery` object
// customProps attaches to >=400 lines, and the `lastContext.url` the error
// sink persists in Postgres. An OAuth `GET /callback?code=...` logged the
// authorization code in cleartext, world-readable, surviving rotation.
//
// The design points below come from Theo's scope on AGE-83:
//  - operate on the RAW string (no decode/re-encode round-trip) so encoded
//    values, odd encodings, or a hostile URL can't change the shape of the
//    output beyond redacting a value;
//  - split each pair on the FIRST `=` only;
//  - any throw or non-string input returns `[UNPARSEABLE_URL]` — never the
//    raw string, because a malformed URL is exactly the input we must not
//    echo to disk;
//  - this is a QUERY-channel list: broader than SENSITIVE_KEYS (which stays
//    untouched for body/params — the Greptile carve-out on AGE-82) because
//    URLs surface whole parameter names, including bare `code=`/`token=`
//    and OAuth `state`, which the body list deliberately does not cover.
// ---------------------------------------------------------------------------

const SENSITIVE_QUERY_KEYS = new Set<string>([
  "token",
  "code",
  "key",
  "secret",
  "password",
  "passwd",
  "pwd",
  "auth",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "api_key",
  "apikey",
  "authcode",
  "auth_code",
  "session",
  "sessionid",
  "session_id",
  "jwt",
  "otp",
  "sig",
  "signature",
  "hmac",
  "state",
  "verifier",
  "credential",
  "credentials",
  "client_secret",
  "clientsecret",
]);

/** Case-insensitive suffix rule: `authToken=`, `GITHUB_CODE=` etc. match. */
const SENSITIVE_QUERY_KEY_SUFFIXES = ["_token", "_secret", "_key", "_code", "_password"];

const UNPARSEABLE_URL = "[UNPARSEABLE_URL]";

function isSensitiveQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_QUERY_KEYS.has(lower)) return true;
  return SENSITIVE_QUERY_KEY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Scrub credential-bearing values from a URL's query string.
 *
 * Preserves everything before the first `?` verbatim (path, or an
 * absolute-form origin — pino-http hands us req.url, which for HTTP/1.1 is
 * usually path+query but can be the full origin), preserves pair order and
 * raw encoding, and redacts only matched values. Multi-value params
 * (`code=a&code=b`) redact each occurrence; params without `=` are left
 * untouched. Never throws: a non-string input or internal failure returns
 * the `[UNPARSEABLE_URL]` placeholder.
 */
export function redactUrlQuery(url: unknown): string {
  try {
    if (typeof url !== "string") return UNPARSEABLE_URL;
    const qIndex = url.indexOf("?");
    if (qIndex === -1) return url;

    const prefix = url.slice(0, qIndex + 1);
    const query = url.slice(qIndex + 1);
    if (query.length === 0) return url;

    const scrubbed = query
      .split("&")
      .map((pair) => {
        if (pair.length === 0) return pair;
        // First `=` only: everything after it is the value, `=`s included.
        const eqIndex = pair.indexOf("=");
        if (eqIndex === -1) return pair; // bare flag param — nothing to redact
        const key = pair.slice(0, eqIndex);
        if (!isSensitiveQueryKey(key)) return pair;
        return `${key}=${REDACTED}`;
      })
      .join("&");

    return `${prefix}${scrubbed}`;
  } catch {
    return UNPARSEABLE_URL;
  }
}

/**
 * Same walker shape as `redactSensitive` (shallow-copy, recursion,
 * MAX_DEPTH cap) but keyed on the query-string key list + suffix rule,
 * for the structured `reqQuery` object customProps attaches to >=400
 * log lines.
 */
export function redactQueryObject(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_DEPTH) return undefined;
    return value.map((entry) => redactQueryObject(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveQueryKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactQueryObject(entry, depth + 1);
  }
  return out;
}
