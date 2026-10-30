import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { AgentProfileApplicationDto } from "@paperclipai/shared";
import { agentProfilesApi, type ResumeAgentProfileApplicationResult } from "@/api/agent-profiles";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import { Section, StateBadge } from "./shared";
import {
  APPLICATION_STATUS_TEXT,
  APPLICATION_STEP_STATUS_TEXT,
  APPLICATION_STEP_TEXT,
  refusalText,
} from "./profile-shared";

// AgentDash: Agent Performance Management gate 2 — the newest application
// receipt: each step and its result, why it stopped, and Resume when the
// application can be resumed and the view's `viewer.canResumeApplication`
// says the resume route's guard (the approver or an admin) lets the viewer.
// A refusal the server still makes is shown as written.

/**
 * Resumable: failed at a step (not on a stale base or a lost authority, which
 * end the application), or `in_progress` past its lease (the server says it
 * no longer holds the agent).
 */
export function isResumable(application: AgentProfileApplicationDto, applicationInProgress: boolean): boolean {
  if (application.status === "failed") return application.failure?.kind === "step";
  if (application.status === "in_progress") return !applicationInProgress;
  return false;
}

export function ProfileApplicationStatus({
  companyId,
  agentId,
  application,
  applicationInProgress,
  canResume,
  onResumed,
}: {
  companyId: string;
  agentId: string;
  application: AgentProfileApplicationDto;
  applicationInProgress: boolean;
  /** The view's `viewer.canResumeApplication`. */
  canResume: boolean;
  onResumed: (result: ResumeAgentProfileApplicationResult) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const resume = useMutation({
    mutationFn: () => agentProfilesApi.resumeApplication(companyId, agentId, application.id),
    onSuccess: (result) => {
      setProblem(null);
      onResumed(result);
    },
    onError: (error) => setProblem(refusalText("resume this application", error)),
  });
  const interrupted = application.status === "in_progress" && !applicationInProgress;
  const statusText = interrupted ? "Interrupted: it stopped before finishing" : APPLICATION_STATUS_TEXT[application.status];
  const resumable = isResumable(application, applicationInProgress);

  return (
    <Section
      id="agent-profile-application"
      title="Applying the approved change"
      description={`Started ${formatDateTime(application.createdAt)}; last update ${formatDateTime(application.updatedAt)}.`}
    >
      <div className="flex flex-wrap gap-1.5">
        <StateBadge
          label="Application"
          value={statusText}
          tone={application.status === "failed" || application.status === "refused_stale" || interrupted ? "problem" : "neutral"}
        />
      </div>
      {application.failure ? (
        <p className="text-sm text-text-primary" data-testid="agent-profile-application-failure">
          {application.failure.detail}
        </p>
      ) : null}
      <ol className="space-y-1.5" data-testid="agent-profile-application-steps">
        {application.steps.map((step, index) => (
          <li key={step.step} className="rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="agent-profile-application-step">
            <p className="text-text-primary">
              <span className="text-text-secondary">Step {index + 1}.</span> {APPLICATION_STEP_TEXT[step.step]}:{" "}
              <span className="font-medium">{APPLICATION_STEP_STATUS_TEXT[step.status]}</span>
              {step.completedAt ? <span className="text-text-secondary"> · {formatDateTime(step.completedAt)}</span> : null}
            </p>
            {step.error ? <p className="mt-0.5 text-text-secondary">{step.error}</p> : null}
          </li>
        ))}
      </ol>
      {application.status === "refused_stale" || application.failure?.kind === "authority" ? (
        <p className="text-sm text-text-secondary">This application has ended. Start a new draft from the active profile.</p>
      ) : null}
      {resumable && !canResume ? (
        <p className="text-sm text-text-secondary" data-testid="agent-profile-resume-not-yours">
          It can be resumed by the person who approved it or a company admin.
        </p>
      ) : null}
      {resumable && canResume ? (
        <div className="space-y-1">
          <Button
            type="button"
            size="sm"
            aria-disabled={resume.isPending}
            onClick={() => !resume.isPending && resume.mutate()}
            data-testid="agent-profile-resume"
          >
            {resume.isPending ? "Resuming…" : "Resume application"}
          </Button>
          <p className="text-xs text-text-secondary">
            Only the approver or a company admin can resume. It re-checks that nothing changed, then continues from the first
            unfinished step.
          </p>
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="text-sm text-text-primary" data-testid="agent-profile-resume-error">
          {problem}
        </p>
      ) : null}
    </Section>
  );
}
