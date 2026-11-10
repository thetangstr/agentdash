import type { ActivityEvent } from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash admin powers (part 4): the admin audit. Owners and admins only;
 * it shows the same rows the activity feed shows them, with filters, paging
 * and a CSV export.
 */
export interface AuditFilters {
  actorType?: "user" | "agent" | "system";
  actorId?: string;
  /** Exact action names or `prefix.*`, at most 20. */
  actions?: string[];
  entityType?: string;
  entityId?: string;
  /** ISO 8601. */
  from?: string;
  to?: string;
  includeSystem?: boolean;
}

export interface AuditPage {
  items: ActivityEvent[];
  actorNames: Record<string, string>;
  nextCursor: string | null;
}

export function auditQueryString(filters: AuditFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (filters.actorType) params.set("actorType", filters.actorType);
  if (filters.actorId) params.set("actorId", filters.actorId);
  if (filters.actions && filters.actions.length > 0) params.set("action", filters.actions.join(","));
  if (filters.entityType) params.set("entityType", filters.entityType);
  if (filters.entityId) params.set("entityId", filters.entityId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.includeSystem === false) params.set("includeSystem", "false");
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const auditApi = {
  list: (companyId: string, filters: AuditFilters, cursor?: string | null, limit = 100) =>
    api.get<AuditPage>(
      `/companies/${companyId}/audit${auditQueryString(filters, { ...(cursor ? { cursor } : {}), limit: String(limit) })}`,
    ),
  /** A same-origin GET the browser downloads with the person's own session. */
  csvUrl: (companyId: string, filters: AuditFilters) =>
    `/api/companies/${companyId}/audit.csv${auditQueryString(filters)}`,
};
