// AgentDash (GH #733): the encrypted envelope every off-box backup is stored in.
//
// The control plane encrypts to an OFFLINE public key, like the master key
// escrow (spec §3.3): it can write a backup but never read one back. Only the
// holder of the backup secret key (the restore tool, on the operator's
// machine) can open it.
//
// Format (all lengths big-endian uint32):
//
//   "ADBKUP1\n"                      8-byte magic
//   <header length> <header JSON>    BackupEnvelopeHeader, plain but authenticated
//   <secretstream header>            24 bytes
//   ( <frame length> <frame> )*      crypto_secretstream_xchacha20poly1305 frames
//
// - A fresh 32-byte data key per backup, sealed (crypto_box_seal) to the
//   backup public key; the header names the key by id (escrowKeyId), so a
//   rotated key still opens old backups.
// - Every frame carries SHA-256(magic || header JSON) as additional data, so
//   the header (box, slug, counts) cannot be swapped onto another backup.
// - The last frame carries TAG_FINAL and nothing may follow it: truncation,
//   reordering and appended data all fail to decrypt.
import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import sodium from "libsodium-wrappers";
import { escrowKeyId } from "../railway/secrets.js";

export const ENVELOPE_MAGIC = Buffer.from("ADBKUP1\n", "latin1");
export const ENVELOPE_ALG = "x25519-sealed-key+xchacha20poly1305-secretstream";
export const FRAME_PLAINTEXT_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

export interface BackupEnvelopeMeta {
  backupId: string;
  boxId: string;
  slug: string;
  createdAt: string;
  /** What the plaintext is, e.g. "paperclip-sql-gz-v1". */
  format: string;
  release: string | null;
  /** Core-table row counts the box reported at export time. */
  counts: Record<string, number | null>;
}

export interface BackupEnvelopeHeader extends BackupEnvelopeMeta {
  v: 1;
  alg: typeof ENVELOPE_ALG;
  /** escrowKeyId of the public key the data key is sealed to. */
  sealedTo: string;
  /** base64 crypto_box_seal of the 32-byte data key. */
  sealedDataKey: string;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function headerAd(headerJson: Buffer): Uint8Array {
  return createHash("sha256").update(ENVELOPE_MAGIC).update(headerJson).digest();
}

/**
 * A Transform that turns plaintext bytes into an envelope. The data key lives
 * only inside this object and is wiped when the stream ends.
 */
export async function createEncryptStream(publicKey: Uint8Array, meta: BackupEnvelopeMeta): Promise<Transform> {
  await sodium.ready;
  const dataKey = sodium.crypto_secretstream_xchacha20poly1305_keygen();
  const header: BackupEnvelopeHeader = {
    v: 1,
    alg: ENVELOPE_ALG,
    ...meta,
    sealedTo: escrowKeyId(publicKey),
    sealedDataKey: Buffer.from(sodium.crypto_box_seal(dataKey, publicKey)).toString("base64"),
  };
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const ad = headerAd(headerJson);
  const { state, header: streamHeader } = sodium.crypto_secretstream_xchacha20poly1305_init_push(dataKey);
  sodium.memzero(dataKey);
  let pending: Buffer = Buffer.alloc(0);
  let started = false;

  const frame = (t: Transform, chunk: Uint8Array, tag: number) => {
    const c = sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk, ad, tag);
    t.push(u32(c.length));
    t.push(Buffer.from(c));
  };
  const start = (t: Transform) => {
    if (started) return;
    started = true;
    t.push(Buffer.concat([ENVELOPE_MAGIC, u32(headerJson.length), headerJson, Buffer.from(streamHeader)]));
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        start(this);
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length > FRAME_PLAINTEXT_BYTES) {
          frame(this, pending.subarray(0, FRAME_PLAINTEXT_BYTES), sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
          pending = pending.subarray(FRAME_PLAINTEXT_BYTES);
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        start(this);
        frame(this, pending, sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL);
        pending = Buffer.alloc(0);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** Parse the plain header from the first bytes of an envelope (needs at most 8 + 4 + 64 KiB). */
export function parseEnvelopeHeader(buf: Buffer): { header: BackupEnvelopeHeader; headerJson: Buffer; bodyOffset: number } | null {
  if (buf.length < ENVELOPE_MAGIC.length + 4) return null;
  if (!buf.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) throw new EnvelopeError("not an AgentDash backup envelope (bad magic)");
  const len = buf.readUInt32BE(ENVELOPE_MAGIC.length);
  if (len === 0 || len > MAX_HEADER_BYTES) throw new EnvelopeError("envelope header length is out of range");
  const start = ENVELOPE_MAGIC.length + 4;
  if (buf.length < start + len) return null;
  const headerJson = Buffer.from(buf.subarray(start, start + len));
  let header: BackupEnvelopeHeader;
  try {
    header = JSON.parse(headerJson.toString("utf8")) as BackupEnvelopeHeader;
  } catch {
    throw new EnvelopeError("envelope header is not JSON");
  }
  if (header.v !== 1 || header.alg !== ENVELOPE_ALG) throw new EnvelopeError(`unsupported envelope (v=${String(header.v)}, alg=${String(header.alg)})`);
  return { header, headerJson, bodyOffset: start + len };
}

/**
 * A Transform that opens an envelope with the OFFLINE key pair. It fails on a
 * wrong key, any modified byte, a missing final frame, or data after it.
 * `onHeader` sees the authenticated-on-first-frame header as soon as it is read.
 */
export async function createDecryptStream(
  publicKey: Uint8Array,
  secretKey: Uint8Array,
  opts: { onHeader?: (h: BackupEnvelopeHeader) => void } = {},
): Promise<Transform> {
  await sodium.ready;
  const HEADERBYTES = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  const ABYTES = sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
  let buf: Buffer = Buffer.alloc(0);
  let ad: Uint8Array | null = null;
  let dataKey: Uint8Array | null = null;
  let state: ReturnType<typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull> | null = null;
  let finished = false;

  const step = (t: Transform) => {
    for (;;) {
      if (!ad) {
        const parsed = parseEnvelopeHeader(buf);
        if (!parsed) return;
        const { header, headerJson, bodyOffset } = parsed;
        if (header.sealedTo !== escrowKeyId(publicKey)) {
          throw new EnvelopeError(`this backup is sealed to backup key ${header.sealedTo}, not ${escrowKeyId(publicKey)}; use that key`);
        }
        try {
          dataKey = sodium.crypto_box_seal_open(Buffer.from(header.sealedDataKey, "base64"), publicKey, secretKey);
        } catch {
          throw new EnvelopeError("could not open the backup's data key with this key pair");
        }
        ad = headerAd(headerJson);
        buf = buf.subarray(bodyOffset);
        opts.onHeader?.(header);
        continue;
      }
      if (!state) {
        if (buf.length < HEADERBYTES) return;
        state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(buf.subarray(0, HEADERBYTES), dataKey!);
        sodium.memzero(dataKey!);
        buf = buf.subarray(HEADERBYTES);
        continue;
      }
      if (buf.length < 4) return;
      if (finished) throw new EnvelopeError("data after the final frame");
      const len = buf.readUInt32BE(0);
      if (len < ABYTES || len > FRAME_PLAINTEXT_BYTES + ABYTES) throw new EnvelopeError("frame length is out of range");
      if (buf.length < 4 + len) return;
      const res = sodium.crypto_secretstream_xchacha20poly1305_pull(state, buf.subarray(4, 4 + len), ad);
      if (!res) throw new EnvelopeError("a frame failed authentication (wrong key, or the backup was modified)");
      buf = buf.subarray(4 + len);
      if (res.message.length) t.push(Buffer.from(res.message));
      if (res.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) finished = true;
    }
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        step(this);
        cb();
      } catch (err) {
        cb(err instanceof EnvelopeError ? err : new EnvelopeError(err instanceof Error ? err.message : String(err)));
      }
    },
    flush(cb: TransformCallback) {
      if (buf.length) return cb(new EnvelopeError(finished ? "data after the final frame" : "the backup is truncated"));
      if (!finished) return cb(new EnvelopeError("the backup is truncated (no final frame)"));
      cb();
    },
  });
}
