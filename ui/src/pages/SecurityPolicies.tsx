"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";

export function SecurityPolicies() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const queryClient = useQueryClient();
  const [killSwitchLoading, setKillSwitchLoading] = useState(false);
  const { data: killStatus } = useQuery({
    queryKey: ["kill-switch-status", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/kill-switch/status`);
      return res.json();
    },
    enabled: !!companyId,
    refetchInterval: 5000,
  });

  const { data: policies = [], isLoading } = useQuery({
    queryKey: ["security-policies", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/security-policies`);
      return res.json();
    },
    enabled: !!companyId,
  });

  const handleKillSwitch = async (action: "halt" | "resume") => {
    setKillSwitchLoading(true);
    try {
      const endpoint = action === "halt" ? "kill-switch" : "kill-switch/resume";
      await fetch(`/api/companies/${companyId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "company", scopeId: companyId, reason: `Manual ${action} from dashboard` }),
      });
      queryClient.invalidateQueries({ queryKey: ["kill-switch-status"] });
    } finally {
      setKillSwitchLoading(false);
    }
  };

  if (!companyId) return <div className="p-6 text-muted-foreground">Select a company</div>;

  const isHalted = killStatus?.companyHalted;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Security & Governance</h1>

      {/* Kill Switch */}
      <div className={`rounded-xl border-2 p-6 ${isHalted ? "border-destructive bg-destructive/5" : "border-border bg-card"}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{isHalted ? "AGENTS HALTED" : "Kill Switch"}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {isHalted
                ? `All agents are paused. ${killStatus.haltedAgentIds?.length ?? 0} agent(s) affected.`
                : "Instantly halt all agent activity. Use in emergencies."}
            </p>
          </div>
          {isHalted ? (
            <button
              onClick={() => handleKillSwitch("resume")}
              disabled={killSwitchLoading}
              className="px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {killSwitchLoading ? "Resuming..." : "Resume All Agents"}
            </button>
          ) : (
            <button
              onClick={() => handleKillSwitch("halt")}
              disabled={killSwitchLoading}
              className="px-5 py-2.5 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {killSwitchLoading ? "Halting..." : "HALT ALL AGENTS"}
            </button>
          )}
        </div>
      </div>

      {/* Policies */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Security Policies</h2>
          <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90">
            Add Policy
          </button>
        </div>
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : policies.length === 0 ? (
          <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No security policies configured.</div>
        ) : (
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">Name</th>
                  <th className="text-left p-3 font-medium">Type</th>
                  <th className="text-left p-3 font-medium">Target</th>
                  <th className="text-left p-3 font-medium">Effect</th>
                  <th className="text-left p-3 font-medium">Priority</th>
                  <th className="text-left p-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {policies.map((p: any) => (
                  <tr key={p.id} className="hover:bg-muted/30">
                    <td className="p-3 font-medium">{p.name}</td>
                    <td className="p-3"><span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{p.policyType}</span></td>
                    <td className="p-3 text-muted-foreground">{p.targetType}{p.targetId ? `: ${p.targetId.slice(0, 8)}` : ""}</td>
                    <td className="p-3"><span className={`rounded-full px-2 py-0.5 text-xs ${p.effect === "deny" ? "bg-destructive/10 text-destructive" : "bg-emerald-100 text-emerald-700"}`}>{p.effect}</span></td>
                    <td className="p-3 text-muted-foreground">{p.priority}</td>
                    <td className="p-3"><span className={`rounded-full px-2 py-0.5 text-xs ${p.isActive ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{p.isActive ? "Active" : "Inactive"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
