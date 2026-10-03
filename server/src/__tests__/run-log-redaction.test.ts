// AgentDash (GH #992): the server-side run-log redaction service — instance
// known secrets come from credential-named process env vars and the managed
// Hermes profile's `.env`, and every helper runs the shared pattern set on
// top of them.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRunLogStreamRedactor,
  instanceKnownSecrets,
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
});
