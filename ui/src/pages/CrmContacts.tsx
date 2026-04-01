import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { Users, Search, Mail, Phone } from "lucide-react";
import { useState, useMemo } from "react";

export function CrmContacts() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;
  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState<string>("all");

  const { data: contacts = [], isLoading } = useQuery({
    queryKey: ["crm-contacts", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/contacts`); return r.json(); },
    enabled: !!cid,
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ["crm-accounts", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/accounts?limit=200`); return r.json(); },
    enabled: !!cid,
  });

  const accountMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const a of accounts as any[]) {
      map.set(a.id, { id: a.id, name: a.name });
    }
    return map;
  }, [accounts]);

  const filtered = useMemo(() => {
    let result = contacts as any[];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((c) =>
        [c.firstName, c.lastName].filter(Boolean).join(" ").toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.title?.toLowerCase().includes(q)
      );
    }
    if (accountFilter !== "all") {
      result = result.filter((c) => c.accountId === accountFilter);
    }
    return result;
  }, [contacts, search, accountFilter]);

  const accountOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { id: string; name: string }[] = [];
    for (const c of contacts as any[]) {
      if (c.accountId && !seen.has(c.accountId)) {
        seen.add(c.accountId);
        const acct = accountMap.get(c.accountId);
        opts.push({ id: c.accountId, name: acct?.name ?? c.accountId });
      }
    }
    return opts.sort((a, b) => a.name.localeCompare(b.name));
  }, [contacts, accountMap]);

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Contacts</h1>
          <p className="text-sm text-muted-foreground mt-1">{(contacts as any[]).length} contacts</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, email, or title..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border bg-background pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <select
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
          className="rounded-lg border bg-background px-3 py-2 text-sm"
        >
          <option value="all">All accounts</option>
          {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">Loading contacts...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center space-y-3">
          <Users className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <div>
            <p className="font-medium text-muted-foreground">
              {search || accountFilter !== "all" ? "No contacts match your filters" : "No contacts yet"}
            </p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              {search || accountFilter !== "all" ? "Try adjusting your search or filters." : "Create your first contact or sync from HubSpot."}
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Name</th>
                <th className="text-left p-3 font-medium">Email</th>
                <th className="text-left p-3 font-medium">Phone</th>
                <th className="text-left p-3 font-medium">Title</th>
                <th className="text-left p-3 font-medium">Account</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((c: any) => {
                const fullName = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown";
                const acct = c.accountId ? accountMap.get(c.accountId) : null;
                return (
                  <tr key={c.id} className="hover:bg-muted/30">
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="font-medium">{fullName}</span>
                      </div>
                    </td>
                    <td className="p-3">
                      {c.email ? (
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <Mail className="h-3.5 w-3.5 shrink-0" />
                          <span>{c.email}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">--</span>
                      )}
                    </td>
                    <td className="p-3">
                      {c.phone ? (
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <Phone className="h-3.5 w-3.5 shrink-0" />
                          <span>{c.phone}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">--</span>
                      )}
                    </td>
                    <td className="p-3 text-muted-foreground">{c.title ?? "--"}</td>
                    <td className="p-3">
                      {acct ? (
                        <Link to={`/crm/accounts/${acct.id}`} className="text-primary hover:underline">
                          {acct.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">--</span>
                      )}
                    </td>
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
