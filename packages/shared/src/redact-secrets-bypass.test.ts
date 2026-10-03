// Permanent regression tests from the PR #998 security review probe:
// authorization headers, env-name JSON keys, YAML/spaced assignments, URL
// userinfo edge cases, curl -u variants, identifier-field survival, NDJSON
// read-time safety and stream boundary handling.
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  redactSecrets,
  redactSecretsInValue,
  createSecretStreamRedactor,
} from "./redact-secrets.js";

const ANT = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SHAPELESS = "f3b9c2d1e4a5968778a1b2c3.Qz9XyW8vU7tS"; // Z.AI style
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const LEAKS: [string, string, string[]?][] = [
  ["auth bearer", `Authorization: Bearer ${SHAPELESS}`],
  ["auth basic", `Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==`],
  ["x-api-key", `x-api-key: ${SHAPELESS}`],
  ["goog", `X-Goog-Api-Key: ${SHAPELESS}`],
  ["private-token", `PRIVATE-TOKEN: glpat-abcdef123456`],
  ["json x-api-key header", `{"headers":{"x-api-key":"${SHAPELESS}"}}`],
  ["json X-Goog-Api-Key", `{"X-Goog-Api-Key": "${SHAPELESS}"}`],
  ["json PRIVATE-TOKEN", `{"PRIVATE-TOKEN": "abcdefghij123"}`],
  ["json authorization Basic", `{"Authorization": "Basic dXNlcjpwYXNzd29yZDEyMw=="}`],
  ["python headers", `headers = {'x-api-key': '${SHAPELESS}'}`],
  ["url userinfo", `postgres://admin:hunter2pass@db.local:5432/x`],
  ["url userinfo with slash", `https://user:ab/cdEFGH12@host/x`],
  ["url userinfo with @", `postgres://admin:p@ssw0rd!@db.local/x`],
  ["bare token url", `https://${"ghp_"}abcdefghij0123456789ABCD@github.com/o/r`],
  ["bare shapeless url", `https://${SHAPELESS}@github.com/o/r`],
  ["curl -u", `curl -u admin:hunter2pass https://x`],
  ["curl -u nospace", `curl -uadmin:hunter2pass https://x`],
  ["env unquoted", `export ZAI_API_KEY=${SHAPELESS}`],
  ["env quoted", `export ZAI_API_KEY="${SHAPELESS}"`],
  ["env spaced python", `api_key = "${SHAPELESS}"`],
  ["env spaced ini aws", `aws_secret_access_key = ${AWS_SECRET}`],
  ["yaml password", `password: hunter2pass99`],
  ["yaml client_secret", `client_secret: ${SHAPELESS}`],
  ["yaml ZAI_API_KEY", `ZAI_API_KEY: ${SHAPELESS}`],
  ["json api_key", `{"api_key":"${SHAPELESS}"}`],
  ["json apiKey", `{"apiKey":"${SHAPELESS}"}`],
  ["json access_token", `{"access_token":"${SHAPELESS}"}`],
  ["json session_token", `{"session_token":"${SHAPELESS}"}`],
  ["json ZAI_API_KEY env dump", `{"ZAI_API_KEY":"${SHAPELESS}"}`],
  ["json secretAccessKey", `{"secretAccessKey":"${AWS_SECRET}"}`],
  ["json \\u escape", `{"api\\u005fkey":"${SHAPELESS}"}`],
  ["json \\u full escape", `{"\\u0061pi_key":"${SHAPELESS}"}`],
  ["json \\u quote-escape key", `{"api_key\\u0022:\\u0022${SHAPELESS}"}`],
  ["json uppercase \\U", `{"tok\\u0065n":"${SHAPELESS}"}`],
  ["sk-", `key sk-abcdefghijklmnop1234`],
  ["sk-ant", `key ${ANT}`],
  ["sk_live", `sk_live_abcdefghij1234567890`],
  ["rk_live", `rk_live_abcdefghij1234567890`],
  ["whsec", `whsec_abcdefghij1234567890`],
  ["ghp", `ghp_abcdefghij0123456789ABCD`],
  ["github_pat", `github_pat_11ABCDEFG0123456789_abcdefghijk`],
  ["xai", `xai-abcdefghij1234567890`],
  ["pcp", `pcp_abcdef0123456789abcdef`],
  ["pcp board", `pcp_board_abcdef0123456789`],
  ["glpat", `glpat-abcdefghij1234567890`],
  ["PEM", `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----`],
  ["base64 of shapeless (known)", `echo ${Buffer.from(SHAPELESS).toString("base64")} | base64 -d`, [SHAPELESS]],
  ["base64 offset known", `echo ${Buffer.from("x:" + SHAPELESS).toString("base64")}`, [SHAPELESS]],
  ["split vars known", `A=${SHAPELESS.slice(0, 12)} B=${SHAPELESS.slice(12)}`, [SHAPELESS]],
  ["zero width header", `Authori​zation: Bearer ${SHAPELESS}`],
  ["zero width in key", `sk-ant-​api03-AbCdEfGhIjKlMnOp`],
  ["reversed known", `${[...SHAPELESS].reverse().join("")}`, [SHAPELESS]],
  ["mysql -p", `mysql -uroot -phunter2pass db`],
  ["--password", `psql --password hunter2pass`],
  ["PGPASSWORD", `PGPASSWORD=hunter2pass psql`],
  ["known short 6", `the key is abc123`, ["abc123"]],
  ["header in json array", `["Authorization","Bearer ${SHAPELESS}"]`],
  ["set -x trace", `+ curl -H 'X-Api-Key: ${SHAPELESS}' https://x`],
  ["lowercase bearer", `authorization: bearer ${SHAPELESS}`],
  ["bearer short", `Authorization: Bearer abc123`],
  // Shell-escaped quote inside a header value — the secret must not survive
  // past a `\"` mid-token (verify-shard 2 regression).
  ["header escaped quote", `curl -H "Authorization: Bearer ab\\"${SHAPELESS}" https://x.test`],
  ["bearer escaped quote", `Authorization: Bearer ab\\"${SHAPELESS}"`],
  ["token escaped quote", `api_token=ab\\"${SHAPELESS}"`],
  // A non-secret label prefix (`run:`, `note:`, `stdout:`, `DEBUG:`) must not
  // swallow the inner `NAME=` — re-review regression: the rejected match
  // consumed the name as its value and the `=…` tail was never scanned.
  ["label run token", `run: TOKEN=abc123xyz "next"`],
  ["label run token bare", `run: TOKEN=abc123xyz`],
  ["label run ZAI", `run: ZAI_API_KEY=${SHAPELESS}`],
  ["label step export", `step: export ZAI_API_KEY=${SHAPELESS} && ok`],
  ["label note api key", `note: API_KEY=${SHAPELESS}`],
  ["label x password", `x: password=hunter2pass`],
  ["label ERROR api_key", `ERROR: invalid api_key=${SHAPELESS}`],
  ["label mid-line", `foo: bar ZAI_API_KEY=${SHAPELESS}`],
  ["label stdout", `stdout: password=hunter2pass`],
  ["label DEBUG", `DEBUG: token=abc123xyz tail`],
  ["label equals sep", `x = password=hunter2pass`],
  // Re-review round 2: a quoted or digit-prefixed value swallowed the inner
  // `NAME=` and was never rescanned — the rewind now lands inside the quote,
  // and the `=` case redacts the inner value directly.
  ["label quoted dq", `note: "API_KEY=hunter2pass"`],
  ["label quoted sq", `note: 'API_KEY=hunter2pass'`],
  ["label quoted password", `msg: "password=hunter2pass"`],
  ["label quoted run", `run: "TOKEN=hunter2pass"`],
  ["label quoted export", `echo: "export API_KEY=hunter2pass"`],
  ["label digit-prefixed name", `step: 1.TOKEN=hunter2pass`],
];

const PROBE_FRAGMENTS = [
  SHAPELESS,
  ANT,
  AWS_SECRET,
  "hunter2pass",
  "dXNlcjpwYXNzd29yZDEyMw",
  "abcdefghij",
  "b3BlbnNzaC1",
  "glpat-",
  "ssw0rd",
  "ab/cdEFGH12",
  "abc123",
];

describe("security-review bypass cases", () => {
  it.each(LEAKS)("hides %s", (_name, input, known) => {
    const out = redactSecrets(input, known);
    for (const fragment of PROBE_FRAGMENTS) {
      expect(out, `${JSON.stringify(input)} leaked ${fragment}`).not.toContain(fragment);
    }
  });

  it("hides an unmarked AWS secret key next to its AKIA id", () => {
    const out = redactSecrets(`aws creds AKIAIOSFODNN7EXAMPLE ${AWS_SECRET} done`);
    expect(out).not.toContain(AWS_SECRET);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it.each([
    "KEYBOARD=us",
    "echo MONKEY=banana",
    "Authorization: required for this endpoint",
    "family: 👨‍👩‍👧 done",
    "commit 3f9a1c2b4d5e6f7081928374655647382910abcd",
    "see packages.something.abcdefgh.ijklmnop",
    "file my-component.stories-config.typescript",
    "token: 1500 tokens used",
    "run: TOKEN",
    "stdout: hello world",
    "note: this is a log line",
    "grep 'TOKEN=' src",
    "the secret: is out",
    "password: required",
    'console.log("\\u0041BC")',
    "ssh://git@github.com/o/r",
    "https://user@host",
    "uuid 123e4567-e89b-12d3-a456-426614174000",
    // Word-like auth schemes in prose are not credentials — an all-letters
    // "token" needs a digit, a symbol, mixed case or >=20 chars.
    "Token authentication is required",
    "Token rotation happens hourly",
    "Key management is important",
    "Basic hygiene first",
    "set key=value",
    "token=<your token>",
    'token = "<your token>"',
    '{"token": "<your token>"}',
    "Key <word>",
    // A single Title-case word after a word-like scheme is prose.
    "Key Exchange",
    "Bot Framework",
    "Key Management Service",
    "Token Ring protocols",
    "Basic Authentication guide",
  ])("leaves ordinary text alone: %s", (sample) => {
    expect(redactSecrets(sample)).toBe(sample);
  });

  it("still redacts real scheme-shaped tokens next to the prose guards", () => {
    expect(redactSecrets("Token abc123XYZsecret99")).not.toContain("abc123XYZsecret99");
    expect(redactSecrets("Basic dXNlcjpwYXNzd29yZDEyMw==")).not.toContain("dXNlcjpwYXNz");
    expect(redactSecrets("Token MixedCaseTokenNoDigits")).not.toContain("MixedCaseTokenNoDigits");
  });

  it("redacts a bare credential value over 512 chars", () => {
    // `client_secret:`/`x-api-key:` values had a 512-char ceiling — a longer
    // blob came back unredacted.
    const blob = "Ab3xZ9qW".repeat(75); // 600 chars, credential-shaped
    expect(redactSecrets(`client_secret: ${blob}`)).not.toContain(blob);
    expect(redactSecrets(`x-api-key: ${blob}`)).not.toContain(blob);
    expect(redactSecrets(`client_secret: ${blob}`)).toContain(REDACTED);
  });

  it("never blanks identifier keys in values", () => {
    const row = {
      contextSnapshot: {
        taskKey: "issue:abc-123",
        issueId: "x",
        wakeReason: "comment",
        idempotencyKey: "k-1",
      },
      sessionIdAfter: "sess-1",
      resultJson: { sessionKey: "s", cacheKey: "c", documentKey: "d", inputTokens: 5 },
    };
    const out = redactSecretsInValue(row) as typeof row;
    expect(out.contextSnapshot.taskKey).toBe("issue:abc-123");
    expect(out.contextSnapshot.idempotencyKey).toBe("k-1");
    expect(out.resultJson.sessionKey).toBe("s");
    expect(out.resultJson.cacheKey).toBe("c");
    expect(out.resultJson.documentKey).toBe("d");
  });

  it.each([
    `echo "API_KEY=${REDACTED}"\n`,
    `run: TOKEN=abc123xyz "next"\n`,
    `curl -H "Authorization: Bearer ${REDACTED}" x\n`,
    `x-api-key: abcdefghijklmnopqrstuvwxyz\\\n`,
  ])("keeps NDJSON lines parseable: %s", (chunk) => {
    const line = JSON.stringify({ ts: "t", stream: "stdout", chunk });
    const out = redactSecrets(line);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("never eats a trailing escaped quote at a JSON boundary", () => {
    // `\"` inside raw text is an escape, not a value character — a token that
    // ends right before it must keep the pair intact.
    const line = '{"h":"Bearer abcdef12345\\"}';
    const out = redactSecrets(line);
    expect(out).toContain(REDACTED);
    expect(out.endsWith('\\"}')).toBe(true);
    const assignment = '{"k":"API_KEY=abcdef12345\\"}';
    const out2 = redactSecrets(assignment);
    expect(out2.endsWith('\\"}')).toBe(true);
  });

  it("holds a secret that straddles the overflow boundary", () => {
    const r = createSecretStreamRedactor([]);
    const pad = "x".repeat(70 * 1024);
    let out = r.push(`${pad} sk-ant-api03-AbCd`);
    out += r.push("EfGhIjKlMnOpQrSt more\n");
    out += r.flush();
    expect(out).not.toContain("EfGhIjKlMnOpQrSt");
  });

  it("keeps a >64KB JSON line redactable to its tail", () => {
    const r = createSecretStreamRedactor([]);
    const big = JSON.stringify({
      type: "tool_result",
      content: `${"y".repeat(65 * 1024)} Authorization: Bearer ${SHAPELESS}`,
    });
    const mid = big.length - 30;
    const out = r.push(big.slice(0, mid)) + r.push(`${big.slice(mid)}\n`) + r.flush();
    expect(out).not.toContain(SHAPELESS);
  });

  it("holds PEM private-key bodies inside a stream", () => {
    const r = createSecretStreamRedactor([]);
    const out =
      r.push("-----BEGIN OPENSSH PRIVATE KEY-----\n") +
      r.push("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n") +
      r.push("more-base64-material-here==\n") +
      r.push("-----END OPENSSH PRIVATE KEY-----\n") +
      r.flush();
    expect(out).not.toContain("b3BlbnNzaC1");
    expect(out).not.toContain("more-base64-material");
    expect(out).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(out).toContain("END OPENSSH PRIVATE KEY");
  });

  it("does not emit an unterminated PEM body on flush", () => {
    const r = createSecretStreamRedactor([]);
    const out =
      r.push("-----BEGIN OPENSSH PRIVATE KEY-----\n") +
      r.push("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n") +
      r.flush();
    expect(out).not.toContain("b3BlbnNzaC1");
  });
});

// Re-review round 3: the caps added for the perf fix truncated long values
// mid-secret — the first 1024/2048/8192 chars were hidden and the rest came
// back in the clear. Every shape below carries a ≥3000-char value (cookie
// uses 9000 — its cap was 8192).
describe("long values past the old regex caps", () => {
  const LONG = "Ab3xZ9qW".repeat(375); // 3000 chars, credential-shaped
  const LONG_PASS = `p${"w0rd9".repeat(500)}`; // 3001 chars
  const JWT = `eyJ${"h".repeat(9)}.${"p".repeat(3000)}.${"s".repeat(20)}`;

  it.each<[string, string, string]>([
    ["quoted assignment", `API_KEY="${LONG}"`, LONG],
    ["quoted assignment unclosed", `API_KEY="${LONG}`, LONG],
    ["quoted password label", `password: "${LONG}"`, LONG],
    ["quoted client_secret label", `client_secret: "${LONG}"`, LONG],
    ["json value", `{"client_secret": "${LONG}"}`, LONG],
    ["json value unquoted", `{"api_key": ${LONG}}`, LONG],
    ["escaped json", `\\"api_key\\":\\"${LONG}\\"`, LONG],
    ["--token", `cli --token ${LONG}`, LONG],
    ["--token=", `cli --token=${LONG}`, LONG],
    ["curl -u", `curl -u user:${LONG_PASS} https://x`, LONG_PASS],
    ["curl -u nospace", `curl -uuser:${LONG_PASS} https://x`, LONG_PASS],
    ["url userinfo", `postgres://admin:${LONG_PASS}@db.local/x`, LONG_PASS],
    ["mysql -p", `mysql -uroot -p${LONG_PASS} db`, LONG_PASS],
    ["sk- key", `key sk-${LONG}`, LONG],
    ["cookie", `Cookie: session=${"c".repeat(9000)}`, "c".repeat(9000)],
    ["bare jwt", `tok ${JWT}`, JWT],
    ["jwt in json", `{"access_token":"${JWT}"}`, JWT],
  ])("hides %s", (_name, input, secret) => {
    const out = redactSecrets(input);
    expect(out, `leaked tail: ${out.slice(-80)}`).not.toContain(secret);
    expect(out).not.toContain(secret.slice(16, 2000));
    expect(out).not.toContain(secret.slice(-2000));
  });
});

// A ~6MB token after `Bearer`/`Token` used to overflow the regex call stack
// ("Maximum call stack size exceeded"), breaking reads of the whole thread.
// Large inputs are now scanned in 1MB windows with a 4KB carry, and each
// shape extends a window-truncated match on the full text.
describe("multi-megabyte values", () => {
  const BIG = "aB3xZ9qW".repeat(1024 * 1024); // 8MB single token

  it.each<[string, (v: string) => string]>([
    ["auth scheme", (v) => `Authorization: Bearer ${v}`],
    ["token scheme", (v) => `Token ${v}`],
    ["jwt", (v) => `see eyJ${"h".repeat(9)}.${v}.${"s".repeat(20)} end`],
    ["quoted assignment", (v) => `API_KEY="${v}"`],
    ["json value", (v) => `{"client_secret":"${v}"}`],
  ])("redacts an 8MB %s without throwing", { timeout: 60_000 }, (_name, wrap) => {
    const input = wrap(BIG);
    let out = "";
    expect(() => {
      out = redactSecrets(input);
    }).not.toThrow();
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(BIG.slice(0, 2000));
    expect(out).not.toContain(BIG.slice(4096, 8192));
    expect(out).not.toContain(BIG.slice(-2000));
  });

  it("redacts a secret straddling a window boundary", { timeout: 60_000 }, () => {
    // The 1MB window splits the token mid-run; the boundary piece must
    // extend the truncated match instead of emitting a partial redaction.
    const pad = "x".repeat(1024 * 1024 - 20);
    const input = `${pad}Authorization: Bearer ${SHAPELESS}${"y".repeat(6000)}`;
    const out = redactSecrets(input);
    expect(out).not.toContain(SHAPELESS);
  });

  it("redacts URL userinfo straddling a window boundary", { timeout: 60_000 }, () => {
    // Only `scheme://` is regex-matched; the userinfo region is scanned in
    // JS so an @-terminated password survives being split across pieces.
    const pad = "x".repeat(1024 * 1024 - 34) + " ";
    const input = `${pad}postgres://u:${SHAPELESS}@db`;
    expect(redactSecrets(input)).not.toContain(SHAPELESS);
  });

  it("redacts a multi-megabyte URL userinfo password", { timeout: 60_000 }, () => {
    // Single slashes are allowed inside a URL password; this 2MB one spans
    // three scan pieces and used to leave the whole password in the clear.
    const pass = "a/".repeat(1024 * 1024);
    const out = redactSecrets(`postgres://u:${pass}@db`);
    expect(out).not.toContain(pass.slice(0, 2000));
    expect(out).toContain("@db");
  });
});

// Review-4 seam: a known secret placed so a 14-char fragment lands in piece
// N while the rest lands in piece N+1 used to leak the tail — the fragment's
// claim suppressed the full-secret match in the later window. Known secrets
// now match once over the full text after all windowed pattern scans.
describe("known-secret window seams", () => {
  const KNOWN = "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz"; // ≥20 chars, fragments emitted
  const TAIL = KNOWN.slice(14);
  const MB = 1024 * 1024;
  const KB = 1024;
  for (const seamEnd of [MB + 4 * KB, 2 * MB + 4 * KB]) {
    for (const delta of [-20, -18, -16, -14, -8, 0, 8, 20]) {
      it(`redacts a known secret crossing a scan seam (${seamEnd}${delta >= 0 ? "+" : ""}${delta})`, { timeout: 60_000 }, () => {
        const text = "x".repeat(seamEnd + delta) + KNOWN + "y".repeat(64);
        const out = redactSecrets(text, [KNOWN]);
        expect(out, `tail visible: ${out.slice(-80)}`).not.toContain(TAIL);
      });
    }
  }
});

describe("URL userinfo edge cases", () => {
  it("keeps `//` inside a URL password", () => {
    // `Zq8R//k2Vm…` — only a `://` (the next URL's scheme) ends the region.
    const out = redactSecrets("redis://default:Zq8R//k2VmLnQpW9xY1b==@cache");
    expect(out).not.toContain("Zq8R//k2VmLnQpW9xY1b==");
    expect(out).toContain("@cache");
  });

  it("matches an uppercase scheme", () => {
    const out = redactSecrets("HTTPS://admin:hunter2pass@host/x");
    expect(out).not.toContain("hunter2pass");
    expect(out).toContain("@host/x");
  });

  it("redacts an @-then-/ password through the real host", () => {
    // `u:p@ss/<KEY>@host/x` — the `@` before `/` is password material when
    // the text between it and the slash is not host-like, so the credential
    // runs to `@host`, not `p@`. Otherwise `ss/<KEY>` leaks in the clear.
    const out = redactSecrets("https://u:p@ss/Secr3tK3y99@host/x");
    expect(out).not.toContain("Secr3tK3y99");
    expect(out).toContain("@host/x");
  });

  it("prefers a host-looking delimiter over a later @", () => {
    // `u:p@host.com/a/@b` — `host.com` reads as a host, so the path and the
    // trailing `@b` survive; only the password is redacted.
    const out = redactSecrets("https://u:hunter2@host.com/a/@b");
    expect(out).toContain("host.com/a/@b");
    expect(out).not.toContain("hunter2");
  });

  it("stops userinfo at the last @ before the path slash", () => {
    // `u:p@host/a/@b` — `host` is a host-shaped label and the trailing `@b`
    // has no `/` after it, so it is not a credential marker: only the
    // password is redacted and `host/a/` survives.
    const out = redactSecrets("https://u:hunter2@host/a/@b");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("host/a/@b");
  });

  it("does not treat `[` after scheme:// as userinfo", () => {
    // `http://[::1]:8080/…` — an IP literal, not credentials.
    expect(redactSecrets("http://[::1]:8080/path@x")).toBe("http://[::1]:8080/path@x");
  });

  it("redacts the token when the user is a secret name", () => {
    // `x-access-token:` is a secret name — the credential must be hidden.
    // (The `@host/path` tail is still claimed by NAME_VALUE's bare value;
    // preserving it is a tracked LOW follow-up.)
    const out = redactSecrets("https://x-access-token:Zq8Rk2Vm7Tn4pQ9w@github.com/o/r");
    expect(out).not.toContain("Zq8Rk2Vm7Tn4pQ9w");
  });
});

describe("escaped-JSON closer", () => {
  it("does not let an extra backslash swallow the value tail", () => {
    // `ab\\\` before `cd` — `\\\"` is an escaped quote (run ≡3 mod 4), so
    // content, and the value closes at the trailing `\"`. What must never
    // be consumed is the text AFTER the real closer.
    const out = redactSecrets("{\\\"password\\\":\\\"ab\\\\\\\"cd\\\"}next");
    expect(out).toContain("next");
    expect(out).not.toContain("ab\\\\");
    expect(out).not.toContain("cd");
  });

  it("redacts a value containing a literal quote", () => {
    // `JSON.stringify({chunk: JSON.stringify({api_key: 'ab"' + KEY})})` —
    // the `"` inside the value escapes to `\\\"` (a `\` run of length 3 ≡ 3
    // mod 4, an escaped quote, not the closer ≡1 mod 4). Treating it as the
    // closer left `<KEY>"` in the clear.
    const input = JSON.stringify({ chunk: JSON.stringify({ api_key: `ab"${SHAPELESS}` }) });
    const out = redactSecrets(input);
    expect(out).not.toContain(SHAPELESS);
    expect(out).toContain(REDACTED);
  });

  it("does not run a non-secret value through later keys", () => {
    // A `cmd` value that ate its own closer used to consume the `api_key`
    // pair entirely — the match was rejected as non-secret and the key was
    // never scanned.
    const out = redactSecrets(`{\\"cmd\\":\\"x\\",\\"api_key\\":\\"${SHAPELESS}\\",\\"n\\":\\"y\\"}`);
    expect(out).not.toContain(SHAPELESS);
    expect(out).toContain(`\\"n\\":\\"y\\"`);
  });

  it("does not run a nested-stringify value through later keys", () => {
    const input = JSON.stringify({
      tool: JSON.stringify({ command: "ls -la", env: { API_KEY: SHAPELESS }, cwd: "/tmp" }),
    });
    const out = redactSecrets(input);
    expect(out).not.toContain(SHAPELESS);
    expect(out).toContain("/tmp");
  });

  it("keeps later non-secret keys visible", () => {
    // A runaway value wipe `\",\"user\":\"alice\"` and alice vanished with it.
    const out = redactSecrets(`{\\"api_key\\":\\"${SHAPELESS}\\",\\"user\\":\\"alice\\"}`);
    expect(out).not.toContain(SHAPELESS);
    expect(out).toContain("alice");
  });

  it("redacts a value ending in a literal backslash", () => {
    // `KEY\` at end-of-value encodes `\\` + `\"` — a 5-backslash run before
    // the quote, which must still close (≡1 mod 4), not count as content.
    const input = JSON.stringify({ c: JSON.stringify({ api_key: `${SHAPELESS}\\` }) });
    expect(redactSecrets(input)).not.toContain(SHAPELESS);
  });

  it("redacts a value containing a newline escape", () => {
    const input = JSON.stringify({ c: JSON.stringify({ api_key: `a\n${SHAPELESS}` }) });
    expect(redactSecrets(input)).not.toContain(SHAPELESS);
  });

  it("redacts a value containing 1,500 quotes", () => {
    const input = JSON.stringify({ c: JSON.stringify({ api_key: `${"\"".repeat(1500)}${SHAPELESS}` }) });
    expect(redactSecrets(input)).not.toContain(SHAPELESS);
  });
});

// A shorter pattern match claimed before a longer overlapping one used to
// suppress the longer edit entirely — the unclaimed tail leaked in the
// clear. Overlapping pushes now fill each unclaimed sub-span, and the
// known-secret literal pass runs before every pattern.
describe("overlapping matches", () => {
  it("redacts a known secret whose head a pattern already claimed", () => {
    // `PASSWORD=` claims `Pa55` (the bare value stops at `;`); without the
    // literal running first, `;word&<key>` stayed visible.
    const secret = "Pa55;word&Zq8QwEr7Ty6Ui5Op4";
    const out = redactSecrets(`PASSWORD=${secret}`, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(";word&");
  });

  it("redacts a known secret containing a delimiter a pattern stops at", () => {
    // `Bearer` claims `abc123`; the `,rest` tail of the configured secret
    // leaked before known-first ordering.
    const secret = "abc123,rest9xToken42";
    const out = redactSecrets(`Bearer ${secret}`, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("rest9xToken42");
  });

  it("redacts a known secret containing a paren a pattern stops at", () => {
    const secret = "hunter2(TopSecret)x";
    const out = redactSecrets(`API_KEY=${secret}`, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("TopSecret");
  });

  it("keeps a cookie line redacted when a key shape lands inside it", () => {
    // The AWS blob inside the line claimed first used to drop the whole
    // cookie edit; sub-span fill now covers both sides of it.
    const out = redactSecrets(
      "Cookie: session=abc123def; AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\ndone",
    );
    expect(out).not.toContain("session=abc123def");
    expect(out).not.toContain("wJalrXUtnFEMI");
    expect(out).toContain("done");
  });
});

// An astral char (emoji) pushes a surrogate pair into the normalized text but
// used to push only one position-map entry — every edit after it landed one
// unit off, leaving the secret in place and duplicating the text.
describe("astral characters before secrets", () => {
  const LEAKS_AFTER_EMOJI: [string, string][] = [
    ["env assignment", `API_KEY=${SHAPELESS}`],
    ["bearer header", `Authorization: Bearer ${SHAPELESS}`],
    ["sk- key", `token is ${ANT}`],
    ["json value", `{"client_secret":"${SHAPELESS}"}`],
    ["TOKEN=", `TOKEN=${SHAPELESS}`],
    ["url userinfo", `postgres://admin:hunter2pass@db.local:5432/x`],
  ];

  it.each(LEAKS_AFTER_EMOJI)("redacts an %s after one emoji", (_name, body) => {
    const out = redactSecrets(`\u{1F680} Deployed! ${body}`);
    expect(out).not.toContain(SHAPELESS);
    expect(out).not.toContain(ANT);
    expect(out).not.toContain("hunter2pass");
    expect(out.split("Deployed!").length - 1).toBe(1);
    expect(out).toContain(REDACTED);
    expect(out).toContain("\u{1F680}");
  });

  it.each(LEAKS_AFTER_EMOJI)("redacts an %s after several astral chars", (_name, body) => {
    const out = redactSecrets(`\u{1F680}\u{1F389}\u{1F31F} done ${body}`);
    expect(out).not.toContain(SHAPELESS);
    expect(out).not.toContain(ANT);
    expect(out).not.toContain("hunter2pass");
    expect(out).toContain(REDACTED);
  });

  it("redacts secrets on both sides of emoji", () => {
    const out = redactSecrets(`API_KEY=${SHAPELESS} \u{1F680}\u{1F389} TOKEN=${AWS_SECRET}`);
    expect(out).not.toContain(SHAPELESS);
    expect(out).not.toContain(AWS_SECRET);
    expect(out).toContain("\u{1F680}\u{1F389}");
  });

  it("returns secret-free astral text byte-for-byte", () => {
    const clean = "\u{1F680} emoji \u{1F389} CJK \u3053\u3093\u306B\u3061\u306F cafe\u0301 \u{1F468}\u{200D}\u{1F4BB} flags \u{1F1FA}\u{1F1F8}";
    expect(redactSecrets(clean)).toBe(clean);
  });

  it("does not duplicate text around an emoji-prefixed secret", () => {
    const out = redactSecrets(`\u{1F680} Deployed! API_KEY=${SHAPELESS}`);
    expect(out).toBe(`\u{1F680} Deployed! API_KEY=${REDACTED}`);
  });
});
