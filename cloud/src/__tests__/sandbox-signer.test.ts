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

function verify(publicKeyPem: string, payloadB64: string, signatureB64: string): boolean {
  return cryptoVerify(
    null,
    Buffer.from(payloadB64, "base64"),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureB64, "base64"),
  );
}

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
  const deadline = Date.now() + 10_000;
  while (!existsSync(sock)) {
    if (Date.now() > deadline) throw new Error("signerd never created its socket");
    await new Promise((r) => setTimeout(r, 25));
  }
});
afterAll(() => daemon.kill());

describe("signerd protocol", () => {
  it("init -> sign -> verify roundtrip", async () => {
    const init = await signerRequest(sock, { op: "init", sessionId: "s-1" });
    expect(init.ok).toBe(true);
    expect(String(init.publicKeyPem)).toContain("BEGIN PUBLIC KEY");

    const payload = Buffer.from("handshake artifact bytes").toString("base64");
    const res = await signerRequest(sock, {
      op: "sign", sessionId: "s-1", artifactType: "handshake_proposal", payloadB64: payload,
    });
    expect(res.ok).toBe(true);

    // Verify the signature is real, not a stub.
    expect(verify(String(init.publicKeyPem), payload, String(res.signatureB64))).toBe(true);
    expect(verify(String(init.publicKeyPem), Buffer.from("tampered").toString("base64"), String(res.signatureB64))).toBe(false);
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
      payloadB64: Buffer.from("x").toString("base64"),
    });
    expect(res).toMatchObject({ ok: false, error: { code: "unknown_session" } });
  });

  it("company-scope artifacts sign under the file key; session scope never exposes it", async () => {
    const pub = await signerRequest(sock, { op: "companyPublicKey" });
    expect(pub.ok).toBe(true);
    const res = await signerRequest(sock, {
      op: "sign", sessionId: "s-1", artifactType: "daily_report",
      payloadB64: Buffer.from("daily").toString("base64"),
    });
    expect(res.ok).toBe(true);
    expect(res.publicKeyPem).toBe(pub.publicKeyPem);
    expect(verify(String(res.publicKeyPem), Buffer.from("daily").toString("base64"), String(res.signatureB64))).toBe(true);
  });

  it("clear forgets the session key", async () => {
    await signerRequest(sock, { op: "clear", sessionId: "s-1" });
    const res = await signerRequest(sock, { op: "publicKey", sessionId: "s-1" });
    expect(res).toMatchObject({ ok: false, error: { code: "unknown_session" } });
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
  });

  it("mirrors the daemon's verdicts", () => {
    const p = signerPolicySchema.parse(POLICY);
    expect(checkSignRequest(p, { artifactType: "checkpoint", payloadBytes: 10 })).toEqual({
      ok: true, keyScope: "session",
    });
    expect(checkSignRequest(p, { artifactType: "wire_transfer", payloadBytes: 10 }).ok).toBe(false);
    expect(checkSignRequest(p, { artifactType: "checkpoint", payloadBytes: 1 << 20 }).ok).toBe(false);
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
