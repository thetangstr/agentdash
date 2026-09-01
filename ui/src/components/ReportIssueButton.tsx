// AgentDash: a persistent "Report an issue" affordance, so anyone using the
// board can file a bug or feature request without leaving it and without a
// GitHub account. Self-contained on purpose — button and dialog live
// together so mounting it costs Layout a single line.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bug, ExternalLink, Lightbulb, MessageSquarePlus } from "lucide-react";
import { useLocation } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { issueReportsApi, type CreatedIssueReport, type IssueReportKind } from "../api/issueReports";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const MAX_TITLE = 160;
const MIN_TITLE = 3;
const MIN_DESCRIPTION = 10;

const KIND_COPY: Record<IssueReportKind, { label: string; hint: string; icon: typeof Bug }> = {
  bug: {
    label: "Bug",
    hint: "What did you do, what happened, and what did you expect instead?",
    icon: Bug,
  },
  feature: {
    label: "Feature request",
    hint: "What are you trying to get done, and what would help you do it?",
    icon: Lightbulb,
  },
};

export function ReportIssueButton() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<IssueReportKind>("bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [filed, setFiled] = useState<CreatedIssueReport | null>(null);
  const { selectedCompanyId } = useCompany();
  const location = useLocation();

  // Hide the button entirely on instances with no GitHub credential. An
  // action that can only fail is worse than no action at all.
  const { data: config } = useQuery({
    queryKey: queryKeys.issueReports.config,
    queryFn: () => issueReportsApi.getConfig(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const fileReport = useMutation({
    mutationFn: () =>
      issueReportsApi.create({
        kind,
        title: title.trim(),
        description: description.trim(),
        ...(selectedCompanyId ? { companyId: selectedCompanyId } : {}),
        pageUrl: location.pathname,
      }),
    onSuccess: (created) => setFiled(created),
  });

  // Reset on close so the next report starts clean rather than resurrecting
  // the last one — including a stale success state.
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => {
      setKind("bug");
      setTitle("");
      setDescription("");
      setFiled(null);
      fileReport.reset();
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!config?.enabled) return null;

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const canSubmit =
    trimmedTitle.length >= MIN_TITLE &&
    trimmedDescription.length >= MIN_DESCRIPTION &&
    !fileReport.isPending;

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        title="Report a bug or request a feature"
      >
        <MessageSquarePlus className="size-3.5" />
        <span className="hidden sm:inline">Report an issue</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          {filed ? (
            <>
              <DialogHeader>
                <DialogTitle>Thanks — that's filed</DialogTitle>
                <DialogDescription>
                  It's in the team's queue as issue #{filed.number}. You can follow it on GitHub.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <Button asChild>
                  <a href={filed.url} target="_blank" rel="noreferrer noopener">
                    View issue #{filed.number}
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Report an issue</DialogTitle>
                <DialogDescription>
                  Goes straight to the team's queue
                  {config.repo ? ` (${config.repo})` : ""}. Your name and the page you're on are
                  attached automatically.
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label>Type</Label>
                  <div className="flex gap-2">
                    {(Object.keys(KIND_COPY) as IssueReportKind[]).map((value) => {
                      const { label, icon: Icon } = KIND_COPY[value];
                      const active = kind === value;
                      return (
                        <Button
                          key={value}
                          type="button"
                          variant={active ? "default" : "outline"}
                          size="sm"
                          aria-pressed={active}
                          onClick={() => setKind(value)}
                          className={cn(!active && "text-text-secondary")}
                        >
                          <Icon className="size-3.5" />
                          {label}
                        </Button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="issue-report-title">Title</Label>
                  <Input
                    id="issue-report-title"
                    value={title}
                    maxLength={MAX_TITLE}
                    placeholder={
                      kind === "bug" ? "Dragging a card drops it on the wrong column" : "Let me filter the board by agent"
                    }
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="issue-report-description">Details</Label>
                  <Textarea
                    id="issue-report-description"
                    value={description}
                    rows={6}
                    placeholder={KIND_COPY[kind].hint}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>

                {fileReport.isError ? (
                  <p role="alert" className="text-sm text-danger-500">
                    {fileReport.error instanceof Error
                      ? fileReport.error.message
                      : "Could not file that. Please try again."}
                  </p>
                ) : null}
              </div>

              <DialogFooter>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button disabled={!canSubmit} onClick={() => fileReport.mutate()}>
                  {fileReport.isPending ? "Filing…" : "File it"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
