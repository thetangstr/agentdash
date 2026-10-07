// AgentDash (scan 4 lane O1, GH #992): credential redaction shared by the UI
// (display hygiene, PR #990) and the server (run logs persisted and served).
// Agents run shell commands that carry credentials (curl headers, env
// assignments, DSNs, JSON bodies), and tools echo them back. One pattern set
// keeps the redaction identical on both sides.
//
// The patterns are anchored so ordinary text survives: `KEYBOARD=us`,
// `echo MONKEY=banana`, `grep 'TOKEN=' src`, `token: 1500 tokens used` and
// prose such as "Authorization: required for this endpoint" are left alone.
// Identifier fields (`taskKey`, `sessionKey`, `issueKey`, `cacheKey`,
// `documentKey`, `idempotencyKey`) are never blanked — `redactSecretsInValue`
// uses the stricter isSecretValueKey for whole-value replacement.
//
// Detection runs on a normalized copy of the input (zero-width codepoints
// stripped, \u00XX escapes decoded) but replacements are applied to the
// ORIGINAL text via an index map, so stored logs keep their ZWJ emoji and
// escape sequences untouched except where a secret is removed.

export const REDACTED = "***REDACTED***";

/**
 * Version of the redaction rules below. Bump it with ANY change to what gets
 * redacted (patterns, known-secret forms, normalization): anything that
 * trusted output as "already redacted" under an older version must redact it
 * again. The server's written-redacted run-log mark is bound to it.
 */
export const REDACTION_RULES_VERSION = 1;

export type KnownSecrets = readonly (string | null | undefined)[];

const MIN_KNOWN_SECRET_LENGTH = 6;
const SECRET_FRAGMENT_LENGTH = 14;
const STREAM_MAX_HOLD = 64 * 1024;
const PEM_MAX_HOLD = 256 * 1024;

/**
 * Segments that mark a name as a credential anywhere (log text, env names).
 * `KEY` counts here — `MYAPP_KEY=…` in a log is almost always a credential,
 * and over-redacting a log line is the safe direction.
 */
const SECRET_NAME_SEGMENTS = new Set([
  "TOKEN", "KEY", "APIKEY", "SECRET", "PASSWORD", "PASSWD", "AUTHORIZATION", "JWT",
  "CREDENTIAL", "CREDENTIALS", "COOKIE", "SIGNATURE",
]);

/**
 * Segments that mark a name as a credential for whole-value blanking and
 * structured (`name: value` / JSON key) matching. `KEY` alone is excluded:
 * `taskKey`, `sessionKey`, `cacheKey`, `documentKey`, `idempotencyKey`,
 * `issueKey`, `publicKey` and `recoveryKey` are identifiers, not secrets.
 */
const STRONG_SECRET_NAME_SEGMENTS = new Set([
  "TOKEN", "APIKEY", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "AUTHORIZATION",
  "JWT", "CREDENTIAL", "CREDENTIALS", "COOKIE", "SIGNATURE", "PRIVATE", "BEARER",
]);

/**
 * Segments that qualify a trailing `KEY` as a credential:
 * `apiKey`, `privateKey`, `masterKey`, `encryptionKey`, `secretAccessKey`.
 * Deliberately absent: TASK, ISSUE, SESSION, CACHE, DOCUMENT, IDEMPOTENCY,
 * PUBLIC, RECOVERY and every other identifier-ish word.
 */
const SECRET_KEY_QUALIFIER_SEGMENTS = new Set([
  "API", "PRIVATE", "SECRET", "MASTER", "ACCESS", "ENCRYPTION", "DECRYPTION",
  "SIGNING", "SSH", "TLS", "SSL", "CLIENT", "CONSUMER", "SERVICE", "APP",
  "JWT", "AUTH", "BEARER", "DB", "DATABASE", "SMTP", "PGP", "GPG", "LICENSE",
]);

/**
 * Credential names that arrive as one undelimited word and would produce no
 * useful segments: `PGPASSWORD`, `MYAPPSECRET`, `AWSSECRETACCESSKEY`.
 */
const SECRET_NAME_SUFFIX_RE =
  /(?:PASSWORDS?|PASSWD|PASSPHRASE|SECRETS?|APIKEY|AUTHKEY|PRIVATEKEY|SECRETKEY|MASTERKEY|ACCESSKEY|ENCRYPTIONKEY|DECRYPTIONKEY|SIGNINGKEY|CLIENTSECRET|APPSECRET|APISECRET|USERSECRET|AUTHTOKEN|ACCESSTOKEN|REFRESHTOKEN|IDTOKEN|SESSIONTOKEN|BEARERTOKEN|JWTTOKEN|CREDENTIALS?|AUTHORIZATION)$/;

function nameToSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[_\-.]+/)
    .filter(Boolean);
}

/** `PAPERCLIP_API_KEY`, `api_key`, `key`, `PGPASSWORD` — but not `KEYBOARD` or `MONKEY`. */
export function isSecretName(name: string): boolean {
  const segments = nameToSegments(name);
  if (segments.some((segment) => SECRET_NAME_SEGMENTS.has(segment))) return true;
  return SECRET_NAME_SUFFIX_RE.test(segments.join(""));
}

/**
 * Stricter than isSecretName for object keys and `name: value` pairs, where a
 * false positive blanks an identifier instead of hiding a credential:
 * `taskKey`/`sessionKey`/`cacheKey` survive, `apiKey`/`privateKey`/
 * `secretAccessKey`/`x-api-key` still count.
 */
export function isSecretValueKey(name: string): boolean {
  const segments = nameToSegments(name);
  if (segments.some((segment) => STRONG_SECRET_NAME_SEGMENTS.has(segment))) return true;
  if (
    segments.length >= 2 &&
    segments[segments.length - 1] === "KEY" &&
    SECRET_KEY_QUALIFIER_SEGMENTS.has(segments[segments.length - 2])
  ) {
    return true;
  }
  return SECRET_NAME_SUFFIX_RE.test(segments.join(""));
}

/**
 * Whether an unquoted `name: value` value looks like a credential and not
 * prose. `hunter2pass99` and `f3b9…Qz9` qualify; `required`, `is`, `out` and
 * `1500` do not (letters+digits or special characters or length ≥ 16).
 * No upper bound: a 600-char bare value after `client_secret:` is still a
 * credential — every check below is a single linear scan.
 */
function looksLikeCredentialValue(value: string): boolean {
  if (value.length < 4) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  return /\d/.test(value) || /[_+/=\-.@~]/.test(value) || value.length >= 16;
}

/** Long header values with no scheme are redacted only when they look like credentials. */
function looksLikeCredential(value: string): boolean {
  if (value.length >= 20) return true;
  return /[0-9$_.=+/-]/.test(value);
}

// ---------------------------------------------------------------------------
// Normalization with an index map back to the original text.
//
// Obfuscation defeats literal patterns: zero-width characters inside a header
// name ("Authori​zation") or a token ("sk-ant-​api03-…"), and `\u00xx`
// escapes inside a JSON key ("api\u005fkey") or between key and colon
// ("\u0022"). Patterns run on the normalized copy; the map lets edits land on
// the original bytes so stored text is never mangled (ZWJ emoji survive,
// `\u` escapes in non-secret text are left alone).
// ---------------------------------------------------------------------------

function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    code === 0xfeff
  );
}

interface NormalizedText {
  text: string;
  /** start[i] = original index where normalized char i begins. */
  start: number[];
  /** end[i] = original index just past normalized char i. */
  end: number[];
}

const UNICODE_ESCAPE_TAIL = /^u00([0-9a-fA-F]{2})/;

function normalizeWithMap(text: string): NormalizedText {
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i) as number;
    const width = code > 0xffff ? 2 : 1;
    // `\u00XX` escape — but not when the backslash is itself escaped (`\\u00XX`).
    if (code === 0x5c && text.charCodeAt(i - 1) !== 0x5c) {
      const escape = text.slice(i + 1, i + 7).match(UNICODE_ESCAPE_TAIL);
      if (escape) {
        chars.push(String.fromCharCode(parseInt(escape[1], 16)));
        start.push(i);
        end.push(i + 6);
        i += 6;
        continue;
      }
    }
    if (!isZeroWidth(code)) {
      chars.push(String.fromCodePoint(code));
      // One map entry per UTF-16 unit — an astral char pushes a surrogate
      // pair into the normalized text, and without a second entry every
      // edit after it lands one unit off (the secret stays, text repeats).
      for (let u = 0; u < width; u++) {
        start.push(i);
        end.push(i + width);
      }
    }
    i += width;
  }
  return { text: chars.join(""), start, end };
}

// ---------------------------------------------------------------------------
// Pattern collection. Every pattern contributes edits {start,end,replacement}
// in normalized coordinates; edits replace only the secret span (never the
// name, separator, scheme or quotes), which keeps JSON/NDJSON valid.
// ---------------------------------------------------------------------------

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

const AUTH_SCHEMES = "(?:Bearer|Basic|Token|Digest|Bot|ApiKey|Key|Negotiate|AWS4-HMAC-SHA256)";

// `-----BEGIN … PRIVATE KEY----- … -----END …-----` (single and multi-line).
// The tempered body `(?:(?!-----BEGIN)[\s\S])*?` cannot cross another BEGIN
// marker, so an unterminated marker fails at the next one instead of scanning
// to end-of-input from every `-----BEGIN` position (quadratic on adversarial
// logs that repeat the marker).
const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----(?:(?!-----BEGIN)[\s\S]){0,262144}?-----END [A-Z0-9 ]{0,64}PRIVATE KEY-----/gd;

// `NAME=value` (env assignment, query parameter, `api_key = "…"`) and
// `NAME: value` (YAML, headers) with an optional auth scheme between
// separator and value. A bare value is a single flat character class — `\`
// is included, so a `\"` escape pair mid-token truncates the match at the
// quote; the callback extends through it when a token char follows and
// trims a trailing `\` run at a boundary. A quoted value either closes
// inside 2048 chars or hits the cap exactly — a lone unclosed quote stays
// prose (`grep 'TOKEN=' src`); at the cap the callback extends the redaction
// forward to the real closer, so >2048-char values are hidden whole.
// The name is bounded ({0,128}) and guarded by `(?<![\w.-])` — a dot/identifier
// run like `a.a.a.…` used to re-attempt a match at every char mid-run.
const NAME_VALUE_RE = new RegExp(
  `(?<![\\w.-])([A-Za-z_][A-Za-z0-9_.-]{0,128})([ \\t]*[:=][ \\t]*)(?:(${AUTH_SCHEMES})[ \\t]+)?(?![\\/]{2})("(?:\\\\.|[^"\\\\]){0,2048}"|"(?:\\\\.|[^"\\\\]){2048}|'(?:\\\\.|[^'\\\\]){0,2048}'|'(?:\\\\.|[^'\\\\]){2048}|[^\\s"',;=\`&|()?]+)`,
  "gid",
);
// Sticky mirror of the NAME_VALUE value alternation — anchored via lastIndex
// so the `=`-tail redaction can check "what follows the `=`" without copying
// the rest of the input into a slice.
const INNER_VALUE_STICKY_RE =
  /(?:"(?:\\.|[^"\\]){0,2048}"|"(?:\\.|[^"\\]){2048}|'(?:\\.|[^'\\]){0,2048}'|'(?:\\.|[^'\\]){2048}|[^\s"',;=`&|()?]+)/y;

// Cookie headers: everything to the end of the quoted value / line.
const COOKIE_HEADER_RE = /(\b(?:set-)?cookie[ \t]*:[ \t]*)([^\n]+)/gid;

// `scheme://userinfo@host`. Only the `scheme://` prefix is a regex match —
// the userinfo region is scanned in JS (see the callback below) because an
// `@`-terminated pattern can never match across a scan-piece edge and a
// bounded-minimum or alternation tail builds a regex backtrack frame per
// char, overflowing on multi-megabyte runs. The lookbehind blocks mid-run
// starts (`https://a:bhttps://a:b…`). Case-insensitive: `HTTPS://` counts.
const URL_SCHEME_RE = /(?<![\w+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)/gid;

// curl `-u user:pass`, `-uuser:pass`, `--user user:pass`, `--user=user:pass`.
const CURL_USER_RE = /(\s--user(?:[ \t]+|=)|\s-u(?:[ \t]+|=|(?=[^\s=-])))(["']?)([^\s"':=]+):([^\s"']*)\2/gd;
// curl `-b "name=value"` / `--cookie` (a cookie file path has no `=` and is kept).
const CURL_COOKIE_RE = /(\s(?:-b|--cookie)(?:[ \t]+|=))(["']?)([^\s"']+=[^\s"']*)\2/gd;

// mysql / mariadb `-p<password>` (no space). Only on those commands: elsewhere `-p8080` is a port.
const MYSQL_LINE_RE = /\b(?:mysql\w*|mariadb\w*)\b[^\n]*/gd;
const MYSQL_PASSWORD_RE = /([ \t]-p)(?![ \t])([^\s"']+)/gd;

// `--password x`, `--token=x`, `--api-key x`, `--client-secret=x`.
const CLI_SECRET_OPTION_RE =
  /((?:^|\s)--?(?:api[-_]?key|(?:access[-_]?|auth[-_]?|refresh[-_]?)?token|password|passwd|secret|client[-_]?secret|private[-_]?key|credentials?|passphrase|pgpassword)(?:[ \t]+|=))(["']?)(?!-)([^\s"']+)\2/gimd;

// JSON / Python-dict keys: `{"api_key": "…"}`, `{'x-api-key': '…'}`. Any quoted
// key name is checked against isSecretValueKey, so `x-api-key`, `PRIVATE-TOKEN`,
// `ZAI_API_KEY`, `session_token` and `secretAccessKey` are all covered while
// `{"key": "…"}` and `{"taskKey": "…"}` are left alone.
// Keys are bounded to 128 chars — an unbounded lazy key retries to
// end-of-input from every quote on an unterminated run (`API_KEY="` + `\"`×N),
// which is quadratic and blocks the event loop on a single hostile comment.
// 128 keeps the per-position retry cost small on adversarial input while
// covering any real credential field name.
const JSON_KV_RE =
  /("(?:\\.|[^"\\]){1,128}?")([ \t]*:[ \t]*)("(?:\\.|[^"\\]){0,2048}"|"(?:\\.|[^"\\]){2048}|'(?:\\.|[^'\\]){0,2048}'|'(?:\\.|[^'\\]){2048}|[^\s,}\]{[]+)|('(?:\\.|[^'\\]){1,128}?')([ \t]*:[ \t]*)('(?:\\.|[^'\\]){0,2048}'|'(?:\\.|[^'\\]){2048}|"(?:\\.|[^"\\]){0,2048}"|"(?:\\.|[^"\\]){2048})/gd;
// The `\"key\":\"value\"` form inside a JSON string. Two value alternatives:
// group 4 is content of a value that closes inside the cap; group 5 is
// exactly 2048 chars — a value past the cap, whose real `\"` closer the
// callback scans for and extends the redaction over.
// The value content units, in order: `\\\\\\\\` (4 backslashes = an escaped
// literal backslash), `\\\\\\"` (3 backslashes + quote = a quote inside the
// value — `JSON.stringify` of a `"` produces exactly that), `\\\\[^"\\]`
// (2 backslashes + other), `\\[^"\\]` (1 backslash + other), `[^"\\]`
// (plain char). Only a single-backslash `\"` can close the value — a `"`
// preceded by a `\` run ≡1 (mod 4) — matching closeEscapedJson.
const ESCAPED_JSON_KV_RE =
  /(\\")((?:\\.|[^"\\]){1,128}?)\\"([ \t]*:[ \t]*)\\"((?:\\\\\\\\|\\\\\\"|\\\\[^"\\]|\\[^"\\]|[^"\\]){0,2048})\\"|(\\")((?:\\.|[^"\\]){1,128}?)\\"([ \t]*:[ \t]*)\\"((?:\\\\\\\\|\\\\\\"|\\\\[^"\\]|\\[^"\\]|[^"\\]){2048})/gd;

// `Bearer <token>` anywhere (JSON bodies, headers embedded in strings).
// The value is a single flat character class — `\` is allowed mid-token
// (`ab\"key"` in a transcript) and a trailing run of `\` is trimmed in the
// callback, so a `\"` closing a JSON string stays outside the span. The
// flat class replaces the old `(?:X+|\\.){1,N}` alternation, which pushed a
// regex backtrack frame per character and overflowed the stack on
// multi-megabyte tokens.
const AUTH_SCHEME_VALUE_RE = /\b(Bearer|Basic|Token|Digest|Bot|ApiKey|Key|Negotiate|AWS4-HMAC-SHA256)([ \t]+)([^\s"'`,;\]]+)/gd;

// An AWS secret access key is an unmarked 40-char blob — only redactable when
// an AKIA access key id sits within ~300 chars on the same line(s).
const AWS_SECRET_AFTER_ID_RE = /(\bAKIA[0-9A-Z]{16}[^\n]{0,300}?)(?<![A-Za-z0-9/+=])([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gd;
const AWS_SECRET_BEFORE_ID_RE = /(?<![A-Za-z0-9/+=])([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])(?=[^\n]{0,300}?\bAKIA[0-9A-Z]{16})/gd;

// Well-known key shapes. `(?<![\w-])` (not `\b`) starts each pattern so a
// repeated prefix — `sk-sk-sk-…`, `eyJ-eyJ-…` — can only start at the run
// boundary, never mid-run where a `\b` would still match after `-`. The tail
// classes are unbounded: the lookbehind plus flat character classes keep the
// scan linear, and upper bounds would leak long keys. Every tail is written
// `X{min-1}X+`, never `X{min,}` — a bounded-minimum quantifier pushes a
// regex backtrack frame per character in V8 and overflows the call stack on
// multi-megabyte tokens; a fixed prefix plus a flat `+` does not.
const KEY_SHAPES: RegExp[] = [
  // Stripe secret / restricted keys and webhook signing secrets.
  /(?<![\w-])[rs]k_(?:live|test)_[A-Za-z0-9]{9}[A-Za-z0-9]+/gd,
  /(?<![\w-])whsec_[A-Za-z0-9]{9}[A-Za-z0-9]+/gd,
  /(?<![\w-])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{11}[A-Za-z0-9_-]+/gd,
  /(?<![\w-])gh[pousr]_[A-Za-z0-9_]{19}[A-Za-z0-9_]+/gd,
  /(?<![\w-])github_pat_[A-Za-z0-9_]{19}[A-Za-z0-9_]+/gd,
  // GitLab personal access tokens.
  /(?<![\w-])glpat-[A-Za-z0-9_-]{9}[A-Za-z0-9_-]+/gd,
  // xAI keys (xai-…).
  /(?<![\w-])xai-[A-Za-z0-9_-]{9}[A-Za-z0-9_-]+/gd,
  /(?<![\w-])xox[abprs]-[A-Za-z0-9-]{9}[A-Za-z0-9-]+/gd,
  /\bAKIA[0-9A-Z]{16}\b/gd,
  // Paperclip agent API keys (`pcp_…`), board keys (`pcp_board_…`) and CLI auth
  // tokens (`pcp_cli_auth_…`) share the prefix, so this covers all three.
  /(?<![\w-])pcp_[A-Za-z0-9_-]{7}[A-Za-z0-9_-]+/gd,
  /(?<![\w-])AIza[0-9A-Za-z_-]{29}[0-9A-Za-z_-]+/gd,
];
// JWTs always begin `eyJ` (base64 of `{"`). The match is a single flat class
// over the whole dotted run — the `.`-separated segment structure is checked
// in the callback, so a multi-megabyte token never builds a regex backtrack
// chain (a `X\.Y\.Z` pattern gives the run back one char at a time on
// failure, and can never match across scan pieces anyway).
const JWT_RUN_RE = /(?<![\w-])eyJ[A-Za-z0-9_.-]{19}[A-Za-z0-9_.-]+/gd;

// ---------------------------------------------------------------------------
// Known-secret forms: verbatim, common encodings, split-safe fragments and the
// reversed spelling (a `[...key].reverse()` probe in a transcript should still
// hide the key). Compiled into one alternation regex, cached by content.
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toBase64(secret: string): string | null {
  try {
    if (typeof Buffer !== "undefined") return Buffer.from(secret, "utf8").toString("base64");
    if (typeof btoa !== "undefined") return btoa(unescape(encodeURIComponent(secret)));
  } catch {
    // fall through — encoding a weird value must never break redaction
  }
  return null;
}

function toHex(secret: string): string {
  let out = "";
  for (let i = 0; i < secret.length; i++) out += secret.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

function secretEncodedForms(secret: string): string[] {
  const forms: string[] = [];
  const b64 = toBase64(secret);
  if (b64 && b64.length >= 8 && b64 !== secret) forms.push(b64);
  if (b64) {
    const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (b64url.length >= 8 && b64url !== secret && b64url !== b64) forms.push(b64url);
  }
  const hex = toHex(secret);
  if (hex.length >= 16 && hex !== secret) forms.push(hex);
  const urlEncoded = encodeURIComponent(secret);
  if (urlEncoded.length >= 8 && urlEncoded !== secret) forms.push(urlEncoded);
  if (secret.length >= 8) {
    const reversed = [...secret].reverse().join("");
    if (reversed !== secret) forms.push(reversed);
  }
  return forms;
}

/**
 * True when `value` contains a run of ≥8 sequential characters (a–z, A–Z or
 * 0–9, either direction). Such runs are low entropy — fragments cut from
 * them (`abcdefghijklmn`) collide with ordinary identifiers and the test
 * fixture alphabet inside values like `pk_live_abcdefghijklmnopqrstuvwx`.
 */
function hasSequentialRun(value: string, runLength = 8): boolean {
  let run = 1;
  for (let i = 1; i < value.length; i++) {
    const prev = value.charCodeAt(i - 1);
    const cur = value.charCodeAt(i);
    const sameClass =
      (prev >= 0x30 && prev <= 0x39 && cur >= 0x30 && cur <= 0x39) ||
      (prev >= 0x41 && prev <= 0x5a && cur >= 0x41 && cur <= 0x5a) ||
      (prev >= 0x61 && prev <= 0x7a && cur >= 0x61 && cur <= 0x7a);
    run = sameClass && Math.abs(cur - prev) === 1 ? run + 1 : 1;
    if (run >= runLength) return true;
  }
  return false;
}

/**
 * Windows of a known secret, so a key split across innocuous assignments
 * (`A=sk-proj-4f8a… B=…z9q2`) still hides each half. Only token-shaped
 * secrets get fragment matching — a fragment of a file path, URL or spaced
 * passphrase is an ordinary word (`…/secrets/master.key`, `…/.well-known/`),
 * and persist-time over-redaction cannot be undone. "Token-shaped" means a
 * URL-safe run with no `/` or spaces and some entropy: a digit, mixed case,
 * or a `_-~+=@` separator (dots alone don't count — dotted names like
 * `packages.something.foo` are identifiers). Each 14-char window is also
 * dropped when it is mostly a sequential run — `abcdefghijklmn` cut from an
 * alphabet-ordered secret collides with the alphabet inside unrelated
 * values like `pk_live_abcdefghijklmnopqrstuvwx`. A fragment needs 14
 * characters, so a 2-way split of a 28+ character secret is caught on
 * both sides.
 */
function secretFragments(secret: string): string[] {
  if (secret.length < 20 || !/^[A-Za-z0-9][A-Za-z0-9._~+=@-]*$/.test(secret)) return [];
  if (!/\d/.test(secret) && !(/[a-z]/.test(secret) && /[A-Z]/.test(secret)) && !/[_~+=@-]/.test(secret)) {
    return [];
  }
  const fragments = new Set<string>();
  for (let i = 0; i + SECRET_FRAGMENT_LENGTH <= secret.length; i++) {
    const fragment = secret.slice(i, i + SECRET_FRAGMENT_LENGTH);
    // Low-entropy windows stay out too: sequential runs collide with the
    // alphabet inside unrelated values, and near-uniform windows
    // (`00000000000000`) collide with ordinary padding.
    if (!hasSequentialRun(fragment) && new Set(fragment).size >= 3) {
      fragments.add(fragment);
    }
  }
  return [...fragments];
}

// Compiled matcher per exact secret list, bounded LRU. The key is taken
// BEFORE any derivation: building encodings and every 14-char fragment,
// sorting and joining them costs milliseconds per call for a dozen secrets,
// and `redactSecretsInValue` calls `redactSecrets` once per string — an
// NDJSON run-log read made thousands of calls and blocked the event loop for
// tens of seconds (2026-10-07 HQ stall). The derivation is a pure function of
// the list, so a hit returns exactly the regex a rebuild would produce.
const KNOWN_SECRETS_REGEX_CACHE_MAX = 32;
const knownSecretsRegexCache = new Map<string, RegExp | null>();

function knownSecretsCacheKey(secrets: readonly string[]): string {
  // Length-prefixed so no secret content can make two lists collide.
  let key = "";
  for (const secret of secrets) key += `${secret.length}:${secret}\u0000`;
  return key;
}

function knownSecretsRegex(secrets: readonly string[]): RegExp | null {
  if (secrets.length === 0) return null;
  const cacheKey = knownSecretsCacheKey(secrets);
  if (knownSecretsRegexCache.has(cacheKey)) {
    const cached = knownSecretsRegexCache.get(cacheKey) ?? null;
    // Refresh recency.
    knownSecretsRegexCache.delete(cacheKey);
    knownSecretsRegexCache.set(cacheKey, cached);
    return cached;
  }
  const regex = buildKnownSecretsRegex(secrets);
  knownSecretsRegexCache.set(cacheKey, regex);
  while (knownSecretsRegexCache.size > KNOWN_SECRETS_REGEX_CACHE_MAX) {
    const oldest = knownSecretsRegexCache.keys().next().value;
    if (oldest === undefined) break;
    knownSecretsRegexCache.delete(oldest);
  }
  return regex;
}

/** Test seam: size of the compiled known-secrets cache. */
export function __knownSecretsRegexCacheSizeForTests(): number {
  return knownSecretsRegexCache.size;
}

function buildKnownSecretsRegex(secrets: readonly string[]): RegExp | null {
  const literals = new Set<string>();
  for (const secret of secrets) {
    literals.add(secret);
    for (const form of secretEncodedForms(secret)) literals.add(form);
    for (const fragment of secretFragments(secret)) literals.add(fragment);
  }
  const all = [...literals].filter(Boolean).sort((a, b) => b.length - a.length);
  if (all.length === 0) return null;
  return new RegExp(all.map(escapeRegExp).join("|"), "gd");
}

// ---------------------------------------------------------------------------
// Edit collection over the normalized text.
// ---------------------------------------------------------------------------

/**
 * Iterate `regex` over `text`. When `fn` returns a number the scan rewinds to
 * that index and continues — used by NAME_VALUE_RE so a rejected `label:`
 * prefix does not swallow a `NAME=` that starts inside its value.
 */
function eachMatch(regex: RegExp, text: string, fn: (match: RegExpExecArray) => void | number): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const rewind = fn(match);
    if (typeof rewind === "number") {
      regex.lastIndex = Math.max(0, Math.min(rewind, text.length));
      continue;
    }
    if (match[0].length === 0) regex.lastIndex++;
  }
}

/** Span of a capture group, or null when the group did not participate. */
function groupSpan(match: RegExpExecArray, group: number): { start: number; end: number } | null {
  const indices = match.indices?.[group];
  if (!indices || indices[0] < 0) return null;
  return { start: indices[0], end: indices[1] };
}

// Past ~1MB the matcher runs on 1MB pieces with a 4KB tail carried into the
// next piece (like the stream redactor's keepTail). A regex match can then
// never span more than one piece — a multi-megabyte token used to recurse the
// regex engine past the call-stack limit — while the carry keeps a label or
// open value crossing the boundary matchable. A push whose span ends exactly
// at the piece edge is a truncated match: `push` extends it forward through
// `cont` (the pattern's value class), so the token is still redacted whole.
// Each piece also starts a few chars before its offset: a `(?<!…)` or `\b`
// at position 0 otherwise sees no left neighbor, and a token cut at the
// boundary could produce a false start (`a|sk-…`) or a missed one.
const SCAN_PIECE = 1024 * 1024;
const SCAN_OVERLAP = 4 * 1024;
const SCAN_LEFT = 64;

// Sticky single-char continuation classes — one per unbounded value shape.
const CONT_NAME_VALUE = /[^\s"',;=`&|()?]/y;
const CONT_AUTH_VALUE = /[^\s"'`,;\]]/y;
const CONT_JSON_BARE = /[^\s,}\]{[]/y;
const CONT_LINE = /[^\n]/y;
const CONT_TOKEN = /[^\s"']/y;
const CONT_KEY_SHAPE = /[A-Za-z0-9_.-]/y;
// Chars allowed after a mid-token `\"` escape pair — the strict lookahead
// classes the escape-pair alternatives used to carry. `{`, `[`, `}` and `]`
// are delimiters here (a `\"` before `}`/`]` is a JSON boundary, not token
// material) even though the main value classes allow them.
const PAIR_NEXT_NAME_VALUE = /[^\s"',;=`&|()?\\}\]]/y;
const PAIR_NEXT_AUTH = /[^\s"'`,;\]\\}\[{]/y;

/** Extend a piece-truncated match forward in `text` while `cont` matches. */
function extendRight(text: string, from: number, cont: RegExp): number {
  let i = from;
  while (i < text.length) {
    cont.lastIndex = i;
    if (!cont.test(text)) break;
    i = cont.lastIndex;
  }
  return i;
}

/**
 * Final end of a bare token/class match. The value classes include `\` but
 * exclude `"`, so a `\"` escape pair truncates the match at the quote — when
 * a token char follows the pair it is still the same value (`ab\"f3b9` in a
 * transcript). Also extend through a piece boundary while the class holds.
 * The caller trims a trailing `\` run so a boundary `\"` stays outside.
 */
function bareValueEnd(text: string, end: number, limit: number, cont: RegExp, pairNext: RegExp): number {
  for (;;) {
    if (text[end - 1] === "\\" && text[end] === '"' && end + 1 < text.length) {
      pairNext.lastIndex = end + 1;
      if (pairNext.test(text)) {
        end = extendRight(text, end + 1, cont);
        continue;
      }
    }
    if (end === limit && end < text.length) {
      const next = extendRight(text, end, cont);
      if (next === end) return end;
      end = next;
      continue;
    }
    return end;
  }
}

/**
 * Position just past the unescaped `q` that closes the quoted value starting
 * before `from`, or at EOL/end when no closer exists. Called when a quoted
 * value hit the {0,2048} pattern cap (or a piece edge) without its quote.
 */
function closeQuoted(text: string, from: number, q: string): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === q) return i + 1;
    if (c === "\n") return i;
  }
  return text.length;
}

/**
 * Position of the `\` starting the `\"` that closes an escaped-JSON string
 * value, or end of input. In doubly-escaped JSON a `"` closes the value only
 * when the `\` run before it has length ≡1 (mod 4): `\\\"` (≡3 mod 4) is an
 * escaped quote inside the value and `\\\\` (even) is a literal backslash —
 * a literal `\` at end-of-value makes the closer's run 5, 9, … Returning the
 * closer's start keeps the `\"` itself outside the redacted span.
 */
function closeEscapedJson(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) backslashes++;
    if (backslashes % 4 === 1) return i - 1;
  }
  return text.length;
}

function collectEdits(text: string, secrets: readonly string[]): Edit[] {
  const edits: Edit[] = [];
  // Per-byte claim mask. Marking and checking are both O(span), never
  // O(prior edits) — a linear `claimed` scan is quadratic on `-b a=`×N and
  // AWS-blob×N above the 1MB bound (11–14s and ~85s at 8MB before this
  // mask).
  const claimed = new Uint8Array(text.length);
  // End of the piece currently being scanned — a push ending exactly there is
  // a window-truncated match, extended through `cont` on the full text.
  let pieceEnd = text.length;
  const push = (start: number, end: number, replacement = REDACTED, cont?: RegExp): void => {
    if (cont && end === pieceEnd && end < text.length) end = extendRight(text, end, cont);
    if (end <= start) return;
    // A push fully inside earlier claims adds nothing; a PARTIALLY claimed
    // push fills each unclaimed sub-span instead of dropping — a short
    // match claimed first must not suppress a longer match's tail
    // (`PASSWORD=Pa55;word&<known>`: `Pa55` claimed by NAME_VALUE would
    // otherwise drop the known literal and leak `;word&<known>`).
    let i = start;
    while (i < end) {
      while (i < end && claimed[i]) i++;
      let j = i;
      while (j < end && !claimed[j]) j++;
      if (j <= i) return;
      claimed.fill(1, i, j);
      // Only a clean whole-span push keeps a custom replacement (e.g. the
      // PEM markers); split fills use the plain marker.
      edits.push({ start: i, end: j, replacement: i === start && j === end ? replacement : REDACTED });
      i = j;
    }
  };

  // PEM private-key blocks first — they claim the largest spans and keep the
  // BEGIN/END markers so the log still reads as a key. Runs once on the full
  // text: it is the only multi-line pattern and a windowed scan could split
  // the body.
  eachMatch(PEM_BLOCK_RE, text, (m) => {
    const block = m[0];
    const firstNl = block.indexOf("\n");
    const lastNl = block.lastIndexOf("\n");
    const replacement =
      firstNl >= 0 && lastNl > firstNl
        ? `${block.slice(0, firstNl + 1)}${REDACTED}\n${block.slice(lastNl + 1)}`
        : REDACTED;
    push(m.index, m.index + block.length, replacement);
  });

  // Configured (known) secrets next — once over the whole text and BEFORE
  // every pattern pass. A shorter pattern match claimed first would make the
  // literal's push land as a partial overlap: even with sub-span fill the
  // literal then redacts as two fragments and a custom shape in between can
  // still break it apart. Claimed first, the literal is a single span and
  // overlapping pattern pushes fill around it harmlessly. Running inside the
  // windows is also unsafe: a fragment claim in an earlier window can
  // suppress the full match in the next one and leak the tail.
  const known = knownSecretsRegex(secrets);
  if (known) {
    eachMatch(known, text, (m) => {
      if (m[0] === REDACTED) return;
      push(m.index, m.index + m[0].length);
    });
  }

  // Scan the piece [base, limit). Match spans are piece-relative; callbacks
  // translate to full-text offsets with `base` — context reads go to `text`
  // so a lookbehind/lookahead at the piece edge still sees real neighbours.
  const collect = (base: number, limit: number): void => {
    pieceEnd = limit;
    const slice = text.slice(base, limit);

    // An unmarked 40-char AWS secret only counts next to its AKIA id.
    eachMatch(AWS_SECRET_AFTER_ID_RE, slice, (m) => {
      const span = groupSpan(m, 2);
      if (span) push(base + span.start, base + span.end);
    });
    eachMatch(AWS_SECRET_BEFORE_ID_RE, slice, (m) => {
      const span = groupSpan(m, 1);
      if (span) push(base + span.start, base + span.end);
    });

    eachMatch(COOKIE_HEADER_RE, slice, (m) => {
      const span = groupSpan(m, 2);
      if (span && !m[2].includes(REDACTED)) push(base + span.start, base + span.end, REDACTED, CONT_LINE);
    });

    // `scheme://userinfo@host`. Only the `scheme://` prefix is a regex match —
    // the userinfo region is scanned in JS (see the callback below) because an
    // `@`-terminated pattern can never match across a scan-piece edge and a
    // bounded-minimum or alternation tail builds a regex backtrack frame per
    // char, overflowing on multi-megabyte runs. This runs BEFORE NAME_VALUE so
    // a secret name inside the URL (`x-access-token:`) cannot claim
    // `<token>@host/path` as its bare value and eat the host.
    eachMatch(URL_SCHEME_RE, slice, (m) => {
      const start = base + m.index + m[0].length;
      // `[` opens an IP literal (`http://[::1]:8080/…`) — never userinfo.
      if (text.charCodeAt(start) === 0x5b) return;
      let end = start;
      let at = -1;
      let atBeforeSlash = -1;
      let firstAt = -1;
      let colon = -1;
      let slash = -1;
      let backslash = -1;
      for (; end < text.length; end++) {
        const c = text.charCodeAt(end);
        if (c <= 0x20 || c === 0x22 || c === 0x27) break;
        if (c === 0x2f) {
          // Only a `://` (the next URL's scheme) ends the userinfo region —
          // `//` inside the password is content (`Zq8R//k2Vm…==` base64).
          if (text.charCodeAt(end + 1) === 0x2f && text.charCodeAt(end - 1) === 0x3a) break;
          if (slash === -1) slash = end;
        } else if (c === 0x40) {
          if (firstAt === -1) firstAt = end;
          if (slash === -1) atBeforeSlash = end;
          at = end;
        } else if (c === 0x3a && colon === -1) {
          colon = end;
        } else if (c === 0x5c && backslash === -1) {
          backslash = end;
        }
      }
      // The userinfo delimiter is the last `@` inside the authority — before
      // the host/path slash — when the text between that `@` and the `/`
      // reads as a host: an `[A-Za-z0-9-]+` label, or anything carrying `.`,
      // `:port`, `[`, or the name `localhost`. The exception: when a later
      // `@` in the region itself precedes a `/`, the slash-separated text is
      // password material, not a host — `u:p@ss/<key>@host/x` must redact
      // through `@host`, not stop at `p@` and leak `ss/<key>`. When every
      // `@` sits past a `/`, the slashes are password material and the last
      // `@` delimits.
      let delim = at;
      if (atBeforeSlash !== -1 && atBeforeSlash !== at) {
        const hostCandidate = text.slice(atBeforeSlash + 1, slash);
        const hostLike =
          /^[A-Za-z0-9-]+$/.test(hostCandidate) ||
          hostCandidate === "localhost" ||
          /[.:\[]/.test(hostCandidate);
        const rest = text.slice(slash, end);
        const laterAt = rest.indexOf("@");
        const moreBeforeSlash = laterAt !== -1 && rest.indexOf("/", laterAt + 1) !== -1;
        if (hostLike && !moreBeforeSlash) delim = atBeforeSlash;
      }
      if (delim < start) return;
      // `user:pass@` — the user has no `/`, `:` or `@`, and the pass keeps
      // `p@ssw0rd!`, `ab/cdEFGH12` and `//` pairs.
      if (colon > start && colon < delim && (slash === -1 || slash > colon) && firstAt > colon) {
        push(colon + 1, delim);
        return;
      }
      // `TOKEN@` bare userinfo — the token carries no `/`, `:` or `@`.
      if (
        (colon === -1 || colon > delim) &&
        (slash === -1 || slash > delim) &&
        (backslash === -1 || backslash > delim) &&
        delim - start >= 4
      ) {
        const candidate = text.slice(start, delim);
        if (looksLikeCredential(candidate)) push(start, delim);
      }
    });

    // `NAME=value` and `NAME: value`. `=` uses the broad matcher (env
    // assignments are intentional); `:` uses the strict matcher and requires
    // a credential-looking bare value so prose (`password: required`,
    // `token: 1500 tokens used`) and identifier fields survive.
    eachMatch(NAME_VALUE_RE, slice, (m) => {
      const name = m[1];
      const sep = m[2];
      const scheme = m[3];
      const value = m[4];
      const span = groupSpan(m, 4);
      if (!span) return;
      const isAssignment = sep.includes("=");
      if (isAssignment ? !isSecretName(name) : !isSecretValueKey(name)) {
        // A non-secret label (`run:`, `note:`, `x:`, `stdout:`) can swallow
        // an inner `NAME=` as its value — `run: TOKEN=abc` consumes `TOKEN`
        // and the `=abc` tail is never checked.
        if (/^["']/.test(value)) {
          // Quoted value: the assignment is inside the quotes
          // (`note: "API_KEY=…"`). Rewind to just inside the quote — bounded
          // by the closing quote, so it stays linear.
          return span.start + 1;
        }
        if (text[base + span.end] === "=") {
          // The value ends right before `=`: `run: TOKEN=…`, `step:
          // 1.TOKEN=…`. Walk back over identifier chars, then forward to the
          // first name-start char, and redact the `=`-value directly — a
          // rescan cannot be trusted to re-match here because the
          // `(?<![\w.-])` start guard deliberately blocks `TOKEN` inside
          // `1.TOKEN`.
          let start = span.end;
          while (start > span.start && /[A-Za-z0-9_.-]/.test(text[base + start - 1])) start--;
          while (start < span.end && !/[A-Za-z_]/.test(text[base + start])) start++;
          if (start === span.end) return;
          const tailName = text.slice(base + start, base + span.end);
          if (!isSecretName(tailName)) return start;
          // Sticky-anchored match at the char after `=` — no O(N) tail slice
          // per rewind. Runs on the full text, so the inner value is not
          // truncated at the piece edge.
          INNER_VALUE_STICKY_RE.lastIndex = base + span.end + 1;
          const inner = INNER_VALUE_STICKY_RE.exec(text);
          if (!inner) return start;
          let innerValue = inner[0];
          let innerEnd = inner.index + innerValue.length;
          const innerQuote = /^["']/.test(innerValue) ? innerValue[0] : "";
          if (innerQuote) {
            if (!innerValue.endsWith(innerQuote)) innerEnd = closeQuoted(text, innerEnd, innerQuote);
          } else {
            innerEnd = bareValueEnd(text, innerEnd, text.length, CONT_NAME_VALUE, PAIR_NEXT_NAME_VALUE);
            while (innerEnd > inner.index && text[innerEnd - 1] === "\\") innerEnd--;
            innerValue = text.slice(inner.index, innerEnd);
          }
          if (
            !innerValue ||
            innerValue.includes(REDACTED) ||
            /^["']?\$/.test(innerValue) ||
            /^["']?</.test(innerValue) ||
            /^["']?value["']?$/i.test(innerValue)
          ) {
            return;
          }
          push(inner.index, innerEnd, innerQuote ? `${innerQuote}${REDACTED}${innerQuote}` : REDACTED);
          return;
        }
        return;
      }
      const quote = /^["']/.test(value) ? value[0] : "";
      if (value === '""' || value === "''" || value === "") return;
      if (value.includes(REDACTED)) return;
      if (quote) {
        // A variable reference or doc placeholder is not a secret.
        if (/^["']?\$/.test(value) || /^["']?</.test(value) || /^["']?value["']?$/i.test(value)) {
          return;
        }
        if (!value.endsWith(quote)) {
          // The quoted value hit the {0,2048} pattern cap — extend the
          // redaction to the real closer (or EOL) so a >2048-char value is
          // hidden whole, then resume scanning after it.
          const close = closeQuoted(text, base + span.end, quote);
          push(base + span.start, close, `${quote}${REDACTED}${quote}`);
          return close - base;
        }
        push(base + span.start, base + span.end, `${quote}${REDACTED}${quote}`);
        return;
      }
      // Bare value: extend through mid-token `\"` escape pairs and the piece
      // edge, then drop trailing `\`s from the final end — a boundary `\`
      // is not token material.
      let valueEnd = bareValueEnd(text, base + span.end, limit, CONT_NAME_VALUE, PAIR_NEXT_NAME_VALUE);
      while (valueEnd > base + span.start && text[valueEnd - 1] === "\\") valueEnd--;
      const bare = text.slice(base + span.start, valueEnd);
      // A variable reference or command substitution is not itself a secret.
      if (/^["']?\$/.test(bare)) return;
      // Doc placeholders: `key=value`, `token=<your token>` — not credentials.
      if (/^["']?</.test(bare) || /^["']?value["']?$/i.test(bare)) return;
      if (!scheme && !isAssignment && !looksLikeCredentialValue(bare)) return;
      push(base + span.start, valueEnd);
    });

    eachMatch(CURL_USER_RE, slice, (m) => {
      const span = groupSpan(m, 4);
      if (span && m[4] && !m[4].includes(REDACTED)) {
        push(base + span.start, base + span.end, REDACTED, CONT_TOKEN);
      }
    });
    eachMatch(CURL_COOKIE_RE, slice, (m) => {
      const span = groupSpan(m, 3);
      if (span && !m[3].includes(REDACTED)) push(base + span.start, base + span.end, REDACTED, CONT_TOKEN);
    });

    eachMatch(MYSQL_LINE_RE, slice, (m) => {
      eachMatch(MYSQL_PASSWORD_RE, m[0], (inner) => {
        const span = groupSpan(inner, 2);
        if (span && inner[2] !== REDACTED) {
          push(base + m.index + span.start, base + m.index + span.end, REDACTED, CONT_TOKEN);
        }
      });
    });

    eachMatch(CLI_SECRET_OPTION_RE, slice, (m) => {
      const span = groupSpan(m, 3);
      if (span && m[3] !== REDACTED && !/^</.test(m[3])) {
        push(base + span.start, base + span.end, REDACTED, CONT_TOKEN);
      }
    });

    // Quoted JSON / Python-dict keys.
    eachMatch(JSON_KV_RE, slice, (m) => {
      const key = m[1] ?? m[4];
      const value = m[3] ?? m[6];
      const valueSpan = groupSpan(m, 3) ?? groupSpan(m, 6);
      if (!key || !value || !valueSpan) return;
      const name = key.slice(1, -1);
      if (!isSecretValueKey(name)) return;
      if (value.includes(REDACTED)) return;
      const quote = /^["']/.test(value) ? value[0] : "";
      if (!quote && !looksLikeCredentialValue(value)) return;
      // `{"token": "<your token>"}` is a doc placeholder, not a credential.
      if (quote && /^</.test(value.slice(1))) return;
      if (value === '"' || value === "'") return;
      if (quote && !value.endsWith(quote)) {
        // Value past the {0,2048} cap or the piece edge — extend to the
        // real closing quote (or end of object/input).
        const close = closeQuoted(text, base + valueSpan.end, quote);
        push(base + valueSpan.start, close, `${quote}${REDACTED}${quote}`);
        return close - base;
      }
      push(
        base + valueSpan.start,
        base + valueSpan.end,
        quote ? `${quote}${REDACTED}${quote}` : REDACTED,
        quote ? undefined : CONT_JSON_BARE,
      );
    });
    eachMatch(ESCAPED_JSON_KV_RE, slice, (m) => {
      const name = m[2] ?? m[6];
      const span = groupSpan(m, 4) ?? groupSpan(m, 8);
      const value = m[4] ?? m[8];
      if (!span || !name || !isSecretValueKey(name)) return;
      if (value.includes(REDACTED)) return;
      if (m[4] !== undefined) {
        push(base + span.start, base + span.end);
        return;
      }
      // Group 8: value at the {0,2048} cap with no `\"` closer — extend to
      // the real closer (kept outside the span) and resume after it.
      const close = closeEscapedJson(text, base + span.end);
      push(base + span.start, close);
      return Math.min(close + 2, text.length) - base;
    });

    // `Bearer x` / `Basic x` anywhere.
    eachMatch(AUTH_SCHEME_VALUE_RE, slice, (m) => {
      const span = groupSpan(m, 3);
      if (!span) return;
      // Extend through mid-token `\"` escape pairs and the piece edge, then
      // drop trailing `\`s from the final end — a boundary `\"` stays out.
      let valueEnd = bareValueEnd(text, base + span.end, limit, CONT_AUTH_VALUE, PAIR_NEXT_AUTH);
      while (valueEnd > base + span.start && text[valueEnd - 1] === "\\") valueEnd--;
      const bare = text.slice(base + span.start, valueEnd);
      if (bare === "" || bare.includes(REDACTED)) return;
      // `\X` escape pairs inside a token are part of it; strip before the
      // shape check so `ab\"key` is judged on `abkey`.
      const unescaped = bare.replace(/\\(.)/g, "$1");
      // Negated-class searches, not anchored `^X+$` tests — an anchored
      // full-match builds a regex backtrack frame per char and overflows the
      // stack on a multi-megabyte token.
      if (unescaped.length < 6 || /[^A-Za-z0-9._~+/=-]/.test(unescaped)) return;
      if (unescaped.length < 8 && !/\d/.test(unescaped)) return;
      // Prose like `Token authentication is required` or `Key rotation` is
      // not a credential: for the word-like schemes an all-letters value
      // only counts when it still looks token-ish (mixed case or >=20
      // chars), and a single Title-case word ("Key Exchange", "Bot
      // Framework") never does.
      if (/^(?:Token|Key|Bot|Basic)$/i.test(m[1])) {
        if (
          unescaped.length > 1 &&
          unescaped[0] >= "A" &&
          unescaped[0] <= "Z" &&
          !/[^a-z]/.test(unescaped.slice(1))
        ) {
          return;
        }
        if (
          !/[^A-Za-z]/.test(unescaped) &&
          unescaped.length < 20 &&
          !(/[a-z]/.test(unescaped) && /[A-Z]/.test(unescaped))
        ) {
          return;
        }
      }
      push(base + span.start, valueEnd);
    });

    for (const shape of KEY_SHAPES) {
      eachMatch(shape, slice, (m) => push(base + m.index, base + m.index + m[0].length, REDACTED, CONT_KEY_SHAPE));
    }

    // JWTs: the flat run match is extended to its real end first, then the
    // `header.payload.signature` segment structure is checked in JS — a
    // `X.Y.Z` regex can neither span pieces nor survive a multi-MB segment.
    eachMatch(JWT_RUN_RE, slice, (m) => {
      let end = base + m.index + m[0].length;
      if (end === limit && end < text.length) end = extendRight(text, end, CONT_KEY_SHAPE);
      const parts = text.slice(base + m.index, end).split(".");
      // `eyJ` + {4,} then two {8,} segments — the minimum real JWT shape.
      if (parts.length < 3 || parts[0].length < 7 || parts[1].length < 8 || parts[2].length < 8) return;
      push(base + m.index, end);
    });

  };

  // 1MB windows, each re-scanning the previous window's last 4KB so a
  // label/value crossing the boundary is matched whole (duplicate pushes
  // are dropped by the claim mask), and carrying 64 chars of left context
  // so lookbehind/`\b` at the window edge see real text. Small inputs take
  // the same path through a single window.
  for (let pos = 0; pos < text.length; pos += SCAN_PIECE) {
    collect(Math.max(0, pos - SCAN_LEFT), Math.min(pos + SCAN_PIECE + SCAN_OVERLAP, text.length));
  }
  return edits;
}

function normalizedSecrets(knownSecrets?: KnownSecrets): string[] {
  if (!knownSecrets) return [];
  return [...new Set(knownSecrets)]
    .filter((secret): secret is string => typeof secret === "string" && secret.length >= MIN_KNOWN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

/**
 * Hide credentials in text. Idempotent.
 *
 * `knownSecrets` are replaced verbatim, so a configured key that matches no
 * pattern is still hidden; the anchored pattern set then covers everything
 * key-shaped. Matching runs on a normalized copy; replacements are applied to
 * the original text.
 */
export function redactSecrets(text: string, knownSecrets?: KnownSecrets): string {
  if (!text) return text;
  const normalized = normalizeWithMap(text);
  if (normalized.text.length === 0) return text;
  const edits = collectEdits(normalized.text, normalizedSecrets(knownSecrets));
  if (edits.length === 0) return text;
  const original = edits
    .map((edit) => ({
      start: normalized.start[edit.start],
      end: normalized.end[edit.end - 1],
      replacement: edit.replacement,
    }))
    .sort((a, b) => a.start - b.start);
  // Build the output in one pass: splicing into `out` per edit is O(N) each
  // — quadratic on inputs that produce many edits (`mysql -pa`×N yields
  // ~270K at 1MB, ~5s before this). Contiguous same-marker edits coalesce
  // (sub-span fills around an earlier claim read as one redaction).
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of original) {
    if (edit.start < cursor) continue;
    const gap = text.slice(cursor, edit.start);
    if (gap) parts.push(gap);
    if (parts[parts.length - 1] !== edit.replacement) parts.push(edit.replacement);
    cursor = edit.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** True when `redactSecrets` would hide something in `text`. */
export function containsSecrets(text: string, knownSecrets?: KnownSecrets): boolean {
  if (!text) return false;
  const normalized = normalizeWithMap(text);
  if (normalized.text.length === 0) return false;
  return collectEdits(normalized.text, normalizedSecrets(knownSecrets)).length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `redactSecrets` over every string in a tool input or result, plus any
 * object value under a credential-named key (`{ "apiKey": "…" }`), so the
 * value is redacted before it is pretty-printed. Blank-or-redact uses the
 * strict isSecretValueKey so identifier keys (`taskKey`, `issueKey`,
 * `sessionKey`, `idempotencyKey`, `cacheKey`, `documentKey`) survive
 * untouched. Non-plain objects (Date, class instances) pass through.
 */
export function redactSecretsInValue<T>(value: T, knownSecrets?: KnownSecrets): T {
  if (typeof value === "string") return redactSecrets(value, knownSecrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactSecretsInValue(item, knownSecrets)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        typeof item === "string" && item && isSecretValueKey(key) && !/^(?:id|key)$/i.test(key)
          ? REDACTED
          : redactSecretsInValue(item, knownSecrets);
    }
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Stream redactor.
//
// Emitted text only ever ends at a line boundary, so the stream result matches
// redacting the joined text — a secret cut by a chunk boundary is still
// caught. Two failure modes are handled explicitly:
//
//  * Overlong single line: when the held buffer exceeds maxHold, all but the
//    trailing `keepTail` characters are emitted. keepTail covers the longest
//    possible secret form so a secret straddling the emit boundary is held
//    and completed by the next push instead of being split.
//  * PEM private-key blocks: once a BEGIN marker is emitted the body is held
//    (base64 body lines match no pattern and would pass through unredacted)
//    until the END marker arrives; the block is then emitted as
//    `BEGIN\n***REDACTED***\nEND`. If a body exceeds PEM_MAX_HOLD the marker
//    is emitted once and the rest of the body is dropped until END.
// ---------------------------------------------------------------------------

const PEM_BEGIN_LINE_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END_LINE_RE = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

// Absolute bound on the held tail when a line has no delimiter at all.
const STREAM_HARD_CAP = 1024 * 1024;

// Last whitespace/delimiter (` `, tab, newline, CR, `'`, `"`, `` ` ``, `,`, `;`)
// at or before `end`. `=` is excluded on purpose: `NAME=value` pairs must be
// held whole, or the bare value leaks without its secret name.
function lastDelimiterBefore(text: string, end: number): number {
  for (let i = Math.min(end, text.length) - 1; i >= 0; i--) {
    switch (text.charCodeAt(i)) {
      case 0x20:
      case 0x09:
      case 0x0a:
      case 0x0d:
      case 0x22:
      case 0x27:
      case 0x60:
      case 0x2c:
      case 0x3b:
        return i;
    }
  }
  return -1;
}

// How far back from the delimiter cut a label may sit. Delimiter-free
// regions (`"…"`, long tokens) separate `API_KEY="` from the cut, so the
// hold window must reach past the label, not just the value.
const LABEL_CONTEXT = 512;

// An "open label" at the end of emitted text: `Bearer `, `API_KEY=`,
// `API_KEY="`, `{"password": "`, `client_secret: `, `--token `, `-u `.
// Emitting the label alone and holding its value leaves the value
// patternless — it would leak on the next emit. Plain trailing words are
// not labels, so prose ending in ` word ` is unaffected.
const OPEN_LABEL_TAIL_RE =
  /(?:\b(?:Bearer|Basic|Token|Bot|Key|Digest|ApiKey|Negotiate|AWS4-HMAC-SHA256)|[A-Za-z_][A-Za-z0-9_.-]{0,128}[ \t]*[:=]|--[A-Za-z][A-Za-z0-9_-]{0,63}|-[a-zA-Z]|"[^"\n]{1,80}"[ \t]*:|'[^'\n]{1,80}'[ \t]*:)[ \t]*["']?$/;

export function createSecretStreamRedactor(
  knownSecrets?: KnownSecrets,
  maxHold = STREAM_MAX_HOLD,
): { push(chunk: string): string; flush(): string } {
  const secrets = normalizedSecrets(knownSecrets);
  const longestSecret = secrets.reduce((max, secret) => Math.max(max, secret.length), 0);
  // Hex encoding doubles the length; 256 covers separators, names and shape
  // patterns longer than any known secret.
  const keepTail = Math.max(1024, 2 * longestSecret + 256);
  let held = "";
  let inPem = false;
  let pemBytes = 0;
  let pemMarkerEmitted = false;

  return {
    push(chunk: string): string {
      if (!chunk) return "";
      let text = held + chunk;
      held = "";
      let out = "";
      for (;;) {
        const newline = text.indexOf("\n");
        if (newline < 0) break;
        const line = text.slice(0, newline + 1);
        text = text.slice(newline + 1);
        if (inPem) {
          pemBytes += line.length;
          if (PEM_END_LINE_RE.test(line)) {
            if (!pemMarkerEmitted) out += `${REDACTED}\n`;
            out += line;
            inPem = false;
            pemBytes = 0;
            pemMarkerEmitted = false;
          } else if (pemBytes > PEM_MAX_HOLD && !pemMarkerEmitted) {
            out += `${REDACTED}\n`;
            pemMarkerEmitted = true;
          }
          continue;
        }
        if (PEM_BEGIN_LINE_RE.test(line)) {
          inPem = true;
          pemBytes = line.length;
          out += line;
          continue;
        }
        out += line;
      }
      if (inPem) {
        // The trailing partial line is inside a PEM body — hold it so no
        // fragment of key material is emitted mid-block.
        pemBytes += text.length;
        if (pemBytes > PEM_MAX_HOLD && !pemMarkerEmitted) {
          out += `${REDACTED}\n`;
          pemMarkerEmitted = true;
        }
      } else if (text.length > maxHold) {
        // Never cut at a fixed position: a key starting a few chars before the
        // cut would be persisted in two halves. Emit only up to a delimiter
        // before the tail window so a token straddling it is held whole, and
        // keep the label that makes the held value recognizable — `Bearer `
        // or `password="` emitted alone leaves the value patternless, and it
        // leaks on the next emit. `=` is deliberately not a delimiter —
        // `NAME=value` must be held as one piece. With no delimiter at all
        // the buffer keeps growing until STREAM_HARD_CAP, where all but the
        // tail window is emitted (redacted) to bound memory.
        const emitEnd = text.length - keepTail;
        let cut = lastDelimiterBefore(text, emitEnd);
        if (cut >= 0) {
          // Hold label context too: the delimiter just before a straddling
          // value separates it from its label.
          cut = lastDelimiterBefore(text, cut - LABEL_CONTEXT);
          // If the new emit point still lands right after a label
          // (`... Bearer `, `... password="`), hold the label as well.
          for (let guard = 8; cut >= 0 && guard > 0; guard--) {
            // Only the last 512 chars — a label never reaches further back,
            // and scanning the whole prefix here is O(buffer) per emit.
            const tail = OPEN_LABEL_TAIL_RE.exec(
              text.slice(Math.max(0, cut + 1 - LABEL_CONTEXT), cut + 1),
            );
            if (!tail || tail[0].length === 0) break;
            const next = lastDelimiterBefore(text, cut + 1 - tail[0].length);
            if (next < 0) {
              cut = -1;
              break;
            }
            cut = next;
          }
        }
        if (cut >= 0) {
          out += text.slice(0, cut + 1);
          held = text.slice(cut + 1);
        } else if (text.length > STREAM_HARD_CAP) {
          // Delimiter-free even at the cap: emit up to the tail window and
          // keep holding the tail so a straddling secret stays together.
          const capEnd = text.length - keepTail;
          out += text.slice(0, capEnd);
          held = text.slice(capEnd);
        } else {
          held = text;
        }
      } else {
        held = text;
      }
      return out ? redactSecrets(out, secrets) : "";
    },
    flush(): string {
      const rest = held;
      held = "";
      if (inPem) {
        inPem = false;
        pemBytes = 0;
        pemMarkerEmitted = false;
        // An unterminated PEM body must never be emitted raw.
        return rest.length > 0 ? `${REDACTED}\n` : "";
      }
      return rest ? redactSecrets(rest, secrets) : "";
    },
  };
}

/** Shown in Raw views, where redacted text could otherwise read as the real log. */
export const CREDENTIALS_HIDDEN_NOTE = "Credentials in this log are hidden.";
