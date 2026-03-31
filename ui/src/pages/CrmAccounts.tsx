import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { Building2, Search, ArrowUpDown } from "lucide-react";
import { useState, useMemo } from "react";

const STAGE_COLORS: Record<string, string> = {
  prospect: "bg-slate-100 text-slate-700",
  onboarding: "bg-blue-100 text-blue-700",
  active: "bg-emerald-100 text-emerald-700",
  at_risk: "bg-red-100 text-red-700",
  renewal: "bg-amber-100 text-amber-700",
  expansion: "bg-violet-100 text-violet-700",
  champion: "bg-teal-100 text-teal-700",
  churned: "bg-gray-100 text-gray-500",
};

export function CrmAccounts() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<"name" | "createdAt">("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["crm-accounts", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/accounts?limit=200`); return r.json(); },
    enabled: !!cid,
  });

  const { data: deals = [] } = useQuery({
    queryKey: ["crm-deals", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/deals`); return r.json(); },
    enabled: !!cid,
  });

  const { data: contacts = [] } = useQuery({
    queryKey: ["crm-contacts", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/contacts`); return r.json(); },
    enabled: !!cid,
  });

  // Enrich accounts with deal/contact counts
  const enriched = useMemo(() => {
    const dealsByAccount = new Map<string, { count: number; totalCents: number }>();
    for (const d of deals as any[]) {
      if (!d.accountId) continue;
      const existing = dealsByAccount.get(d.accountId) ?? { count: 0, totalCents: 0 };
      existing.count++;
      existing.totalCents += Number(d.amountCents) || 0;
      dealsByAccount.set(d.accountId, existing);
    }
    const contactsByAccount = new Map<string, number>();
    for (const c of contacts as any[]) {
      if (!c.accountId) continue;
      contactsByAccount.set(c.accountId, (contactsByAccount.get(c.accountId) ?? 0) + 1);
    }
    return (accounts as any[]).map((a) => ({
      ...a,
      dealCount: dealsByAccount.get(a.id)?.count ?? 0,
      totalValueCents: dealsByAccount.get(a.id)?.totalCents ?? 0,
      contactCount: contactsByAccount.get(a.id) ?? 0,
    }));
  }, [accounts, deals, contacts]);

  // Filter and sort
  const filtered = useMemo(() => {
    let result = enriched;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((a) =>
        a.name?.toLowerCase().includes(q) ||
        a.domain?.toLowerCase().includes(q) ||
        a.industry?.toLowerCase().includes(q)
      );
    }
    if (stageFilter !== "all") {
      result = result.filter((a) => a.stage === stageFilter);
    }
    result.sort((a, b) => {
      const aVal = sortField === "name" ? (a.name ?? "") : (a.createdAt ?? "");
      const bVal = sortField === "name" ? (b.name ?? "") : (b.createdAt ?? "");
      return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
    return result;
  }, [enriched, search, stageFilter, sortField, sortDir]);

  const stages = useMemo(() => {
    const s = new Set<string>();
    for (const a of accounts as any[]) { if (a.stage) s.add(a.stage); }
    return Array.from(s).sort();
  }, [accounts]);

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Accounts</h1>
          <p className="text-sm text-muted-foreground mt-1">{enriched.length} accounts</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search accounts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border bg-background pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          className="rounded-lg border bg-background px-3 py-2 text-sm"
        >
          <option value="all">All stages</option>
          {stages.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button
          onClick={() => {
            if (sortField === "name") { setSortDir((d) => d === "asc" ? "desc" : "asc"); }
            else { setSortField("name"); setSortDir("asc"); }
          }}
          className="flex items-center gap-1 rounded-lg border bg-background px-3 py-2 text-sm hover:bg-muted/50"
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
          {sortField === "name" ? `Name ${sortDir === "asc" ? "A-Z" : "Z-A"}` : "Sort by name"}
        </button>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">Loading accounts...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
          {search || stageFilter !== "all" ? "No accounts match your filters." : "No accounts yet. Create one or sync from HubSpot."}
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Account</th>
                <th className="text-left p-3 font-medium">Stage</th>
                <th className="text-left p-3 font-medium">Industry</th>
                <th className="text-right p-3 font-medium">Contacts</th>
                <th className="text-right p-3 font-medium">Deals</th>
                <th className="text-right p-3 font-medium">Value</th>
                <th className="text-left p-3 font-medium">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((a: any) => {
                const stageColor = STAGE_COLORS[a.stage] ?? "bg-muted text-muted-foreground";
                return (
                  <tr key={a.id} className="hover:bg-muted/30">
                    <td className="p-3">
                      <Link to={`/crm/accounts/${a.id}`} className="flex items-center gap-2 group">
                        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div>
                          <span className="font-medium group-hover:text-primary transition-colors">{a.name}</span>
                          {a.domain && <p className="text-xs text-muted-foreground">{a.domain}</p>}
                        </div>
                      </Link>
                    </td>
                    <td className="p-3">
                      {a.stage ? <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stageColor}`}>{a.stage}</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="p-3 text-muted-foreground">{a.industry ?? "—"}</td>
                    <td className="p-3 text-right">{a.contactCount}</td>
                    <td className="p-3 text-right">{a.dealCount}</td>
                    <td className="p-3 text-right font-medium">
                      {a.totalValueCents > 0 ? `$${(a.totalValueCents / 100).toLocaleString()}` : "—"}
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">{a.externalSource ?? "manual"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
