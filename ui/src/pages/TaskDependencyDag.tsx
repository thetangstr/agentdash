import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { GitBranch, ZoomIn, ZoomOut, LayoutGrid } from "lucide-react";
import { useState, useMemo, useCallback } from "react";

// --- Types ---

interface Issue {
  id: string;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  projectId?: string | null;
}

interface Dependency {
  id: string;
  issueId: string;
  blockedByIssueId: string;
  dependencyType: string;
}

interface DagNode {
  id: string;
  issue: Issue;
  layer: number;
  x: number;
  y: number;
}

interface DagEdge {
  from: string;
  to: string;
  type: string;
}

// --- Constants ---

const STATUS_COLORS: Record<string, { bg: string; text: string; fill: string }> = {
  done: { bg: "fill-emerald-100", text: "fill-emerald-700", fill: "#d1fae5" },
  completed: { bg: "fill-emerald-100", text: "fill-emerald-700", fill: "#d1fae5" },
  in_progress: { bg: "fill-blue-100", text: "fill-blue-700", fill: "#dbeafe" },
  running: { bg: "fill-blue-100", text: "fill-blue-700", fill: "#dbeafe" },
  blocked: { bg: "fill-red-100", text: "fill-red-700", fill: "#fee2e2" },
  todo: { bg: "fill-slate-100", text: "fill-slate-700", fill: "#f1f5f9" },
  backlog: { bg: "fill-slate-100", text: "fill-slate-700", fill: "#f1f5f9" },
  pending: { bg: "fill-slate-100", text: "fill-slate-700", fill: "#f1f5f9" },
  cancelled: { bg: "fill-gray-100", text: "fill-gray-500", fill: "#f3f4f6" },
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 70;
const LAYER_GAP_X = 280;
const NODE_GAP_Y = 90;
const PADDING = 60;
const MAX_NODES_FOR_DAG = 200;

// --- Layout algorithm ---

function buildDag(
  issues: Issue[],
  dependencies: Dependency[],
): { nodes: DagNode[]; edges: DagEdge[]; width: number; height: number } {
  const issueMap = new Map<string, Issue>();
  for (const issue of issues) {
    issueMap.set(issue.id, issue);
  }

  // Collect all issue ids involved in dependencies
  const involvedIds = new Set<string>();
  for (const dep of dependencies) {
    if (issueMap.has(dep.issueId)) involvedIds.add(dep.issueId);
    if (issueMap.has(dep.blockedByIssueId)) involvedIds.add(dep.blockedByIssueId);
  }

  if (involvedIds.size === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  // Build adjacency: blockedByIssueId -> issueId (left to right)
  const outEdges = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const edges: DagEdge[] = [];

  for (const id of involvedIds) {
    outEdges.set(id, []);
    inDegree.set(id, 0);
  }

  for (const dep of dependencies) {
    if (!involvedIds.has(dep.issueId) || !involvedIds.has(dep.blockedByIssueId)) continue;
    const from = dep.blockedByIssueId;
    const to = dep.issueId;
    outEdges.get(from)!.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    edges.push({ from, to, type: dep.dependencyType });
  }

  // Topological sort (Kahn's algorithm) to assign layers
  const queue: string[] = [];
  const layer = new Map<string, number>();

  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      layer.set(id, 0);
    }
  }

  let maxLayer = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLayer = layer.get(current) ?? 0;
    for (const neighbor of outEdges.get(current) ?? []) {
      const newLayer = currentLayer + 1;
      layer.set(neighbor, Math.max(layer.get(neighbor) ?? 0, newLayer));
      maxLayer = Math.max(maxLayer, layer.get(neighbor)!);
      const remaining = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, remaining);
      if (remaining === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Handle nodes that weren't reached (cycles or disconnected) - put them in layer 0
  for (const id of involvedIds) {
    if (!layer.has(id)) {
      layer.set(id, 0);
    }
  }

  // Group by layer
  const layerBuckets = new Map<number, string[]>();
  for (const [id, l] of layer) {
    if (!layerBuckets.has(l)) layerBuckets.set(l, []);
    layerBuckets.get(l)!.push(id);
  }

  // Position nodes
  const nodes: DagNode[] = [];
  const posMap = new Map<string, { x: number; y: number }>();

  for (let l = 0; l <= maxLayer; l++) {
    const bucket = layerBuckets.get(l) ?? [];
    for (let i = 0; i < bucket.length; i++) {
      const id = bucket[i];
      const issue = issueMap.get(id);
      if (!issue) continue;
      const x = PADDING + l * LAYER_GAP_X;
      const y = PADDING + i * NODE_GAP_Y;
      posMap.set(id, { x, y });
      nodes.push({ id, issue, layer: l, x, y });
    }
  }

  const width = PADDING * 2 + (maxLayer + 1) * LAYER_GAP_X;
  const maxBucketSize = Math.max(...Array.from(layerBuckets.values()).map((b) => b.length), 1);
  const height = PADDING * 2 + maxBucketSize * NODE_GAP_Y;

  return { nodes, edges, width, height };
}

// --- Component ---

export function TaskDependencyDag() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;
  const [zoom, setZoom] = useState(1);
  const [viewMode, setViewMode] = useState<"dag" | "list">("dag");

  const { data: issues = [], isLoading: issuesLoading } = useQuery({
    queryKey: ["dag-issues", cid],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${cid}/issues?limit=100`);
      return res.json();
    },
    enabled: !!cid,
  });

  // Collect all unique project IDs from issues
  const projectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const issue of issues as Issue[]) {
      if (issue.projectId) ids.add(issue.projectId);
    }
    return Array.from(ids);
  }, [issues]);

  // Fetch dependency graph for each project
  const { data: dependencies = [], isLoading: depsLoading } = useQuery({
    queryKey: ["dag-dependencies", cid, projectIds],
    queryFn: async () => {
      const allDeps: Dependency[] = [];
      for (const projectId of projectIds) {
        try {
          const res = await fetch(
            `/api/companies/${cid}/projects/${projectId}/dependency-graph`,
          );
          if (res.ok) {
            const deps = await res.json();
            allDeps.push(...deps);
          }
        } catch {
          // skip failed project fetches
        }
      }
      return allDeps;
    },
    enabled: !!cid && projectIds.length > 0,
  });

  const dag = useMemo(() => buildDag(issues as Issue[], dependencies), [issues, dependencies]);

  const handleZoomIn = useCallback(() => setZoom((z) => Math.min(z + 0.15, 2)), []);
  const handleZoomOut = useCallback(() => setZoom((z) => Math.max(z - 0.15, 0.3)), []);

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;

  const isLoading = issuesLoading || depsLoading;
  const hasDependencies = dependencies.length > 0;
  const tooComplex = dag.nodes.length > MAX_NODES_FOR_DAG;
  const showDag = viewMode === "dag" && !tooComplex;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <GitBranch className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold">Task Dependencies</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {dag.nodes.length} tasks with dependencies, {dag.edges.length} edges
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasDependencies && (
            <button
              onClick={() => setViewMode(viewMode === "dag" ? "list" : "dag")}
              className="flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2 text-sm hover:bg-muted/50"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              {viewMode === "dag" ? "List view" : "DAG view"}
            </button>
          )}
          {showDag && hasDependencies && (
            <>
              <button
                onClick={handleZoomOut}
                className="rounded-lg border bg-background p-2 hover:bg-muted/50"
                title="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <span className="text-xs text-muted-foreground w-12 text-center">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={handleZoomIn}
                className="rounded-lg border bg-background p-2 hover:bg-muted/50"
                title="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
          Loading dependency graph...
        </div>
      ) : !hasDependencies ? (
        <div className="rounded-xl border bg-card p-12 text-center space-y-3">
          <GitBranch className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <div>
            <p className="font-medium text-muted-foreground">
              No task dependencies configured. Add dependencies to visualize the DAG.
            </p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Dependencies connect tasks so blocked work is visible at a glance.
            </p>
          </div>
        </div>
      ) : showDag ? (
        <DagSvg dag={dag} zoom={zoom} />
      ) : (
        <DagListView issues={issues as Issue[]} dependencies={dependencies} />
      )}
    </div>
  );
}

// --- SVG DAG ---

function DagSvg({
  dag,
  zoom,
}: {
  dag: ReturnType<typeof buildDag>;
  zoom: number;
}) {
  const posMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const node of dag.nodes) m.set(node.id, { x: node.x, y: node.y });
    return m;
  }, [dag.nodes]);

  return (
    <div className="rounded-xl border bg-card overflow-auto" style={{ maxHeight: "70vh" }}>
      <svg
        width={dag.width * zoom}
        height={dag.height * zoom}
        viewBox={`0 0 ${dag.width} ${dag.height}`}
        className="select-none"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="10"
            refY="3.5"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
          </marker>
        </defs>

        {/* Edges */}
        {dag.edges.map((edge, i) => {
          const from = posMap.get(edge.from);
          const to = posMap.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + NODE_WIDTH;
          const y1 = from.y + NODE_HEIGHT / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_HEIGHT / 2;
          const midX = (x1 + x2) / 2;
          return (
            <path
              key={`edge-${i}`}
              d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="#94a3b8"
              strokeWidth="1.5"
              markerEnd="url(#arrowhead)"
            />
          );
        })}

        {/* Nodes */}
        {dag.nodes.map((node) => (
          <DagNodeRect key={node.id} node={node} />
        ))}
      </svg>
    </div>
  );
}

function DagNodeRect({ node }: { node: DagNode }) {
  const colors = STATUS_COLORS[node.issue.status] ?? STATUS_COLORS.pending;
  const truncatedTitle =
    node.issue.title.length > 28
      ? node.issue.title.slice(0, 26) + "..."
      : node.issue.title;
  const assignee =
    node.issue.assigneeAgentId?.slice(0, 8) ??
    node.issue.assigneeUserId?.slice(0, 8) ??
    "unassigned";

  return (
    <Link to={`/issues/${node.id}`}>
      <g className="cursor-pointer" style={{ pointerEvents: "all" }}>
        <rect
          x={node.x}
          y={node.y}
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={12}
          fill={colors.fill}
          stroke="#e2e8f0"
          strokeWidth="1"
        />
        <text
          x={node.x + 12}
          y={node.y + 24}
          fontSize="12"
          fontWeight="600"
          fill="#1e293b"
        >
          {truncatedTitle}
        </text>
        {/* Status badge */}
        <rect
          x={node.x + 12}
          y={node.y + 36}
          width={node.issue.status.length * 7 + 12}
          height={18}
          rx={9}
          fill={colors.fill}
          stroke={statusBorderColor(node.issue.status)}
          strokeWidth="0.5"
        />
        <text
          x={node.x + 18}
          y={node.y + 49}
          fontSize="10"
          fill={statusTextColor(node.issue.status)}
        >
          {node.issue.status}
        </text>
        {/* Assignee */}
        <text
          x={node.x + NODE_WIDTH - 12}
          y={node.y + 49}
          fontSize="9"
          fill="#94a3b8"
          textAnchor="end"
        >
          {assignee}
        </text>
      </g>
    </Link>
  );
}

function statusBorderColor(status: string): string {
  switch (status) {
    case "done":
    case "completed":
      return "#6ee7b7";
    case "in_progress":
    case "running":
      return "#93c5fd";
    case "blocked":
      return "#fca5a5";
    default:
      return "#cbd5e1";
  }
}

function statusTextColor(status: string): string {
  switch (status) {
    case "done":
    case "completed":
      return "#047857";
    case "in_progress":
    case "running":
      return "#1d4ed8";
    case "blocked":
      return "#dc2626";
    default:
      return "#475569";
  }
}

// --- List view fallback ---

function DagListView({
  issues,
  dependencies,
}: {
  issues: Issue[];
  dependencies: Dependency[];
}) {
  const issueMap = useMemo(() => {
    const m = new Map<string, Issue>();
    for (const issue of issues) m.set(issue.id, issue);
    return m;
  }, [issues]);

  // Group: for each issue, find its blockers
  const blockerMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const dep of dependencies) {
      if (!m.has(dep.issueId)) m.set(dep.issueId, []);
      m.get(dep.issueId)!.push(dep.blockedByIssueId);
    }
    return m;
  }, [dependencies]);

  // Find root issues (those that are blockers but not blocked by anything)
  const blocked = new Set(blockerMap.keys());
  const allBlockers = new Set(dependencies.map((d) => d.blockedByIssueId));
  const roots = Array.from(allBlockers).filter((id) => !blocked.has(id));

  // Also include blocked issues that have no blocker in our set (orphan roots)
  const involvedIds = new Set<string>();
  for (const dep of dependencies) {
    involvedIds.add(dep.issueId);
    involvedIds.add(dep.blockedByIssueId);
  }

  const statusBadge = (status: string) => {
    const cls: Record<string, string> = {
      done: "bg-emerald-100 text-emerald-700",
      completed: "bg-emerald-100 text-emerald-700",
      in_progress: "bg-blue-100 text-blue-700",
      running: "bg-blue-100 text-blue-700",
      blocked: "bg-red-100 text-red-700",
      todo: "bg-slate-100 text-slate-700",
      backlog: "bg-slate-100 text-slate-700",
      cancelled: "bg-gray-100 text-gray-500",
    };
    return (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls[status] ?? "bg-muted text-muted-foreground"}`}>
        {status}
      </span>
    );
  };

  // Recursive render with depth
  const rendered = new Set<string>();
  function renderTree(id: string, depth: number): React.ReactNode {
    if (rendered.has(id)) return null;
    rendered.add(id);
    const issue = issueMap.get(id);
    if (!issue) return null;

    // Find dependents (issues blocked by this issue)
    const dependents = dependencies
      .filter((d) => d.blockedByIssueId === id)
      .map((d) => d.issueId);

    return (
      <div key={id}>
        <div
          className="flex items-center gap-3 py-2 px-3 hover:bg-muted/30 rounded-lg"
          style={{ paddingLeft: `${depth * 24 + 12}px` }}
        >
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Link
            to={`/issues/${id}`}
            className="font-medium text-sm hover:text-primary transition-colors truncate flex-1"
          >
            {issue.title}
          </Link>
          {statusBadge(issue.status)}
        </div>
        {dependents.map((depId) => renderTree(depId, depth + 1))}
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-4 space-y-1">
      <div className="flex items-center gap-2 mb-3 pb-3 border-b">
        <LayoutGrid className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">List View</span>
        <span className="text-xs text-muted-foreground">
          ({involvedIds.size} tasks, {dependencies.length} dependencies)
        </span>
      </div>
      {roots.length > 0
        ? roots.map((id) => renderTree(id, 0))
        : Array.from(involvedIds).map((id) => renderTree(id, 0))}
    </div>
  );
}
