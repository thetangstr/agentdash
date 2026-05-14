import type {
  AnchorAdapter,
  AnchorMetadata,
  AnchorResult,
  VerificationResult,
  VerifiedTime,
} from "../types.js";

export interface ClockchainAdapterOptions {
  apiKey: string;
  /** Base URL, e.g. https://node.clockchain.network/ (with or without trailing slash). */
  apiBase?: string;
  /** Per-request timeout in milliseconds. Defaults to 10s. */
  timeoutMs?: number;
  /**
   * Override the global `fetch` — useful for tests. Must be call-compatible
   * with the standard WHATWG `fetch`.
   */
  fetch?: typeof fetch;
}

interface TimeResponse {
  success?: boolean;
  data?: {
    latestBlockTime?: string;
    latestBlockHeight?: string;
  };
  meta?: {
    timestamp?: string;
  };
}

interface LogResponse {
  success?: boolean;
  data?: {
    logId?: string;
    blockHeight?: string;
    txHash?: string;
    timestamp?: string;
  };
  meta?: {
    timestamp?: string;
  };
}

interface SearchAssetResponse {
  success?: boolean;
  data?: {
    assetHash?: string;
    clientId?: string;
    logId?: string;
    blockHeight?: string;
    timestamp?: string;
  } | Array<{
    assetHash?: string;
    logId?: string;
  }>;
}

/**
 * Strip a trailing slash so we can concatenate path segments deterministically.
 */
function normalizeBase(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`clockchain ${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createClockchainAdapter(opts: ClockchainAdapterOptions): AnchorAdapter {
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new Error("Clockchain adapter requires an apiKey");
  }
  const apiBase = normalizeBase(opts.apiBase ?? "https://node.clockchain.network");
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetch ?? fetch;

  const headers: Record<string, string> = {
    "x-api-key": opts.apiKey,
    accept: "application/json, text/plain, */*",
  };

  async function getJson<T>(path: string): Promise<T> {
    const url = `${apiBase}${path}`;
    const res = await withTimeout(fetchImpl(url, { method: "GET", headers }), timeoutMs, `GET ${path}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`clockchain GET ${path} failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const url = `${apiBase}${path}`;
    const res = await withTimeout(
      fetchImpl(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      timeoutMs,
      `POST ${path}`,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`clockchain POST ${path} failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  return {
    name: "clockchain",

    async getVerifiedTime(): Promise<VerifiedTime> {
      const resp = await getJson<TimeResponse>("/api/time/time");
      const time = resp.data?.latestBlockTime ?? resp.meta?.timestamp;
      if (!time) {
        throw new Error("clockchain getVerifiedTime: response missing time field");
      }
      return {
        time,
        blockHeight: resp.data?.latestBlockHeight ?? null,
        raw: resp,
      };
    },

    async anchorBatch(payloadHash: string, metadata: AnchorMetadata): Promise<AnchorResult> {
      const resp = await postJson<LogResponse>("/log", {
        clientId: metadata.companyId,
        assetHash: payloadHash,
        metadata: {
          batchStartActivityId: metadata.batchStartActivityId,
          batchEndActivityId: metadata.batchEndActivityId,
          batchActivityCount: metadata.batchActivityCount,
          prevAnchorId: metadata.prevAnchorId,
          source: "agentdash",
          manifestVersion: 1,
        },
      });
      const externalLogId =
        resp.data?.logId ??
        resp.data?.txHash ??
        (resp.data?.blockHeight ? `block:${resp.data.blockHeight}` : null);
      if (!externalLogId) {
        throw new Error("clockchain anchorBatch: response missing log identifier");
      }
      return {
        externalLogId,
        externalBlockHeight: resp.data?.blockHeight ?? null,
        externalAnchoredAt: resp.data?.timestamp ?? resp.meta?.timestamp ?? null,
        raw: resp,
      };
    },

    async verifyAnchor(externalLogId: string, expectedPayloadHash: string): Promise<VerificationResult> {
      const path =
        `/searchAsset?logId=${encodeURIComponent(externalLogId)}` +
        `&assetHash=${encodeURIComponent(expectedPayloadHash)}`;
      try {
        const resp = await getJson<SearchAssetResponse>(path);
        const record = Array.isArray(resp.data)
          ? resp.data.find((r) => r.assetHash === expectedPayloadHash || r.logId === externalLogId)
          : resp.data;
        if (!record) {
          return { ok: false, reason: "anchor_not_found", details: { externalLogId } };
        }
        if (record.assetHash && record.assetHash !== expectedPayloadHash) {
          return {
            ok: false,
            reason: "asset_hash_mismatch",
            details: { externalLogId, actual: record.assetHash, expected: expectedPayloadHash },
          };
        }
        return { ok: true, externalLogId, details: { record } };
      } catch (err) {
        return {
          ok: false,
          reason: "verify_request_failed",
          details: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  };
}
