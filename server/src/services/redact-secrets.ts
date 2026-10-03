// AgentDash: scrub secrets out of text that is about to be logged or shown.
//
// Adapter output reaches the server log and the chat's "CoS couldn't reply"
// card, and some providers echo part of the credential back on a 401. Callers
// pass the keys they know about; generic shapes are scrubbed regardless.
//
// The anchored pattern set lives in `@paperclipai/shared` so the UI and the
// server share one implementation (GH #992). This wrapper adds exact-match
// known-key scrubbing plus server-only extra patterns for provider error
// text: masked key echoes ("sk-proj-****abcd"), Z.AI "<id>.<secret>" keys,
// and long hex/base64 blobs. The extras are deliberately NOT applied to run
// logs — long-hex would shred git SHAs in transcripts.
import { redactSecrets as redactSharedSecrets, isSecretName, REDACTED } from "@paperclipai/shared";

// Anchored on the asterisks with bounded flanks — unbounded `[A-Za-z0-9_-]*`
// on both sides re-attempts a scan at every char of an `a`-or-`*` run.
const MASKED_KEY_RE = /[A-Za-z0-9_-]{0,64}[*•]{3,}[A-Za-z0-9_-]{0,64}/g;

const FIELD_NAME_SECRET =
  /(["']?(?:api[_-]?key|apikey|x-api-key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]{1,1024}/gi;

const BASIC_SCHEME_RE = /(\bBasic\s+)[A-Za-z0-9._~+/=-]{8,1024}/g;

const EXTRA_PATTERNS: RegExp[] = [
  // Z.AI style "<id>.<secret>" keys.
  /\b[A-Za-z0-9]{24,256}\.[A-Za-z0-9]{8,256}/g,
  // Long hex strings (tokens, digests).
  /(?<![\w-])[a-f0-9]{32,4096}\b/gi,
  // Long base64-ish tokens. Paths and profile names are not matched: they
  // contain "_", "-" or "." every few characters, which breaks the run.
  /(?<![\w-])[A-Za-z0-9+/]{32,4096}={0,2}(?![A-Za-z0-9+/=])/g,
];

// A masked key echoed by a provider, e.g. "sk-proj-****abcd" or "****abcd".
// The adjacency guard keeps the `***REDACTED***` marker itself (and markdown
// emphasis) from being mangled on a second pass.
function redactMaskedKeys(text: string): string {
  return text.replace(MASKED_KEY_RE, (match: string, offset: number, whole: string) => {
    if (match.includes("REDACTED")) return match;
    const before = whole.slice(Math.max(0, offset - 8), offset);
    const after = whole.slice(offset + match.length, offset + match.length + 8);
    if (before.endsWith("REDACTED") || after.startsWith("REDACTED")) return match;
    return REDACTED;
  });
}

/** Replace each known key and anything key-shaped with "***REDACTED***". */
export function redactSecrets(text: string, knownKeys: readonly (string | undefined | null)[] = []): string {
  let out = redactSharedSecrets(text, knownKeys);
  out = redactMaskedKeys(out);
  // `Basic <credentials>` anywhere (shared covers `Bearer` already).
  out = out.replace(BASIC_SCHEME_RE, `$1${REDACTED}`);
  for (const pattern of EXTRA_PATTERNS) out = out.replace(pattern, REDACTED);
  // Key-value secrets by field name: "api_key":"...", api_key=..., token: ...
  out = out.replace(FIELD_NAME_SECRET, (match: string, head: string, offset: number, whole: string) => {
    const value = match.slice(head.length);
    if (value.startsWith("*")) return match;
    // `Authorization: Bearer ***REDACTED***` — the shared pass left the scheme
    // word in front of the marker; re-redacting "Bearer" would mangle it.
    if (
      /^(?:Bearer|Basic|Token|Digest|ApiKey|Key|Negotiate)$/i.test(value)
      && whole.slice(offset + match.length).trimStart().startsWith("*")
    ) {
      return match;
    }
    return `${head}${REDACTED}`;
  });
  return out;
}

// `*_FILE` / `*_PATH` / `*_DIR` / `*_URL` hold locations, not credential
// material — `PAPERCLIP_SECRETS_MASTER_KEY_FILE` is the path TO the key, and
// collecting the path would shred instance directories out of every log line.
const LOCATION_NAME_TAIL_RE = /_(?:FILE|PATH|DIR|URL)$/i;

// Publishable/public values are public by design — `pk_live_…`,
// `STRIPE_PUBLISHABLE_KEY`, `*_PUBLIC_KEY_URL` must never be redacted.
const PUBLIC_NAME_RE = /(?:^|_)(?:PUBLISHABLE|PUBLIC)(?:_|$)/i;

/** A value that is a filesystem path or URL is a pointer, not the secret. */
function looksLikeLocation(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("~")) return true;
  if (/^[/.]/.test(value)) {
    // A base64 secret can legitimately start with "/" — about 1 in 64 AWS
    // secret keys do — so a lone leading slash is not a path. A path needs
    // at least two slashes ("/a/b") and must not look like a base64 token.
    const slashes = (value.match(/\//g) ?? []).length;
    return slashes >= 2 && !/^[A-Za-z0-9+/=]{30,}$/.test(value);
  }
  return false;
}

/**
 * Whether a credential-named variable holds real secret material and is safe
 * to collect for verbatim matching. Paths, URLs and publishable keys are
 * excluded — collecting them shreds ordinary text out of every log line, and
 * persist-time over-redaction cannot be undone.
 */
export function isCollectableSecretValue(name: string, value: string): boolean {
  return (
    !LOCATION_NAME_TAIL_RE.test(name) &&
    !PUBLIC_NAME_RE.test(name) &&
    !looksLikeLocation(value) &&
    !/^pk_(?:live|test)_/.test(value)
  );
}

// UUIDs are identifiers, not secrets; a lowercase slug of
// hyphen/underscore-joined words (`database-password2-prod`) is a name.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD_SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;

/**
 * Whether a URL path segment is itself the credential rather than an
 * identifier. >=16 chars needs letters AND digits (`Zq8Rk2Vm7Tn4Wb9Xc3Ls`)
 * — an all-digit channel id, a UUID or a word slug is not a token. A
 * shorter segment (10-15) counts only when it also mixes case.
 *
 * `looseSlug` applies only to the LAST segment of a webhook URL, where the
 * token lives and slug shapes are legitimate (`ab12-cd34-ef56-gh78-ij90`,
 * `ZqRkVmTnWbXcLsQxZpLm`): >=16 chars with mixed case OR a digit is enough.
 * A lowercase word slug with no digits (`database-password-prod`) still
 * fails — the loosening does not resurrect that over-redaction.
 */
function isTokenishSegment(seg: string, looseSlug = false): boolean {
  if (seg.length < 10 || !/^[A-Za-z0-9_-]+$/.test(seg) || UUID_RE.test(seg)) return false;
  if (looseSlug && seg.length >= 16) {
    return /\d/.test(seg) || (/[a-z]/.test(seg) && /[A-Z]/.test(seg));
  }
  if (!/[A-Za-z]/.test(seg) || !/\d/.test(seg)) return false;
  if (seg.length >= 16) return !WORD_SLUG_RE.test(seg);
  return /[a-z]/.test(seg) && /[A-Z]/.test(seg);
}

/**
 * Whether a URL carries credential material — userinfo, a secret-named
 * query parameter (`?token=…`), or a token-like path segment (webhook
 * URLs). `https://oauth2.googleapis.com/token` and bare vault hosts do not
 * qualify: they are endpoints, not credentials.
 */
function urlCarriesCredential(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return true;
    for (const key of url.searchParams.keys()) if (isSecretName(key)) return true;
    // `seg` wrapper is load-bearing: `.some(isTokenishSegment)` would pass the
    // segment's index as `looseSlug`, loosening every segment past index 0.
    return url.pathname.split("/").some((seg) => isTokenishSegment(seg));
  } catch {
    return false;
  }
}

/** The credential fragments inside a credential-carrying URL. */
function credentialPartsOfUrl(raw: string, looseLastSegment = false): string[] {
  const parts: string[] = [];
  try {
    const url = new URL(raw);
    if (url.username && url.username.length >= 8) parts.push(decodeURIComponent(url.username));
    if (url.password && url.password.length >= 8) parts.push(decodeURIComponent(url.password));
    for (const [key, param] of url.searchParams) {
      // `sig`/`signature` are not secret names generally, but on a webhook
      // URL they carry the shared-secret signature — collect them so a bare
      // echo of the value is caught too.
      const credentialParam = isSecretName(key) || (looseLastSegment && /^(?:sig|signature)$/i.test(key));
      if (credentialParam && param.length >= 8) parts.push(param);
    }
    const segments = url.pathname.split("/");
    for (let i = 0; i < segments.length; i++) {
      if (isTokenishSegment(segments[i], looseLastSegment && i === segments.length - 1)) {
        parts.push(segments[i]);
      }
    }
  } catch {
    // malformed — nothing to extract
  }
  return parts;
}

/** Credentials this process was started with, for redacting adapter output. */
export function knownKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    const credentialNamed = isSecretName(name) || /_?KEY$/i.test(name);
    if (
      value.length >= 8 &&
      credentialNamed &&
      isCollectableSecretValue(name, value)
    ) {
      keys.push(value);
    }
    // A URL is normally a location, not a secret — even a secret-named one
    // (`OAUTH_TOKEN_URL=https://oauth2.googleapis.com/token` is the token
    // ENDPOINT, not the token). A WEBHOOK-named URL is always collected
    // verbatim: possessing the URL is the credential. Other secret-named
    // URLs collect only when they carry credential material: userinfo, a
    // secret-named query parameter, or a token-like path segment
    // (`hooks.slack.com/services/T…/B…/<token>`).
    const isWebhookNamed = /WEBHOOK/i.test(name);
    if (
      value.length >= 8 &&
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
      !PUBLIC_NAME_RE.test(name) &&
      (isWebhookNamed || (credentialNamed && urlCarriesCredential(value)))
    ) {
      keys.push(value);
      // The credential fragment on its own is also a known secret — a bare
      // `echo <token>` would not match the whole URL. A webhook URL's last
      // segment is the token even when slug-shaped, so it gets the looser
      // mixed-case-or-digit rule.
      for (const part of credentialPartsOfUrl(value, isWebhookNamed)) keys.push(part);
    }
    // DSNs carry their credential inline: postgres://user:pass@host, or a
    // bare userinfo credential like a Sentry DSN key (https://<key>@host).
    // It counts only when it looks real — the embedded default
    // `paperclip:paperclip` (user == pass, or a well-known default) would
    // redact a common word out of every line, and persist-time
    // over-redaction cannot be undone.
    const dsn = /^[a-z][a-z0-9+.-]*:\/\/([^\s/@"']+?)(?::([^\s/"']+))?@/i.exec(value);
    if (dsn) {
      const candidate = dsn[2] ?? dsn[1];
      if (
        candidate !== dsn[1] &&
        candidate.length >= 8 &&
        !/^(?:paperclip|postgres|password)$/i.test(candidate) &&
        (/\d/.test(candidate) || (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate)))
      ) {
        keys.push(candidate);
      } else if (!dsn[2] && candidate.length >= 16 && /\d/.test(candidate)) {
        // No ":" — the userinfo itself is the credential (Sentry-style keys
        // are long and digit-bearing); a bare username is not.
        keys.push(candidate);
      }
    }
  }
  return keys;
}
