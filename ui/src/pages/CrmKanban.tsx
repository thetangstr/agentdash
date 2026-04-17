// AgentDash: CrmKanban page — CUJ-A drag-and-drop pipeline board
import { useEffect, useMemo, useState, useCallback, type CSSProperties } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  type DragEndEvent,
  useDroppable,
  useDraggable,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { KanbanSquare } from "lucide-react";
import { crmApi, type CrmDeal } from "../api/crm";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Canonical pipeline stages (standard B2B sales funnel)
// ---------------------------------------------------------------------------

export const DEAL_STAGES = [
  "prospect",
  "qualified",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

const STAGE_LABELS: Record<DealStage, string> = {
  prospect: "Prospect",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
};

function isValidStage(s: string): s is DealStage {
  return (DEAL_STAGES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Amount formatting — the backend stores `amountCents` (string of integer
// cents) as the canonical value, but legacy rows may carry `amount` as a
// float. Handle both.
// ---------------------------------------------------------------------------

function formatDealAmount(deal: CrmDeal): string | null {
  const currency = deal.currency ?? "USD";
  let dollars: number | null = null;
  if (deal.amountCents != null && deal.amountCents !== "") {
    const cents = Number(deal.amountCents);
    if (Number.isFinite(cents)) dollars = Math.round(cents) / 100;
  } else if (typeof deal.amount === "number" && Number.isFinite(deal.amount)) {
    dollars = deal.amount;
  }
  if (dollars == null) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(dollars);
  } catch {
    return `$${dollars.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
}

// ---------------------------------------------------------------------------
// Drop handler — exported for unit testing. Performs an optimistic local
// update, calls the API, and reverts + toasts on failure.
// ---------------------------------------------------------------------------

export interface HandleDealDropParams {
  companyId: string;
  dealId: string;
  toStage: DealStage;
  deals: CrmDeal[];
  updateDeal: (
    companyId: string,
    id: string,
    patch: Partial<CrmDeal>,
  ) => Promise<CrmDeal>;
  pushToast: (input: {
    tone?: "info" | "success" | "warn" | "error";
    title: string;
    body?: string;
  }) => unknown;
  onLocalUpdate: (next: CrmDeal[]) => void;
}

export async function handleDealDrop(params: HandleDealDropParams): Promise<void> {
  const { companyId, dealId, toStage, deals, updateDeal, pushToast, onLocalUpdate } = params;
  const current = deals.find((d) => d.id === dealId);
  if (!current) return;
  if (current.stage === toStage) return;

  // Optimistic update
  const optimistic = deals.map((d) =>
    d.id === dealId ? { ...d, stage: toStage } : d,
  );
  onLocalUpdate(optimistic);

  try {
    await updateDeal(companyId, dealId, { stage: toStage });
    pushToast({
      tone: "success",
      title: `Deal moved to ${STAGE_LABELS[toStage]}`,
    });
  } catch (err) {
    // Revert
    onLocalUpdate(deals);
    pushToast({
      tone: "error",
      title: "Failed to move deal",
      body: err instanceof Error ? err.message : "Unknown error",
    });
  }
}

// ---------------------------------------------------------------------------
// Card + Column components
// ---------------------------------------------------------------------------

function DealCard({
  deal,
  onClick,
}: {
  deal: CrmDeal;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: deal.id,
  });

  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.5 : 1,
    cursor: isDragging ? "grabbing" : "grab",
    touchAction: "none",
  };

  const amount = formatDealAmount(deal);

  // Distinguish click-vs-drag: only fire click when no transform happened.
  const handleClick = (e: React.MouseEvent) => {
    // dnd-kit attaches listeners for pointer events; a normal click without
    // movement still falls through to onClick here. If dragging, isDragging
    // is true and we skip.
    if (isDragging) {
      e.preventDefault();
      return;
    }
    onClick();
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`kanban-card-${deal.id}`}
      onClick={handleClick}
      {...listeners}
      {...attributes}
      className="rounded-md border border-border bg-background p-3 shadow-sm hover:border-primary hover:shadow-md transition-colors"
    >
      <div className="text-sm font-medium truncate">{deal.name}</div>
      {amount && (
        <div className="mt-1 text-xs text-muted-foreground">{amount}</div>
      )}
    </div>
  );
}

function StageColumn({
  stage,
  deals,
  onCardClick,
}: {
  stage: DealStage;
  deals: CrmDeal[];
  onCardClick: (deal: CrmDeal) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  return (
    <div
      ref={setNodeRef}
      data-testid={`kanban-column-${stage}`}
      className={`flex w-72 shrink-0 flex-col rounded-md border bg-muted/20 ${
        isOver ? "border-primary bg-primary/5" : "border-border"
      }`}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{STAGE_LABELS[stage]}</h2>
        <span className="text-xs text-muted-foreground">{deals.length}</span>
      </div>
      <div className="flex flex-col gap-2 p-2 min-h-16">
        {deals.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground/60">
            Drop deals here
          </p>
        ) : (
          deals.map((deal) => (
            <DealCard key={deal.id} deal={deal} onClick={() => onCardClick(deal)} />
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CrmKanban page
// ---------------------------------------------------------------------------

export function CrmKanban() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipeline Kanban" }]);
  }, [setBreadcrumbs]);

  const queryKey = ["crm-kanban-deals", selectedCompanyId ?? "_none_"] as const;

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => crmApi.listDeals(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Local mirror for optimistic DnD updates. We derive it from the query
  // data, but allow in-place mutation so the drag animation is instant.
  const [localDeals, setLocalDeals] = useState<CrmDeal[] | null>(null);

  useEffect(() => {
    if (data) setLocalDeals(data);
  }, [data]);

  const deals = localDeals ?? data ?? [];

  const dealsByStage = useMemo(() => {
    const groups: Record<DealStage, CrmDeal[]> = {
      prospect: [],
      qualified: [],
      proposal: [],
      negotiation: [],
      closed_won: [],
      closed_lost: [],
    };
    for (const deal of deals) {
      const stage = deal.stage && isValidStage(deal.stage) ? deal.stage : "prospect";
      groups[stage].push(deal);
    }
    return groups;
  }, [deals]);

  // dnd-kit: require a small pointer distance to differentiate click from drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const onCardClick = useCallback(
    (deal: CrmDeal) => {
      navigate(`/crm/deals/${deal.id}`);
    },
    [navigate],
  );

  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || !selectedCompanyId) return;
      const toStage = String(over.id);
      if (!isValidStage(toStage)) return;

      const dealId = String(active.id);
      const snapshot = [...deals];

      await handleDealDrop({
        companyId: selectedCompanyId,
        dealId,
        toStage,
        deals: snapshot,
        updateDeal: (cid, id, patch) => crmApi.updateDeal(cid, id, patch),
        pushToast,
        onLocalUpdate: (next) => {
          setLocalDeals(next);
          queryClient.setQueryData(queryKey, next);
        },
      });
    },
    [deals, selectedCompanyId, pushToast, queryClient, queryKey],
  );

  if (!selectedCompanyId) {
    return (
      <p className="text-sm text-muted-foreground p-6">Select a company first.</p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Pipeline Kanban</h1>
        <p className="text-sm text-muted-foreground">
          Drag deals across stages to update the pipeline.
        </p>
      </div>

      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load deals"}
        </p>
      )}

      {isLoading ? (
        <div className="flex gap-3 overflow-x-auto" data-testid="kanban-loading">
          {DEAL_STAGES.map((stage) => (
            <div key={stage} className="w-72 shrink-0 space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ))}
        </div>
      ) : deals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <KanbanSquare className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            No deals yet. Create one from the pipeline page to get started.
          </p>
        </div>
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {DEAL_STAGES.map((stage) => (
              <StageColumn
                key={stage}
                stage={stage}
                deals={dealsByStage[stage]}
                onCardClick={onCardClick}
              />
            ))}
          </div>
        </DndContext>
      )}
    </div>
  );
}
