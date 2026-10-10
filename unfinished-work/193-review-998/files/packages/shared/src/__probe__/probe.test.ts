import { describe, it } from "vitest";
import { redactSecrets, redactSecretsInValue, createSecretStreamRedactor } from "../redact-secrets.js";

const ANT = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SHAPELESS = "f3b9c2d1e4a5968778a1b2c3.Qz9XyW8vU7tS"; // Z.AI style
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const cases: [string, string, string[]?][] = [
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
  ["yaml OPENAI_API_KEY", `ZAI_API_KEY: ${SHAPELESS}`],
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
  ["AWS secret alone", `${AWS_SECRET}`],
  ["PEM", `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----`],
  ["base64 of sk-ant", `echo ${Buffer.from(ANT).toString("base64")} | base64 -d`],
  ["base64 of shapeless (known)", `echo ${Buffer.from(SHAPELESS).toString("base64")} | base64 -d`, [SHAPELESS]],
  ["base64 offset known", `echo ${Buffer.from("x:" + SHAPELESS).toString("base64")}`, [SHAPELESS]],
  ["split vars known", `A=${SHAPELESS.slice(0, 12)} B=${SHAPELESS.slice(12)}`, [SHAPELESS]],
  ["split vars 3-way known", `A=${SHAPELESS.slice(0, 13)} B=${SHAPELESS.slice(13, 26)} C=${SHAPELESS.slice(26)}`, [SHAPELESS]],
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
];

describe("bypass probe", () => {
  it("prints", () => {
    const rows: string[] = [];
    for (const [name, input, known] of cases) {
      const out = redactSecrets(input, known);
      const leaked = [SHAPELESS, ANT, AWS_SECRET, "hunter2pass", "dXNlcjpwYXNzd29yZDEyMw", "abcdefghij", "b3BlbnNzaC1", "glpat-", "ssw0rd", "ab/cdEFGH12", "abc123", Buffer.from(ANT).toString("base64").slice(0,20)]
        .some((s) => out.includes(s));
      rows.push(`${leaked ? "LEAK" : "ok  "} | ${name} | ${JSON.stringify(out).slice(0, 160)}`);
    }
    console.log(rows.join("\n"));
  });

  it("stream boundary + long line", () => {
    const r = createSecretStreamRedactor([]);
    const pad = "x".repeat(70 * 1024);
    let out = r.push(pad + " sk-ant-api03-AbCd");
    out += r.push("EfGhIjKlMnOpQrSt more\n");
    out += r.flush();
    console.log("LONGLINE", out.includes("EfGhIjKlMnOpQrSt") ? "LEAK" : "ok", JSON.stringify(out.slice(-80)));
    // json line > 64KB typical of stream-json tool results
    const r2 = createSecretStreamRedactor([]);
    const big = JSON.stringify({ type: "tool_result", content: "y".repeat(65 * 1024) + ` Authorization: Bearer ${SHAPELESS}` });
    const mid = big.length - 30;
    const o2 = r2.push(big.slice(0, mid)) + r2.push(big.slice(mid) + "\n") + r2.flush();
    console.log("BIGJSON", o2.includes(SHAPELESS.slice(-10)) ? "LEAK" : "ok", JSON.stringify(o2.slice(-90)));
    // CR-only progress output (no \n)
    const r3 = createSecretStreamRedactor([]);
    let o3 = "";
    for (let i = 0; i < 2000; i++) o3 += r3.push(`progress ${i}% ${"z".repeat(30)}\r`);
    o3 += r3.push(`TOKEN=${SHAPELESS.slice(0,10)}`) + r3.push(`${SHAPELESS.slice(10)}\r`) + r3.flush();
    console.log("CR", o3.includes(SHAPELESS.slice(10)) ? "LEAK" : "ok");
  });

  it("over-redaction / mangling", () => {
    const samples = [
      "KEYBOARD=us", "echo MONKEY=banana", "Authorization: required for this endpoint",
      "family: 👨‍👩‍👧 done", "commit 3f9a1c2b4d5e6f7081928374655647382910abcd",
      "see packages.something.abcdefgh.ijklmnop", "file my-component.stories-config.typescript",
      "token: 1500 tokens used", "the secret: is out", "password: required",
      'console.log("\\u0041BC")', "ssh://git@github.com/o/r", "https://user@host",
      "uuid 123e4567-e89b-12d3-a456-426614174000",
    ];
    for (const s of samples) {
      const o = redactSecrets(s);
      console.log(o === s ? "same   " : "CHANGED", JSON.stringify(s), "=>", JSON.stringify(o));
    }
    const row = { contextSnapshot: { taskKey: "issue:abc-123", issueId: "x", wakeReason: "comment", idempotencyKey: "k-1" }, sessionIdAfter: "sess-1", resultJson: { sessionKey: "s", cacheKey: "c", inputTokens: 5 } };
    console.log("ROW", JSON.stringify(redactSecretsInValue(row)));
  });

  it("ndjson read-time corruption", () => {
    const chunk = `echo "API_KEY=***REDACTED***"\n`;
    const line = JSON.stringify({ ts: "t", stream: "stdout", chunk });
    const red = redactSecrets(line);
    let ok = true; try { JSON.parse(red); } catch { ok = false; }
    console.log("NDJSON quoted assignment", ok ? "parses" : "BROKEN", red);
    const chunk2 = `run: TOKEN=abc123xyz "next"\n`;
    const red2 = redactSecrets(JSON.stringify({ chunk: chunk2 }));
    let ok2 = true; try { JSON.parse(red2); } catch { ok2 = false; }
    console.log("NDJSON 2", ok2 ? "parses" : "BROKEN", red2);
    const chunk3 = `curl -H "Authorization: Bearer ***REDACTED***" x\n`;
    const red3 = redactSecrets(JSON.stringify({ chunk: chunk3 }));
    let ok3 = true; try { JSON.parse(red3); } catch { ok3 = false; }
    console.log("NDJSON 3", ok3 ? "parses" : "BROKEN", red3);
    const chunk4 = `x-api-key: abcdefghijklmnopqrstuvwxyz\\\n`;
    const red4 = redactSecrets(JSON.stringify({ chunk: chunk4 }));
    let ok4 = true; try { JSON.parse(red4); } catch { ok4 = false; }
    console.log("NDJSON 4", ok4 ? "parses" : "BROKEN", red4);
  });

  it("perf", () => {
    const known = Array.from({ length: 25 }, (_, i) => `secretvalue_${i}_` + "a1B2c3D4e5F6g7H8i9J0".repeat(3));
    const line = "normal log line with some text and numbers 12345 ".repeat(80) + "\n";
    let t = performance.now();
    for (let i = 0; i < 1000; i++) redactSecrets(line);
    const base = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < 1000; i++) redactSecrets(line, known);
    const withKnown = performance.now() - t;
    console.log(`PERF 1000 x 4KB lines: patterns=${base.toFixed(0)}ms, +25 known secrets=${withKnown.toFixed(0)}ms`);
  });
});
