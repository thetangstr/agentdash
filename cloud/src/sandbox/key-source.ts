// AgentDash: where the company signing key lives (spike R2). Two sources
// behind one interface so signerd/policy code never cares which is in use:
//
//   LocalFileKeySource — the prototype: a PEM at /etc/sandbox-signer/
//                        signing-key.pem, mode 0400, owned by the `signer`
//                        uid; the daemon refuses a world/group-readable file.
//   KmsKeySource       — Phase 1: an AWS KMS asymmetric key in the AgentDash
//                        account. Key material never leaves KMS; sign() is a
//                        KMS Sign call and publicKey() is GetPublicKey. The
//                        interface is the injected `KmsLike` client — nothing
//                        here constructs a real AWS client, so this module can
//                        never silently touch AWS from a test or dev box.
//
// Curve note: KMS does not support ed25519. If Clockchain needs secp256k1 the
// KMS spec is ECC_SECG_P256K1 with MessageType=DIGEST over a caller-computed
// keccak256 — an open question recorded in SPIKE.md.
import { createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export interface SignerKeySource {
  readonly kind: "local-file" | "kms";
  /** SPKI public key — PEM for local-file, base64 DER for kms. */
  publicKey(): Promise<string>;
  sign(payload: Buffer): Promise<Buffer>;
}

export class KeyFilePermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyFilePermissionError";
  }
}

/**
 * The R2 invariant as an assertion: the key file must be mode 0400/0600 and
 * owned by the expected uid. `expectedUid` is the `signer` uid in the image;
 * pass undefined in dev where the daemon runs as the operator.
 */
export function assertKeyFilePerms(path: string, expectedUid?: number): void {
  const st = statSync(path);
  if (st.mode & 0o077) {
    throw new KeyFilePermissionError(
      `${path} mode ${(st.mode & 0o777).toString(8)} is readable by group/other`,
    );
  }
  if (expectedUid !== undefined && st.uid !== expectedUid) {
    throw new KeyFilePermissionError(`${path} owned by uid ${st.uid}, expected ${expectedUid}`);
  }
}

export class LocalFileKeySource implements SignerKeySource {
  readonly kind = "local-file" as const;

  constructor(
    private readonly path: string,
    expectedUid?: number,
  ) {
    assertKeyFilePerms(path, expectedUid);
  }

  async publicKey(): Promise<string> {
    return createPublicKey(this.key()).export({ type: "spki", format: "pem" }).toString();
  }

  async sign(payload: Buffer): Promise<Buffer> {
    // ed25519 for the prototype file key.
    return cryptoSign(null, payload, this.key());
  }

  private key() {
    return createPrivateKey(readFileSync(this.path));
  }
}

/** Minimal KMS surface — maps to AWS KMS Sign and GetPublicKey. */
export interface KmsLike {
  /** KMS Sign: returns the signature bytes. */
  sign(input: { keyId: string; message: Buffer; messageType: "RAW" | "DIGEST" }): Promise<Buffer>;
  /** KMS GetPublicKey: returns the DER-encoded SubjectPublicKeyInfo. */
  getPublicKey(input: { keyId: string }): Promise<Buffer>;
}

export class KmsKeySource implements SignerKeySource {
  readonly kind = "kms" as const;

  constructor(
    private readonly opts: {
      keyId: string;
      kms: KmsLike;
      /** "RAW" signs the payload (<=4KiB); "DIGEST" signs a pre-computed digest. */
      messageType?: "RAW" | "DIGEST";
    },
  ) {}

  async publicKey(): Promise<string> {
    const der = await this.opts.kms.getPublicKey({ keyId: this.opts.keyId });
    return der.toString("base64");
  }

  async sign(payload: Buffer): Promise<Buffer> {
    return this.opts.kms.sign({
      keyId: this.opts.keyId,
      message: payload,
      messageType: this.opts.messageType ?? "RAW",
    });
  }
}
