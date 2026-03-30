import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
export function ResearchDashboard() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;

  const { data: cycles = [], isLoading } = useQuery({
    queryKey: ["research-cycles", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/research-cycles`);
      return res.json();
    },
    enabled: !!companyId,
  });

  if (!companyId) return <div className="p-6 text-muted-foreground">Select a company</div>;
  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  const statusColors: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-700",
    paused: "bg-amber-100 text-amber-700",
    completed: "bg-blue-100 text-blue-700",
    cancelled: "bg-muted text-muted-foreground",
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">AutoResearch</h1>
          <p className="text-sm text-muted-foreground mt-1">Hypothesis-driven experiment loops tied to your goals</p>
        </div>
        <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90">
          New Research Cycle
        </button>
      </div>

      {cycles.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center space-y-3">
          <div className="text-4xl">🔬</div>
          <h3 className="font-semibold text-lg">No research cycles yet</h3>
          <p className="text-muted-foreground text-sm max-w-md mx-auto">
            Start a research cycle to automatically test hypotheses, run experiments, and iterate toward your business goals.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {cycles.map((c: any) => (
            <div key={c.id} className="rounded-xl border bg-card p-5 space-y-3 hover:border-foreground/20 transition-colors">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{c.title}</h3>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[c.status] ?? "bg-muted text-muted-foreground"}`}>{c.status}</span>
              </div>
              {c.description && <p className="text-sm text-muted-foreground line-clamp-2">{c.description}</p>}
              <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2 border-t">
                <span>Iteration {c.currentIteration}{c.maxIterations ? `/${c.maxIterations}` : ""}</span>
                {c.startedAt && <span>Started {new Date(c.startedAt).toLocaleDateString()}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
