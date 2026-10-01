// AgentDash (GH #733): a minimal S3-compatible object store client (AWS S3,
// Cloudflare R2, Backblaze B2, MinIO) for the off-box backups: PUT a file,
// GET a stream, DELETE. Signature Version 4 is implemented here (about sixty
// lines) rather than pulling in the AWS SDK for three calls.
//
// Credentials are a Secret, revealed only into the HMAC; no request ever logs
// a header. Objects are already encrypted (./envelope.ts) before they get here.
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import type { Secret } from "../secret.js";

export interface ObjectStore {
  /** Upload a local file. `sha256` (hex) is the file's digest, signed into the request. */
  put(path: string, file: string, info: { size: number; sha256: string }, opts?: { signal?: AbortSignal }): Promise<void>;
  get(path: string, opts?: { signal?: AbortSignal }): Promise<Readable>;
  delete(path: string, opts?: { signal?: AbortSignal }): Promise<void>;
  /** A short description for logs and status (endpoint host, bucket, prefix). Never a credential. */
  describe(): string;
}

export class ObjectStoreError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ObjectStoreError";
    this.status = status;
  }
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** S3's single-request PUT limit. Larger backups need multipart upload (post-launch). */
export const MAX_SINGLE_PUT_BYTES = 5 * 1024 ** 3;

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** RFC 3986 encoding, as SigV4 requires (S3 keeps "/" in the path). */
export function uriEncode(value: string, keepSlash: boolean): string {
  let out = "";
  for (const ch of Buffer.from(value, "utf8")) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += `%${ch.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to sign besides host; names are lowercased. Must include x-amz-content-sha256. */
  headers: Record<string, string>;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** e.g. 20130524T000000Z */
  amzDate: string;
  service?: string;
}

/** The Authorization header value for an AWS Signature Version 4 request (header-based, no query string). */
export function signV4(input: SignInput): string {
  const service = input.service ?? "s3";
  const date = input.amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: input.url.host };
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    uriEncode(decodeURIComponent(input.url.pathname), true),
    query,
    canonicalHeaders,
    signedHeaders,
    headers["x-amz-content-sha256"] ?? EMPTY_SHA256,
  ].join("\n");
  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function amzDate(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export interface S3StoreOptions {
  /** e.g. https://s3.us-west-2.amazonaws.com or https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: Secret;
  /** Path prefix inside the bucket (no leading or trailing slash). */
  prefix: string;
  /** Virtual-hosted style (<bucket>.<host>); path style (<host>/<bucket>) when false. */
  virtualHosted?: boolean;
  now?: () => Date;
  /** Per-request inactivity timeout. */
  timeoutMs?: number;
}

/**
 * One HTTP exchange on node:http(s). Not fetch: fetch drops a caller's
 * Content-Length and streams the body chunked, which S3 refuses for a PUT.
 */
function exchange(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: Readable | null,
  opts: { signal?: AbortSignal; timeoutMs: number },
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, { method, headers, signal: opts.signal, timeout: opts.timeoutMs }, resolve);
    req.on("timeout", () => req.destroy(new Error("object store request timed out")));
    req.on("error", (err) => reject(new ObjectStoreError(`object store ${method} failed: ${(err as NodeJS.ErrnoException).code ?? err.message}`, 0)));
    if (body) {
      body.on("error", (err) => req.destroy(err));
      body.pipe(req);
    } else req.end();
  });
}

async function drain(res: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of res) if (text.length < 4096) text += String(chunk);
  return text;
}

export class S3Store implements ObjectStore {
  readonly #o: S3StoreOptions;

  constructor(opts: S3StoreOptions) {
    this.#o = opts;
  }

  #timeout(): number {
    return this.#o.timeoutMs ?? 120_000;
  }

  describe(): string {
    return `${new URL(this.#o.endpoint).host}/${this.#o.bucket}/${this.#o.prefix}`;
  }

  url(path: string): URL {
    const base = new URL(this.#o.endpoint);
    const full = [this.#o.prefix, path].filter(Boolean).join("/");
    const encoded = uriEncode(full, true);
    if (this.#o.virtualHosted) return new URL(`${base.protocol}//${this.#o.bucket}.${base.host}/${encoded}`);
    const root = base.pathname.replace(/\/+$/, "");
    return new URL(`${base.protocol}//${base.host}${root}/${uriEncode(this.#o.bucket, false)}/${encoded}`);
  }

  #signed(method: string, url: URL, payloadSha256: string, extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { "x-amz-content-sha256": payloadSha256, "x-amz-date": amzDate(this.#o.now?.() ?? new Date()), ...extra };
    const authorization = signV4({
      method,
      url,
      headers,
      region: this.#o.region,
      accessKeyId: this.#o.accessKeyId,
      secretAccessKey: this.#o.secretAccessKey.reveal(),
      amzDate: headers["x-amz-date"]!,
    });
    return { ...headers, authorization };
  }

  async #fail(op: string, res: IncomingMessage): Promise<never> {
    // S3 error bodies are XML with a Code; keep only the code, never echo the request.
    const text = await drain(res).catch(() => "");
    const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? null;
    throw new ObjectStoreError(`object store ${op} failed: HTTP ${res.statusCode}${code ? ` ${code}` : ""}`, res.statusCode ?? 0);
  }

  async put(path: string, file: string, info: { size: number; sha256: string }, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (info.size > MAX_SINGLE_PUT_BYTES) throw new ObjectStoreError(`backup is ${info.size} bytes, over the 5 GiB single-PUT limit`, 0);
    const url = this.url(path);
    const headers = this.#signed("PUT", url, info.sha256, { "content-length": String(info.size), "content-type": "application/octet-stream" });
    const res = await exchange("PUT", url, headers, createReadStream(file), { signal: opts.signal, timeoutMs: this.#timeout() });
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) await this.#fail("put", res);
    await drain(res);
  }

  async get(path: string, opts: { signal?: AbortSignal } = {}): Promise<Readable> {
    const url = this.url(path);
    const res = await exchange("GET", url, this.#signed("GET", url, EMPTY_SHA256), null, { signal: opts.signal, timeoutMs: this.#timeout() });
    if (res.statusCode !== 200) await this.#fail("get", res);
    return res;
  }

  async delete(path: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const url = this.url(path);
    const res = await exchange("DELETE", url, this.#signed("DELETE", url, EMPTY_SHA256), null, { signal: opts.signal, timeoutMs: this.#timeout() });
    // S3 answers 204 for a delete, also when the object was already gone.
    const status = res.statusCode ?? 0;
    if ((status < 200 || status >= 300) && status !== 404) await this.#fail("delete", res);
    await drain(res);
  }
}
