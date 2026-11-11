import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { auditApi, type AuditFilters } from "@/api/audit";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useCapability } from "@/hooks/useCapability";
import { formatActivityVerb, knownActivityActions } from "@/lib/activity-format";
import { queryKeys } from "@/lib/queryKeys";

/**
 * AgentDash admin powers (part 4): the admin audit. Who did what in this
 * company, filtered by person, action and dates, paged with "Load more" and
 * exported as CSV. Owners and admins only: it shows the same rows the
 * activity feed shows them, never more. Every company sees the same page.
 */

const PAGE_SIZE = 100;

/** A local calendar day as the first and last instant of that day. */
function dayStart(day: string): string | undefined {
  if (!day) return undefined;
  const at = new Date(`${day}T00:00:00`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}
function dayEnd(day: string): string | undefined {
  if (!day) return undefined;
  const at = new Date(`${day}T23:59:59.999`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

function actionFamilies(actions: string[]): string[] {
  return [...new Set(actions.map((action) => action.split(".")[0]!).filter(Boolean))].sort();
}

export function CompanyAudit() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const manage = useCapability(selectedCompanyId, "company:manage");
  const canSee = !manage.isLoading && manage.allowed;

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Audit" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const [person, setPerson] = useState("");
  const [action, setAction] = useState("");
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [includeSystem, setIncludeSystem] = useState(true);

  const filters = useMemo<AuditFilters>(() => {
    const next: AuditFilters = { includeSystem };
    if (person === "system") next.actorType = "system";
    else if (person.startsWith("user:")) { next.actorType = "user"; next.actorId = person.slice(5); }
    else if (person.startsWith("agent:")) { next.actorType = "agent"; next.actorId = person.slice(6); }
    if (action) next.actions = [action];
    next.from = dayStart(fromDay);
    next.to = dayEnd(toDay);
    return next;
  }, [person, action, fromDay, toDay, includeSystem]);

  const members = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId && canSee,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && canSee,
  });

  const audit = useInfiniteQuery({
    queryKey: queryKeys.audit(selectedCompanyId!, filters),
    queryFn: ({ pageParam }) => auditApi.list(selectedCompanyId!, filters, pageParam, PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!selectedCompanyId && canSee,
    retry: false,
  });

  const actions = useMemo(() => knownActivityActions(), []);
  const families = useMemo(() => actionFamilies(actions), [actions]);
  const rows = useMemo(() => (audit.data?.pages ?? []).flatMap((page) => page.items), [audit.data]);
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const page of audit.data?.pages ?? []) Object.assign(map, page.actorNames);
    return map;
  }, [audit.data]);

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to see its audit.</div>;
  }

  return (
    <div className="max-w-6xl min-w-0 space-y-6" data-testid="company-audit-page">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Audit</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Who did what in this company, with the same visibility as the activity feed. Filter it, page through it, or export it as CSV.
        </p>
      </div>

      {manage.isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="company-audit-loading">Loading…</p>
      ) : !manage.allowed ? (
        <p className="text-sm text-muted-foreground" data-testid="company-audit-no-access">Only owners and admins can see this.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3" data-testid="company-audit-filters">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground max-sm:w-full">
              Person
              <select
                aria-label="Person"
                data-testid="company-audit-person"
                className="w-56 max-sm:min-h-11 max-sm:w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm text-foreground"
                value={person}
                onChange={(event) => setPerson(event.target.value)}
              >
                <option value="">Everyone</option>
                <optgroup label="People">
                  {(members.data?.users ?? []).map((entry) => (
                    <option key={entry.principalId} value={`user:${entry.principalId}`}>
                      {entry.user?.name || entry.user?.email || entry.principalId}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Agents">
                  {(agents.data ?? []).map((agent) => (
                    <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>
                  ))}
                </optgroup>
                <option value="system">The system</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground max-sm:w-full">
              Action
              <select
                aria-label="Action"
                data-testid="company-audit-action"
                className="w-64 max-sm:min-h-11 max-sm:w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm text-foreground"
                value={action}
                onChange={(event) => setAction(event.target.value)}
              >
                <option value="">Any action</option>
                <optgroup label="Kinds">
                  {families.map((family) => (
                    <option key={family} value={`${family}.*`}>Anything about {family.replace(/_/g, " ")}</option>
                  ))}
                </optgroup>
                <optgroup label="Actions">
                  {actions.map((name) => (
                    <option key={name} value={name}>{`${formatActivityVerb(name)} (${name})`}</option>
                  ))}
                </optgroup>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground max-sm:flex-1">
              From
              <input
                type="date"
                aria-label="From"
                data-testid="company-audit-from"
                className="rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm text-foreground max-sm:min-h-11"
                value={fromDay}
                onChange={(event) => setFromDay(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground max-sm:flex-1">
              To
              <input
                type="date"
                aria-label="To"
                data-testid="company-audit-to"
                className="rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm text-foreground max-sm:min-h-11"
                value={toDay}
                onChange={(event) => setToDay(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground max-sm:w-full">
              <input
                type="checkbox"
                data-testid="company-audit-include-system"
                checked={includeSystem}
                onChange={(event) => setIncludeSystem(event.target.checked)}
              />
              Include system events
            </label>
            <a
              href={auditApi.csvUrl(selectedCompanyId, filters)}
              download
              data-testid="company-audit-export"
              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent max-sm:min-h-11"
            >
              Export CSV
            </a>
          </div>
          <p className="text-xs text-muted-foreground">An export holds at most 50,000 rows; narrow the filters for more. Each export is recorded in the audit.</p>

          {audit.isLoading ? (
            <p className="text-sm text-muted-foreground" data-testid="company-audit-rows-loading">Loading the audit…</p>
          ) : audit.error ? (
            <p className="text-sm text-destructive" role="alert" data-testid="company-audit-error">
              {audit.error instanceof ApiError ? audit.error.message : "The audit could not be loaded."}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="company-audit-empty">Nothing matches these filters.</p>
          ) : (
            <div className="max-w-full overflow-x-auto rounded-md border border-border" data-testid="company-audit-table">
              <table className="w-full min-w-[44rem] text-sm">
                <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Who</th>
                    <th className="px-3 py-2 font-medium">What they did</th>
                    <th className="px-3 py-2 font-medium">On</th>
                    <th className="px-3 py-2 font-medium">How</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const details = (row.details ?? null) as Record<string, unknown> | null;
                    const via = typeof details?.via === "string" ? details.via : null;
                    const batch = details?.batch && typeof details.batch === "object" ? (details.batch as { id?: unknown }).id : null;
                    return (
                      <tr key={row.id} className="border-t border-border align-top" data-testid="company-audit-row">
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</td>
                        <td className="px-3 py-2">{row.actorType === "system" ? "The system" : names[row.actorId] ?? row.actorId}</td>
                        <td className="px-3 py-2">
                          {formatActivityVerb(row.action, details)}
                          <span className="ml-1 font-mono text-xs text-muted-foreground">{row.action}</span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{row.entityType} {row.entityId}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {via ?? (typeof batch === "string" ? `batch ${batch}` : "")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {audit.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void audit.fetchNextPage()}
              disabled={audit.isFetchingNextPage}
              data-testid="company-audit-load-more"
            >
              {audit.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
