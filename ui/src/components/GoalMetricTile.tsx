// AgentDash: goals-eval-hitl
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Target, Edit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  goalMetricDefinitionSchema,
  type GoalMetricDefinition,
} from "@paperclipai/shared";
import { goalsEvalHitlApi } from "../api/goals-eval-hitl";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";

interface GoalMetricTileProps {
  companyId: string;
  goalId: string;
  metricDefinition: GoalMetricDefinition | null | undefined;
}

export function GoalMetricTile({ companyId, goalId, metricDefinition }: GoalMetricTileProps) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (def: GoalMetricDefinition) =>
      goalsEvalHitlApi.setGoalMetricDefinition(companyId, goalId, def),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(goalId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(companyId) });
      setOpen(false);
    },
  });

  const md = metricDefinition;

  return (
    <div className="px-4 py-4 sm:px-5 sm:py-5 rounded-lg border border-border">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {md ? (
            <>
              <p className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums">
                {md.currentValue ?? "—"}
                <span className="text-base text-muted-foreground/70">
                  {" "}
                  / {md.target} {md.unit}
                </span>
              </p>
              <p className="text-xs sm:text-sm font-medium text-muted-foreground mt-1">
                Goal Metric
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1.5">
                Source: {md.source}
                {md.lastUpdatedAt ? ` · updated ${timeAgo(md.lastUpdatedAt)}` : " · never updated"}
              </p>
            </>
          ) : (
            <>
              <p className="text-2xl sm:text-3xl font-semibold tracking-tight text-muted-foreground/50">
                —
              </p>
              <p className="text-xs sm:text-sm font-medium text-muted-foreground mt-1">
                Goal Metric
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1.5">
                No metric defined
              </p>
            </>
          )}
        </div>
        <Target className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-1.5" />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
        >
          <Edit2 className="h-3 w-3 mr-1.5" />
          {md ? "Edit metric" : "Define metric"}
        </Button>
      </div>

      <GoalMetricEditorDialog
        open={open}
        onOpenChange={setOpen}
        initial={md ?? null}
        onSubmit={(next) => mutation.mutate(next)}
        isPending={mutation.isPending}
        error={mutation.error ? (mutation.error as Error).message : null}
      />
    </div>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: GoalMetricDefinition | null;
  onSubmit: (next: GoalMetricDefinition) => void;
  isPending: boolean;
  error: string | null;
}

function GoalMetricEditorDialog({ open, onOpenChange, initial, onSubmit, isPending, error }: DialogProps) {
  const [target, setTarget] = useState<string>(initial?.target?.toString() ?? "");
  const [unit, setUnit] = useState<string>(initial?.unit ?? "");
  const [source, setSource] = useState<string>(initial?.source ?? "manual");
  const [baseline, setBaseline] = useState<string>(initial?.baseline?.toString() ?? "");
  const [currentValue, setCurrentValue] = useState<string>(
    initial?.currentValue?.toString() ?? "",
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  function handleSubmit() {
    setValidationError(null);
    const candidate: Record<string, unknown> = {
      target: target.trim() === "" ? undefined : maybeNumber(target),
      unit: unit.trim(),
      source: source.trim(),
    };
    if (baseline.trim() !== "") candidate.baseline = maybeNumber(baseline);
    if (currentValue.trim() !== "") {
      candidate.currentValue = maybeNumber(currentValue);
      candidate.lastUpdatedAt = new Date().toISOString();
    }

    const parsed = goalMetricDefinitionSchema.safeParse(candidate);
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Invalid metric");
      return;
    }
    onSubmit(parsed.data);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit goal metric" : "Define goal metric"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="metric-target">Target</Label>
              <Input
                id="metric-target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="100"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="metric-unit">Unit</Label>
              <Input
                id="metric-unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="users, $, etc."
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="metric-source">Source</Label>
            <Input
              id="metric-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="manual, stripe, analytics"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="metric-baseline">Baseline</Label>
              <Input
                id="metric-baseline"
                value={baseline}
                onChange={(e) => setBaseline(e.target.value)}
                placeholder="optional"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="metric-current">Current value</Label>
              <Input
                id="metric-current"
                value={currentValue}
                onChange={(e) => setCurrentValue(e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>
          {(validationError || error) && (
            <p className="text-xs text-destructive">{validationError ?? error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function maybeNumber(raw: string): number | string {
  const n = Number(raw);
  if (!Number.isNaN(n) && raw.trim() !== "") return n;
  return raw;
}
