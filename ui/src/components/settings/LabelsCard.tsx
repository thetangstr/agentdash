import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueLabel } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { useCanBulkChange } from "../../hooks/useCapability";
import { BatchPreviewDialog, type BatchFieldText } from "../batch/BatchPreviewDialog";

/**
 * AgentDash admin powers: the company's labels in Company Settings → Work.
 * Rename, recolor, delete one or delete several. Today's rule is kept: any
 * member may rename, recolor or delete a label. Deleting several at once is a
 * bulk change, for owners and admins only. An owner or admin deletes through
 * the shared preview dialog, which says how many tasks lose each label; a
 * member deletes one label straight through its own route, after a confirm.
 */

const NOUN = { one: "label", many: "labels" };

function formatField(field: string, value: unknown): BatchFieldText | null {
  if (field === "state") return { label: "Label", value: value === "deleted" ? "Deleted" : "Kept" };
  return null;
}

function LabelRow({
  label,
  selectable,
  selected,
  onSelected,
  onDelete,
}: {
  label: IssueLabel;
  /** Owners and admins only: the checkbox for deleting several at once. */
  selectable: boolean;
  selected: boolean;
  onSelected: (selected: boolean) => void;
  /** Absent: delete this one label directly, after an inline confirm. */
  onDelete?: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  useEffect(() => setName(label.name), [label.name]);
  useEffect(() => setColor(label.color), [label.color]);
  const update = useMutation({
    mutationFn: (data: { name?: string; color?: string }) => issuesApi.updateLabel(label.id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(label.companyId) });
    },
  });
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => issuesApi.deleteLabel(label.id),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(label.companyId) });
    },
  });
  const renamed = name.trim().length > 0 && name.trim() !== label.name;
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="labels-row">
      {selectable ? (
        <label className="flex shrink-0 cursor-pointer items-center max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center">
          <input type="checkbox" className="h-4 w-4" aria-label={`Select ${label.name}`} checked={selected} onChange={(event) => onSelected(event.target.checked)} />
        </label>
      ) : null}
      <input
        type="color"
        aria-label={`Color of ${label.name}`}
        value={color}
        onChange={(event) => setColor(event.target.value)}
        // Saved once the picker closes, not on every step of a drag.
        onBlur={() => { if (color.toLowerCase() !== label.color.toLowerCase()) update.mutate({ color }); }}
        className="h-7 w-9 shrink-0 cursor-pointer rounded border border-border bg-transparent max-sm:h-11 max-sm:w-11"
      />
      <input
        aria-label={`Name of ${label.name}`}
        value={name}
        maxLength={48}
        onChange={(event) => setName(event.target.value)}
        className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none max-sm:min-h-11"
      />
      {renamed ? (
        <Button size="sm" className="max-sm:min-h-11" disabled={update.isPending} onClick={() => update.mutate({ name: name.trim() })}>
          Rename
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" className="text-destructive max-sm:min-h-11" onClick={onDelete ?? (() => setConfirming(true))} aria-label={`Delete ${label.name}`}>
        Delete
      </Button>
      {confirming ? (
        <div className="flex basis-full flex-wrap items-center gap-2 text-xs" data-testid="labels-confirm-delete">
          <span className="text-muted-foreground">Delete {label.name}? Every task that has it loses it.</span>
          <Button size="sm" variant="destructive" className="max-sm:min-h-11" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Delete label
          </Button>
          <Button size="sm" variant="ghost" className="max-sm:min-h-11" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {remove.isError ? (
        <p className="basis-full text-xs text-destructive" role="alert">
          {remove.error instanceof Error ? remove.error.message : "The label was not deleted."}
        </p>
      ) : null}
      {update.isError ? (
        <p className="basis-full text-xs text-destructive" role="alert">
          {update.error instanceof Error ? update.error.message : "The label was not saved."}
        </p>
      ) : null}
    </li>
  );
}

export function LabelsCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const canBulkChange = useCanBulkChange(companyId);
  const { data: labels, isLoading } = useQuery({
    queryKey: queryKeys.issues.labels(companyId),
    queryFn: () => issuesApi.listLabels(companyId),
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const shown = labels ?? [];
  const selectedShown = !canBulkChange ? [] : selected.filter((id) => shown.some((label) => label.id === id));

  return (
    <div className="rounded-md border border-border" data-testid="company-settings-labels-card">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div>
          <div className="text-sm font-medium">Labels</div>
          <p className="text-xs text-muted-foreground">Rename, recolor or delete the labels your tasks use.</p>
        </div>
        {selectedShown.length > 0 ? (
          <Button size="sm" variant="outline" className="text-destructive max-sm:min-h-11" onClick={() => setDeleting(selectedShown)} data-testid="labels-delete-selected">
            Delete {selectedShown.length} selected
          </Button>
        ) : null}
      </div>
      {isLoading ? <p className="px-3 pb-3 text-xs text-muted-foreground">Loading labels...</p> : null}
      {!isLoading && shown.length === 0 ? <p className="px-3 pb-3 text-xs text-muted-foreground">No labels yet. Add them from a task.</p> : null}
      {shown.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {shown.map((label) => (
            <LabelRow
              key={label.id}
              label={label}
              selectable={canBulkChange}
              selected={selected.includes(label.id)}
              onSelected={(checked) => setSelected((current) => (checked ? [...current.filter((id) => id !== label.id), label.id] : current.filter((id) => id !== label.id)))}
              onDelete={canBulkChange ? () => setDeleting([label.id]) : undefined}
            />
          ))}
        </ul>
      ) : null}
      {deleting ? (
        <BatchPreviewDialog
          open
          onOpenChange={(open) => { if (!open) setDeleting(null); }}
          companyId={companyId}
          title={deleting.length === 1 ? "Delete a label" : `Delete ${deleting.length} labels`}
          kind="label.delete"
          ids={deleting}
          change={{}}
          noun={NOUN}
          formatField={formatField}
          onFinished={() => {
            setSelected([]);
            void queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(companyId) });
          }}
        />
      ) : null}
    </div>
  );
}
