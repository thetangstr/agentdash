// AgentDash (AGE-48 Phase 2): Plan approval card for the Goal Hub.
//
// Fetches the most-recent proposed plan for a goal and renders its
// proposed agents, KPIs, budget, and rationale. Surfaces three actions:
//   - Approve  → agentPlansApi.approve (Phase 3 will extend to spawn
//                sub-goals + project + playbooks atomically; in PR-a this
//                remains agents-only).
//   - Edit     → opens PlanEditorDrawer with the current proposal.
//   - Reject   → hits agentPlansApi.reject with a short decision note.
//
// Design notes
// ------------
// - We pull the list of plans via `agentPlansApi.list({ goalId, status:
//   "proposed" })` and pick the first row (the service orders by createdAt
//   DESC). If the auto-propose hasn't landed yet, we render a brief loading
//   state ("Chief of Staff is drafting a plan…"). Once the plan is
//   approved/rejected, the card collapses — the goal-hub rollup already
//   shows the approved plan summary.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  MessageCircle,
  Pencil,
  Sparkles,
  X,
} from "lucide-react";
import type { AgentTeamPlanPayload } from "@agentdash/shared";
import { agentPlansApi, type AgentPlanRow } from "@/api/agent-plans";
import { goalsApi } from "@/api/goals";
// AgentDash (AGE-50 Phase 4b): DialogContext exposes openChat so the
// "Run deep interview" CTA can seed the assistant chat with a prompt.
import { useDialog } from "../context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PlanEditorDrawer } from "./PlanEditorDrawer";

interface PlanApprovalCardProps {
  companyId: string;
  goalId: string;
}

function centsToUsd(dollars: number): string {
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function PlanApprovalCard({ companyId, goalId }: PlanApprovalCardProps) {
  const queryClient = useQueryClient();
  const { openChat } = useDialog();
  const [editorOpen, setEditorOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  // AgentDash (AGE-50 Phase 4b): fetch the goal to know its level — company
  // goals without a plan surface a "Run deep interview" CTA instead of the
  // generic "drafting…" copy.
  const goalQuery = useQuery({
    queryKey: queryKeys.goals.detail(goalId),
    queryFn: () => goalsApi.get(goalId),
    enabled: !!goalId,
    staleTime: 30_000,
  });

  const plansQuery = useQuery({
    queryKey: queryKeys.agentPlans.byGoal(companyId, goalId),
    queryFn: () => agentPlansApi.list(companyId, { goalId, status: "proposed" }),
    enabled: !!companyId && !!goalId,
    // Poll briefly after goal creation so the auto-propose plan appears
    // without a manual refresh.
    refetchInterval: (query) => {
      const data = query.state.data as AgentPlanRow[] | undefined;
      if (!data || data.length === 0) return 2000;
      return false;
    },
  });

  const plan = (plansQuery.data ?? [])[0] as AgentPlanRow | undefined;

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.agentPlans.byGoal(companyId, goalId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.goals.hub(companyId, goalId),
    });
  };

  const approveMutation = useMutation({
    mutationFn: () => agentPlansApi.approve(companyId, plan!.id),
    onSuccess: () => invalidate(),
  });

  const rejectMutation = useMutation({
    mutationFn: (note: string) => agentPlansApi.reject(companyId, plan!.id, note),
    onSuccess: () => {
      setRejectOpen(false);
      setRejectNote("");
      invalidate();
    },
  });

  if (plansQuery.isLoading) {
    return (
      <Card data-testid="plan-approval-card-loading">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Proposed plan
          </CardTitle>
          <CardDescription>Loading plan proposal…</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-20 bg-muted/40 animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  if (!plan) {
    // AgentDash (AGE-50 Phase 4b): company-level goals require a Socratic
    // deep-interview before a plan is written. Show an explicit CTA — the
    // canned "drafting…" copy would be misleading because nothing is actually
    // queued. Clicking seeds the assistant chat.
    const goal = goalQuery.data;
    if (goal && goal.level === "company") {
      const seedMessage = [
        `Please run /deep-interview on this goal: "${goal.title}".`,
        goal.description ? `Description: ${goal.description}` : "",
        `Capture the operator's intent, constraints, channels, blockers, and success criteria. Ask one question at a time (3–5 total), then summarize the answers into a GoalInterviewPayload and call submit_goal_interview with goalId="${goal.id}" and the payload. Keep it friendly and brief.`,
      ]
        .filter(Boolean)
        .join("\n\n");

      return (
        <Card data-testid="plan-approval-card-company-interview">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Chief of Staff interview
            </CardTitle>
            <CardDescription>
              Company-level goals start with a brief Q&amp;A so the Chief of
              Staff can propose a plan grounded in your actual constraints.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              size="sm"
              onClick={() => openChat({ seedMessage })}
              data-testid="plan-start-interview-btn"
            >
              <MessageCircle className="h-3.5 w-3.5 mr-1.5" />
              Start deep interview
            </Button>
          </CardContent>
        </Card>
      );
    }

    return (
      <Card data-testid="plan-approval-card-pending">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Proposed plan
          </CardTitle>
          <CardDescription>
            Chief of Staff is drafting a plan for this goal. Hang tight — the
            proposal will appear here within a few seconds.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const payload = plan.proposalPayload as AgentTeamPlanPayload | null;

  return (
    <>
      <Card data-testid="plan-approval-card">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ClipboardList className="h-4 w-4" />
                Proposed plan
              </CardTitle>
              <CardDescription>
                Chief of Staff proposes this team. Approve to spawn the agents,
                edit to tweak first, or reject to start over.
              </CardDescription>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary" className="capitalize">{plan.archetype}</Badge>
              <Badge variant="outline" className="capitalize">{plan.status}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Rationale */}
          {payload?.rationale && (
            <p className="text-sm whitespace-pre-wrap" data-testid="plan-rationale">
              {payload.rationale}
            </p>
          )}

          {/* Proposed agents */}
          <section aria-labelledby="plan-agents-heading">
            <h4 id="plan-agents-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Proposed agents ({payload?.proposedAgents?.length ?? 0})
            </h4>
            <ul className="divide-y divide-border border border-border" data-testid="plan-agents-list">
              {(payload?.proposedAgents ?? []).map((a, idx) => (
                <li key={`${a.role}-${idx}`} className="flex items-start justify-between gap-3 p-3" data-testid={`plan-agent-${idx}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{a.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {a.role} · {a.adapterType}
                      {a.skills && a.skills.length > 0 ? ` · ${a.skills.join(", ")}` : ""}
                    </p>
                    {a.systemPrompt && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{a.systemPrompt}</p>
                    )}
                  </div>
                  {typeof a.estimatedMonthlyCostUsd === "number" && (
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {centsToUsd(a.estimatedMonthlyCostUsd)}/mo
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* KPIs */}
          {payload?.kpis && payload.kpis.length > 0 && (
            <section aria-labelledby="plan-kpis-heading">
              <h4 id="plan-kpis-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Target KPIs
              </h4>
              <ul className="divide-y divide-border border border-border" data-testid="plan-kpis-list">
                {payload.kpis.map((k) => (
                  <li key={k.metric} className="flex items-center justify-between p-3">
                    <div>
                      <p className="text-sm font-medium">{k.metric}</p>
                      <p className="text-xs text-muted-foreground">
                        {k.baseline} → {k.target} {k.unit} · {k.horizonDays}d horizon
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Budget */}
          {payload?.budget && (
            <section aria-labelledby="plan-budget-heading">
              <h4 id="plan-budget-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Budget
              </h4>
              <p className="text-sm" data-testid="plan-budget">
                Monthly cap {centsToUsd(payload.budget.monthlyCapUsd)} · warn at {payload.budget.warnAtPct}% · kill at {payload.budget.killSwitchAtPct}%
              </p>
            </section>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
            <Button
              onClick={() => approveMutation.mutate()}
              disabled={approveMutation.isPending || rejectMutation.isPending}
              size="sm"
              data-testid="plan-approve-btn"
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              {approveMutation.isPending ? "Approving…" : "Approve"}
            </Button>
            <Button
              onClick={() => setEditorOpen(true)}
              disabled={approveMutation.isPending || rejectMutation.isPending}
              size="sm"
              variant="outline"
              data-testid="plan-edit-btn"
            >
              <Pencil className="h-3.5 w-3.5 mr-1" />
              Edit
            </Button>
            <Button
              onClick={() => setRejectOpen((v) => !v)}
              disabled={approveMutation.isPending || rejectMutation.isPending}
              size="sm"
              variant="ghost"
              data-testid="plan-reject-btn"
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Reject
            </Button>
          </div>

          {/* Inline reject form */}
          {rejectOpen && (
            <div className="border border-border p-3 space-y-2" data-testid="plan-reject-form">
              <label className="text-xs font-medium text-muted-foreground">
                Why rejecting? (required)
              </label>
              <textarea
                className="w-full border border-border p-2 text-sm bg-background rounded-md"
                rows={2}
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                data-testid="plan-reject-note"
              />
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setRejectOpen(false); setRejectNote(""); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => rejectMutation.mutate(rejectNote.trim())}
                  disabled={rejectNote.trim().length === 0 || rejectMutation.isPending}
                  data-testid="plan-reject-submit"
                >
                  {rejectMutation.isPending ? "Rejecting…" : "Confirm reject"}
                </Button>
              </div>
            </div>
          )}

          {/* Mutation errors */}
          {approveMutation.isError && (
            <p className="text-sm text-destructive inline-flex items-center gap-1" role="alert">
              <AlertTriangle className="h-3.5 w-3.5" />
              {(approveMutation.error as Error).message}
            </p>
          )}
          {rejectMutation.isError && (
            <p className="text-sm text-destructive inline-flex items-center gap-1" role="alert">
              <AlertTriangle className="h-3.5 w-3.5" />
              {(rejectMutation.error as Error).message}
            </p>
          )}
        </CardContent>
      </Card>

      <PlanEditorDrawer
        companyId={companyId}
        goalId={goalId}
        plan={plan}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
      />
    </>
  );
}
