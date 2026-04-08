import { useMemo } from "react";
import type { PipelineStageDefinition, PipelineEdgeDefinition } from "@agentdash/shared";

// AgentDash: Read-only DAG visualization for pipeline stages

interface DagPreviewProps {
  stages: PipelineStageDefinition[];
  edges: PipelineEdgeDefinition[];
  activeStageIds?: string[];
  completedStageIds?: string[];
  failedStageIds?: string[];
  className?: string;
}

const NODE_W = 160;
const NODE_H = 48;
const GAP_X = 80;
const GAP_Y = 24;
const PADDING = 24;

function computeLayers(
  stages: PipelineStageDefinition[],
  edges: PipelineEdgeDefinition[],
): Map<string, number> {
  const layers = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const s of stages) {
    inDegree.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const e of edges) {
    adj.get(e.fromStageId)?.push(e.toStageId);
    inDegree.set(e.toStageId, (inDegree.get(e.toStageId) ?? 0) + 1);
  }

  // BFS topological layering
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
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
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  return layers;
}

function stageColor(
  stageId: string,
  type: string,
  active?: string[],
  completed?: string[],
  failed?: string[],
): string {
  if (failed?.includes(stageId)) return "#ef4444";
  if (active?.includes(stageId)) return "#3b82f6";
  if (completed?.includes(stageId)) return "#22c55e";
  if (type === "hitl_gate") return "#f59e0b";
  if (type === "merge") return "#8b5cf6";
  return "#6b7280";
}

function stageLabel(type: string): string {
  if (type === "hitl_gate") return "HITL";
  if (type === "merge") return "Merge";
  return "";
}

export function DagPreview({
  stages,
  edges,
  activeStageIds,
  completedStageIds,
  failedStageIds,
  className,
}: DagPreviewProps) {
  const layout = useMemo(() => {
    const layers = computeLayers(stages, edges);
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
  }, [stages, edges]);

  if (stages.length === 0) {
    return <div className={className}>No stages defined</div>;
  }

  return (
    <svg
      width={layout.svgW}
      height={layout.svgH}
      className={className}
      viewBox={`0 0 ${layout.svgW} ${layout.svgH}`}
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5"
          markerWidth="8" markerHeight="8" orient="auto-start-auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#9ca3af" />
        </marker>
      </defs>

      {/* Edges */}
      {edges.map((edge) => {
        const from = layout.positions.get(edge.fromStageId);
        const to = layout.positions.get(edge.toStageId);
        if (!from || !to) return null;
        return (
          <g key={edge.id}>
            <line
              x1={from.x + NODE_W}
              y1={from.y + NODE_H / 2}
              x2={to.x}
              y2={to.y + NODE_H / 2}
              stroke="#9ca3af"
              strokeWidth={1.5}
              markerEnd="url(#arrow)"
            />
            {edge.condition && (
              <text
                x={(from.x + NODE_W + to.x) / 2}
                y={(from.y + to.y) / 2 + NODE_H / 2 - 4}
                fontSize={10}
                fill="#6b7280"
                textAnchor="middle"
              >
                {edge.condition.length > 30
                  ? edge.condition.slice(0, 27) + "..."
                  : edge.condition}
              </text>
            )}
          </g>
        );
      })}

      {/* Nodes */}
      {stages.map((stage) => {
        const pos = layout.positions.get(stage.id);
        if (!pos) return null;
        const color = stageColor(
          stage.id, stage.type, activeStageIds, completedStageIds, failedStageIds,
        );
        const badge = stageLabel(stage.type);
        return (
          <g key={stage.id}>
            <rect
              x={pos.x} y={pos.y}
              width={NODE_W} height={NODE_H}
              rx={8} ry={8}
              fill="white"
              stroke={color}
              strokeWidth={2}
            />
            <text
              x={pos.x + NODE_W / 2}
              y={pos.y + NODE_H / 2 + (badge ? -2 : 4)}
              fontSize={12}
              fontWeight={500}
              fill="#1f2937"
              textAnchor="middle"
            >
              {stage.name.length > 18 ? stage.name.slice(0, 15) + "..." : stage.name}
            </text>
            {badge && (
              <text
                x={pos.x + NODE_W / 2}
                y={pos.y + NODE_H / 2 + 14}
                fontSize={9}
                fill={color}
                textAnchor="middle"
              >
                {badge}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
