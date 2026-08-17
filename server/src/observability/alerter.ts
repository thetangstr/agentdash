/**
 * Signals → email, via Resend's HTTPS API.
 *
 * Decided 2026-08-16: alerts are the ONE deliberate egress from this box.
 * The error payloads themselves stay local (see the error sink); what leaves
 * is the signal's one-sentence summary, its kind, a count, and a link back
 * to the local instance — never a request body, never client content. That
 * line is load-bearing: this system runs in a client's office on client data.
 *
 * With no API key configured the alerter still subscribes and counts what it
 * would have sent, so `droppedSinceBoot` makes the silence visible in the
 * health endpoint instead of the config gap masquerading as a quiet system —
 * the exact failure mode (a transport nothing configured, silently dropping)
 * this module replaces.
 *
 * The key is read from the environment file, never argv, and is sent only to
 * api.resend.com over TLS.
 */

import type { Signal, SignalKind } from "./signals.js";
import { subscribeToSignals } from "./signals.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;

/** Repeats of the same (kind, dedupeKey) within this window fold silently. */
const DEBOUNCE_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface AlerterConfig {
  apiKey: string | null;
  from: string | null;
  to: string[];
  /** Base URL of the local instance, for the "look here" link. */
  publicBaseUrl: string | null;
}

export function readAlerterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AlerterConfig {
  const to = (env.AGENTDASH_ALERT_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    apiKey: env.AGENTDASH_ALERT_RESEND_API_KEY?.trim() || null,
    from: env.AGENTDASH_ALERT_FROM?.trim() || null,
    to,
    publicBaseUrl: env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() || null,
  };
}

export interface AlerterStatus {
  configured: boolean;
  sentSinceBoot: number;
  droppedSinceBoot: number;
  debouncedSinceBoot: number;
  lastSendError: string | null;
}

const status: AlerterStatus = {
  configured: false,
  sentSinceBoot: 0,
  droppedSinceBoot: 0,
  debouncedSinceBoot: 0,
  lastSendError: null,
};

export function alerterStatus(): AlerterStatus {
  return { ...status };
}

function dedupeKey(signal: Signal): string {
  const detailKey =
    typeof signal.detail?.fingerprint === "string"
      ? signal.detail.fingerprint
      : typeof signal.detail?.agentId === "string"
        ? signal.detail.agentId
        : "";
  return `${signal.kind}:${detailKey}`;
}

function renderBody(signal: Signal, baseUrl: string | null): string {
  // Plain text on purpose: nothing here should ever need HTML, and plain
  // text cannot smuggle content. Summary + kind + timestamp + link. No more.
  const lines = [
    signal.summary,
    "",
    `kind: ${signal.kind}`,
    `at:   ${signal.occurredAt.toISOString()}`,
  ];
  if (baseUrl) lines.push("", `instance: ${baseUrl}`);
  lines.push("", "Details stay on the instance by design; this email carries none.");
  return lines.join("\n");
}

/**
 * Which kinds alert. Everything alerts today except run_failed one-offs are
 * still included — the review's finding was that every failure mode we have
 * actually hit had the shape of a run ending wrong, so day one errs loud.
 */
const ALERTING_KINDS: ReadonlySet<SignalKind> = new Set([
  "server_error",
  "run_failed",
  "run_timed_out",
  "run_stuck",
  "backup_failed",
  "backup_stale",
  "disk_low",
  "budget_warn",
  "budget_stop",
  "mandate_expired",
]);

export function startAlerter(config: AlerterConfig = readAlerterConfigFromEnv()): AlerterStatus {
  const configured = Boolean(config.apiKey && config.from && config.to.length > 0);
  status.configured = configured;

  const lastSentAt = new Map<string, number>();

  subscribeToSignals(async (signal) => {
    if (!ALERTING_KINDS.has(signal.kind)) return;

    if (!configured) {
      status.droppedSinceBoot += 1;
      return;
    }

    const key = dedupeKey(signal);
    const now = Date.now();
    const last = lastSentAt.get(key);
    if (last !== undefined && now - last < DEBOUNCE_WINDOW_MS) {
      status.debouncedSinceBoot += 1;
      return;
    }
    lastSentAt.set(key, now);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: config.from,
          to: config.to,
          subject: `[AgentDash ${signal.kind}] ${signal.summary}`.slice(0, 200),
          text: renderBody(signal, config.publicBaseUrl),
        }),
      });
      if (!res.ok) {
        status.lastSendError = `resend ${res.status}`;
        // The send failed but the signal was real: count it as dropped so the
        // health endpoint shows mail is not getting out.
        status.droppedSinceBoot += 1;
        return;
      }
      status.sentSinceBoot += 1;
      status.lastSendError = null;
    } catch (err) {
      status.lastSendError = err instanceof Error ? err.message : String(err);
      status.droppedSinceBoot += 1;
    } finally {
      clearTimeout(timer);
    }
  });

  return alerterStatus();
}
