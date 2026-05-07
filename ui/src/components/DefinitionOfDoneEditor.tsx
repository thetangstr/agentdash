// AgentDash: goals-eval-hitl
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { definitionOfDoneSchema, type DefinitionOfDone } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface DefinitionOfDoneEditorProps {
  value: DefinitionOfDone | null;
  onSave: (next: DefinitionOfDone) => void;
  isPending?: boolean;
  errorMessage?: string | null;
  /** Discriminator for label copy. Editor shape is identical across entities. */
  entityType: "goal" | "project" | "issue";
  className?: string;
}

const EMPTY: DefinitionOfDone = {
  summary: "",
  criteria: [{ id: cryptoRandomId(), text: "", done: false }],
  goalMetricLink: undefined,
};

export function DefinitionOfDoneEditor({
  value,
  onSave,
  isPending,
  errorMessage,
  entityType,
  className,
}: DefinitionOfDoneEditorProps) {
  const [draft, setDraft] = useState<DefinitionOfDone>(value ?? EMPTY);
  const [validationError, setValidationError] = useState<string | null>(null);

  function update(next: DefinitionOfDone) {
    setDraft(next);
    setValidationError(null);
  }

  function handleAddCriterion() {
    update({
      ...draft,
      criteria: [...draft.criteria, { id: cryptoRandomId(), text: "", done: false }],
    });
  }

  function handleRemoveCriterion(id: string) {
    update({ ...draft, criteria: draft.criteria.filter((c) => c.id !== id) });
  }

  function handleSave() {
    setValidationError(null);
    const candidate: DefinitionOfDone = {
      summary: draft.summary.trim(),
      criteria: draft.criteria
        .map((c) => ({ ...c, text: c.text.trim() }))
        .filter((c) => c.text.length > 0),
      goalMetricLink:
        draft.goalMetricLink && draft.goalMetricLink.trim() !== ""
          ? draft.goalMetricLink.trim()
          : undefined,
    };
    const parsed = definitionOfDoneSchema.safeParse(candidate);
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Invalid Definition of Done");
      return;
    }
    onSave(parsed.data);
  }

  const labelNoun =
    entityType === "issue" ? "issue" : entityType === "project" ? "project" : "goal";

  return (
    <div className={className ?? "space-y-3"}>
      <div className="space-y-1">
        <Label htmlFor="dod-summary">Definition of Done</Label>
        <Textarea
          id="dod-summary"
          value={draft.summary}
          onChange={(e) => update({ ...draft, summary: e.target.value })}
          placeholder={`What does "done" mean for this ${labelNoun}?`}
          rows={3}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Criteria</Label>
        {draft.criteria.length === 0 && (
          <p className="text-xs text-muted-foreground/70">No criteria yet.</p>
        )}
        {draft.criteria.map((c, idx) => (
          <div key={c.id} className="flex items-center gap-2">
            <Checkbox
              checked={c.done}
              onCheckedChange={(checked) => {
                const next = [...draft.criteria];
                next[idx] = { ...c, done: checked === true };
                update({ ...draft, criteria: next });
              }}
            />
            <Input
              value={c.text}
              onChange={(e) => {
                const next = [...draft.criteria];
                next[idx] = { ...c, text: e.target.value };
                update({ ...draft, criteria: next });
              }}
              placeholder="Acceptance criterion"
              className="flex-1"
            />
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={() => handleRemoveCriterion(c.id)}
              aria-label="Remove criterion"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleAddCriterion}
        >
          <Plus className="h-3 w-3 mr-1.5" />
          Add criterion
        </Button>
      </div>

      <div className="space-y-1">
        <Label htmlFor="dod-goal-link">Linked goal metric (optional)</Label>
        <Input
          id="dod-goal-link"
          value={draft.goalMetricLink ?? ""}
          onChange={(e) => update({ ...draft, goalMetricLink: e.target.value })}
          placeholder="goal-id or metric reference"
        />
      </div>

      {(validationError || errorMessage) && (
        <p className="text-xs text-destructive">{validationError ?? errorMessage}</p>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isPending}>
          {isPending ? "Saving…" : "Save Definition of Done"}
        </Button>
      </div>
    </div>
  );
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Math.random().toString(36).slice(2, 10)}`;
}
