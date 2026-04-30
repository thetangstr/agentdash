import type { ReactNode } from "react";
import { ControlPlaneDiagram } from "../diagrams/ControlPlaneDiagram";
import { OrchestrationDiagram } from "../diagrams/OrchestrationDiagram";
import { WorkspacesDiagram } from "../diagrams/WorkspacesDiagram";
import { AgentPrimitivesDiagram } from "../diagrams/AgentPrimitivesDiagram";
import { InteropDiagram } from "../diagrams/InteropDiagram";
import { TrustSafetyDiagram } from "../diagrams/TrustSafetyDiagram";
import { ModelServingDiagram } from "../diagrams/ModelServingDiagram";

export interface DescentLayer {
  number: string;
  name: string;
  oneLine: string;
  diagram: ReactNode;
}

export const DESCENT_LAYERS: DescentLayer[] = [
  { number: "01", name: "Control Plane",        oneLine: "Where you run your AI company.",                       diagram: <ControlPlaneDiagram /> },
  { number: "02", name: "Orchestration",        oneLine: "Task graphs, dependencies, scheduling, approvals.",     diagram: <OrchestrationDiagram /> },
  { number: "03", name: "Workspaces & Adapters",oneLine: "The execution environments your agents actually run in.",diagram: <WorkspacesDiagram /> },
  { number: "04", name: "Agent Primitives",     oneLine: "Identity, memory, heartbeat, tools.",                   diagram: <AgentPrimitivesDiagram /> },
  { number: "05", name: "Interop",              oneLine: "How agents reach humans, systems, and each other.",     diagram: <InteropDiagram /> },
  { number: "06", name: "Trust & Safety",       oneLine: "Policies, budgets, audits, kill switch.",               diagram: <TrustSafetyDiagram /> },
  { number: "07", name: "Model Serving",        oneLine: "Inference. Your tokens, your models.",                  diagram: <ModelServingDiagram /> },
];
