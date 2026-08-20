import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { ShieldCheck, ShieldQuestion, CircleDot } from "lucide-react";
import type { Issue, IssueAssigneeSteward, IssueAwaitingReview } from "@paperclipai/shared";

const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
  /**
   * When "steward", columns are the distinct active-steward values
   * (one "Unassigned" column for issues with no steward) instead of the
   * default status columns. Drag-to-change-column is disabled in this
   * mode — there is no drop target the API understands.
   */
  boardGroupBy?: "status" | "steward";
  /**
   * Currently-authenticated user. Required to render the
   * "Awaiting your review" badge on cards whose execution state has the
   * viewer as the current stage's user principal.
   */
  viewerUserId?: string | null;
  /**
   * Optional map of steward userId → display label. When supplied,
   * steward column headers use it; otherwise we fall back to the email
   * (or userId prefix) carried on the first issue's
   * `assigneeSteward.userId`.
   */
  stewardLabelByUserId?: Map<string, string>;
}

/* ── Steward display helpers ── */

function stewardDisplayName(
  steward: Pick<IssueAssigneeSteward, "userId" | "name" | "email">,
  labelByUserId?: Map<string, string>,
): string {
  const override = labelByUserId?.get(steward.userId);
  if (override) return override;
  if (steward.name?.trim()) return steward.name.trim();
  if (steward.email?.trim()) return steward.email.trim();
  return steward.userId.slice(0, 5);
}

function stewardColumnKey(steward: IssueAssigneeSteward | null | undefined): string {
  // Stable column keys. `__steward:<userId>` for any steward (explicit or
  // owner fallback), `__unstewarded` for issues whose assignee agent has
  // neither.
  if (!steward) return "__unstewarded";
  return `__steward:${steward.userId}`;
}

/* ── Droppable Column ── */

function KanbanColumn({
  columnId,
  label,
  icon,
  issues,
  agents,
  liveIssueIds,
  viewerUserId,
  stewardLabelByUserId,
  draggable,
}: {
  columnId: string;
  label: string;
  icon: React.ReactNode;
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  viewerUserId?: string | null;
  stewardLabelByUserId?: Map<string, string>;
  /**
   * When false, the column is not a drop target — only the default
   * status columns accept status-changing drops.
   */
  draggable: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId, disabled: !draggable });

  const isEmpty = issues.length === 0;

  return (
    <div className={`flex flex-col shrink-0 transition-[width,min-width] ${isEmpty && !isOver ? "min-w-[48px] w-[48px]" : "min-w-[260px] w-[260px]"}`}>
      <div className={`flex items-center gap-2 px-2 py-2 mb-1 ${isEmpty && !isOver ? "justify-center" : ""}`}>
        {icon}
        {(!isEmpty || isOver) && (
          <>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground truncate">
              {label}
            </span>
            <span className="text-xs text-muted-foreground/60 ml-auto tabular-nums shrink-0">
              {issues.length}
            </span>
          </>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[120px] rounded-md p-1 space-y-1 transition-colors ${
          isOver ? "bg-accent/40" : "bg-muted/20"
        }`}
      >
        <SortableContext
          items={issues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {issues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              isLive={liveIssueIds?.has(issue.id)}
              viewerUserId={viewerUserId}
              stewardLabelByUserId={stewardLabelByUserId}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  isLive,
  isOverlay,
  viewerUserId,
  stewardLabelByUserId,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  isOverlay?: boolean;
  viewerUserId?: string | null;
  stewardLabelByUserId?: Map<string, string>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const steward = issue.assigneeSteward ?? null;
  const awaitingReview: IssueAwaitingReview | null = viewerUserId
    ? issue.awaitingReviewByViewer ?? null
    : null;
  // Cross-check the viewer field on the payload too — the server already
  // gates this but a stale build or a forged client could ship any value;
  // never trust the wire.
  const viewerMatches =
    awaitingReview?.viewerMatchesPrincipal === true &&
    awaitingReview?.viewerUserId === viewerUserId;
  const isAwaitingYourReview = viewerMatches;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`rounded-md border bg-card p-2.5 cursor-grab active:cursor-grabbing transition-shadow ${
        isDragging && !isOverlay ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"}`}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        disableIssueQuicklook
        className="block no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        <div className="flex items-start gap-1.5 mb-1.5">
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isLive && (
            <span className="relative flex h-2 w-2 shrink-0 mt-0.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
          {isAwaitingYourReview && (
            <span
              className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-900 border border-amber-300"
              title={`Awaiting your review (${awaitingReview?.stageType ?? "review"})`}
              aria-label={`Awaiting your review on ${issue.title}`}
            >
              <CircleDot className="h-2.5 w-2.5" />
              Awaiting your review
            </span>
          )}
        </div>
        <p className="text-sm leading-snug line-clamp-2 mb-2">{issue.title}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <PriorityIcon priority={issue.priority} />
          {issue.assigneeAgentId && (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? (
              <Identity name={name} size="xs" />
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                {issue.assigneeAgentId.slice(0, 8)}
              </span>
            );
          })()}
          {steward && (() => {
            const displayName = stewardDisplayName(steward, stewardLabelByUserId);
            const isOwnerFallback = steward.source === "owner";
            const Icon = isOwnerFallback ? ShieldQuestion : ShieldCheck;
            const tooltip = isOwnerFallback
              ? `Owner fallback — no active steward. ${displayName} created this agent.`
              : `Active steward: ${displayName}`;
            return (
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                  isOwnerFallback
                    ? "bg-muted text-muted-foreground border-border"
                    : "bg-emerald-50 text-emerald-900 border-emerald-200"
                }`}
                title={tooltip}
                aria-label={`${isOwnerFallback ? "Owner fallback" : "Steward"}: ${displayName}`}
              >
                <Icon className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate max-w-[140px]">{displayName}</span>
              </span>
            );
          })()}
        </div>
      </Link>
    </div>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  onUpdateIssue,
  boardGroupBy = "status",
  viewerUserId,
  stewardLabelByUserId,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  /**
   * Build the column list and per-column buckets. When grouping by
   * steward we synthesize columns from the distinct assigneeSteward
   * userIds present on the issue set (plus an Unassigned bucket), so
   * teams can see "everything Erik is on the hook for" at a glance.
   */
  const { columns, columnIssues } = useMemo(() => {
    if (boardGroupBy === "steward") {
      const order: string[] = [];
      const buckets = new Map<string, Issue[]>();
      const ensure = (key: string) => {
        if (!buckets.has(key)) {
          buckets.set(key, []);
          order.push(key);
        }
      };
      ensure("__unstewarded");
      for (const issue of issues) {
        const key = stewardColumnKey(issue.assigneeSteward ?? null);
        ensure(key);
        buckets.get(key)!.push(issue);
      }
      const cols = order.map((key) => {
        if (key === "__unstewarded") {
          return {
            id: key,
            label: "Unassigned",
            icon: <ShieldQuestion className="h-3.5 w-3.5 text-muted-foreground" />,
          };
        }
        const userId = key.slice("__steward:".length);
        // Pick the first steward in this column to derive a display label.
        const sample = issues.find((i) => i.assigneeSteward?.userId === userId)?.assigneeSteward;
        const displayName = sample ? stewardDisplayName(sample, stewardLabelByUserId) : userId.slice(0, 5);
        const isOwnerFallback = sample?.source === "owner";
        return {
          id: key,
          label: displayName,
          icon: isOwnerFallback ? (
            <ShieldQuestion className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-700" />
          ),
        };
      });
      return { columns: cols, columnIssues: buckets };
    }

    // Default: status columns.
    const grouped = new Map<string, Issue[]>();
    for (const status of boardStatuses) grouped.set(status, []);
    for (const issue of issues) {
      const bucket = grouped.get(issue.status);
      if (bucket) bucket.push(issue);
    }
    return {
      columns: boardStatuses.map((status) => ({
        id: status,
        label: statusLabel(status),
        icon: <StatusIcon status={status} />,
      })),
      columnIssues: grouped,
    };
  }, [issues, boardGroupBy, stewardLabelByUserId]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    if (boardGroupBy !== "status") {
      // Steward-grouped boards have no API-mappable drop target — accept
      // drag-and-drop reorder visually only.
      return;
    }
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    // Determine target status: the "over" could be a column id (status string)
    // or another card's id. Find which column the "over" belongs to.
    let targetStatus: string | null = null;

    if (boardStatuses.includes(over.id as string)) {
      targetStatus = over.id as string;
    } else {
      // It's a card - find which column it's in
      const targetIssue = issues.find((i) => i.id === over.id);
      if (targetIssue) {
        targetStatus = targetIssue.status;
      }
    }

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Could be used for visual feedback; keeping simple for now
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
        {columns.map((column) => (
          <KanbanColumn
            key={column.id}
            columnId={column.id}
            label={column.label}
            icon={column.icon}
            issues={columnIssues.get(column.id) ?? []}
            agents={agents}
            liveIssueIds={liveIssueIds}
            viewerUserId={viewerUserId}
            stewardLabelByUserId={stewardLabelByUserId}
            draggable={boardGroupBy === "status"}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard
            issue={activeIssue}
            agents={agents}
            isOverlay
            viewerUserId={viewerUserId}
            stewardLabelByUserId={stewardLabelByUserId}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
