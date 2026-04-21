// AgentDash (AGE-48 Phase 2): Plan editor drawer.
//
// Opens from the Approve card's "Edit" button. Provides a single-form view
// for tweaking sub-goal suggestions, agent roster (name/system prompt),
// KPI targets, and budget cap. Close without save discards mutations.
//
// Implementation notes
// --------------------
// - We use the existing Dialog primitive rather than a separate Drawer
//   component; no drawer exists yet in this codebase and Dialog is the
//   nearest shell that matches the visual weight of the GoalHub card.
// - Form state is local; on save we compute a diff and PATCH only the
//   changed fields (rationale, proposedAgents, kpis, budget, decisionNote).
//   Sub-goal edits are persisted to `proposedPlaybooks` only in Phase 3;
//   for now we stash them in an empty metadata-free subGoals field that
//   the server Zod schema accepts but Phase-3 migrations will read.

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentTeamPlanPayload, ProposedAgent, ProposedKpi } from "@agentdash/shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";
import { agentPlansApi, type AgentPlanRow } from "@/api/agent-plans";
import { queryKeys } from "@/lib/queryKeys";

interface PlanEditorDrawerProps {
  companyId: string;
  goalId: string;
  plan: AgentPlanRow;
  open: boolean;
  onClose: () => void;
}

interface DraftSubGoal {
  title: string;
  description?: string;
  level?: "company" | "team" | "agent" | "task";
}

function cloneAgents(payload: AgentTeamPlanPayload | null): ProposedAgent[] {
  return (payload?.proposedAgents ?? []).map((a) => ({
    ...a,
    skills: [...(a.skills ?? [])],
  }));
}

function cloneKpis(payload: AgentTeamPlanPayload | null): ProposedKpi[] {
  return (payload?.kpis ?? []).map((k) => ({ ...k }));
}

export function PlanEditorDrawer({ companyId, goalId, plan, open, onClose }: PlanEditorDrawerProps) {
  const queryClient = useQueryClient();
  const payload = plan.proposalPayload as AgentTeamPlanPayload | null;

  const [rationale, setRationale] = useState(payload?.rationale ?? "");
  const [agents, setAgents] = useState<ProposedAgent[]>(() => cloneAgents(payload));
  const [kpis, setKpis] = useState<ProposedKpi[]>(() => cloneKpis(payload));
  const [subGoals, setSubGoals] = useState<DraftSubGoal[]>([]);
  const [budgetCap, setBudgetCap] = useState<number>(payload?.budget?.monthlyCapUsd ?? 0);

  // Reset form each time drawer opens (match current plan content).
  useMemo(() => {
    if (open) {
      setRationale(payload?.rationale ?? "");
      setAgents(cloneAgents(payload));
      setKpis(cloneKpis(payload));
      setSubGoals([]);
      setBudgetCap(payload?.budget?.monthlyCapUsd ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan.id]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!payload) return plan;
      const patch: Record<string, unknown> = {};
      if (rationale.trim() !== (payload.rationale ?? "")) patch.rationale = rationale.trim();
      // Agents: naïve compare — always send on any edit (the server
      // revalidates the shape and rejects an empty roster).
      patch.proposedAgents = agents;
      patch.kpis = kpis;
      if (budgetCap !== payload.budget?.monthlyCapUsd) {
        patch.budget = { ...payload.budget, monthlyCapUsd: budgetCap };
      }
      if (subGoals.length > 0) {
        patch.subGoals = subGoals;
      }
      return agentPlansApi.updateProposal(companyId, plan.id, patch as any);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agentPlans.byGoal(companyId, goalId),
      });
      onClose();
    },
  });

  function updateAgent(idx: number, patch: Partial<ProposedAgent>) {
    setAgents((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  }

  function removeAgent(idx: number) {
    setAgents((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateKpi(idx: number, patch: Partial<ProposedKpi>) {
    setKpis((prev) => prev.map((k, i) => (i === idx ? { ...k, ...patch } : k)));
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="plan-editor-drawer">
        <DialogHeader>
          <DialogTitle>Edit proposed plan</DialogTitle>
          <DialogDescription>
            Tweak the roster, KPIs, sub-goals, and budget before approving. Close
            without saving to discard edits.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* Rationale */}
          <div className="space-y-2">
            <Label htmlFor="plan-rationale-input">Rationale</Label>
            <Textarea
              id="plan-rationale-input"
              rows={4}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              data-testid="plan-editor-rationale"
            />
          </div>

          {/* Agents */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Agents ({agents.length})</Label>
            </div>
            <ul className="space-y-3" data-testid="plan-editor-agents">
              {agents.map((a, idx) => (
                <li key={`${a.role}-${idx}`} className="border border-border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <Input
                      value={a.name}
                      onChange={(e) => updateAgent(idx, { name: e.target.value })}
                      placeholder="Agent name"
                      data-testid={`plan-editor-agent-name-${idx}`}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => removeAgent(idx)}
                      aria-label="Remove agent"
                      data-testid={`plan-editor-agent-remove-${idx}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                  <Textarea
                    rows={3}
                    value={a.systemPrompt}
                    onChange={(e) => updateAgent(idx, { systemPrompt: e.target.value })}
                    placeholder="System prompt"
                    data-testid={`plan-editor-agent-prompt-${idx}`}
                  />
                  <Input
                    value={(a.skills ?? []).join(", ")}
                    onChange={(e) =>
                      updateAgent(idx, {
                        skills: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="Skills (comma-separated)"
                    data-testid={`plan-editor-agent-skills-${idx}`}
                  />
                </li>
              ))}
            </ul>
          </div>

          {/* KPIs */}
          <div className="space-y-2">
            <Label>KPI targets</Label>
            <ul className="space-y-2" data-testid="plan-editor-kpis">
              {kpis.map((k, idx) => (
                <li key={k.metric} className="border border-border p-3 grid grid-cols-2 gap-2">
                  <div className="col-span-2 text-sm font-medium">{k.metric}</div>
                  <div>
                    <Label className="text-xs">Target</Label>
                    <Input
                      type="number"
                      value={k.target}
                      onChange={(e) =>
                        updateKpi(idx, { target: Number(e.target.value) })
                      }
                      data-testid={`plan-editor-kpi-target-${k.metric}`}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Horizon (days)</Label>
                    <Input
                      type="number"
                      value={k.horizonDays}
                      onChange={(e) =>
                        updateKpi(idx, { horizonDays: Number(e.target.value) })
                      }
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Sub-goals */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Sub-goal suggestions (optional)</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setSubGoals((prev) => [...prev, { title: "", level: "team" }])
                }
                data-testid="plan-editor-subgoal-add"
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add
              </Button>
            </div>
            <ul className="space-y-2" data-testid="plan-editor-subgoals">
              {subGoals.map((sg, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <Input
                    value={sg.title}
                    onChange={(e) =>
                      setSubGoals((prev) =>
                        prev.map((s, i) => (i === idx ? { ...s, title: e.target.value } : s)),
                      )
                    }
                    placeholder="Sub-goal title"
                    data-testid={`plan-editor-subgoal-title-${idx}`}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() =>
                      setSubGoals((prev) => prev.filter((_, i) => i !== idx))
                    }
                    aria-label="Remove sub-goal"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>

          {/* Budget cap */}
          <div className="space-y-2">
            <Label htmlFor="plan-budget-input">Monthly budget cap (USD)</Label>
            <Input
              id="plan-budget-input"
              type="number"
              value={budgetCap}
              onChange={(e) => setBudgetCap(Number(e.target.value))}
              data-testid="plan-editor-budget"
            />
          </div>

          {saveMutation.isError && (
            <p className="text-sm text-destructive" role="alert">
              {(saveMutation.error as Error).message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} data-testid="plan-editor-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            data-testid="plan-editor-save"
          >
            {saveMutation.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
