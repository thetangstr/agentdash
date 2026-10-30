import type { ReactNode } from "react";
import type {
  AgentProfileAccessChange,
  AgentProfileChangePayload,
  AgentProfileDiffEntry,
  AgentProfileFieldAuthorityEntry,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { FIELD_AUTHORITY_TEXT, ProfileDiffList } from "./profile-shared";
import { ManagerFiledBadge, PERFORMANCE_MANAGER_ADVISORY_TEXT, isManagerFiledPayload } from "./manager-shared";

// AgentDash: Agent Performance Management gate 2 — the `agent_profile_change`
// approval renderer (overview LLD §4.1, §6): what changes field by field and
// who may decide each field (with the reason, not just the class), access
// that widens or is clipped by the ceiling, the evidence, and what applying
// will change. An approval is a decision, not an application: it says so.
// The payload is read defensively — a missing list renders as empty, never
// as a crash or raw JSON.
// Gate 4: a proposal the company's performance manager filed
// (`proposedBy.capacity`) is marked "Proposed by the performance manager",
// with what that role may and may not do.

type Payload = Partial<AgentProfileChangePayload>;

function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const ACCESS_DIMENSION_TEXT: Record<string, string> = {
  "see.projects": "Projects it can see",
  "see.connections": "Connections it can read through",
  "do.connections": "What it can do through connections",
  "do.skills": "Skills it can use",
  "talk.agents": "Agents it can reach",
  "talk.people": "People it can ask",
  "talk.external": "Outside contacts",
  "talk.inbound": "Who can reach it",
  permissions: "Permissions",
  monthlyBudgetCents: "Monthly budget",
  destructiveActions: "Destructive actions",
  dataScopes: "Data scopes",
  providers: "Providers",
  minimumApproval: "Minimum approval",
};

const ACCESS_CHANGE_TEXT: Record<AgentProfileAccessChange["change"], string> = {
  widens: "Widens access",
  narrows: "Narrows access",
  changes: "Changes access (the two can't be ranked)",
};

function authorityFor(
  entry: AgentProfileDiffEntry,
  index: number,
  fieldAuthority: AgentProfileFieldAuthorityEntry[],
): AgentProfileFieldAuthorityEntry | null {
  const byIndex = fieldAuthority[index];
  if (byIndex && byIndex.pointer === entry.pointer) return byIndex;
  return fieldAuthority.find((candidate) => candidate.pointer === entry.pointer) ?? null;
}

/** Plain consequences of applying, from which parts of the profile the diff touches (overview LLD §4.2 step 4–5). */
export function applyConsequences(diff: AgentProfileDiffEntry[], revisionNumber: number | null): string[] {
  const tops = new Set<string>();
  const paths = diff.map((entry) => entry.pointer.split("/").slice(1));
  for (const tokens of paths) tops.add(tokens[0] ?? "*");
  const all = tops.has("*");
  const touches = (top: string) => all || tops.has(top);
  const runtimeField = (field: string) => all || paths.some((tokens) => tokens[0] === "runtime" && tokens[1] === field);
  const obligations = all || paths.some((tokens) => tokens[0] === "responsibilities" && (tokens.length <= 2 || tokens[2] === "obligation"));
  const out: string[] = [];
  if (touches("access")) out.push("Its requested access is updated. The admin's ceiling still limits it.");
  if (runtimeField("model") || runtimeField("heartbeat")) out.push("Its configuration (model, heartbeat) is updated through the recorded configuration path.");
  if (runtimeField("environmentId")) out.push("Its execution environment is changed through the governed environment path.");
  if (obligations) out.push("Routine bindings are checked. Routines themselves are never changed.");
  if (touches("skills")) out.push("Its installed skills are synced, limited to the skills its access allows.");
  if (touches("responsibilities")) out.push("The evaluation contract for its responsibilities is declared for this revision.");
  out.push(
    revisionNumber != null
      ? `Revision ${revisionNumber} becomes the active profile, and the operating-profile block in its instructions is rewritten.`
      : "This revision becomes the active profile, and the operating-profile block in its instructions is rewritten.",
  );
  return out;
}

function AccessChangeRow({ change }: { change: AgentProfileAccessChange }) {
  const flagged = change.change === "widens" || change.clippedByCeiling;
  return (
    <li
      className={
        flagged
          ? "rounded-md border border-warn-500/40 bg-warn-500/5 px-3 py-2 text-sm"
          : "rounded-md border border-border-soft px-3 py-2 text-sm"
      }
      data-testid="agent-profile-change-access"
      data-flagged={flagged ? "true" : "false"}
    >
      <p className="text-text-primary">
        <span className="font-medium">{ACCESS_DIMENSION_TEXT[change.dimension] ?? change.dimension}:</span>{" "}
        {ACCESS_CHANGE_TEXT[change.change] ?? change.change}
        {change.clippedByCeiling ? " · clipped by the ceiling" : ""}
      </p>
      {change.detail ? <p className="mt-0.5 text-text-secondary">{change.detail}</p> : null}
      {change.clippedByCeiling ? (
        <p className="mt-0.5 text-text-secondary">
          It asks for more than the admin's ceiling allows, so the agent gets only what the ceiling allows
          {change.clip?.detail ? `: ${change.clip.detail}` : "."}
          {change.clip?.values && change.clip.values.length > 0 ? ` Beyond the ceiling: ${change.clip.values.join(", ")}.` : ""}
          {" "}Approving it as asked needs a company admin, who raises the ceiling as a separate recorded step.
        </p>
      ) : null}
    </li>
  );
}

function Block({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

export function AgentProfileChangePayloadView({ payload }: { payload: Record<string, unknown> }) {
  const p = payload as Payload;
  const diff = array<AgentProfileDiffEntry>(p.diff);
  const fieldAuthority = array<AgentProfileFieldAuthorityEntry>(p.fieldAuthority);
  const accessChanges = array<AgentProfileAccessChange>(p.accessChanges);
  const affected = array<string>(p.affectedResponsibilities).filter((key) => typeof key === "string");
  const ledgerEventIds = array<string>(p.evidence?.ledgerEventIds).filter((id) => typeof id === "string");
  const revisionNumber = typeof p.revisionNumber === "number" ? p.revisionNumber : null;
  const agentId = text(p.agentId);
  const reason = text(p.reason);
  const expectedBenefit = text(p.expectedBenefit);
  const risks = text(p.risks);
  const required = p.requiredAuthority && FIELD_AUTHORITY_TEXT[p.requiredAuthority] ? p.requiredAuthority : null;
  const widening = accessChanges.filter((change) => change.change === "widens" || change.clippedByCeiling);
  const byManager = isManagerFiledPayload(p);
  const proposer =
    p.proposedBy?.kind === "agent" && byManager
      ? `The company's performance manager, an agent (${p.proposedBy.agentId.slice(0, 8)}). It can never decide its own proposal. ${PERFORMANCE_MANAGER_ADVISORY_TEXT}`
      : p.proposedBy?.kind === "agent"
      ? `An agent (${p.proposedBy.agentId.slice(0, 8)}). The proposing agent can never decide its own proposal.`
      : p.proposedBy?.kind === "user"
        ? `A person (${p.proposedBy.userId}). A person with the required authority may approve their own draft; it is recorded as a self-approval.`
        : null;

  return (
    <div className="mt-4 space-y-4 text-sm" data-testid="agent-profile-change-payload">
      {byManager ? (
        <p>
          <ManagerFiledBadge testId="agent-profile-change-manager-filed" />
        </p>
      ) : null}
      <p className="leading-6 text-foreground">
        {revisionNumber != null ? `Revision ${revisionNumber} of this agent's operating profile` : "A change to this agent's operating profile"}
        {diff.length > 0 ? `, changing ${diff.length} field${diff.length === 1 ? "" : "s"}.` : "."} Approving decides it; the
        change is then applied step by step and can stop if the agent changed in the meantime.
      </p>

      {required ? (
        <Block title="Who may decide" testId="agent-profile-change-required">
          <p className="text-foreground">{FIELD_AUTHORITY_TEXT[required]}.</p>
        </Block>
      ) : null}

      {proposer ? (
        <Block title="Proposed by" testId="agent-profile-change-proposer">
          <p className="text-muted-foreground">{proposer}</p>
        </Block>
      ) : null}

      {reason || expectedBenefit || risks ? (
        <Block title="Why">
          {reason ? <p className="text-foreground">{reason}</p> : null}
          {expectedBenefit ? <p className="text-muted-foreground">Expected benefit: {expectedBenefit}</p> : null}
          {risks ? <p className="text-muted-foreground">Risks: {risks}</p> : null}
        </Block>
      ) : null}

      <Block title="Access" testId="agent-profile-change-access-block">
        {accessChanges.length === 0 ? (
          <p className="text-muted-foreground">No change to what it may see, do, talk to or spend.</p>
        ) : (
          <>
            {widening.length > 0 ? (
              <p className="font-medium text-foreground" data-testid="agent-profile-change-widening">
                {widening.length === 1
                  ? "1 access change widens access or is clipped by the ceiling."
                  : `${widening.length} access changes widen access or are clipped by the ceiling.`}{" "}
                Check these first.
              </p>
            ) : null}
            <ul className="space-y-1.5">
              {accessChanges.map((change, index) => (
                <AccessChangeRow key={`${change.dimension}-${index}`} change={change} />
              ))}
            </ul>
          </>
        )}
      </Block>

      <Block title="What changes, field by field" testId="agent-profile-change-diff">
        <ProfileDiffList
          diff={diff}
          beforeLabel="Now"
          afterLabel="Proposed"
          emptyText="No field changes are recorded in this request."
          annotate={(entry) => {
            const index = diff.indexOf(entry);
            const authority = authorityFor(entry, index, fieldAuthority);
            if (!authority) return null;
            return (
              <p className="mt-1 text-xs text-text-secondary" data-testid="agent-profile-change-authority">
                Needs: {FIELD_AUTHORITY_TEXT[authority.required] ?? authority.required}
                {authority.reason ? ` — ${authority.reason}` : ""}
              </p>
            );
          }}
        />
      </Block>

      {affected.length > 0 ? (
        <Block title="Responsibilities affected">
          <p className="font-mono text-xs text-muted-foreground">{affected.join(", ")}</p>
        </Block>
      ) : null}

      <Block title="What applying will change" testId="agent-profile-change-consequences">
        <ul className="list-disc space-y-0.5 pl-5 text-foreground">
          {applyConsequences(diff, revisionNumber).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Nothing changes before approval. If the agent's active profile, access policy or configuration changed after this
          was proposed, applying stops as out of date and nothing is switched.
        </p>
      </Block>

      <Block title="Evidence" testId="agent-profile-change-evidence">
        {p.evidence?.cardId || ledgerEventIds.length > 0 ? (
          <ul className="space-y-0.5 text-muted-foreground">
            {p.evidence?.cardId ? (
              <li>
                Card <span className="font-mono text-xs">{p.evidence.cardId}</span>
                {p.evidence.cardVersion != null ? `, version ${p.evidence.cardVersion}` : ""}
              </li>
            ) : null}
            {ledgerEventIds.length > 0 ? (
              <li>
                Evaluator records: <span className="font-mono text-xs">{ledgerEventIds.join(", ")}</span>
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="text-muted-foreground">No evidence was attached to this request.</p>
        )}
        {agentId ? (
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            <Link className="text-accent-500 underline-offset-4 hover:underline" to={`/agents/${agentId}/performance`}>
              Open the agent's performance
            </Link>
            <Link className="text-accent-500 underline-offset-4 hover:underline" to={`/agents/${agentId}/profile`}>
              Open the agent's profile and revision history
            </Link>
          </p>
        ) : null}
      </Block>

    </div>
  );
}
