import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, FlaskConical, Play, Search } from "lucide-react";
import type {
  IssueGraphLivenessAutoRecoveryPreview,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { SettingsSaveBar } from "@/components/settings/SettingsSaveBar";
import { useSettingsDraft } from "@/hooks/useSettingsDraft";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useCapabilities } from "../hooks/useCapability";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function issueHref(identifier: string | null, issueId: string) {
  if (!identifier) return `/issues/${issueId}`;
  const prefix = identifier.split("-")[0] || "PAP";
  return `/${prefix}/issues/${identifier}`;
}

function formatRecoveryState(state: string) {
  return state.replace(/_/g, " ");
}

function RecoveryPreviewDialog({
  preview,
  open,
  onOpenChange,
  onEnableOnly,
  onEnableAndRun,
  isPending,
}: {
  preview: IssueGraphLivenessAutoRecoveryPreview | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnableOnly: () => void;
  onEnableAndRun: () => void;
  isPending: boolean;
}) {
  const count = preview?.recoverableFindings ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Confirm auto-recovery</DialogTitle>
          <DialogDescription>
            {preview
              ? `${count} recovery ${count === 1 ? "task" : "tasks"} match the last ${preview.lookbackHours} hours.`
              : "Checking recovery candidates before enabling."}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[min(28rem,65vh)] space-y-3 overflow-y-auto pr-1">
          {preview && preview.items.length === 0 ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
              No recovery tasks would be created right now. Auto-recovery can still run for future liveness incidents in
              this window.
            </div>
          ) : null}

          {preview?.items.map((item) => (
            <div key={item.incidentKey} className="rounded-md border border-border bg-card px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={issueHref(item.identifier, item.issueId)}
                  className="text-sm font-medium text-primary underline-offset-2 hover:underline"
                >
                  {item.identifier ?? item.issueId}
                </a>
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {formatRecoveryState(item.state)}
                </span>
              </div>
              <p className="mt-1 text-sm text-foreground">{item.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{item.reason}</p>
              <div className="mt-2 text-xs text-muted-foreground">
                Recovery target:{" "}
                <a
                  href={issueHref(item.recoveryIdentifier, item.recoveryIssueId)}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {item.recoveryIdentifier ?? item.recoveryIssueId}
                </a>
              </div>
            </div>
          ))}
        </div>

        {preview && preview.skippedOutsideLookback > 0 ? (
          <p className="text-xs text-muted-foreground">
            {preview.skippedOutsideLookback} current{" "}
            {preview.skippedOutsideLookback === 1 ? "finding is" : "findings are"} outside the configured lookback and
            will not be touched.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="outline" onClick={onEnableOnly} disabled={isPending || !preview}>
            Enable only
          </Button>
          <Button onClick={onEnableAndRun} disabled={isPending || !preview}>
            {count > 0 ? `Enable and create ${count}` : "Enable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InstanceExperimentalSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  // AgentDash (c3-a11y review): the dev-server section names a real local
  // command — it only makes sense to the person who runs the instance.
  const isInstanceAdmin = useCapabilities(selectedCompanyId).data?.isInstanceAdmin === true;
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [pendingPreview, setPendingPreview] = useState<IssueGraphLivenessAutoRecoveryPreview | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Experimental" },
    ]);
  }, [setBreadcrumbs]);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  // Each section is a draft until its "Save changes", which sends only the
  // changed fields in one request.
  const experimental = experimentalQuery.data;
  const saveExperimental = (patch: PatchInstanceExperimentalSettings) => instanceSettingsApi.updateExperimental(patch);
  const refreshExperimental = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
      queryClient.invalidateQueries({ queryKey: queryKeys.health }),
    ]);
  const environmentsDraft = useSettingsDraft({
    saved: { enableEnvironments: experimental?.enableEnvironments === true },
    save: saveExperimental,
    onSaved: refreshExperimental,
  });
  const workspacesDraft = useSettingsDraft({
    saved: { enableIsolatedWorkspaces: experimental?.enableIsolatedWorkspaces === true },
    save: saveExperimental,
    onSaved: refreshExperimental,
  });
  const devServerDraft = useSettingsDraft({
    saved: { autoRestartDevServerWhenIdle: experimental?.autoRestartDevServerWhenIdle === true },
    save: saveExperimental,
    onSaved: refreshExperimental,
  });
  // Auto-recovery: the switch and the lookback hours (the field's text) save
  // together. Turning it on still goes through the preview below first.
  const recoveryDraft = useSettingsDraft({
    saved: {
      enableIssueGraphLivenessAutoRecovery: experimental?.enableIssueGraphLivenessAutoRecovery === true,
      issueGraphLivenessAutoRecoveryLookbackHours: String(experimental?.issueGraphLivenessAutoRecoveryLookbackHours ?? 24),
    },
    save: (changes) => {
      const patch: PatchInstanceExperimentalSettings = {};
      if (changes.enableIssueGraphLivenessAutoRecovery !== undefined) {
        patch.enableIssueGraphLivenessAutoRecovery = changes.enableIssueGraphLivenessAutoRecovery;
      }
      if (changes.issueGraphLivenessAutoRecoveryLookbackHours !== undefined) {
        patch.issueGraphLivenessAutoRecoveryLookbackHours = Number.parseInt(changes.issueGraphLivenessAutoRecoveryLookbackHours, 10);
      }
      return saveExperimental(patch);
    },
    onSaved: refreshExperimental,
  });

  const previewMutation = useMutation({
    mutationFn: async (lookbackHours: number) =>
      instanceSettingsApi.previewIssueGraphLivenessAutoRecovery({ lookbackHours }),
    onSuccess: (preview) => {
      setActionError(null);
      setPendingPreview(preview);
      setPreviewDialogOpen(true);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to preview recovery tasks.");
    },
  });

  const runRecoveryMutation = useMutation({
    mutationFn: async (lookbackHours: number) =>
      instanceSettingsApi.runIssueGraphLivenessAutoRecovery({ lookbackHours }),
    onSuccess: async () => {
      setActionError(null);
      setPreviewDialogOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to create recovery tasks.");
    },
  });

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading experimental settings...</div>;
  }

  if (experimentalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {experimentalQuery.error instanceof Error
          ? experimentalQuery.error.message
          : "Failed to load experimental settings."}
      </div>
    );
  }

  const { enableEnvironments } = environmentsDraft.values;
  const { enableIsolatedWorkspaces } = workspacesDraft.values;
  const { autoRestartDevServerWhenIdle } = devServerDraft.values;
  const enableIssueGraphLivenessAutoRecovery = recoveryDraft.values.enableIssueGraphLivenessAutoRecovery;
  const lookbackHoursDraft = recoveryDraft.values.issueGraphLivenessAutoRecoveryLookbackHours;
  // What the server has now: "Run now" and the current-window line use these.
  const savedRecoveryEnabled = experimental?.enableIssueGraphLivenessAutoRecovery === true;
  const lookbackHours = experimental?.issueGraphLivenessAutoRecoveryLookbackHours ?? 24;
  const parsedLookbackHours = Number.parseInt(lookbackHoursDraft, 10);
  const lookbackHoursIsValid =
    String(parsedLookbackHours) === lookbackHoursDraft.trim() && parsedLookbackHours >= 1 && parsedLookbackHours <= 720;
  const recoveryActionPending =
    recoveryDraft.isSaving || previewMutation.isPending || runRecoveryMutation.isPending;

  function previewForEnable() {
    if (!lookbackHoursIsValid) {
      setActionError("Lookback hours must be a whole number from 1 to 720.");
      return;
    }
    previewMutation.mutate(parsedLookbackHours);
  }

  // Saving a draft that turns auto-recovery on shows the preview first; the
  // dialog's buttons are what save it. Any other draft saves directly.
  function saveRecovery() {
    if (!lookbackHoursIsValid) return;
    if (recoveryDraft.changes.enableIssueGraphLivenessAutoRecovery === true) {
      previewForEnable();
      return;
    }
    recoveryDraft.save();
  }

  // The dialog's buttons turn auto-recovery on with the hours it previewed,
  // along with anything else in the draft.
  const enableWithPreviewedHours = {
    enableIssueGraphLivenessAutoRecovery: true,
    issueGraphLivenessAutoRecoveryLookbackHours: lookbackHoursDraft,
  };

  function enableOnly() {
    if (!lookbackHoursIsValid) return;
    recoveryDraft.save({ include: enableWithPreviewedHours, onSuccess: () => setPreviewDialogOpen(false) });
  }

  function enableAndRun() {
    if (!lookbackHoursIsValid) return;
    recoveryDraft.save({
      include: enableWithPreviewedHours,
      onSuccess: () => runRecoveryMutation.mutate(parsedLookbackHours),
    });
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Experimental</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Opt into features that are still being evaluated before they become default behavior.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enable Environments</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show environment management in company settings and allow project and agent environment assignment
              controls.
            </p>
          </div>
          <ToggleSwitch
            checked={enableEnvironments}
            onCheckedChange={(checked) => environmentsDraft.set("enableEnvironments", checked)}
            disabled={environmentsDraft.isSaving}
            aria-label="Toggle environments experimental setting"
          />
        </div>
        <div className="mt-4">
          <SettingsSaveBar draft={environmentsDraft} testId="instance-experimental-environments" />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enable Isolated Workspaces</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show execution workspace controls in project configuration and allow isolated workspace behavior for new
              and existing issue runs.
            </p>
          </div>
          <ToggleSwitch
            checked={enableIsolatedWorkspaces}
            onCheckedChange={(checked) => workspacesDraft.set("enableIsolatedWorkspaces", checked)}
            disabled={workspacesDraft.isSaving}
            aria-label="Toggle isolated workspaces experimental setting"
          />
        </div>
        <div className="mt-4">
          <SettingsSaveBar draft={workspacesDraft} testId="instance-experimental-workspaces" />
        </div>
      </section>

      {isInstanceAdmin && (
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">Auto-Restart Dev Server When Idle</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                In <code className="rounded bg-muted px-1 py-0.5">pnpm dev:once</code>, wait for all
                queued and running local agent runs to finish, then restart the server automatically when backend
                changes or migrations make the current boot stale.
              </p>
            </div>
            <ToggleSwitch
              checked={autoRestartDevServerWhenIdle}
              onCheckedChange={(checked) => devServerDraft.set("autoRestartDevServerWhenIdle", checked)}
              disabled={devServerDraft.isSaving}
              aria-label="Toggle guarded dev-server auto-restart"
            />
          </div>
          <div className="mt-4">
            <SettingsSaveBar draft={devServerDraft} testId="instance-experimental-dev-server" />
          </div>
        </section>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">Auto-Create Issue Recovery Tasks</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Let the heartbeat scheduler create recovery issues for issue dependency chains found inside the
                configured lookback window.
              </p>
            </div>
            <ToggleSwitch
              checked={enableIssueGraphLivenessAutoRecovery}
              onCheckedChange={(checked) => recoveryDraft.set("enableIssueGraphLivenessAutoRecovery", checked)}
              disabled={recoveryActionPending}
              aria-label="Toggle issue graph liveness auto-recovery"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(10rem,14rem)_1fr] sm:items-end">
            <label className="space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                Lookback hours
              </span>
              <Input
                type="number"
                min={1}
                max={720}
                step={1}
                value={lookbackHoursDraft}
                aria-label="Lookback hours"
                onChange={(event) => recoveryDraft.set("issueGraphLivenessAutoRecoveryLookbackHours", event.target.value)}
                disabled={recoveryDraft.isSaving}
                aria-invalid={!lookbackHoursIsValid}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={previewForEnable}
                disabled={recoveryActionPending}
              >
                <Search className="h-4 w-4" />
                Preview
              </Button>
              <Button
                // Runs what is saved: the saved switch and the saved hours, not the draft.
                onClick={() => runRecoveryMutation.mutate(lookbackHours)}
                disabled={recoveryActionPending || !savedRecoveryEnabled}
              >
                <Play className="h-4 w-4" />
                Run now
              </Button>
            </div>
          </div>

          {!lookbackHoursIsValid && (
            <p className="text-xs text-destructive">Lookback hours must be a whole number from 1 to 720.</p>
          )}

          <p className="text-xs text-muted-foreground">
            Current window: last {lookbackHours} {lookbackHours === 1 ? "hour" : "hours"}.
          </p>

          <SettingsSaveBar
            draft={recoveryDraft}
            canSave={lookbackHoursIsValid}
            onSave={saveRecovery}
            testId="instance-experimental-recovery"
          />
        </div>
      </section>

      <RecoveryPreviewDialog
        open={previewDialogOpen}
        onOpenChange={setPreviewDialogOpen}
        preview={pendingPreview}
        onEnableOnly={enableOnly}
        onEnableAndRun={enableAndRun}
        isPending={recoveryActionPending}
      />
    </div>
  );
}
