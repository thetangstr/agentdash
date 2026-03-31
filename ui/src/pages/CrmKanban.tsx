import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useState, useMemo, useCallback } from "react";
import { Briefcase, GripVertical } from "lucide-react";

const STAGES = ["new", "contacted", "qualified", "proposal", "negotiation", "closed_won", "closed_lost"] as const;
type Stage = (typeof STAGES)[number];

const STAGE_META: Record<string, { label: string; color: string; headerBg: string }> = {
  new: { label: "New", color: "bg-blue-100 text-blue-700", headerBg: "bg-blue-50 border-blue-200" },
  contacted: { label: "Contacted", color: "bg-indigo-100 text-indigo-700", headerBg: "bg-indigo-50 border-indigo-200" },
  qualified: { label: "Qualified", color: "bg-violet-100 text-violet-700", headerBg: "bg-violet-50 border-violet-200" },
  proposal: { label: "Proposal", color: "bg-amber-100 text-amber-700", headerBg: "bg-amber-50 border-amber-200" },
  negotiation: { label: "Negotiation", color: "bg-orange-100 text-orange-700", headerBg: "bg-orange-50 border-orange-200" },
  closed_won: { label: "Won", color: "bg-emerald-100 text-emerald-700", headerBg: "bg-emerald-50 border-emerald-200" },
  closed_lost: { label: "Lost", color: "bg-red-100 text-red-700", headerBg: "bg-red-50 border-red-200" },
};

export function CrmKanban() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;
  const queryClient = useQueryClient();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const { data: deals = [], isLoading } = useQuery({
    queryKey: ["crm-deals", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/deals`); return r.json(); },
    enabled: !!cid,
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ["crm-accounts", cid],
    queryFn: async () => { const r = await fetch(`/api/companies/${cid}/crm/accounts`); return r.json(); },
    enabled: !!cid,
  });

  const accountMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts as any[]) {
      map.set(a.id, a.name);
    }
    return map;
  }, [accounts]);

  const dealsByStage = useMemo(() => {
    const grouped: Record<string, any[]> = {};
    for (const stage of STAGES) {
      grouped[stage] = [];
    }
    for (const d of deals as any[]) {
      const stage = d.stage ?? "new";
      if (grouped[stage]) {
        grouped[stage].push(d);
      } else {
        // Unknown stage — put in "new"
        grouped["new"].push(d);
      }
    }
    return grouped;
  }, [deals]);

  const handleDragStart = useCallback((e: React.DragEvent, dealId: string) => {
    e.dataTransfer.setData("text/plain", dealId);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(dealId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, stage: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(stage);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, newStage: string) => {
    e.preventDefault();
    setDropTarget(null);
    setDraggingId(null);
    const dealId = e.dataTransfer.getData("text/plain");
    if (!dealId || !cid) return;

    // Find the deal to check if stage actually changed
    const deal = (deals as any[]).find((d) => d.id === dealId);
    if (!deal || deal.stage === newStage) return;

    try {
      await fetch(`/api/companies/${cid}/crm/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: newStage }),
      });
      queryClient.invalidateQueries({ queryKey: ["crm-deals"] });
    } catch {
      // Silently fail — user can retry
    }
  }, [cid, deals, queryClient]);

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setDropTarget(null);
  }, []);

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Pipeline Board</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Drag deals between stages to update their status
          </p>
        </div>
        <Link
          to="/crm"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to Pipeline
        </Link>
      </div>

      {isLoading ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
          Loading deals...
        </div>
      ) : (deals as any[]).length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center space-y-3">
          <Briefcase className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <div>
            <p className="font-medium text-muted-foreground">No deals yet</p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Create your first deal or sync from HubSpot.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4 flex-wrap lg:flex-nowrap">
          {STAGES.map((stage) => {
            const meta = STAGE_META[stage];
            const stageDeals = dealsByStage[stage] ?? [];
            const totalCents = stageDeals.reduce(
              (sum: number, d: any) => sum + (Number(d.amountCents) || 0),
              0
            );
            const isOver = dropTarget === stage;

            return (
              <div
                key={stage}
                className={`min-w-[220px] flex-1 rounded-xl border transition-colors ${
                  isOver ? "ring-2 ring-primary/40 bg-primary/5" : "bg-card"
                }`}
                onDragOver={(e) => handleDragOver(e, stage)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, stage)}
              >
                {/* Column Header */}
                <div className={`rounded-t-xl border-b p-3 ${meta.headerBg}`}>
                  <div className="flex items-center justify-between">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.color}`}>
                      {meta.label}
                    </span>
                    <span className="text-xs font-medium text-muted-foreground">
                      {stageDeals.length}
                    </span>
                  </div>
                  {totalCents > 0 && (
                    <p className="text-sm font-semibold mt-1.5">
                      ${(totalCents / 100).toLocaleString()}
                    </p>
                  )}
                </div>

                {/* Cards */}
                <div className="p-2 space-y-2 min-h-[80px]">
                  {stageDeals.map((deal: any) => {
                    const isDragging = draggingId === deal.id;
                    const accountName = deal.accountId
                      ? accountMap.get(deal.accountId)
                      : undefined;

                    return (
                      <div
                        key={deal.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, deal.id)}
                        onDragEnd={handleDragEnd}
                        className={`rounded-lg border bg-background p-3 cursor-grab active:cursor-grabbing hover:shadow-sm transition-all ${
                          isDragging ? "opacity-40" : ""
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <Link
                              to={`/crm/deals/${deal.id}`}
                              className="text-sm font-medium hover:text-primary transition-colors line-clamp-2"
                            >
                              {deal.name}
                            </Link>
                            {accountName && (
                              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                {accountName}
                              </p>
                            )}
                            <div className="flex items-center gap-2 mt-1.5">
                              {deal.amountCents && (
                                <span className="text-xs font-semibold">
                                  ${(Number(deal.amountCents) / 100).toLocaleString()}
                                </span>
                              )}
                              {deal.closeDate && (
                                <span className="text-[11px] text-muted-foreground">
                                  {new Date(deal.closeDate).toLocaleDateString()}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
