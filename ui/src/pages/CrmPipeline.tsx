import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";

const STAGE_META: Record<string, { label: string; color: string }> = {
  new: { label: "New", color: "bg-blue-100 text-blue-700" },
  contacted: { label: "Contacted", color: "bg-indigo-100 text-indigo-700" },
  qualified: { label: "Qualified", color: "bg-violet-100 text-violet-700" },
  proposal: { label: "Proposal", color: "bg-amber-100 text-amber-700" },
  negotiation: { label: "Negotiation", color: "bg-orange-100 text-orange-700" },
  closed_won: { label: "Won", color: "bg-emerald-100 text-emerald-700" },
  closed_lost: { label: "Lost", color: "bg-red-100 text-red-700" },
};

export function CrmPipeline() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;

  const { data: hubspotConfig } = useQuery({
    queryKey: ["hubspot-config", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/integrations/hubspot/config`); return r.json(); },
    enabled: !!cid,
  });

  const { data: pipeline } = useQuery({
    queryKey: ["crm-pipeline", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/pipeline`); return r.json(); },
    enabled: !!cid,
  });
  const { data: deals = [] } = useQuery({
    queryKey: ["crm-deals", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/deals`); return r.json(); },
    enabled: !!cid,
  });
  const { data: leads = [] } = useQuery({
    queryKey: ["crm-leads", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/leads`); return r.json(); },
    enabled: !!cid,
  });
  const { data: accounts = [] } = useQuery({
    queryKey: ["crm-accounts", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/accounts`); return r.json(); },
    enabled: !!cid,
  });
  const { data: partners = [] } = useQuery({
    queryKey: ["crm-partners", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/partners`); return r.json(); },
    enabled: !!cid,
  });

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;

  const totalPipeline = pipeline?.totalPipelineValueCents ? `$${(pipeline.totalPipelineValueCents / 100).toLocaleString()}` : "$0";

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">CRM</h1>
        <p className="text-sm text-muted-foreground mt-1">Customer relationships, pipeline, and revenue tracking</p>
      </div>

      {/* AgentDash: HubSpot connection banner */}
      {hubspotConfig && !hubspotConfig.configured && (
        <Link to="/crm/hubspot" className="block">
          <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-5 hover:bg-primary/10 transition-colors">
            <p className="font-semibold text-primary">Connect HubSpot</p>
            <p className="text-sm text-muted-foreground mt-1">Sync your contacts, companies, deals, and activities from HubSpot.</p>
          </div>
        </Link>
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm text-muted-foreground">Pipeline Value</p>
          <p className="text-3xl font-bold mt-1">{totalPipeline}</p>
          <p className="text-xs text-muted-foreground mt-1">{pipeline?.totalDeals ?? 0} deals</p>
        </div>
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm text-muted-foreground">Accounts</p>
          <p className="text-3xl font-bold mt-1">{accounts.length}</p>
        </div>
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm text-muted-foreground">Leads</p>
          <p className="text-3xl font-bold mt-1">{leads.length}</p>
          <p className="text-xs text-muted-foreground mt-1">{leads.filter((l: any) => l.status === "new").length} new</p>
        </div>
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm text-muted-foreground">Deals</p>
          <p className="text-3xl font-bold mt-1">{deals.length}</p>
        </div>
        <div className="rounded-xl border bg-card p-5">
          <p className="text-sm text-muted-foreground">Partners</p>
          <p className="text-3xl font-bold mt-1">{partners.length}</p>
        </div>
      </div>

      {/* Pipeline Stages */}
      {pipeline?.stages && pipeline.stages.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Pipeline by Stage</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {pipeline.stages.map((s: any) => {
              const meta = STAGE_META[s.stage] ?? { label: s.stage, color: "bg-muted text-muted-foreground" };
              return (
                <div key={s.stage} className="rounded-xl border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.color}`}>{meta.label}</span>
                    <span className="text-sm font-semibold">{s.count}</span>
                  </div>
                  <p className="text-xl font-bold mt-2">${((s.totalAmountCents ?? 0) / 100).toLocaleString()}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Deals Table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Recent Deals</h2>
          <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90">New Deal</button>
        </div>
        {deals.length === 0 ? (
          <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No deals yet. Create your first deal or sync from HubSpot.</div>
        ) : (
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">Deal</th>
                  <th className="text-left p-3 font-medium">Stage</th>
                  <th className="text-left p-3 font-medium">Amount</th>
                  <th className="text-left p-3 font-medium">Close Date</th>
                  <th className="text-left p-3 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {deals.slice(0, 10).map((d: any) => {
                  const meta = STAGE_META[d.stage] ?? { label: d.stage ?? "—", color: "bg-muted text-muted-foreground" };
                  return (
                    <tr key={d.id} className="hover:bg-muted/30">
                      <td className="p-3 font-medium">{d.name}</td>
                      <td className="p-3"><span className={`rounded-full px-2 py-0.5 text-xs ${meta.color}`}>{meta.label}</span></td>
                      <td className="p-3">{d.amountCents ? `$${(Number(d.amountCents) / 100).toLocaleString()}` : "—"}</td>
                      <td className="p-3 text-muted-foreground">{d.closeDate ? new Date(d.closeDate).toLocaleDateString() : "—"}</td>
                      <td className="p-3 text-muted-foreground text-xs">{d.externalSource ?? "manual"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Leads Table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Leads</h2>
          <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90">New Lead</button>
        </div>
        {leads.length === 0 ? (
          <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No leads yet.</div>
        ) : (
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">Name</th>
                  <th className="text-left p-3 font-medium">Company</th>
                  <th className="text-left p-3 font-medium">Email</th>
                  <th className="text-left p-3 font-medium">Source</th>
                  <th className="text-left p-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {leads.slice(0, 10).map((l: any) => (
                  <tr key={l.id} className="hover:bg-muted/30">
                    <td className="p-3 font-medium">{[l.firstName, l.lastName].filter(Boolean).join(" ") || "—"}</td>
                    <td className="p-3 text-muted-foreground">{l.company ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{l.email ?? "—"}</td>
                    <td className="p-3 text-muted-foreground text-xs">{l.source ?? "—"}</td>
                    <td className="p-3"><span className={`rounded-full px-2 py-0.5 text-xs ${l.status === "new" ? "bg-blue-100 text-blue-700" : l.status === "converted" ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{l.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Partners */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Partners</h2>
          <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90">Add Partner</button>
        </div>
        {partners.length === 0 ? (
          <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No partners yet.</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {partners.map((p: any) => (
              <div key={p.id} className="rounded-xl border bg-card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{p.name}</h3>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{p.type}</span>
                </div>
                {p.contactEmail && <p className="text-sm text-muted-foreground">{p.contactEmail}</p>}
                <div className="flex gap-3 text-xs text-muted-foreground">
                  {p.tier && <span>Tier: {p.tier}</span>}
                  {p.referralCount && <span>{p.referralCount} referrals</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
