import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
export function CapacityDashboard() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;

  const { data: workforce } = useQuery({
    queryKey: ["capacity-workforce", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/capacity/workforce`);
      return res.json();
    },
    enabled: !!companyId,
  });

  const { data: pipeline } = useQuery({
    queryKey: ["capacity-pipeline", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/capacity/pipeline`);
      return res.json();
    },
    enabled: !!companyId,
  });

  const { data: departments = [] } = useQuery({
    queryKey: ["departments", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/departments`);
      return res.json();
    },
    enabled: !!companyId,
  });

  if (!companyId) return <div className="p-6 text-muted-foreground">Select a company</div>;

  const statusColors: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-700",
    running: "bg-blue-100 text-blue-700",
    idle: "bg-secondary text-secondary-foreground",
    paused: "bg-amber-100 text-amber-700",
    error: "bg-destructive/10 text-destructive",
    todo: "bg-secondary text-secondary-foreground",
    in_progress: "bg-blue-100 text-blue-700",
    done: "bg-emerald-100 text-emerald-700",
    blocked: "bg-destructive/10 text-destructive",
    backlog: "bg-muted text-muted-foreground",
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Capacity & Workforce</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Workforce */}
        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Workforce</h2>
          <div className="text-4xl font-bold">{workforce?.totalAgents ?? 0}</div>
          <p className="text-sm text-muted-foreground mt-1">total agents</p>
          {workforce?.byStatus && Object.keys(workforce.byStatus).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-4">
              {Object.entries(workforce.byStatus).map(([status, count]) => (
                <span key={status} className={`rounded-full px-2 py-0.5 text-xs ${statusColors[status] ?? "bg-muted text-muted-foreground"}`}>
                  {status}: {count as number}
                </span>
              ))}
            </div>
          )}
          {workforce?.byRole && Object.keys(workforce.byRole).length > 0 && (
            <div className="mt-4 space-y-1.5">
              {Object.entries(workforce.byRole).map(([role, count]) => (
                <div key={role} className="flex justify-between text-sm">
                  <span className="text-muted-foreground capitalize">{role}</span>
                  <span className="font-medium">{count as number}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pipeline */}
        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Task Pipeline</h2>
          <div className="text-4xl font-bold">{pipeline?.totalIssues ?? 0}</div>
          <p className="text-sm text-muted-foreground mt-1">total issues</p>
          {pipeline?.byStatus && Object.keys(pipeline.byStatus).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-4">
              {Object.entries(pipeline.byStatus).map(([status, count]) => (
                <span key={status} className={`rounded-full px-2 py-0.5 text-xs ${statusColors[status] ?? "bg-muted text-muted-foreground"}`}>
                  {status}: {count as number}
                </span>
              ))}
            </div>
          )}
          {pipeline?.unassigned > 0 && (
            <p className="text-sm text-amber-600 mt-3">{pipeline.unassigned} unassigned</p>
          )}
        </div>

        {/* Departments */}
        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Departments</h2>
          <div className="text-4xl font-bold">{departments.length}</div>
          <p className="text-sm text-muted-foreground mt-1">departments</p>
          {departments.length > 0 && (
            <div className="mt-4 space-y-2">
              {departments.map((d: any) => (
                <div key={d.id} className="flex items-center justify-between text-sm">
                  <span className="font-medium">{d.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusColors[d.status] ?? "bg-muted text-muted-foreground"}`}>{d.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
