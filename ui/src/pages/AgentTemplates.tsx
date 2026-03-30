import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
export function AgentTemplates() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["agent-templates", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/agent-templates`);
      return res.json();
    },
    enabled: !!companyId,
  });

  if (!companyId) return <div className="p-6 text-muted-foreground">Select a company</div>;
  if (isLoading) return <div className="p-6 text-muted-foreground">Loading templates...</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agent Templates</h1>
          <p className="text-sm text-muted-foreground mt-1">Role-based blueprints for spawning agents</p>
        </div>
        <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90">
          Create Template
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <p className="text-muted-foreground">No templates yet. Create your first agent template to start spawning agents.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t: any) => (
            <div key={t.id} className="rounded-xl border bg-card p-5 space-y-3 hover:border-foreground/20 transition-colors">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{t.name}</h3>
                <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium">{t.role}</span>
              </div>
              {t.description && <p className="text-sm text-muted-foreground line-clamp-2">{t.description}</p>}
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="rounded-md bg-muted px-2 py-0.5">{t.authorityLevel}</span>
                <span className="rounded-md bg-muted px-2 py-0.5">{t.taskClassification}</span>
                <span className="rounded-md bg-muted px-2 py-0.5">{t.adapterType}</span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
                <span>${(t.budgetMonthlyCents / 100).toFixed(0)}/mo</span>
                <span>{t.skillKeys?.length ?? 0} skills</span>
                <span>{t.okrs?.length ?? 0} OKRs</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
