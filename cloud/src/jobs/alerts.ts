// AgentDash: paging ops when a job fails or goes dead (spec §3.4, §6.3).
// Transports: the log (always), a webhook URL, and email through Resend.
// Every alert is redacted before it leaves the process, and an alert that
// cannot be delivered is logged, never thrown into the job runner.
import type { Logger } from "../logger.js";
import { redact, redactString } from "../logger.js";
import type { Secret } from "../secret.js";

export interface Alert {
  kind: "job_failed" | "job_dead" | "cleanup_refused";
  subject: string;
  boxId?: string | null;
  slug?: string | null;
  jobId?: string | null;
  jobKind?: string | null;
  step?: string | null;
  attempt?: number | null;
  error?: string | null;
}

export interface Alerter {
  send(alert: Alert): Promise<void>;
}

function clean(alert: Alert): Alert {
  const out = redact(alert) as Alert;
  out.subject = redactString(alert.subject);
  return out;
}

export function logAlerter(log: Logger): Alerter {
  return {
    async send(alert) {
      log.error("ops alert", { alert: clean(alert) });
    },
  };
}

export function webhookAlerter(url: string, opts: { fetch?: typeof fetch; log: Logger }): Alerter {
  const f = opts.fetch ?? fetch;
  return {
    async send(alert) {
      const body = clean(alert);
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `[agentdash-cloud] ${body.subject}`, alert: body }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`alert webhook answered HTTP ${res.status}`);
    },
  };
}

/** Email through Resend's HTTP API (the control plane's mail provider, spec §3.7). */
export function resendEmailAlerter(opts: { apiKey: Secret; from: string; to: string[]; fetch?: typeof fetch }): Alerter {
  const f = opts.fetch ?? fetch;
  return {
    async send(alert) {
      const body = clean(alert);
      const lines = Object.entries(body)
        .filter(([k, v]) => k !== "subject" && v !== null && v !== undefined)
        .map(([k, v]) => `${k}: ${String(v)}`);
      const res = await f("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey.reveal()}` },
        body: JSON.stringify({ from: opts.from, to: opts.to, subject: `[agentdash-cloud] ${body.subject}`, text: lines.join("\n") }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`alert email answered HTTP ${res.status}`);
    },
  };
}

/** Fan out to every configured transport; each failure is logged and swallowed. */
export function combineAlerters(log: Logger, alerters: Alerter[]): Alerter {
  return {
    async send(alert) {
      await Promise.all(
        alerters.map((a) =>
          a.send(alert).catch((err: unknown) => {
            log.error("alert delivery failed", { err, alertKind: alert.kind });
          }),
        ),
      );
    },
  };
}
