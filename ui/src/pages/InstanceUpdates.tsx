import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OtaCompatibilityVerdict, OtaUpdateStatus } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { otaApi } from "@/api/ota";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Instance updates.
 *
 * The design rule for this page: never let it look more certain than the server
 * is. `canApply` and `blockedReasons` come from the server and are rendered
 * verbatim rather than re-derived here, because a button that offers an update
 * the updater will refuse is worse than no button.
 *
 * Two things are shown even though they are unflattering, because hiding them
 * would make this page a liar: that release signatures are not verified, and
 * that a release carrying a migration cannot be rolled back by code alone.
 */

const VERDICT_LABEL: Record<OtaCompatibilityVerdict, string> = {
  compatible: "No database changes",
  needs_migration: "Reversible database changes",
  forward_only: "One-way database changes",
  unknown: "Database impact unknown",
};

function verdictVariant(verdict: OtaCompatibilityVerdict): "secondary" | "destructive" | "outline" {
  if (verdict === "compatible") return "secondary";
  if (verdict === "unknown") return "destructive";
  return "outline";
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 py-3 last:border-b-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

function InstalledCard({ status }: { status: OtaUpdateStatus }) {
  const { installed } = status;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Currently running</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Row label="Version" value={installed.version ?? installed.tag ?? "unreleased build"} />
        <Row
          label="Commit"
          value={<code className="font-mono text-xs">{installed.commit.slice(0, 12) || "unknown"}</code>}
        />
        <Row label="Channel" value={status.channel} />
        <Row
          label="Serving from"
          value={
            status.servingFromReleaseDir ? (
              <span>immutable release</span>
            ) : (
              <span className="text-destructive">a developer checkout — not updatable</span>
            )
          }
        />
      </CardContent>
    </Card>
  );
}

function CompatibilityCard({ status }: { status: OtaUpdateStatus }) {
  const { compatibility, rollback } = status;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">Database compatibility</CardTitle>
        <Badge variant={verdictVariant(compatibility.verdict)}>
          {VERDICT_LABEL[compatibility.verdict]}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {compatibility.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>

        {compatibility.pendingMigrations.length > 0 && (
          <div className="rounded-md border border-border/60 p-3">
            <p className="mb-2 text-xs font-medium text-foreground">
              {compatibility.pendingMigrations.length} migration
              {compatibility.pendingMigrations.length === 1 ? "" : "s"} would run
            </p>
            <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
              {compatibility.pendingMigrations.map((migration) => (
                <li key={migration.id}>{migration.name}</li>
              ))}
            </ul>
          </div>
        )}

        {/* The honest, unflattering half. Shown before the button, not after. */}
        <div className="rounded-md border border-border/60 bg-muted/40 p-3">
          <p className="text-xs font-medium text-foreground">If this update goes wrong</p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
            {rollback.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
          {rollback.requiresDatabaseRestore && (
            <p className="mt-2 text-xs font-medium text-destructive">
              Rolling this back needs a database restore. {rollback.dataLossWindow}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AvailableCard({ status }: { status: OtaUpdateStatus }) {
  const { available, diff } = status;
  if (!available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Available update</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 text-sm text-muted-foreground">
          {status.upToDate
            ? "This instance is on the newest release."
            : "No release information yet. The update check has not run."}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">Available update</CardTitle>
        <Badge variant="secondary">{available.version}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-0">
        <div>
          <Row
            label="Commit"
            value={<code className="font-mono text-xs">{available.commit.slice(0, 12)}</code>}
          />
          <Row label="Published" value={available.publishedAt ?? "unknown"} />
          {diff && (
            <Row
              label="Changes"
              value={`${diff.commitCount} commits · ${diff.filesChanged} files · +${diff.insertions}/−${diff.deletions}`}
            />
          )}
        </div>

        {available.notes && (
          <div>
            <p className="mb-2 text-xs font-medium text-foreground">Release notes</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 p-3 text-xs text-muted-foreground">
              {available.notes}
            </pre>
          </div>
        )}

        {diff && diff.commitSubjects.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-foreground">What changed</p>
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {diff.commitSubjects.map((subject, index) => (
                <li key={`${index}-${subject}`} className="truncate">
                  {subject}
                </li>
              ))}
              {diff.truncated && <li className="italic">…and more, see the full release notes</li>}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function InstanceUpdates() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const {
    data: status,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.otaStatus,
    queryFn: () => otaApi.getStatus(),
    // The status reflects the last update check, not live upstream state, so
    // polling hard would only re-read the same file.
    refetchInterval: 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.otaStatus });

  const approve = useMutation({
    mutationFn: async () => {
      if (!status?.available) throw new Error("No release available to approve.");
      const requested = await otaApi.requestApproval({
        tag: status.available.tag,
        commit: status.available.commit,
      });
      return otaApi.decide(requested.approval.id, "approved");
    },
    onSuccess: async () => {
      setConfirming(false);
      await invalidate();
    },
  });

  const withdraw = useMutation({
    mutationFn: async (approvalId: string) => otaApi.withdraw(approvalId),
    onSuccess: invalidate,
  });

  if (isLoading) {
    return <div className="mx-auto w-full max-w-4xl px-6 py-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (error || !status) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-6 text-sm text-destructive">
        Could not read update status. {error instanceof Error ? error.message : ""}
      </div>
    );
  }

  const approved = status.approval?.status === "approved";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-foreground">Instance updates</h1>
        <p className="text-sm text-muted-foreground">
          Updating replaces the code this instance runs. Only an instance administrator can approve one.
        </p>
      </div>

      <InstalledCard status={status} />
      <AvailableCard status={status} />
      <CompatibilityCard status={status} />

      {/* Deliberately not hidden behind a disclosure. Someone approving a code
          change on their own hardware is entitled to know provenance is unsigned. */}
      <div className="rounded-md border border-border/60 bg-muted/40 p-3">
        <p className="text-xs font-medium text-foreground">Release signatures are not verified</p>
        <p className="mt-1 text-xs text-muted-foreground">
          This instance checks that a release is a tagged commit on the project&apos;s main branch. It does not
          verify who signed it, so a compromised upstream push would not be detected here. Signature
          verification is planned and does not exist yet.
        </p>
      </div>

      {status.approval && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <CardTitle className="text-base">Approval</CardTitle>
            <Badge variant={approved ? "secondary" : "outline"}>{status.approval.status}</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pt-0">
            <Row label="Release" value={status.approval.tag} />
            <Row
              label="Commit"
              value={<code className="font-mono text-xs">{status.approval.commit.slice(0, 12)}</code>}
            />
            <Row label="Decided" value={status.approval.decidedAt ?? "not yet"} />
            {approved && (
              <p className="text-xs text-muted-foreground">
                Approved. The update runs on the next scheduled update pass; this page will show the result.
              </p>
            )}
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => withdraw.mutate(status.approval!.id)}
                disabled={withdraw.isPending}
              >
                {withdraw.isPending ? "Withdrawing…" : "Withdraw approval"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {status.blockedReasons.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not ready to update</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
              {status.blockedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <Button
          onClick={() => setConfirming(true)}
          disabled={!status.available || status.upToDate || approved || approve.isPending || !status.canApply}
        >
          Update this instance
        </Button>
        {approve.error && (
          <span className="text-sm text-destructive">
            {approve.error instanceof Error ? approve.error.message : "Could not approve."}
          </span>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update to {status.available?.version}?</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm">
                <span>
                  This records your approval. The update is applied by the host&apos;s update process, which
                  takes a backup first, switches to the new release, restarts, and checks health.
                </span>
                <span>
                  {status.rollback.codeOnly
                    ? "If health does not come back, it returns to the current release automatically."
                    : "If health does not come back it returns to the current release automatically, but that restores code only — the database changes in this release are not undone by it."}
                </span>
                <span className="text-muted-foreground">Release signatures are not verified.</span>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={approve.isPending}>
              Cancel
            </Button>
            <Button onClick={() => approve.mutate()} disabled={approve.isPending}>
              {approve.isPending ? "Approving…" : "Approve this update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default InstanceUpdates;
