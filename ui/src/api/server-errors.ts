import { api } from "./client";

export interface ServerErrorRow {
  id: string;
  fingerprint: string;
  name: string;
  message: string;
  stack: string | null;
  lastContext: { method?: string; url?: string; status?: number; kind?: string } | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface AlerterStatus {
  configured: boolean;
  sentSinceBoot: number;
  droppedSinceBoot: number;
  debouncedSinceBoot: number;
  lastSendError: string | null;
}

export interface HealthChecks {
  status: "ok" | "degraded";
  db: { ok: boolean; latencyMs: number };
  disk: { ok: boolean; freeBytes: number };
  backup: { ok: boolean; latestAt: string | null; ageHours: number | null } | null;
  runs: { ok: boolean; stuck: number };
}

export interface ServerErrorsResponse {
  errors: ServerErrorRow[];
  alerter: AlerterStatus;
  checks: HealthChecks | null;
}

export const serverErrorsApi = {
  list: () => api.get<ServerErrorsResponse>("/instance/errors"),
  clear: (fingerprint: string) =>
    api.delete<{ cleared: number }>(`/instance/errors/${encodeURIComponent(fingerprint)}`),
};
