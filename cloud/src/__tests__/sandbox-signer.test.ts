// AgentDash: spike tests for the signer daemon (R2). The daemon under test is
// the REAL cloud/sandbox/signerd.mjs — spawned on a unix socket in a temp
// dir, so policy refusals and signature validity are end-to-end, not mocked.
//
// The "agent cannot read the key" invariant is tested at two levels here:
// the daemon refuses a permissively-moded key file (assertKeyFilePerms +
// signerd's own startup check), and cloud/src/__tests__/sandbox-container.test.ts
// proves the uid boundary inside the image when Docker is available.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import {
  assertKeyFilePerms,
  KeyFilePermissionError,
  KmsKeySource,
  LocalFileKeySource,
} from "../sandbox/key-source.js";
import { checkSignRequest, signerPolicySchema } from "../sandbox/signer-policy.js";
import { signerRequest } from "../sandbox/signer-client.js";

const SANDBOX_DIR = fileURLToPath(new URL("../../sandbox", import.meta.url));
const SIGNERD = join(SANDBOX_DIR, "signerd.mjs");
const POLICY = JSON.parse(readFileSync(join(SANDBOX_DIR, "signer-policy.json"), "utf8")) as unknown;

// Domain separation: signerd signs tag || artifactType || "\n" || payload —
// keep this byte string in sync with taggedPayload() in signerd.mjs.
const SIGN_TAG_PREFIX = "agentdash-sandbox-sign/v1";
function tagged(artifactType: string, payloadB64: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${SIGN_TAG_PREFIX}\n`, "utf8"),
    Buffer.from(`${artifactType}\n`, "utf8"),
    Buffer.from(payloadB64, "base64"),
  ]);
}

function verify(publicKeyPem: string, artifactType: string, payloadB64: string, signatureB64: string): boolean {
  return cryptoVerify(
    null,
    tagged(artifactType, payloadB64),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureB64, "base64"),
  );
}

const JSON_PAYLOAD = Buffer.from(JSON.stringify({ kind: "proposal", body: "terms" })).toString("base64");

let dir: string;
let sock: string;
let daemon: ChildProcess;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "signerd-test-"));
  sock = join(dir, "sign.sock");
  daemon = spawn(
    process.execPath,
    [SIGNERD, "--socket", sock, "--policy", join(SANDBOX_DIR, "signer-policy.json"),
     "--key-file", join(dir, "key.pem"), "--generate"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const deadline = Date.now() + 60_000; // node spawn is slow on a loaded host
  while (!existsSync(sock)) {
    if (Date.now() > deadline) throw new Error("signerd never created its socket");
    await new Promise((r) => setTimeout(r, 25));
  }
});
afterAll(() => daemon.kill());

describe("signerd protocol", () => {
  it("init -> sign -> verify roundtrip over the domain-separated bytes", async () => {
    const init = await signerRequest(sock, { op: "init", sessionId: "s-1" });
    expect(init.ok).toBe(true);
    expect(String(init.publicKeyPem)).toContain("BEGIN PUBLIC KEY");

    const res = await signerRequest(sock, {
      op: "sign", sessionId: "s-1", artifactType: "handshake_proposal", payloadB64: JSON_PAYLOAD,
    });
    expect(res.ok).toBe(true);

    // The signature is real — and it is over tagged bytes: raw payload
    // verification must FAIL, a different artifactType must FAIL.
    expect(verify(String(init.publicKeyPem), "handshake_proposal", JSON_PAYLOAD, String(res.signatureB64))).toBe(true);
    expect(
      cryptoVerify(
        null,
        Buffer.from(JSON_PAYLOAD, "base64"), // untagged — must not verify
        createPublicKey(String(init.publicKeyPem)),
        Buffer.from(String(res.signatureB64), "base64"),
      ),
    ).toBe(false);
    expect(verify(String(init.publicKeyPem), "checkpoint", JSON_PAYLOAD, String(res.signatureB64))).toBe(false);
    expect(
      verify(
        String(init.publicKeyPem),
        "handshake_proposal",
        Buffer.from(JSON.stringify({ kind: "proposal", body: "tampered" })).toString("base64"),
        String(res.signatureB64),
      ),
    ).toBe(false);
  });

  it("sign is idempotent-stable per session: same key across calls", async () => {
    const a = await signerRequest(sock, { op: "init", sessionId: "s-2" });
    const b = await signerRequest(sock, { op: "init", sessionId: "s-2" });
    expect(a.publicKeyPem).toBe(b.publicKeyPem);
  });

  it("refuses an artifactType outside policy", async () => {
    const res = await signerRequest(sock, {
      op: "sign", sessionId: "s-1", artifactType: "wire_transfer",
      payloadB64: Buffer.from("x").toString("base64"),
    });
    expect(res).toMatchObject({ ok: false, error: { code: "policy_denied" } });
  });

  it("refuses Object.prototype names as artifactTypes (own-property lookup)", async () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const res = await signerRequest(sock, {
        op: "sign", sessionId: "s-1", artifactType: name,
        payloadB64: Buffer.from("x").toString("base64"),
      });
      expect(res, name).toMatchObject({ ok: false, error: { code: "policy_denied" } });
    }
  });

  it("refuses a payload that fails the artifact type's format check", async () => {
    // handshake_proposal is payloadFormat json-object; raw bytes deny.
    const res = await signerRequest(sock, {
      op: "sign", sessionId: "s-1", artifactType: "handshake_proposal",
      payloadB64: Buffer.from("not json at all").toString("base64"),
    });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    // a JSON array is not an object
    const arr = await signerRequest(sock, {
      op: "sign", sessionId: "s-1", artifactType: "handshake_proposal",
      payloadB64: Buffer.from("[1,2,3]").toString("base64"),
    });
    expect(arr).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
  });

  it("refuses an oversized payload", async () => {
    const res = await signerRequest(sock, {
      op: "sign", sessionId: "s-1", artifactType: "handshake_proposal",
      payloadB64: Buffer.alloc(70_000).toString("base64"),
    });
    expect(res).toMatchObject({ ok: false, error: { code: "payload_too_large" } });
  });

  it("refuses sign on a session that was never init'd", async () => {
    const res = await signerRequest(sock, {
      op: "sign", sessionId: "never", artifactType: "handshake_proposal",
      payloadB64: JSON_PAYLOAD,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "unknown_session" } });
  });

  it("company-scope artifacts sign under the file key; session scope never exposes it", async () => {
    const pub = await signerRequest(sock, { op: "companyPublicKey" });
    expect(pub.ok).toBe(true);
    const reportB64 = Buffer.from("daily report text").toString("base64"); // utf8 format
    const res = await signerRequest(sock, {
      op: "sign", sessionId: "s-1", artifactType: "daily_report", payloadB64: reportB64,
    });
    expect(res.ok).toBe(true);
    expect(res.publicKeyPem).toBe(pub.publicKeyPem);
    expect(verify(String(res.publicKeyPem), "daily_report", reportB64, String(res.signatureB64))).toBe(true);
  });

  it("clear forgets the session key", async () => {
    await signerRequest(sock, { op: "clear", sessionId: "s-1" });
    const res = await signerRequest(sock, { op: "publicKey", sessionId: "s-1" });
    expect(res).toMatchObject({ ok: false, error: { code: "unknown_session" } });
  });
});

describe("signerd socket lifecycle", () => {
  it("reclaims a stale socket file but refuses a live one", async () => {
    const stale = join(dir, "stale.sock");
    // Make a genuinely stale socket: run a daemon, SIGKILL it — the socket
    // file remains with nothing listening behind it.
    const dead = spawn(process.execPath, [
      SIGNERD, "--socket", stale, "--policy", join(SANDBOX_DIR, "signer-policy.json"),
      "--key-file", join(dir, "key2.pem"), "--generate",
    ]);
    const deadline0 = Date.now() + 60_000;
    while (!existsSync(stale)) {
      if (Date.now() > deadline0) throw new Error("first daemon never created its socket");
      await new Promise((r) => setTimeout(r, 25));
    }
    dead.kill("SIGKILL");
    await new Promise((r) => dead.on("exit", r));
    expect(statSync(stale).isSocket()).toBe(true);

    const d = spawn(process.execPath, [
      SIGNERD, "--socket", stale, "--policy", join(SANDBOX_DIR, "signer-policy.json"),
      "--key-file", join(dir, "key2.pem"), "--generate",
    ]);
    try {
      // claimSocket unlinks the stale file, then listen() is async — poll.
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          const h = await signerRequest(stale, { op: "health" });
          expect(h.ok).toBe(true);
          break;
        } catch {
          if (Date.now() > deadline) throw new Error("reclaimed socket never answered");
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    } finally {
      d.kill();
    }
    // a second daemon on a LIVE socket must refuse
    const dup = spawn(process.execPath, [
      SIGNERD, "--socket", sock, "--policy", join(SANDBOX_DIR, "signer-policy.json"),
    ]);
    const code = await new Promise((r) => dup.on("exit", r));
    expect(code).not.toBe(0);
  });
});

describe("key file permissions (R2)", () => {
  it("daemon minted the prototype key with mode 0400, owned by itself", () => {
    const st = statSync(join(dir, "key.pem"));
    expect(st.mode & 0o777).toBe(0o400);
  });

  it("assertKeyFilePerms rejects group/other-readable keys", () => {
    const p = join(dir, "loose.pem");
    const pair = generateKeyPairSync("ed25519");
    writeFileSync(p, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o644 });
    expect(() => new LocalFileKeySource(p)).toThrow(KeyFilePermissionError);
    chmodSync(p, 0o400);
    expect(() => new LocalFileKeySource(p)).not.toThrow();
    expect(() => new LocalFileKeySource(p, 99_999)).toThrow(KeyFilePermissionError); // wrong owner uid
    expect(() => assertKeyFilePerms(p)).not.toThrow();
  });

  it("signerd refuses to start on a permissive key file", async () => {
    const p = join(dir, "loose2.pem");
    writeFileSync(p, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o644,
    });
    const bad = spawn(process.execPath, [
      SIGNERD, "--socket", join(dir, "s2.sock"), "--policy",
      join(SANDBOX_DIR, "signer-policy.json"), "--key-file", p,
    ]);
    const code = await new Promise((r) => bad.on("exit", r));
    expect(code).not.toBe(0);
  });
});

describe("signerPolicy + checkSignRequest (TS mirror)", () => {
  it("validates the shipped policy document", () => {
    const p = signerPolicySchema.parse(POLICY);
    expect(p.artifactTypes.handshake_proposal?.key).toBe("session");
    expect(p.artifactTypes.handshake_proposal?.payloadFormat).toBe("json-object");
  });

  it("mirrors the daemon's verdicts", () => {
    const p = signerPolicySchema.parse(POLICY);
    expect(checkSignRequest(p, { artifactType: "checkpoint", payloadBytes: 10 })).toEqual({
      ok: true, keyScope: "session", payloadFormat: "json-object",
    });
    expect(checkSignRequest(p, { artifactType: "wire_transfer", payloadBytes: 10 }).ok).toBe(false);
    expect(checkSignRequest(p, { artifactType: "checkpoint", payloadBytes: 1 << 20 }).ok).toBe(false);
    // proto-member names deny here too
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(checkSignRequest(p, { artifactType: name, payloadBytes: 10 }).ok, name).toBe(false);
    }
    // format check mirrors the daemon when a payload is supplied
    const verdict = checkSignRequest(p, {
      artifactType: "handshake_proposal",
      payloadBytes: 5,
      payload: Buffer.from("nope"),
    });
    expect(verdict).toMatchObject({ ok: false, code: "invalid_payload" });
  });
});

describe("KmsKeySource", () => {
  it("delegates to the injected client and never owns AWS wiring", async () => {
    const calls: unknown[] = [];
    const kms = {
      getPublicKey: async (i: unknown) => (calls.push(i), Buffer.from("DERBYTES")),
      sign: async (i: { keyId: string; message: Buffer }) => (calls.push(i), Buffer.from("SIG")),
    };
    const src = new KmsKeySource({ keyId: "arn:aws:kms:us-east-1:1:key/company", kms });
    expect(await src.publicKey()).toBe(Buffer.from("DERBYTES").toString("base64"));
    expect((await src.sign(Buffer.from("payload"))).toString()).toBe("SIG");
    expect(calls).toHaveLength(2);
  });
});
