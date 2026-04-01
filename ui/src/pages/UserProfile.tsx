import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { User, Building2, Shield, Key } from "lucide-react";

export function UserProfile() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;

  const { data: members = [] } = useQuery({
    queryKey: ["company-members", cid],
    queryFn: async () => {
      const r = await fetch(`/api/companies/${cid}/access/members`);
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!cid,
  });

  // In local_trusted mode, we're always "local-board"
  // In production, this would come from the auth session
  const currentUser = {
    id: "local-board",
    name: "Board Operator",
    email: "local@localhost",
  };

  return (
    <div className="p-6 space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-sm text-muted-foreground mt-1">Your identity, memberships, and permissions</p>
      </div>

      {/* Identity */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-center gap-4">
          <div className="rounded-full bg-muted p-3">
            <User className="h-6 w-6 text-muted-foreground" />
          </div>
          <div>
            <p className="text-lg font-semibold">{currentUser.name}</p>
            <p className="text-sm text-muted-foreground">{currentUser.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Key className="h-3.5 w-3.5" />
          <span>ID: {currentUser.id}</span>
        </div>
      </div>

      {/* Company */}
      {selectedCompany && (
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Building2 className="h-4 w-4" />
            Current Company
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{selectedCompany.name}</span>
              <span className="rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-medium">Active</span>
            </div>
            <p className="text-xs text-muted-foreground">Prefix: {selectedCompany.issuePrefix} — ID: {selectedCompany.id.slice(0, 8)}...</p>
          </div>
        </div>
      )}

      {/* Members */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Shield className="h-4 w-4" />
          Team Members ({members.length})
        </div>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members found (local_trusted mode)</p>
        ) : (
          <div className="space-y-2">
            {(members as any[]).map((m: any) => (
              <div key={m.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <div>
                  <p className="text-sm font-medium">{m.principalId}</p>
                  <p className="text-xs text-muted-foreground">{m.principalType} — {m.membershipRole ?? "member"}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  m.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"
                }`}>{m.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Permissions info */}
      <div className="rounded-xl border bg-card p-6 space-y-3">
        <p className="text-sm font-semibold">Available Permissions</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {["agents:create", "users:invite", "users:manage_permissions", "tasks:assign", "tasks:assign_scope", "joins:approve"].map((perm) => (
            <div key={perm} className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
              <span className="font-mono text-xs">{perm}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">In local_trusted mode, all permissions are granted implicitly.</p>
      </div>
    </div>
  );
}
