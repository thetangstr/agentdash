import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

function normalizeMethod(input: string): string {
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : "POST";
}

function resolveTimeoutMs(config: Record<string, unknown>): number {
  const timeoutMs = asNumber(config.timeoutMs, Number.NaN);
  if (Number.isFinite(timeoutMs)) return Math.max(0, Math.floor(timeoutMs));
  const timeoutSec = asNumber(config.timeoutSec, 0);
  return Math.max(0, Math.floor(timeoutSec * 1000));
}

function readHeaders(input: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parseObject(input)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context, onMeta } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = normalizeMethod(asString(config.method, "POST"));
  const timeoutMs = resolveTimeoutMs(config);
  const headers = readHeaders(config.headers);
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };
  const shouldSendBody = method !== "GET" && method !== "HEAD";

  if (onMeta) {
    await onMeta({
      adapterType: "http",
      command: `${method} ${url}`,
      commandArgs: [],
      context,
    });
  }

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      ...(shouldSendBody ? { body: JSON.stringify(body) } : {}),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      const responseBody = await res.text().catch(() => "");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "http_status",
        errorMessage: `HTTP ${method} ${url} failed with status ${res.status}`,
        summary: `HTTP ${method} ${url}`,
        resultJson: {
          status: res.status,
          statusText: res.statusText,
          body: responseBody,
        },
      };
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `HTTP ${method} ${url} timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "http_request_failed",
      errorMessage: `HTTP ${method} ${url} failed: ${message}`,
      summary: `HTTP ${method} ${url}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
