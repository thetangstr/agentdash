// AgentDash: Task dependency DAG visualization (CUJ-4)
import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { GitBranch } from "lucide-react";

interface DagIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string | null;
  blockedBy: string[];
  blocks: string[];
}

interface DagGraph {
  issues: DagIssue[];
}

const NODE_W = 200;
const NODE_H = 56;
const GAP_X = 80;
const GAP_Y = 20;
const PADDING = 32;

function statusColor(status: string): string {
  if (status === "done") return "#22c55e";
  if (status === "in_progress") return "#3b82f6";
  if (status === "blocked") return "#ef4444";
  if (status === "cancelled") return "#6b7280";
  return "#9ca3af";
}

function computeLayout(issues: DagIssue[]) {
  const layers = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const issue of issues) {
    inDeg.set(issue.id, 0);
    adj.set(issue.id, []);
  }
  for (const issue of issues) {
    for (const blockerId of issue.blockedBy) {
      adj.get(blockerId)?.push(issue.id);
      inDeg.set(issue.id, (inDeg.get(issue.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) {
      queue.push(id);
      layers.set(id, 0);
    }
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    const layer = layers.get(node) ?? 0;
    for (const next of adj.get(node) ?? []) {
      const nextLayer = Math.max(layers.get(next) ?? 0, layer + 1);
      layers.set(next, nextLayer);
      const newDeg = (inDeg.get(next) ?? 1) - 1;
      inDeg.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  // Assign layers to orphans (no dependencies)
  for (const issue of issues) {
    if (!layers.has(issue.id)) layers.set(issue.id, 0);
  }

  const layerGroups = new Map<number, string[]>();
  for (const [id, layer] of layers) {
    if (!layerGroups.has(layer)) layerGroups.set(layer, []);
    layerGroups.get(layer)!.push(id);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [layer, ids] of layerGroups) {
    ids.forEach((id, i) => {
      positions.set(id, {
        x: PADDING + layer * (NODE_W + GAP_X),
        y: PADDING + i * (NODE_H + GAP_Y),
      });
    });
  }

  const maxLayer = Math.max(0, ...layers.values());
  const maxPerLayer = Math.max(1, ...Array.from(layerGroups.values()).map((g) => g.length));
  const svgW = PADDING * 2 + (maxLayer + 1) * NODE_W + maxLayer * GAP_X;
  const svgH = PADDING * 2 + maxPerLayer * NODE_H + (maxPerLayer - 1) * GAP_Y;

  return { positions, svgW, svgH };
}

export function TaskDependencyDag() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Task Dependencies" }]);
  }, [setBreadcrumbs]);

  // Fetch all issues for the company and build the graph client-side
  const { data: issues, isLoading, error } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "dependency-graph"],
    queryFn: () => api.get<DagIssue[]>(`/companies/${selectedCompanyId}/issues?includeDependencies=true`),
    enabled: !!selectedCompanyId,
  });

  // Filter to only issues that have dependencies
  const dagIssues = useMemo(() => {
    if (!issues) return [];
    const hasDepIds = new Set<string>();
    for (const issue of issues) {
      if (issue.blockedBy?.length > 0) {
        hasDepIds.add(issue.id);
        for (const bid of issue.blockedBy) hasDepIds.add(bid);
      }
      if (issue.blocks?.length > 0) {
        hasDepIds.add(issue.id);
        for (const bid of issue.blocks) hasDepIds.add(bid);
      }
    }
    return issues.filter((i) => hasDepIds.has(i.id));
  }, [issues]);

  const layout = useMemo(() => {
    if (dagIssues.length === 0) return null;
    return computeLayout(dagIssues);
  }, [dagIssues]);

  const issueMap = useMemo(() => {
    const map = new Map<string, DagIssue>();
    for (const i of dagIssues) map.set(i.id, i);
    return map;
  }, [dagIssues]);

  if (!selectedCompanyId) {
    return <EmptyState icon={GitBranch} message="Select a company to view task dependencies." />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;

  if (dagIssues.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Task Dependencies</h2>
        <EmptyState icon={GitBranch} message="No task dependencies found." />
      </div>
    );
  }

  // Collect edges
  const edges: { from: string; to: string }[] = [];
  for (const issue of dagIssues) {
    for (const blockerId of issue.blockedBy ?? []) {
      if (issueMap.has(blockerId)) {
        edges.push({ from: blockerId, to: issue.id });
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Task Dependencies</h2>
        <span className="text-xs text-muted-foreground">
          {dagIssues.length} task{dagIssues.length !== 1 ? "s" : ""} with dependencies
        </span>
      </div>

      {/* SVG DAG */}
      {layout && (
        <div className="border border-border overflow-auto bg-muted/20 rounded">
          <svg
            width={layout.svgW}
            height={layout.svgH}
            viewBox={`0 0 ${layout.svgW} ${layout.svgH}`}
          >
            <defs>
              <marker id="dep-arrow" viewBox="0 0 10 10" refX="10" refY="5"
                markerWidth="8" markerHeight="8" orient="auto-start-auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#9ca3af" />
              </marker>
            </defs>

            {/* Edges */}
            {edges.map((edge, i) => {
              const from = layout.positions.get(edge.from);
              const to = layout.positions.get(edge.to);
              if (!from || !to) return null;
              return (
                <line
                  key={i}
                  x1={from.x + NODE_W}
                  y1={from.y + NODE_H / 2}
                  x2={to.x}
                  y2={to.y + NODE_H / 2}
                  stroke="#9ca3af"
                  strokeWidth={1.5}
                  markerEnd="url(#dep-arrow)"
                />
              );
            })}

            {/* Nodes */}
            {dagIssues.map((issue) => {
              const pos = layout.positions.get(issue.id);
              if (!pos) return null;
              const color = statusColor(issue.status);
              return (
                <g key={issue.id}>
                  <rect
                    x={pos.x} y={pos.y}
                    width={NODE_W} height={NODE_H}
                    rx={6} ry={6}
                    fill="white"
                    stroke={color}
                    strokeWidth={2}
                    className="cursor-pointer"
                  />
                  <text
                    x={pos.x + 8} y={pos.y + 18}
                    fontSize={10}
                    fill="#6b7280"
                    fontFamily="monospace"
                  >
                    {issue.identifier}
                  </text>
                  <text
                    x={pos.x + 8} y={pos.y + 36}
                    fontSize={12}
                    fontWeight={500}
                    fill="#1f2937"
                  >
                    {issue.title.length > 22 ? issue.title.slice(0, 19) + "..." : issue.title}
                  </text>
                  <circle cx={pos.x + NODE_W - 14} cy={pos.y + 14} r={5} fill={color} />
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Issue list */}
      <div className="border border-border">
        {dagIssues.map((issue) => (
          <Link
            key={issue.id}
            to={`/issues/${issue.id}`}
            className="flex items-center gap-3 px-4 py-2 text-sm border-b border-border last:border-b-0 hover:bg-accent/50 no-underline text-inherit"
          >
            <span className="text-xs text-muted-foreground font-mono shrink-0">{issue.identifier}</span>
            <span className="flex-1 truncate">{issue.title}</span>
            <div className="flex items-center gap-2 shrink-0">
              {issue.blockedBy.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {issue.blockedBy.length} blocker{issue.blockedBy.length !== 1 ? "s" : ""}
                </span>
              )}
              <StatusBadge status={issue.status} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
