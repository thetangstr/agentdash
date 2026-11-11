import { Button } from "@/components/ui/button";
import type { SettingsDraftControls } from "../../hooks/useSettingsDraft";

/**
 * The save row under a settings section: "Save changes", "Discard" while there
 * is a draft, and one line saying where the draft stands ("Unsaved changes",
 * "Saved", or the server's error). Save is disabled when nothing changed, when
 * a save is in flight, or when `canSave` is false (a field is not valid).
 */
export function SettingsSaveBar({
  draft,
  testId,
  canSave = true,
  onSave,
  errorMessage,
}: {
  draft: SettingsDraftControls;
  /** Prefix for the row's test ids: `-save`, `-discard`, `-state`, `-error`. */
  testId: string;
  canSave?: boolean;
  /** Replaces the plain save, e.g. to confirm first. */
  onSave?: () => void;
  errorMessage?: (error: unknown) => string;
}) {
  const message = draft.error
    ? errorMessage?.(draft.error)
      ?? (draft.error instanceof Error && draft.error.message ? draft.error.message : "The changes were not saved.")
    : null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
      <Button
        size="sm"
        onClick={() => (onSave ? onSave() : draft.save())}
        disabled={!draft.isDirty || draft.isSaving || !canSave}
        data-testid={`${testId}-save`}
      >
        {draft.isSaving ? "Saving..." : "Save changes"}
      </Button>
      {draft.isDirty && (
        <Button
          size="sm"
          variant="ghost"
          onClick={draft.discard}
          disabled={draft.isSaving}
          data-testid={`${testId}-discard`}
        >
          Discard
        </Button>
      )}
      <span role="status" aria-live="polite" className="text-xs text-muted-foreground" data-testid={`${testId}-state`}>
        {draft.isDirty ? "Unsaved changes" : draft.isSaved ? "Saved" : ""}
      </span>
      {message && (
        <span role="alert" className="text-xs text-destructive" data-testid={`${testId}-error`}>
          {message}
        </span>
      )}
    </div>
  );
}
