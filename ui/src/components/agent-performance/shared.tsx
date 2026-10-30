import type { ReactNode } from "react";
import { Info } from "lucide-react";
import type { AgentProjectionCount, DerivedProvenance } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { cn, formatDateTime } from "@/lib/utils";

// AgentDash: Agent Performance Management gate 1 — shared pieces for the
// Profile, Access and Performance tabs. Every state is written out as text
// (never colour alone), unknown is "Unknown" (never 0), and nothing here is a
// control that changes the agent.

/** The 403 text for the Access and Performance views (gate 1 build spec, "States"). */
export const RESTRICTED_VIEW_TEXT =
  "Only the agent's accountable person, its steward and company admins can see this.";

export function isForbiddenError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The server did not say why.";
}

/**
 * Loading, refused and failed states for one view. Returns null once data is
 * in hand, so the caller renders the view. `restricted` turns a 403 into the
 * plain "who can see this" explanation instead of a raw error.
 */
export function ViewStatus({
  what,
  isLoading,
  error,
  restricted = false,
}: {
  /** Plain name of the view, e.g. "access". */
  what: string;
  isLoading: boolean;
  error: unknown;
  restricted?: boolean;
}) {
  if (error) {
    if (restricted && isForbiddenError(error)) {
      return (
        <p className="max-w-3xl text-sm text-text-secondary" data-testid="agent-pm-restricted">
          {RESTRICTED_VIEW_TEXT}
        </p>
      );
    }
    return (
      <div
        role="alert"
        className="max-w-3xl rounded-md border border-danger-500/30 px-3 py-2 text-sm text-text-primary"
        data-testid="agent-pm-error"
      >
        <p className="font-medium">Couldn't load this agent's {what}.</p>
        <p className="mt-1 text-text-secondary">{errorMessage(error)}</p>
      </div>
    );
  }
  if (isLoading) {
    return (
      <p role="status" className="text-sm text-text-secondary" data-testid="agent-pm-loading">
        Loading {what}…
      </p>
    );
  }
  return null;
}

/** A standing explanation at the top of a view. Not dismissible; not a toast. */
export function Banner({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      className="flex max-w-3xl items-start gap-2 rounded-md border border-border-soft bg-surface-sunken px-3 py-2 text-sm text-text-secondary"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

/** A titled block. Headings are real headings so screen readers can jump between them. */
export function Section({
  id,
  title,
  description,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className={cn("space-y-3", className)} data-testid={id}>
      <div className="space-y-1">
        <h3 id={headingId} className="text-base font-semibold text-text-primary">
          {title}
        </h3>
        {description ? <p className="text-sm text-text-secondary">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Plain text for an empty block. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-secondary">{children}</p>;
}

/** A text badge for one state. The label always names what the state is about. */
export function StateBadge({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "problem";
}) {
  return (
    <Badge variant={tone === "problem" ? "destructive" : "outline"} className="whitespace-normal text-left">
      <span className="font-normal text-text-secondary">{label}:</span> {value}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Plain wording for a derived field's `source`. The contract's examples are
 * `agent.title`, `plan_card:<cardId>`, `workforce_enrollment` and
 * `routine:<id>`; anything else is shown as written.
 */
export function describeSource(source: string): string {
  const colon = source.indexOf(":");
  const prefix = colon === -1 ? source : source.slice(0, colon);
  const ref = colon === -1 ? "" : source.slice(colon + 1);
  const shortRef = ref ? ` ${ref.slice(0, 8)}` : "";
  switch (prefix) {
    case "plan_card":
      return `the confirmed plan card${shortRef}`;
    case "workforce_enrollment":
      return "the workforce enrollment";
    case "routine":
      return `routine${shortRef}`;
    default:
      break;
  }
  if (source.startsWith("agent.")) return `the agent record (${source.slice("agent.".length)})`;
  return source;
}

export function provenanceText(provenance: DerivedProvenance, source: string | null): string {
  if (provenance === "missing" || !source) return "Missing";
  return `Proposed — from ${describeSource(source)}`;
}

export function ProvenanceLabel({ provenance, source }: { provenance: DerivedProvenance; source: string | null }) {
  const text = provenanceText(provenance, source);
  return (
    <Badge variant="secondary" className="whitespace-normal text-left" data-testid="agent-pm-provenance">
      {text}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/** "3 of 10", or "Unknown" plus its note when the count has no source. Never 0 for unknown. */
export function CountValue({ count, unit }: { count: AgentProjectionCount; unit?: string }) {
  if (count.value === null) {
    return (
      <span data-testid="agent-pm-unknown">
        <span className="font-medium text-text-primary">Unknown</span>
        {count.note ? <span className="text-text-secondary"> — {count.note}</span> : null}
      </span>
    );
  }
  return (
    <span>
      <span className="font-medium tabular-nums text-text-primary">{count.value}</span>
      {count.of != null ? <span className="text-text-secondary"> of {count.of}</span> : null}
      {unit ? <span className="text-text-secondary"> {unit}</span> : null}
      {count.note ? <span className="text-text-secondary"> — {count.note}</span> : null}
    </span>
  );
}

/** A labelled list of facts: label on the left, value on the right; stacks on narrow screens. */
export function FactList({ children }: { children: ReactNode }) {
  return <dl className="divide-y divide-border-soft rounded-md border border-border-soft">{children}</dl>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[minmax(10rem,14rem)_1fr] sm:gap-3">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0 break-words text-text-primary">{children}</dd>
    </div>
  );
}

export function GapList({
  id,
  gaps,
  emptyText = "No gaps reported.",
}: {
  id: string;
  gaps: ReadonlyArray<{ code: string; message: string }>;
  emptyText?: string;
}) {
  return (
    <Section id={id} title="Gaps" description="What today's records can't show or don't check yet.">
      {gaps.length === 0 ? (
        <EmptyNote>{emptyText}</EmptyNote>
      ) : (
        <ul className="space-y-2">
          {gaps.map((gap, index) => (
            <li key={`${gap.code}-${index}`} className="rounded-md border border-border-soft px-3 py-2 text-sm">
              <p className="text-text-primary">{gap.message}</p>
              <p className="mt-0.5 font-mono text-xs text-text-secondary">{gap.code}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Refusal codes
// ---------------------------------------------------------------------------

/**
 * Plain wording for refusal codes: an `authz.refused` reason code, or the
 * refusing action's name (`connector_send.refused`, ...). Unmapped codes are
 * shown as written; the raw code is always shown beside the wording.
 */
const REFUSAL_CODE_TEXT: Record<string, string> = {
  // AgentDash (APM gate 3): an enforced refusal by the agent's own access rules.
  ACCESS_POLICY_REFUSED: "Refused by its access rules",
  AGENT_CROSS_COMPANY: "Tried to reach another company",
  BOARD_ACCESS_REQUIRED: "Needed a person's board access",
  BOARD_ORG_ACCESS_REQUIRED: "Needed a person's board access",
  COMPANY_ACCESS_DENIED: "No access to the company",
  COMPANY_MEMBERSHIP_INACTIVE: "Company membership is inactive",
  COMPANY_ADMINISTRATOR_REQUIRED: "Needed a company admin",
  COMPANY_DIRECTION_ADMIN_REQUIRED: "Needed a company admin",
  INSTANCE_ADMIN_REQUIRED: "Needed an instance admin",
  ISSUE_MUTATION_OTHER_AGENT: "Tried to change another agent's issue",
  NOT_ASSIGNEE: "Not the issue's assignee",
  AGENT_DIRECTION_FORBIDDEN: "Not allowed to direct that agent",
  EVALUATOR_READ_ONLY: "Evaluators are read-only",
  UNSPECIFIED: "Refused, reason not recorded",
  "connector_send.refused": "A connector send was refused",
  "issue.agent_handoff_refused": "A handoff to another agent was refused",
};

export function refusalCodeText(code: string): string {
  const text = REFUSAL_CODE_TEXT[code];
  return text ? `${text} (${code})` : code;
}

/** Codes sorted by count, most first; ties alphabetical. */
export function sortedRefusalCodes(byCode: Record<string, number>): Array<[string, number]> {
  return Object.entries(byCode).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function formatWindow(window: { from: string; to: string }): string {
  return `${formatDateTime(window.from)} – ${formatDateTime(window.to)}`;
}
