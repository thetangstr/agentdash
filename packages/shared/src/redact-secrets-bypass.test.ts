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
});
