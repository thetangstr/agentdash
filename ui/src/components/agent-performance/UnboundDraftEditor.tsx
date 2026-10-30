import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AGENT_PROFILE_HIRE_INVALID,
  AGENT_ROLES,
  type AgentOperatingProfileV1,
  type AgentProfileRevisionDto,
  type UnboundAgentProfileProposalResult,
} from "@paperclipai/shared";
import { unboundAgentProfilesApi } from "@/api/agent-profiles";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { humanizeAgentRole } from "@/lib/agent-identity";
import { formatDateTime } from "@/lib/utils";
import { ProfileBodyView } from "./ProfileBodyView";
import {
  ProfileAccessField,
  ProfileDraftConflictPanel,
  ProfileDraftProblemPanel,
  ProfileDraftStatus,
  ProfileIdentityFields,
  ProfileKnowledgeFields,
  ProfileResponsibilityFields,
  ProfileRhythmFields,
  ProfileRuntimeFields,
  ProfileStyleFields,
  SELECT_CLASS,
  TextAreaPlain,
  useProfileDraftEditing,
  type ProfileAdapterOption,
} from "./ProfileDraftEditor";
import { apiErrorCode, pointerLabel, refusalText } from "./profile-shared";
import { HIRE_NEEDS_APPROVAL_TEXT, hireIssues } from "./brief-shared";

// AgentDash: Agent Performance Management gate 5 (P5.2) — the draft profile
// for a role nobody holds yet, in DESIGN.md's four steps: Work to own →
// Operating profile → Boundaries and checks → Review plan. The fields are the
// agent draft editor's (same provenance labels, If-Match save and 409
// comparison). All four steps stay mounted, so moving between them never
// loses an edit. Save draft writes the draft and nothing else. Request hire
// files a `hire_agent` approval for the saved draft: it needs approval, and
// nothing starts until it is approved.

export const UNBOUND_DRAFT_INTRO_TEXT =
  "A draft profile for a role nobody holds yet. Saving changes nothing: no agent is hired or started.";

export const UNBOUND_STEPS = [
  {
    key: "work",
    title: "Work to own",
    description: "Work this agent owns: what it is for, each responsibility, and what it delivers.",
  },
  {
    key: "profile",
    title: "Operating profile",
    description: "What it needs and how it works: sources, skills, rhythm, style, and what it would run on.",
  },
  {
    key: "boundaries",
    title: "Boundaries and checks",
    description: "What it may do, what it doesn't own, when to ask, and how we will judge the work.",
  },
  {
    key: "review",
    title: "Review plan",
    description: "Check the whole draft, then request the hire.",
  },
] as const;

const STEP_INDEX: Record<(typeof UNBOUND_STEPS)[number]["key"], number> = { work: 0, profile: 1, boundaries: 2, review: 3 };

const NEW_HIRE_OBLIGATION_HINT =
  "A new hire has no routines yet: use assigned work, a deliverable or a goal, and bind a routine after the hire.";

export interface HireCheck {
  text: string;
  step: number;
}

/** What would make the server refuse the hire (the same rules `prepareUnboundProfileHire` applies). */
export function hireBlockers(body: AgentOperatingProfileV1): HireCheck[] {
  const out: HireCheck[] = [];
  if (!body.runtime?.adapterType) {
    out.push({ text: "Choose the adapter the new agent runs on (Operating profile → Runtime).", step: STEP_INDEX.profile });
  }
  body.responsibilities.forEach((item, index) => {
    if (item.obligation.kind === "routine") {
      out.push({
        text: `“${item.title || `Responsibility ${index + 1}`}” is bound to a routine. ${NEW_HIRE_OBLIGATION_HINT}`,
        step: STEP_INDEX.work,
      });
    }
  });
  return out;
}

/** Facts still missing. They don't block a draft or a hire request, but the people deciding will see them. */
export function profileGaps(body: AgentOperatingProfileV1): HireCheck[] {
  const out: HireCheck[] = [];
  if (!body.identity.summary.trim()) out.push({ text: "What this agent is for (Summary)", step: STEP_INDEX.work });
  if (body.responsibilities.length === 0) out.push({ text: "Any responsibility: the work it owns", step: STEP_INDEX.work });
  body.responsibilities.forEach((item, index) => {
    const name = `“${item.title || `Responsibility ${index + 1}`}”`;
    if (!item.outcome.trim()) out.push({ text: `${name}: its outcome`, step: STEP_INDEX.work });
    if (!item.deliverable.what.trim()) out.push({ text: `${name}: what it delivers`, step: STEP_INDEX.work });
    if (!item.escalation.when.trim()) out.push({ text: `${name}: when to ask`, step: STEP_INDEX.boundaries });
    if (item.performance.criteria.length === 0) out.push({ text: `${name}: how we will judge the work (no criteria yet)`, step: STEP_INDEX.boundaries });
  });
  return out;
}

function SubSection({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3" data-testid={id}>
      <div className="space-y-1">
        <h4 id={`${id}-heading`} className="text-sm font-semibold text-text-primary">
          {title}
        </h4>
        {description ? <p className="text-sm text-text-secondary">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function CheckList({ items, onGo, testId }: { items: HireCheck[]; onGo: (step: number) => void; testId: string }) {
  return (
    <ul className="space-y-1.5" data-testid={testId}>
      {items.map((item) => (
        <li key={item.text} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-primary">
          <span>{item.text}</span>
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => onGo(item.step)}>
            Go to {UNBOUND_STEPS[item.step]!.title}
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function UnboundDraftEditor({
  companyId,
  profileId,
  draft,
  mayPropose,
  adapterOptions,
  sourceIssueId = null,
  onSaved,
  onProposed,
  onStale,
}: {
  companyId: string;
  profileId: string;
  /** The open draft. Read once; later prop changes never reset the person's edits. */
  draft: AgentProfileRevisionDto;
  /** The view's `viewer.canPropose`: false hides Request hire (the server would refuse it). */
  mayPropose: boolean;
  /** Runtimes a hire can name (`runtime.adapterType`). */
  adapterOptions: ProfileAdapterOption[];
  /** The brief's planning issue, linked to the hire approval when the draft was opened from it. */
  sourceIssueId?: string | null;
  onSaved: (saved: AgentProfileRevisionDto) => void;
  onProposed: (result: UnboundAgentProfileProposalResult) => void;
  /** The draft is no longer editable here (proposed elsewhere, or bound to a hired agent). */
  onStale: () => void;
}) {
  const editing = useProfileDraftEditing({
    draft,
    saveDraft: (ifMatch, input) => unboundAgentProfilesApi.saveDraft(companyId, profileId, draft.id, ifMatch, input),
    onSaved,
  });
  const { body, provenance, dirty, jsonBlocked, conflict, savedAt, baseHash, formKey, headingRef, requestSave } = editing;
  const uid = useId();
  const [step, setStep] = useState(0);
  const [stepAnnouncement, setStepAnnouncement] = useState("");
  const [runtimeInitiallyOpen] = useState(() => !draft.body.runtime?.adapterType);
  const [role, setRole] = useState<string>("general");
  const [reason, setReason] = useState("");
  const [expectedBenefit, setExpectedBenefit] = useState("");
  const [risks, setRisks] = useState("");
  const [hireProblem, setHireProblem] = useState<{ text: string; issues: string[]; stale: boolean } | null>(null);
  const stepButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const stepHeadings = useRef<Array<HTMLHeadingElement | null>>([]);
  const focusHeadingOnStep = useRef(false);

  useEffect(() => {
    if (!focusHeadingOnStep.current) return;
    focusHeadingOnStep.current = false;
    stepHeadings.current[step]?.focus();
  }, [step]);

  function goTo(next: number, { focusHeading }: { focusHeading: boolean }) {
    const clamped = Math.max(0, Math.min(UNBOUND_STEPS.length - 1, next));
    focusHeadingOnStep.current = focusHeading && clamped !== step;
    setStep(clamped);
    setStepAnnouncement(`Step ${clamped + 1} of ${UNBOUND_STEPS.length}: ${UNBOUND_STEPS[clamped]!.title}`);
  }

  /** Arrow keys, Home and End move between the step buttons; Enter or Space opens one. */
  function onStepKeyDown(event: KeyboardEvent<HTMLOListElement>) {
    const current = stepButtons.current.findIndex((node) => node === document.activeElement);
    if (current < 0) return;
    let target: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") target = (current + 1) % UNBOUND_STEPS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = (current - 1 + UNBOUND_STEPS.length) % UNBOUND_STEPS.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = UNBOUND_STEPS.length - 1;
    if (target === null) return;
    event.preventDefault();
    stepButtons.current[target]?.focus();
  }

  const blockers = hireBlockers(body);
  const gaps = profileGaps(body);
  const canRequestHire = !dirty && !jsonBlocked && !conflict && blockers.length === 0;

  const propose = useMutation({
    mutationFn: () =>
      unboundAgentProfilesApi.propose(companyId, profileId, draft.id, {
        role: role as (typeof AGENT_ROLES)[number],
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(expectedBenefit.trim() ? { expectedBenefit: expectedBenefit.trim() } : {}),
        ...(risks.trim() ? { risks: risks.trim() } : {}),
        ...(sourceIssueId ? { sourceIssueId } : {}),
      }),
    onSuccess: (result) => {
      setHireProblem(null);
      onProposed(result);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 422 && apiErrorCode(error) === AGENT_PROFILE_HIRE_INVALID) {
        setHireProblem({
          text: "This draft can't be filed as a hire yet. Nothing was requested.",
          issues: hireIssues(error).map(
            (issue) => `${issue.pointer ? pointerLabel(issue.pointer, body) : issue.path || "(top level)"}: ${issue.message}`,
          ),
          stale: false,
        });
        return;
      }
      const stale = error instanceof ApiError && error.status === 409;
      setHireProblem({
        text: `${refusalText("request the hire", error)} Nothing was requested.`,
        issues: [],
        stale,
      });
    },
  });

  function requestHire() {
    if (propose.isPending || !canRequestHire) return;
    propose.mutate();
  }

  const requestHireHintId = `${uid}-request-hire-hint`;
  const stepTitleId = (index: number) => `${uid}-step-${UNBOUND_STEPS[index]!.key}-heading`;

  function stepContent(index: number): ReactNode {
    switch (UNBOUND_STEPS[index]!.key) {
      case "work":
        return (
          <>
            <ProfileIdentityFields editing={editing} />
            <ProfileResponsibilityFields editing={editing} mode="work" obligationHint={NEW_HIRE_OBLIGATION_HINT} />
          </>
        );
      case "profile":
        return (
          <>
            <SubSection id="unbound-profile-needs" title="What it needs" description="Sources it should use, and the skills it knows how to use.">
              <ProfileKnowledgeFields editing={editing} />
            </SubSection>
            <SubSection id="unbound-profile-rhythm" title="How it works" description="Its rhythm and who it reports to.">
              <ProfileRhythmFields editing={editing} />
            </SubSection>
            <SubSection id="unbound-profile-style" title="Style" description="How it communicates.">
              <ProfileStyleFields editing={editing} />
            </SubSection>
            <ProfileRuntimeFields
              editing={editing}
              adapterOptions={adapterOptions}
              defaultOpen={runtimeInitiallyOpen}
              intro="A hire request needs the adapter the new agent runs on. These run on the host, so a company admin decides them when approving the hire."
            />
          </>
        );
      case "boundaries":
        return (
          <>
            <SubSection id="unbound-boundaries-access" title="What it may do" description="The access it asks for. Asking is not having: an admin's ceiling still limits it.">
              <ProfileAccessField editing={editing} />
            </SubSection>
            <SubSection id="unbound-boundaries-checks" title="When to ask, and how we will judge the work">
              <ProfileResponsibilityFields editing={editing} mode="boundaries" />
            </SubSection>
          </>
        );
      case "review":
        return (
          <div className="space-y-6">
            {dirty ? (
              <p className="text-sm text-text-primary" data-testid="unbound-review-unsaved">
                You have unsaved changes. Save the draft first: a hire is requested for what was saved.
              </p>
            ) : null}
            <SubSection id="unbound-review-blockers" title="Before a hire can be requested">
              {blockers.length === 0 ? (
                <p className="text-sm text-text-secondary">Nothing blocks a hire request.</p>
              ) : (
                <CheckList items={blockers} onGo={(target) => goTo(target, { focusHeading: true })} testId="unbound-review-blockers-list" />
              )}
            </SubSection>
            <SubSection
              id="unbound-review-gaps"
              title="Still missing"
              description="These don't block the draft or the request. The people deciding will see them as missing."
            >
              {gaps.length === 0 ? (
                <p className="text-sm text-text-secondary">Nothing obvious is missing.</p>
              ) : (
                <CheckList items={gaps} onGo={(target) => goTo(target, { focusHeading: true })} testId="unbound-review-gaps-list" />
              )}
            </SubSection>
            <SubSection id="unbound-review-plan" title="The plan as it stands">
              <ProfileBodyView body={body} provenance={provenance} testId="unbound-review-body" />
            </SubSection>
            {mayPropose ? (
              <SubSection id="unbound-review-hire" title="Request hire" description={HIRE_NEEDS_APPROVAL_TEXT}>
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-role`}>Role</Label>
                  <select id={`${uid}-role`} className={SELECT_CLASS} value={role} onChange={(event) => setRole(event.target.value)}>
                    {AGENT_ROLES.map((value) => (
                      <option key={value} value={value}>
                        {humanizeAgentRole(value)}
                      </option>
                    ))}
                  </select>
                </div>
                <TextAreaPlain label="Why this role" value={reason} onChange={setReason} />
                <TextAreaPlain label="What it should improve" value={expectedBenefit} onChange={setExpectedBenefit} />
                <TextAreaPlain label="Risks" value={risks} onChange={setRisks} />
                <p className="text-sm text-text-secondary">
                  Requesting the hire freezes the saved draft and sends it to the people who can approve hires. The new agent
                  isn't created as a working agent, and nothing runs, until a person approves it.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    onClick={requestHire}
                    aria-disabled={!canRequestHire || propose.isPending}
                    aria-describedby={!canRequestHire ? requestHireHintId : undefined}
                    data-testid="unbound-request-hire"
                  >
                    {propose.isPending ? "Requesting…" : "Request hire"}
                  </Button>
                </div>
                {!canRequestHire ? (
                  <p id={requestHireHintId} className="text-xs text-text-secondary" data-testid="unbound-request-hire-hint">
                    {dirty || jsonBlocked || conflict
                      ? "Save the draft first: a hire is requested for what was saved."
                      : "Fix what blocks a hire request (listed above) and save the draft."}
                  </p>
                ) : null}
                {hireProblem ? (
                  <div role="alert" className="space-y-2 rounded-md border border-danger-500/30 px-3 py-2 text-sm" data-testid="unbound-hire-error">
                    <p className="text-text-primary">{hireProblem.text}</p>
                    {hireProblem.issues.length > 0 ? (
                      <ul className="list-disc space-y-0.5 pl-5 text-text-secondary">
                        {hireProblem.issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    ) : null}
                    {hireProblem.stale ? (
                      <Button type="button" size="sm" variant="outline" onClick={onStale}>
                        Reload the draft
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </SubSection>
            ) : (
              <p className="text-sm text-text-secondary" data-testid="unbound-review-no-hire">
                Only an administrator who can create agents can request this hire. {HIRE_NEEDS_APPROVAL_TEXT}
              </p>
            )}
          </div>
        );
    }
  }

  return (
    <section aria-labelledby={`${uid}-heading`} className="space-y-6" data-testid="unbound-draft-editor">
      <div className="space-y-1">
        <h2
          id={`${uid}-heading`}
          ref={headingRef}
          tabIndex={-1}
          className="text-base font-semibold text-text-primary focus-visible:outline-none"
        >
          Draft revision {draft.revisionNumber}
        </h2>
        <p className="text-sm text-text-secondary">{UNBOUND_DRAFT_INTRO_TEXT}</p>
        <p className="text-xs text-text-secondary">
          Last saved {formatDateTime(savedAt)}. {dirty ? "You have unsaved changes." : "No unsaved changes."}
        </p>
      </div>

      <nav aria-label="Draft steps">
        <ol className="flex flex-wrap gap-2" onKeyDown={onStepKeyDown} data-testid="unbound-steps">
          {UNBOUND_STEPS.map((item, index) => (
            <li key={item.key}>
              <Button
                type="button"
                size="sm"
                variant={index === step ? "default" : "outline"}
                aria-current={index === step ? "step" : undefined}
                ref={(node) => {
                  stepButtons.current[index] = node;
                }}
                onClick={() => goTo(index, { focusHeading: false })}
                data-testid={`unbound-step-${item.key}`}
              >
                Step {index + 1}: {item.title}
              </Button>
            </li>
          ))}
        </ol>
      </nav>
      <p role="status" aria-live="polite" className="sr-only" data-testid="unbound-step-status">
        {stepAnnouncement}
      </p>

      <form
        key={formKey}
        className="space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          requestSave(baseHash);
        }}
      >
        {UNBOUND_STEPS.map((item, index) => (
          <section
            key={item.key}
            hidden={index !== step}
            aria-labelledby={stepTitleId(index)}
            className="space-y-4"
            data-testid={`unbound-step-panel-${item.key}`}
          >
            <div className="space-y-1">
              <h3
                id={stepTitleId(index)}
                ref={(node) => {
                  stepHeadings.current[index] = node;
                }}
                tabIndex={-1}
                className="text-base font-semibold text-text-primary focus-visible:outline-none"
              >
                Step {index + 1} of {UNBOUND_STEPS.length}: {item.title}
              </h3>
              <p className="text-sm text-text-secondary">{item.description}</p>
            </div>
            {stepContent(index)}
          </section>
        ))}

        <ProfileDraftConflictPanel editing={editing} />
        <ProfileDraftProblemPanel editing={editing} onStale={onStale} />

        <div className="sticky bottom-0 z-10 space-y-2 border-t border-border-soft bg-surface-page py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" aria-disabled={editing.savePending} data-testid="agent-profile-save">
              {editing.savePending ? "Saving…" : "Save draft"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => goTo(step - 1, { focusHeading: true })}
              aria-disabled={step === 0}
              data-testid="unbound-step-back"
            >
              Back
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => goTo(step + 1, { focusHeading: true })}
              aria-disabled={step === UNBOUND_STEPS.length - 1}
              data-testid="unbound-step-next"
            >
              Next
            </Button>
            <Button variant="ghost" asChild>
              <a
                href={unboundAgentProfilesApi.exportMarkdownUrl(companyId, profileId, draft.id)}
                download={`draft-profile-revision-${draft.revisionNumber}.md`}
                data-testid="unbound-export-markdown"
              >
                Export Markdown (saved draft)
              </a>
            </Button>
          </div>
          <ProfileDraftStatus editing={editing} />
        </div>
      </form>
    </section>
  );
}
