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
      start.push(i);
      end.push(i + width);
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
const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gd;

// `NAME=value` (env assignment, query parameter, `api_key = "…"`) and
// `NAME: value` (YAML, headers) with an optional auth scheme between
// separator and value. A bare value may contain `\X` escape pairs mid-token
// (`Bearer ab\"key"` in a transcript) but never ends on one: the lookahead
// keeps a trailing `\"` (a JSON string boundary) out of the match.
const NAME_VALUE_RE = new RegExp(
  `(?<![\\w-])([A-Za-z_][A-Za-z0-9_.-]*)([ \\t]*[:=][ \\t]*)(?:(${AUTH_SCHEMES})[ \\t]+)?(?![\\/]{2})("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:[^\\s"'\\\\,;=\`&|()?]+|\\\\.(?=[^\\s"'\\\\,;=\`&|()?}\\]]))+)`,
  "gid",
);

// Cookie headers: everything to the end of the quoted value / line.
const COOKIE_HEADER_RE = /(\b(?:set-)?cookie[ \t]*:[ \t]*)((?:\\.|[^\n\\])+)/gid;

// `scheme://user:pass@host`. The password run is greedy so `p@ssw0rd!` and
// `ab/cdEFGH12` inside userinfo are fully consumed before the last `@`.
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"']+):([^\s"']+)@/gid;
// `scheme://TOKEN@host` — credential as the whole userinfo, no `user:` prefix.
const URL_BARE_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"'\\]{4,})@/gid;

// curl `-u user:pass`, `-uuser:pass`, `--user user:pass`, `--user=user:pass`.
const CURL_USER_RE = /(\s--user(?:[ \t]+|=)|\s-u(?:[ \t]+|=|(?=[^\s=-])))(["']?)([^\s"':=]+):([^\s"']*)\2/gd;
// curl `-b "name=value"` / `--cookie` (a cookie file path has no `=` and is kept).
const CURL_COOKIE_RE = /(\s(?:-b|--cookie)(?:[ \t]+|=))(["']?)([^\s"']*=[^\s"']*)\2/gd;

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
const JSON_KV_RE =
  /("(?:\\.|[^"\\])+?")([ \t]*:[ \t]*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]{[]+)|('(?:\\.|[^'\\])+?')([ \t]*:[ \t]*)('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/gd;
// The `\"key\":\"value\"` form inside a JSON string.
const ESCAPED_JSON_KV_RE =
  /(\\")((?:\\.|[^"\\])+?)\\"([ \t]*:[ \t]*)\\"((?:\\.|[^"\\])*)\\"/gd;

// `Bearer <token>` anywhere (JSON bodies, headers embedded in strings). The
// token may contain `\X` escape pairs mid-value (`ab\"key"`) but never ends
// on one, so a `\"` closing a JSON string stays outside the span.
const AUTH_SCHEME_VALUE_RE = /\b(Bearer|Basic|Token|Digest|Bot|ApiKey|Key|Negotiate|AWS4-HMAC-SHA256)([ \t]+)((?:[^\s"'`,;\]\\]+|\\.(?=[^\s"'`,;\]\\}\[{]))+)/gd;

// An AWS secret access key is an unmarked 40-char blob — only redactable when
// an AKIA access key id sits within ~300 chars on the same line(s).
const AWS_SECRET_AFTER_ID_RE = /(\bAKIA[0-9A-Z]{16}[^\n]{0,300}?)(?<![A-Za-z0-9/+=])([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gd;
const AWS_SECRET_BEFORE_ID_RE = /(?<![A-Za-z0-9/+=])([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])(?=[^\n]{0,300}?\bAKIA[0-9A-Z]{16})/gd;

// Well-known key shapes.
const KEY_SHAPES: RegExp[] = [
  // Stripe secret / restricted keys and webhook signing secrets.
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/gd,
  /\bwhsec_[A-Za-z0-9]{10,}/gd,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/gd,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/gd,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/gd,
  // GitLab personal access tokens.
  /\bglpat-[A-Za-z0-9_-]{10,}/gd,
  // xAI keys (xai-…).
  /\bxai-[A-Za-z0-9_-]{10,}/gd,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gd,
  /\bAKIA[0-9A-Z]{16}\b/gd,
  // Paperclip agent API keys (`pcp_…`), board keys (`pcp_board_…`) and CLI auth
  // tokens (`pcp_cli_auth_…`) share the prefix, so this covers all three.
  /\bpcp_[A-Za-z0-9_-]{8,}/gd,
  /\bAIza[0-9A-Za-z_-]{30,}/gd,
  // JWTs always begin `eyJ` (base64 of `{"`). Requiring it keeps dotted
  // identifiers like `packages.something.abcdefgh` untouched.
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})?\b/gd,
];

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

const knownSecretsRegexCache = new Map<string, RegExp>();

function knownSecretsRegex(secrets: readonly string[]): RegExp | null {
  const literals = new Set<string>();
  for (const secret of secrets) {
    literals.add(secret);
    for (const form of secretEncodedForms(secret)) literals.add(form);
    for (const fragment of secretFragments(secret)) literals.add(fragment);
  }
  const all = [...literals].filter(Boolean).sort((a, b) => b.length - a.length);
  if (all.length === 0) return null;
  const cacheKey = all.join("");
  let regex = knownSecretsRegexCache.get(cacheKey);
  if (!regex) {
    regex = new RegExp(all.map(escapeRegExp).join("|"), "gd");
    if (knownSecretsRegexCache.size > 64) knownSecretsRegexCache.clear();
    knownSecretsRegexCache.set(cacheKey, regex);
  }
  return regex;
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

function collectEdits(text: string, secrets: readonly string[]): Edit[] {
  const edits: Edit[] = [];
  const claimed: Array<[number, number]> = [];
  const push = (start: number, end: number, replacement = REDACTED): void => {
    if (end <= start) return;
    for (const [s, e] of claimed) {
      if (start < e && end > s) return;
    }
    claimed.push([start, end]);
    edits.push({ start, end, replacement });
  };

  // PEM private-key blocks first — they claim the largest spans and keep the
  // BEGIN/END markers so the log still reads as a key.
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

  // An unmarked 40-char AWS secret only counts next to its AKIA id.
  eachMatch(AWS_SECRET_AFTER_ID_RE, text, (m) => {
    const span = groupSpan(m, 2);
    if (span) push(span.start, span.end);
  });
  eachMatch(AWS_SECRET_BEFORE_ID_RE, text, (m) => {
    const span = groupSpan(m, 1);
    if (span) push(span.start, span.end);
  });

  eachMatch(COOKIE_HEADER_RE, text, (m) => {
    const span = groupSpan(m, 2);
    if (span && !m[2].includes(REDACTED)) push(span.start, span.end);
  });

  // `NAME=value` and `NAME: value`. `=` uses the broad matcher (env
  // assignments are intentional); `:` uses the strict matcher and requires a
  // credential-looking bare value so prose (`password: required`,
  // `token: 1500 tokens used`) and identifier fields survive.
  eachMatch(NAME_VALUE_RE, text, (m) => {
    const name = m[1];
    const sep = m[2];
    const scheme = m[3];
    const value = m[4];
    const span = groupSpan(m, 4);
    if (!span) return;
    const isAssignment = sep.includes("=");
    if (isAssignment ? !isSecretName(name) : !isSecretValueKey(name)) {
      // A non-secret label (`run:`, `note:`, `x:`, `stdout:`) swallows the
      // inner name as its value — `run: TOKEN=abc` consumes `TOKEN` and the
      // `=abc` tail is never checked. Rewind to the value start so the inner
      // `NAME=` assignment is scanned on its own. The rescan always starts
      // strictly after this match's start, so the loop still terminates.
      return span.start;
    }
    if (value === '""' || value === "''" || value === "") return;
    if (value.includes(REDACTED)) return;
    // A variable reference or command substitution is not itself a secret.
    if (/^["']?\$/.test(value)) return;
    // Doc placeholders: `key=value`, `token=<your token>` — not credentials.
    if (/^["']?</.test(value) || /^["']?value["']?$/i.test(value)) return;
    if (!scheme && !isAssignment && !/^["']/.test(value) && !looksLikeCredentialValue(value)) return;
    const quote = /^["']/.test(value) ? value[0] : "";
    push(span.start, span.end, quote ? `${quote}${REDACTED}${quote}` : REDACTED);
  });

  eachMatch(URL_USERINFO_RE, text, (m) => {
    const span = groupSpan(m, 3);
    if (span && !m[3].includes(REDACTED)) push(span.start, span.end);
  });
  eachMatch(URL_BARE_USERINFO_RE, text, (m) => {
    const span = groupSpan(m, 2);
    if (span && looksLikeCredential(m[2])) push(span.start, span.end);
  });

  eachMatch(CURL_USER_RE, text, (m) => {
    const span = groupSpan(m, 4);
    if (span && m[4] && !m[4].includes(REDACTED)) push(span.start, span.end);
  });
  eachMatch(CURL_COOKIE_RE, text, (m) => {
    const span = groupSpan(m, 3);
    if (span && !m[3].includes(REDACTED)) push(span.start, span.end);
  });

  eachMatch(MYSQL_LINE_RE, text, (m) => {
    eachMatch(MYSQL_PASSWORD_RE, m[0], (inner) => {
      const span = groupSpan(inner, 2);
      if (span && inner[2] !== REDACTED) push(m.index + span.start, m.index + span.end);
    });
  });

  eachMatch(CLI_SECRET_OPTION_RE, text, (m) => {
    const span = groupSpan(m, 3);
    if (span && m[3] !== REDACTED && !/^</.test(m[3])) push(span.start, span.end);
  });

  // Quoted JSON / Python-dict keys.
  eachMatch(JSON_KV_RE, text, (m) => {
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
    push(valueSpan.start, valueSpan.end, quote ? `${quote}${REDACTED}${quote}` : REDACTED);
  });
  eachMatch(ESCAPED_JSON_KV_RE, text, (m) => {
    const name = m[2];
    const span = groupSpan(m, 4);
    if (!span || !isSecretValueKey(name)) return;
    if (m[4].includes(REDACTED)) return;
    push(span.start, span.end);
  });

  // `Bearer x` / `Basic x` anywhere.
  eachMatch(AUTH_SCHEME_VALUE_RE, text, (m) => {
    const span = groupSpan(m, 3);
    const value = m[3];
    if (!span || value.includes(REDACTED)) return;
    // `\X` escape pairs inside a token are part of it; strip before the shape
    // check so `ab\"key` is judged on `abkey`.
    const unescaped = value.replace(/\\(.)/g, "$1");
    if (!/^[A-Za-z0-9._~+/=-]{6,}$/.test(unescaped)) return;
    if (unescaped.length < 8 && !/\d/.test(unescaped)) return;
    // Prose like `Token authentication is required` or `Key rotation` is not
    // a credential: for the word-like schemes an all-letters value only
    // counts when it still looks token-ish (mixed case or >=20 chars), and a
    // single Title-case word ("Key Exchange", "Bot Framework") never does.
    if (/^(?:Token|Key|Bot|Basic)$/i.test(m[1])) {
      if (/^[A-Z][a-z]+$/.test(unescaped)) return;
      if (
        /^[A-Za-z]+$/.test(unescaped) &&
        unescaped.length < 20 &&
        !(/[a-z]/.test(unescaped) && /[A-Z]/.test(unescaped))
      ) {
        return;
      }
    }
    push(span.start, span.end);
  });

  for (const shape of KEY_SHAPES) {
    eachMatch(shape, text, (m) => push(m.index, m.index + m[0].length));
  }

  const known = knownSecretsRegex(secrets);
  if (known) {
    eachMatch(known, text, (m) => {
      if (m[0] === REDACTED) return;
      push(m.index, m.index + m[0].length);
    });
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
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of original) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return out;
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
  /(?:\b(?:Bearer|Basic|Token|Bot|Key|Digest|ApiKey|Negotiate|AWS4-HMAC-SHA256)|[A-Za-z_][A-Za-z0-9_.-]*[ \t]*[:=]|--[A-Za-z][A-Za-z0-9_-]*|-[a-zA-Z]|"[^"\n]{1,80}"[ \t]*:|'[^'\n]{1,80}'[ \t]*:)[ \t]*["']?$/;

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
            const tail = OPEN_LABEL_TAIL_RE.exec(text.slice(0, cut + 1));
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
