import { describe, expect, it } from "vitest";
import {
  REDACTED,
  containsSecrets,
  createSecretStreamRedactor,
  isSecretName,
  redactSecrets,
  redactSecretsInValue,
} from "./redact-secrets.js";

const SECRET = "SUPERSECRETvalue123";

describe("isSecretName", () => {
  it("marks credential names but not words that merely contain them", () => {
    for (const name of ["PAPERCLIP_API_KEY", "api_key", "access_token", "key", "clientSecret", "x-api-key"]) {
      expect(isSecretName(name)).toBe(true);
    }
    for (const name of ["KEYBOARD", "MONKEY", "PASSPORT", "keynote", "summary"]) {
      expect(isSecretName(name)).toBe(false);
    }
  });
});

describe("redactSecrets", () => {
  const COMMANDS: string[] = [
    `curl -H "authorization: bearer ${SECRET}" https://x.test`,
    `curl -H 'x-api-key: ${SECRET}' https://x.test`,
    `curl --header "Authorization: Bearer ${SECRET}" https://x.test`,
    `curl -u admin:${SECRET} https://x.test`,
    `curl --user admin:${SECRET} https://x.test`,
    `curl https://admin:${SECRET}@x.test/a`,
    `curl "https://x.test/a?token=${SECRET}"`,
    `curl "https://x.test/a?api_key=${SECRET}&b=1"`,
    `curl "https://maps.test/a?key=${SECRET}"`,
    `curl -d '{"auth":"Bearer ${SECRET}"}' https://x.test`,
    `curl -d '{"api_key":"${SECRET}"}' https://x.test`,
    `TOKEN=${SECRET} curl https://x.test`,
    `export OPENAI_API_KEY=${SECRET}`,
    `API_KEY="${SECRET}" node x.js`,
    `curl -H "Cookie: session=${SECRET}" https://x.test`,
    `curl -b "session=${SECRET}" https://x.test`,
    `curl -H "Authorization: Basic ${SECRET}" https://x.test`,
    `Set-Cookie: sid=${SECRET}; Path=/`,
    `curl -H "X-Goog-Api-Key: ${SECRET}" https://x.test`,
    `curl -H "PRIVATE-TOKEN: ${SECRET}" https://x.test`,
    `mysql -uroot -p${SECRET} db`,
    `psql postgres://user:${SECRET}@db:5432/x`,
    `python3 -c 'c=Client(api_key="${SECRET}")'`,
    `curl -d "client_id=a&client_secret=${SECRET}" https://x.test/oauth`,
    `git clone https://oauth2:${SECRET}@gitlab.com/a/b.git`,
  ];

  it.each(COMMANDS)("redacts %#", (command) => {
    expect(redactSecrets(command)).not.toContain(SECRET);
  });

  it("redacts well-known key shapes", () => {
    const shapes = [
      "sk_live_51HxYzAbCdEfGhIjKlMnOp",
      "rk_test_51HxYzAbCdEfGhIjKl",
      "whsec_AbCdEfGhIjKlMnOp12",
      "sk-ant-api03-AbCdEfGhIjKlMnOp",
      "sk-proj-AbCdEfGhIjKlMnOpQr",
      "ghp_AbCdEfGhIjKlMnOpQrStUvWx",
      "github_pat_11ABCDEfGhIjKlMnOpQr_abcdef",
      "xai-AbCdEfGhIjKlMnOpQrSt",
      "pcp_AbCdEfGhIjKlMn",
      "pcp_board_AbCdEfGhIjKlMn",
      "AKIAIOSFODNN7EXAMPLE",
      "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz12345",
    ];
    for (const shape of shapes) {
      expect(redactSecrets(`k=${shape}`)).not.toContain(shape);
    }
  });

  it("redacts a token as bare URL userinfo but keeps plain usernames", () => {
    expect(redactSecrets(`git clone https://${SECRET}@gitlab.com/a/b.git`)).not.toContain(SECRET);
    expect(redactSecrets("ssh://git@github.com/org/repo")).toBe("ssh://git@github.com/org/repo");
    expect(redactSecrets("https://user@example.com/path")).toBe("https://user@example.com/path");
    expect(redactSecrets("https://x-access-token:tok@github.com/a/b")).toContain(REDACTED);
  });

  it("leaves ordinary text alone", () => {
    for (const benign of [
      "git log --oneline",
      "KEYBOARD=us make",
      "echo MONKEY=banana",
      "grep -r 'TOKEN=' src",
      "cat docs/authorization.md",
      "Authorization: required for this endpoint",
      "ssh -p 22 host",
      "git checkout -b feature/x",
      "TOKEN=$(cat ~/.token) && echo ok",
      "git remote add origin git@github.com:org/repo.git",
    ]) {
      expect(redactSecrets(benign)).toBe(benign);
    }
  });

  it("keeps the header name and auth scheme, and is idempotent", () => {
    expect(redactSecrets('-H "Authorization: Bearer abc.def"')).toBe(`-H "Authorization: Bearer ${REDACTED}"`);
    expect(redactSecrets("--token s3cr3t-value")).toBe(`--token ${REDACTED}`);
    expect(redactSecrets("API_KEY=s3cr3t pnpm x")).toBe(`API_KEY=${REDACTED} pnpm x`);
    const once = redactSecrets(`curl -u a:${SECRET} -H "X-Api-Key: ${SECRET}" "https://x.test?token=${SECRET}"`);
    expect(redactSecrets(once)).toBe(once);
  });

  it("redacts JSON keys written with \\u escapes", () => {
    const escaped = '{"api\\u005fkey":"SUPERSECRETvalue123"}';
    const out = redactSecrets(escaped);
    expect(out).not.toContain(SECRET);
    // Only the value is replaced — the original escape sequence in the key is
    // preserved byte-for-byte so stored text is never re-encoded.
    expect(out).toContain("\\u005fkey");
    expect(JSON.parse(out)).toEqual({ api_key: "***REDACTED***" });
  });

  it("redacts a header name split by zero-width characters", () => {
    const obfuscated = `Authori​zation: Bearer ${SECRET}`;
    expect(redactSecrets(obfuscated)).not.toContain(SECRET);
    expect(redactSecrets(`x-api-​key: ${SECRET}`)).not.toContain(SECRET);
  });

  it("redacts secrets the caller knows verbatim, including shapeless values", () => {
    const shapeless = "correct-horse-battery-staple-99";
    expect(redactSecrets(`401 Unauthorized for key ${shapeless}`, [shapeless])).not.toContain(shapeless);
    expect(redactSecrets("nothing to hide", [shapeless])).toBe("nothing to hide");
  });

  it("redacts base64, base64url, hex and URL-encoded forms of a known secret", () => {
    const secret = "sk-live-AbCdEf1234567890";
    const b64 = Buffer.from(secret, "utf8").toString("base64");
    const hex = Buffer.from(secret, "utf8").toString("hex");
    expect(redactSecrets(`echo ${b64}`, [secret])).not.toContain(b64);
    expect(redactSecrets(`echo ${hex}`, [secret])).not.toContain(hex);
    expect(redactSecrets(`v=${encodeURIComponent(secret)}`, [secret])).toContain(REDACTED);
  });

  it("redacts a known secret split across innocuous variables", () => {
    const secret = "k8fP2mX9qB4rT7zN1wJ6yV3hG5d0s";
    const first = secret.slice(0, 15);
    const second = secret.slice(15);
    const out = redactSecrets(`A=${first} B=${second}; curl -H "Auth: $A$B"`, [secret]);
    expect(out).not.toContain(first);
    expect(out).not.toContain(second);
  });

  it("does not fragment-match short or spaced known secrets", () => {
    // A spaced secret's would-be fragments are ordinary words: no fragment
    // matching, so text sharing a phrase stays put.
    const spaced = "correct horse battery staple 99";
    expect(redactSecrets("correct horse", [spaced])).toBe("correct horse");
    // A short secret is only ever matched verbatim.
    expect(redactSecrets("abc123xyz", ["abc123"])).toBe("***REDACTED***xyz");
    // Windows cut from a sequential secret are low entropy — they collide
    // with the alphabet inside unrelated values, so no fragment matching.
    const sequential = "abcdefghijklmnopqrstuvwxyz012345";
    expect(redactSecrets("pk_live_abcdefghijklmnopqrstuvwx", [sequential])).toBe(
      "pk_live_abcdefghijklmnopqrstuvwx",
    );
    expect(redactSecrets(`key is ${sequential}`, [sequential])).toBe("key is ***REDACTED***");
    expect(redactSecrets("abc", ["abc123"])).toBe("abc");
  });
});

describe("redactSecretsInValue", () => {
  it("redacts nested strings and blanks values under credential-named keys", () => {
    const redacted = redactSecretsInValue({
      command: `curl -H "Authorization: Bearer ${SECRET}" u`,
      apiKey: SECRET,
      env: { DB_PASSWORD: SECRET },
      list: [`token=${SECRET}`],
      key: "plan",
    });
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(redacted.key).toBe("plan");
  });

  it("passes non-plain objects through untouched", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const redacted = redactSecretsInValue({ at: date, note: `token=${SECRET}` });
    expect(redacted.at).toBe(date);
    expect(redacted.note).not.toContain(SECRET);
  });
});

describe("createSecretStreamRedactor", () => {
  it("equals redacting the joined text when secrets are cut across chunks", () => {
    const key = "sk-proj-AbCdEfGhIjKlMnOpQrSt";
    const whole = `line one\nAuthorization: Bearer ${key}\nlast ${SECRET}\n`;
    const expected = redactSecrets(whole);
    for (const cutAt of [1, 5, 17, 30, 40, whole.length - 3]) {
      const stream = createSecretStreamRedactor();
      let out = stream.push(whole.slice(0, cutAt));
      out += stream.push(whole.slice(cutAt));
      out += stream.flush();
      expect(out).toBe(expected);
      expect(out).not.toContain(key);
    }
  });

  it("holds a secret cut mid-line across many small chunks", () => {
    const key = "pcp_runSecretValue987654";
    const text = `prefix ${key} suffix\n`;
    const stream = createSecretStreamRedactor();
    let out = "";
    for (const ch of text) out += stream.push(ch);
    out += stream.flush();
    expect(out).not.toContain(key);
    expect(out).toBe(redactSecrets(text));
  });

  it("applies known secrets across chunk boundaries", () => {
    const secret = "verbatim-instance-key-0001";
    const stream = createSecretStreamRedactor([secret]);
    const out = stream.push(`echo ${secret.slice(0, 10)}`) + stream.push(`${secret.slice(10)}\n`);
    expect(out).not.toContain(secret);
  });

  it("emits an overlong line rather than buffering forever", () => {
    const key = "sk-proj-AbCdEfGhIjKlMnOp";
    const stream = createSecretStreamRedactor(undefined, 32);
    const line = ` ${key}`.repeat(10);
    const out = stream.push(line) + stream.flush();
    // Everything is eventually emitted, nothing leaks — the held tail covers a
    // secret that straddles the overflow boundary.
    expect(out).not.toContain(key);
    expect(out.length).toBeGreaterThan(0);
  });

  it("keeps a secret that straddles the overflow boundary", () => {
    const secret = "verbatim-shapeless-key-0123456789abcdef";
    const stream = createSecretStreamRedactor([secret], 64 * 1024);
    const filler = "x".repeat(64 * 1024 - 40);
    // The first half of the secret is pushed right at the maxHold edge so an
    // emit-all overflow would leak its second half in the next chunk.
    const first = stream.push(filler + secret.slice(0, 20));
    const second = stream.push(secret.slice(20) + "\n") + stream.flush();
    expect(first + second).not.toContain(secret);
    expect(first + second).toContain("***REDACTED***");
  });

  it("cuts the overflow emit at a delimiter so a straddling key is held whole", () => {
    // A fixed-position cut at `text.length - keepTail` splits a key that
    // starts a few chars before the boundary; both halves then persist.
    const KEY = "sk-ant-api03-Q7xZp2Lm9RtV4wYb8NcK1jHf"; // synthetic
    const total = 64 * 1024 + 100;
    const emitEnd = total - 1024; // keepTail with no known secrets
    for (const offset of [-40, -30, -20, -12, -10, -5, -3, 0, 5]) {
      const stream = createSecretStreamRedactor([]);
      const pos = emitEnd + offset;
      const line =
        "a ".repeat(Math.floor(pos / 2)) + KEY + " " + "b".repeat(total - pos - KEY.length - 1);
      let out = stream.push(line.slice(0, total));
      out += stream.push(line.slice(total) + "\n");
      out += stream.flush();
      expect(out, `offset ${offset}`).not.toContain(KEY);
      expect(out, `offset ${offset}`).not.toContain(KEY.slice(0, 20));
      expect(out, `offset ${offset}`).not.toContain(KEY.slice(-12));
    }
    // A known (verbatim) secret straddling the boundary too.
    const known = "Zq8Rk2Vm7Tn4Wb9Xc3LsAbc123XyZ"; // synthetic
    const stream = createSecretStreamRedactor([known]);
    const line = "x".repeat(emitEnd - 10) + " " + known + " " + "y".repeat(2000);
    let out = stream.push(line.slice(0, total));
    out += stream.push(line.slice(total) + "\n");
    out += stream.flush();
    expect(out).not.toContain(known.slice(0, 10));
    expect(out).not.toContain(known.slice(10));
  });

  it("emits a delimiter-free line at the hard cap instead of holding forever", () => {
    const stream = createSecretStreamRedactor([]);
    const blob = "x".repeat(1024 * 1024 + 64); // > STREAM_HARD_CAP, no delimiter
    const out = stream.push(blob);
    expect(out.length).toBeGreaterThan(0);
    expect(stream.push("tail\n")).toContain("tail");
  });

  it("keeps holding the tail at the hard cap so a straddling secret survives", () => {
    // The cap emits `len - keepTail`, not the whole buffer — a secret right
    // at that boundary stays in the held tail and is redacted on flush. The
    // `API_KEY=` needs a real word boundary before it: inside an unbroken
    // >128-char identifier run it is not a label (the name match is
    // deliberately bounded).
    const secret = "hunter2pass";
    const stream = createSecretStreamRedactor([]);
    const out = stream.push("a".repeat(1024 * 1024) + ` API_KEY=${secret}`);
    expect(out).not.toContain(secret);
    const flushed = stream.flush();
    expect(out + flushed).not.toContain(secret);
    expect(out + flushed).toContain("***REDACTED***");
  });

  it("holds a label with its value across the overflow boundary", () => {
    // The delimiter cut lands between the label and a straddling value
    // (`Authorization: Bearer |KEY`). Emitting the label alone leaves the
    // value patternless — it must be held with its label.
    const secret = "hunter2pass";
    const total = 64 * 1024 + 100;
    const emitEnd = total - 1024;
    const labels: Array<[string, string]> = [
      ["Authorization: Bearer ", ""],
      ['API_KEY="', '"'],
      ['{"password": "', '"}'],
      ["client_secret: ", ""],
      ["--token ", ""],
    ];
    for (const [label, close] of labels) {
      for (let off = 1; off <= 12; off++) {
        const stream = createSecretStreamRedactor([]);
        const pos = emitEnd - off - label.length;
        // `x ` filler: delimiters everywhere, so the back-off lands mid-pad
        // rather than collapsing to a hold-all. Exactly `pos` chars ending
        // on a space so the secret starts `off` chars before emitEnd.
        const pad = "x ".repeat(Math.ceil(pos / 2)).slice(0, pos - 1) + " ";
        const line = pad + label + secret + close + " " + "y".repeat(2048);
        const out = stream.push(line) + stream.push("z\n") + stream.flush();
        expect(out, `${JSON.stringify(label)} offset -${off}`).not.toContain(secret);
      }
    }
  });
});

describe("containsSecrets", () => {
  it("reports whether redaction would change the text", () => {
    expect(containsSecrets(`token=${SECRET}`)).toBe(true);
    expect(containsSecrets("git status")).toBe(false);
  });
});
