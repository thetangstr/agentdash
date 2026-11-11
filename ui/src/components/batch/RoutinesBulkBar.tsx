import { useState } from "react";
import { Button } from "@/components/ui/button";
import { BatchPreviewDialog, type BatchFieldText } from "./BatchPreviewDialog";

/**
 * AgentDash admin powers: the Routines page's action bar. Archive (it can be
 * restored) or delete (for good; runs, created tasks and history stay). Each
 * opens the shared preview dialog.
 */

const NOUN = { one: "routine", many: "routines" };

function formatField(field: string, value: unknown): BatchFieldText | null {
  const words: Record<string, string> = { active: "On", paused: "Off", archived: "Archived", deleted: "Deleted" };
  if (field === "status" || field === "state") return { label: "Routine", value: typeof value === "string" ? words[value] ?? value : "None" };
  return null;
}

export function RoutinesBulkBar({
  companyId,
  selectedIds,
  onClear,
  onFinished,
}: {
  companyId: string;
  selectedIds: string[];
  onClear: () => void;
  onFinished: () => void;
}) {
  const [kind, setKind] = useState<"routine.archive" | "routine.delete" | null>(null);
  return (
    <>
      <div
        className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 px-3 py-2 shadow-sm backdrop-blur"
        role="toolbar"
        aria-label="Change selected routines"
        data-testid="routines-bulk-bar"
      >
        <span className="mr-1 text-sm font-medium" data-testid="routines-bulk-count">{selectedIds.length} selected</span>
        <Button size="sm" variant="outline" className="max-sm:min-h-11" data-testid="routines-bulk-archive" onClick={() => setKind("routine.archive")}>Archive</Button>
        <Button size="sm" variant="outline" className="text-destructive max-sm:min-h-11" data-testid="routines-bulk-delete" onClick={() => setKind("routine.delete")}>Delete</Button>
        <Button size="sm" variant="ghost" className="ml-auto max-sm:min-h-11" onClick={onClear}>Clear</Button>
      </div>
      {kind ? (
        <BatchPreviewDialog
          open
          onOpenChange={(open) => { if (!open) setKind(null); }}
          companyId={companyId}
          title={kind === "routine.archive" ? "Archive routines" : "Delete routines"}
          kind={kind}
          ids={selectedIds}
          change={{}}
          noun={NOUN}
          formatField={formatField}
          onFinished={onFinished}
        />
      ) : null}
    </>
  );
}
