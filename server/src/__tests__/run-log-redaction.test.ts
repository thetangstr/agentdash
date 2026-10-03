// AgentDash (GH #992): the server-side run-log redaction service — instance
// known secrets come from credential-named process env vars and the managed
// Hermes profile's `.env`, and every helper runs the shared pattern set on
// top of them.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redactSecrets } from "@paperclipai/shared";
import { knownKeysFromEnv } from "../services/redact-secrets.ts";
import {
  createRunLogStreamRedactor,
  instanceKnownSecrets,
  logSafeError,
  redactRunLogNdjson,
  redactRunLogText,
  redactRunLogValue,
} from "../services/run-log-redaction.ts";

const SHAPELESS_KEY = "provk-canary-7f3a9c2d-4e5a-b6c7-8d9e0f1a2b3c";

describe("run-log redaction", () => {
  let profilesDir: string;

  beforeAll(async () => {
    profilesDir = await mkdtemp(join(tmpdir(), "run-log-redaction-"));
    await mkdir(join(profilesDir, "agentdash"), { recursive: true });
    await writeFile(
      join(profilesDir, "agentdash", ".env"),
      `OPENAI_API_KEY=${SHAPELESS_KEY}\nOTHER_SETTING=ok\n`,
      "utf8",
    );
    // Per-agent and per-company profiles hold their own provider keys.
    await mkdir(join(profilesDir, "agent-acme-eng"), { recursive: true });
    await writeFile(
      join(profilesDir, "agent-acme-eng", ".env"),
      `ANTHROPIC_API_KEY=provk-agent-profile-99887766\n`,
      "utf8",
    );
    await mkdir(join(profilesDir, "company-acme"), { recursive: true });
    await writeFile(
      join(profilesDir, "company-acme", ".env"),
      `XAI_API_KEY=provk-company-profile-11223344\n`,
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(profilesDir, { recursive: true, force: true });
  });

  it("collects the Hermes profile provider key and credential env vars", () => {
    const keys = instanceKnownSecrets({
      HERMES_PROFILES_DIR: profilesDir,
      MY_SERVICE_API_KEY: "env-secret-12345678",
      PATH: "/usr/bin",
      NODE_ENV: "test",
    });
    expect(keys).toContain(SHAPELESS_KEY);
    expect(keys).toContain("env-secret-12345678");
    expect(keys).not.toContain("/usr/bin");
  });

  it("returns an empty list when nothing is configured", () => {
    const keys = instanceKnownSecrets({
      HERMES_PROFILES_DIR: join(profilesDir, "does-not-exist"),
      PATH: "/usr/bin",
    });
    expect(keys).toEqual([]);
  });

  it("redacts text against patterns plus explicit run secrets", () => {
    const key = "sk-proj-AbCdEfGhIjKlMnOpQrSt";
    expect(redactRunLogText(`Authorization: Bearer ${key}`)).not.toContain(key);
    const runSecret = "verbatim-run-jwt-0001";
    expect(redactRunLogText(`token=${runSecret}`, [runSecret])).not.toContain(runSecret);
  });

  it("redacts deep values and blanks credential-named keys", () => {
    const out = redactRunLogValue(
      {
        error: `401 for key ${SHAPELESS_KEY}`,
        nested: { apiKey: SHAPELESS_KEY, note: "ok" },
        items: [`Bearer ${SHAPELESS_KEY}`],
      },
      [SHAPELESS_KEY],
    );
    expect(JSON.stringify(out)).not.toContain(SHAPELESS_KEY);
    expect(out.nested.note).toBe("ok");
  });

  it("stream redactor holds a secret split across chunk boundaries", () => {
    const redactor = createRunLogStreamRedactor([SHAPELESS_KEY]);
    const first = SHAPELESS_KEY.slice(0, 20);
    const second = SHAPELESS_KEY.slice(20);
    const out = redactor.push(`head ${first}`) + redactor.push(`${second} tail\n`);
    expect(out).not.toContain(SHAPELESS_KEY);
    // Each half is longer than a fragment window, so both are hidden too.
    expect(out).not.toContain(first);
    expect(out).not.toContain(second);
  });

  it("collects keys from every Hermes profile directory, not just the template", () => {
    const keys = instanceKnownSecrets({
      HERMES_PROFILES_DIR: profilesDir,
      PATH: "/usr/bin",
    });
    expect(keys).toContain(SHAPELESS_KEY);
    expect(keys).toContain("provk-agent-profile-99887766");
    expect(keys).toContain("provk-company-profile-11223344");
  });

  it("collects *_PRIVATE_KEY / PGPASSWORD-style env names and DSN passwords", () => {
    const keys = instanceKnownSecrets({
      HERMES_PROFILES_DIR: join(profilesDir, "does-not-exist"),
      AWS_SECRET_ACCESS_KEY: "aws-secret-value-00001",
      PGPASSWORD: "pg-password-000002",
      SIGNING_PRIVATE_KEY: "signing-key-0000003",
      DATABASE_URL: "postgres://app:dsn-pass-4444444@db.internal:5432/app",
      PATH: "/usr/bin",
    });
    expect(keys).toContain("aws-secret-value-00001");
    expect(keys).toContain("pg-password-000002");
    expect(keys).toContain("signing-key-0000003");
    expect(keys).toContain("dsn-pass-4444444");
    // The full DSN is not collected — `DATABASE_URL` is not a secret name —
    // but an echoed `postgres://user:pass@host` is still scrubbed by the
    // URL-userinfo pattern plus the extracted password literal.
    expect(keys).not.toContain("/usr/bin");
  });

  it("never collects paths, URLs, public keys or trivial DSN passwords", () => {
    // PR #998 re-review: collecting these shreds instance paths and the word
    // `paperclip` out of every run log — and persist-time over-redaction is
    // permanent.
    const keys = knownKeysFromEnv({
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/Users/example/.paperclip/instances/default/secrets/master.key",
      GOOGLE_APPLICATION_CREDENTIALS: "/Users/example/.config/gcloud/application_default_credentials.json",
      STRIPE_PUBLISHABLE_KEY: "pk_live_abcdefghijklmnopqrstuvwx",
      DATABASE_URL: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
      BETTER_AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz012345",
      PAPERCLIP_PUBLIC_KEY_URL: "https://agentdash.example.com/.well-known/jwks.json",
    } as unknown as NodeJS.ProcessEnv);
    expect(keys).toEqual(["abcdefghijklmnopqrstuvwxyz012345"]);

    for (const line of [
      "reading /Users/example/.paperclip/instances/default/data/run-logs/abc.ndjson",
      "cat /Users/example/.config/gcloud/application_default_credentials.json",
      "user paperclip connected to db paperclip",
      "GET https://agentdash.example.com/.well-known/jwks.json",
      "pk_live_abcdefghijklmnopqrstuvwx is publishable",
    ]) {
      expect(redactSecrets(line, keys), JSON.stringify(line)).toBe(line);
    }
  });

  it("still collects a real DSN password and a long != username secret", () => {
    const keys = knownKeysFromEnv({
      DATABASE_URL: "postgres://app:dsn-pass-4444444@db.internal:5432/app",
      SECONDARY_DSN: "mysql://root:r00t-longpassword-99@db.internal/app",
    } as unknown as NodeJS.ProcessEnv);
    expect(keys).toContain("dsn-pass-4444444");
    expect(keys).toContain("r00t-longpassword-99");
  });

  it("collects a base64 secret that starts with '/' (AWS secret keys can)", () => {
    // ~1/64 of AWS secret access keys begin with "/"; treating any
    // slash-leading value as a path drops them from verbatim matching.
    const keys = knownKeysFromEnv({
      AWS_SECRET_ACCESS_KEY: "/k3Zq8Rk2Vm7Tn4Wb9Xc3LsQ7xZp2Lm9RtV4wYb8",
    } as unknown as NodeJS.ProcessEnv);
    expect(keys).toContain("/k3Zq8Rk2Vm7Tn4Wb9Xc3LsQ7xZp2Lm9RtV4wYb8");
    // Real paths still excluded.
    const pathKeys = knownKeysFromEnv({
      AWS_SECRET_ACCESS_KEY: "/etc/ssl/aws-secret",
    } as unknown as NodeJS.ProcessEnv);
    expect(pathKeys).not.toContain("/etc/ssl/aws-secret");
  });

  it("collects short-but-real DSN passwords and rejects weak ones", () => {
    const keys = knownKeysFromEnv({
      DATABASE_URL: "postgres://app:Qx7mR2pL9z@db.internal:5432/app",
      WEAK_DSN: "postgres://app:loweronly@db.internal:5432/app",
      DEFAULT_DSN: "postgres://db:postgres@db.internal:5432/app",
      PW_DSN: "postgres://db:password@db.internal:5432/app",
    } as unknown as NodeJS.ProcessEnv);
    expect(keys).toContain("Qx7mR2pL9z");
    // 8+ chars but no digit and no mixed case — not credential-looking.
    expect(keys).not.toContain("loweronly");
    expect(keys).not.toContain("postgres");
    expect(keys).not.toContain("password");
  });

  it("collects webhook/secret-named URLs verbatim and Sentry-style DSN keys", () => {
    const webhook = "https://hooks.slack.com/services/T0SYNTH/B0SYNTH/Zq8Rk2Vm7Tn4Wb9Xc3Ls";
    const tokenUrl = "https://discord.com/api/webhooks/123/Zq8Rk2Vm7Tn4Wb9Xc3LsAbc";
    const sentry = "https://abcdef0123456789abcdef0123456789@o1.ingest.sentry.io/1";
    const keys = knownKeysFromEnv({
      SLACK_WEBHOOK_URL: webhook,
      DISCORD_WEBHOOK_TOKEN_URL: tokenUrl,
      SENTRY_DSN: sentry,
      PAPERCLIP_PUBLIC_KEY_URL: "https://agentdash.example.com/.well-known/jwks.json",
      MY_SECRET_PATH: "/etc/x",
    } as unknown as NodeJS.ProcessEnv);
    expect(keys).toContain(webhook);
    expect(keys).toContain(tokenUrl);
    expect(keys).toContain("abcdef0123456789abcdef0123456789");
    expect(keys).not.toContain("https://agentdash.example.com/.well-known/jwks.json");
    expect(keys).not.toContain("/etc/x");
    // And printing any of them bare is redacted by the collected key.
    for (const [bare, collected] of [
      [webhook, webhook],
      [tokenUrl, tokenUrl],
      ["abcdef0123456789abcdef0123456789", sentry],
    ]) {
      expect(redactSecrets(`echo ${bare} done`, keys), bare).not.toContain(collected);
    }
  });

  it("NDJSON pass redacts the chunk field and keeps lines parseable", () => {
    const line = JSON.stringify({
      ts: "2026-10-03T00:00:00Z",
      stream: "stdout",
      chunk: `key is ${SHAPELESS_KEY}`,
    });
    const out = redactRunLogNdjson(`${line}\n`, [SHAPELESS_KEY]);
    const parsed = JSON.parse(out.trim());
    expect(parsed.chunk).not.toContain(SHAPELESS_KEY);
    expect(parsed.chunk).toContain("***REDACTED***");
    expect(parsed.stream).toBe("stdout");
  });

  it("NDJSON pass falls back to text redaction on partial lines", () => {
    // A byte-range read can start mid-line; the fragment is not valid JSON.
    const fragment = `...truncated ${SHAPELESS_KEY} tail`;
    const out = redactRunLogNdjson(fragment, [SHAPELESS_KEY]);
    expect(out).not.toContain(SHAPELESS_KEY);
    expect(out).toContain("***REDACTED***");
  });

  it("logSafeError strips secrets from message, stack and cause", () => {
    const err = Object.assign(new Error(`401 for key ${SHAPELESS_KEY}`), {
      cause: new Error(`upstream echoed ${SHAPELESS_KEY}`),
    });
    const safe = logSafeError(err, [SHAPELESS_KEY]) as { message: string; stack?: string; cause?: { message: string } };
    expect(JSON.stringify(safe)).not.toContain(SHAPELESS_KEY);
    expect(safe.message).toContain("***REDACTED***");
    expect(safe.cause?.message).toContain("***REDACTED***");
    expect(typeof logSafeError(`raw ${SHAPELESS_KEY}`, [SHAPELESS_KEY])).toBe("string");
    expect(logSafeError(`raw ${SHAPELESS_KEY}`, [SHAPELESS_KEY])).not.toContain(SHAPELESS_KEY);
  });
});
