import { useQuery } from "@tanstack/react-query";
import {
  AGENT_ACCESS_DIMENSIONS,
  type AgentAccessDimension,
  type AgentAccessEnforcementMode,
  type AgentAccessInventory,
  type AgentAccessItem,
  type AgentAccessRefusalRecord,
} from "@paperclipai/shared";
import { agentPerformanceApi, agentPerformanceQueryKeys } from "@/api/agent-performance";
import { formatDateTime } from "@/lib/utils";
import {
  Banner,
  EmptyNote,
  Fact,
  FactList,
  GapList,
  Section,
  StateBadge,
  ViewStatus,
  formatWindow,
  refusalCodeText,
  sortedRefusalCodes,
} from "./shared";

// AgentDash: Agent Performance Management — the Access tab. What today's
// rules let this agent see, do, talk to and spend, with the five states kept
// apart (access LLD §3.3): Requested, Defined, Enforced, Working, Used.
// Gate 1: nobody has defined access through a profile, so "Requested" is
// "Not defined" everywhere and the view says so up front.
// Gate 2: "Requested" reads the active profile, "Defined" includes the
// profile's V2 rule, and the company's enforcement mode is shown. In shadow
// mode the profile's rules are checked and logged but refuse nothing, so
// items read "Defined, not enforced" and would-be refusals are listed here
// from the inventory's `shadow` summary for the window (they are hidden from
// the default activity feed).
// Gate 3: in enforce mode the profile's rules refuse what they don't allow.
// Items read "Enforced" (refused or allowed), and the refused items are
// listed with the refusals recorded in the window — the inventory's
// `enforced` summary (`ACCESS_POLICY_REFUSED` records), which, like `shadow`,
// leaves out records naming a project the viewer can't see.
// The people it can always reach stay listed below in every mode.

export const ACCESS_BANNER_TEXT = "Access not yet defined by a person. Showing what today's rules allow.";
export const ACCESS_PROFILE_BANNER_TEXT = "Access is defined by the agent's active operating profile.";
export const SHADOW_ITEM_TEXT = "Defined, not enforced";
export const ENFORCED_REFUSED_TEXT = "Enforced: refused";
export const ENFORCED_ALLOWED_TEXT = "Enforced: allowed";

const MODE_TEXT: Record<AgentAccessEnforcementMode, string> = {
  off: "off",
  shadow: "shadow (checked and logged; nothing is refused)",
  enforce: "enforce (anything the profile's rules don't allow is refused)",
};

const PROFILE_RULE_TEXT: Record<AgentAccessEnforcementMode, string> = {
  off: "Defined, not checked (enforcement off)",
  shadow: SHADOW_ITEM_TEXT,
  enforce: "Enforced",
};

const REQUESTED_TEXT: Record<AgentAccessItem["requested"]["state"], string> = {
  not_defined: "Not defined",
  requested: "Requested",
  not_requested: "Not requested",
};

const DIMENSION_COPY: Record<AgentAccessDimension, { title: string; description: string }> = {
  see: { title: "See", description: "What it can read." },
  do: { title: "Do", description: "What it can change or act on." },
  talk: { title: "Talk", description: "Who it can contact, and who can reach it." },
  spend: { title: "Spend", description: "What it can spend." },
};

const ENFORCEMENT_TEXT: Record<AgentAccessItem["enforced"]["state"], string> = {
  enforced: "Enforced",
  partial: "Partly enforced",
  not_enforced: "Not enforced",
  profile_only: "Only on some product profiles",
  unknown: "Unknown",
};

const WORKING_TEXT: Record<AgentAccessItem["working"]["state"], string> = {
  ok: "Working",
  not_working: "Not working",
  not_applicable: "Not applicable",
  unknown: "Unknown",
};

function plainSource(source: string): string {
  return source.replace(/_/g, " ");
}

function definedText(defined: AgentAccessItem["defined"]): string {
  if (defined.allowed === "unrestricted") return "Unrestricted";
  return defined.allowed ? "Allowed" : "Not allowed";
}

function times(n: number | null | undefined): string {
  if (n == null) return "an unknown number of times";
  return `${n} time${n === 1 ? "" : "s"}`;
}

function usedText(used: AgentAccessItem["used"]): string {
  switch (used.state) {
    case "used":
      return `Used ${times(used.uses)}`;
    case "refused":
      return `Refused ${times(used.refusals)}`;
    case "used_and_refused":
      return `Used ${times(used.uses)}, refused ${times(used.refusals)}`;
    case "not_observed":
      return "Not observed";
    default:
      return "Unknown";
  }
}

function targetText(target: AgentAccessItem["target"]): string | null {
  if (!target) return null;
  const name = target.label ?? target.kind;
  return target.count != null ? `${name} (${target.count})` : name;
}

function hasProfileRule(item: AgentAccessItem): boolean {
  return Boolean(item.defined.v2) || item.requested.state !== "not_defined";
}

function AccessItemRow({ item, mode }: { item: AgentAccessItem; mode: AgentAccessEnforcementMode }) {
  const target = targetText(item.target);
  const v2 = item.defined.v2;
  const notes = [
    item.defined.detail ? `Defined: ${item.defined.detail}` : null,
    v2
      ? `Profile rule: ${v2.allowed ? "allows this" : mode === "enforce" ? "refuses this" : "would refuse this once enforced"}${
          v2.rule ? ` (${v2.rule})` : ""
        }`
      : null,
    item.enforced.note ? `Enforced: ${item.enforced.note}` : null,
    item.working.detail ? `Working: ${item.working.detail}` : null,
    item.used.lastAt ? `Last used or refused ${formatDateTime(item.used.lastAt)}` : null,
  ].filter((note): note is string => Boolean(note));
  return (
    <li className="rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="agent-access-item">
      <p className="font-medium text-text-primary">{item.label}</p>
      {target ? <p className="text-text-secondary">Applies to: {target}</p> : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <StateBadge label="Requested" value={REQUESTED_TEXT[item.requested.state]} />
        <StateBadge label="Defined" value={`${definedText(item.defined)} (${plainSource(item.defined.source)})`} />
        <StateBadge label="Enforced" value={ENFORCEMENT_TEXT[item.enforced.state]} />
        {hasProfileRule(item) ? (
          <StateBadge
            label="Profile rule"
            value={mode === "enforce" && v2 ? (v2.allowed ? ENFORCED_ALLOWED_TEXT : ENFORCED_REFUSED_TEXT) : PROFILE_RULE_TEXT[mode]}
            tone={v2 && !v2.allowed && mode === "enforce" ? "problem" : "neutral"}
          />
        ) : null}
        <StateBadge
          label="Working"
          value={WORKING_TEXT[item.working.state]}
          tone={item.working.state === "not_working" ? "problem" : "neutral"}
        />
        <StateBadge label="Used" value={usedText(item.used)} />
      </div>
      {notes.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-text-secondary">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function hostPermissionsText(value: boolean | "unknown"): string {
  if (value === "unknown") return "Unknown";
  return value ? "Restricted" : "Not restricted";
}

const HOST_KIND_TEXT: Record<AgentAccessInventory["hostEnvironment"]["kind"], string> = {
  local_host: "Local machine",
  managed_environment: "Managed environment",
  remote: "Remote",
  unknown: "Unknown",
};

const REACHABLE_ROLE_TEXT: Record<AgentAccessInventory["alwaysReachable"][number]["role"], string> = {
  accountable: "Accountable person",
  steward: "Steward",
  admin: "Company admin",
};

function countText(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Would-be refusals in shadow mode: the items the profile's rules don't
 * allow, and what the server logged (`access.would_refuse`) for this agent in
 * the window — the inventory's `shadow` summary: the total, by dimension, and
 * the newest records.
 */
function WouldRefuseSection({ inventory }: { inventory: AgentAccessInventory }) {
  const notAllowed = inventory.items.filter((item) => item.defined.v2 && !item.defined.v2.allowed);
  const shadow = inventory.shadow ?? null;
  const byDimension = Object.entries(shadow?.byDimension ?? {}).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const recent = shadow?.recent ?? [];
  return (
    <Section
      id="agent-access-would-refuse"
      title="Would be refused once enforced"
      description="Shadow mode: the profile's rules are checked and logged, but nothing is refused."
    >
      <div className="space-y-1" data-testid="agent-access-would-refuse-items">
        <h4 className="text-sm font-medium text-text-primary">Not allowed by the profile's rules</h4>
        {notAllowed.length === 0 ? (
          <EmptyNote>Every item above is allowed by the profile's rules.</EmptyNote>
        ) : (
          <ul className="space-y-1 text-sm">
            {notAllowed.map((item) => (
              <li key={item.id}>
                {item.label}
                {item.defined.v2?.rule ? <span className="text-text-secondary"> · rule {item.defined.v2.rule}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1" data-testid="agent-access-would-refuse-logged">
        <h4 className="text-sm font-medium text-text-primary">Logged in this window</h4>
        {!shadow ? (
          <EmptyNote>The server sent no would-be refusal summary for this window.</EmptyNote>
        ) : shadow.wouldRefuseTotal === 0 ? (
          <EmptyNote>None logged in this window.</EmptyNote>
        ) : (
          <>
            <p className="text-sm text-text-primary" data-testid="agent-access-would-refuse-total">
              {countText(shadow.wouldRefuseTotal, "would-be refusal", "would-be refusals")} logged.
            </p>
            {byDimension.length > 0 ? (
              <ul className="space-y-0.5 text-sm" data-testid="agent-access-would-refuse-by-dimension">
                {byDimension.map(([dimension, n]) => (
                  <li key={dimension}>
                    {dimension}: <span className="tabular-nums">{times(n)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <RefusalRecords recent={recent} total={shadow.wouldRefuseTotal} testId="agent-access-would-refuse-recent" />
          </>
        )}
      </div>
    </Section>
  );
}

/** The newest logged records (would-be refusals or refusals), labelled by name. */
function RefusalRecords({ recent, total, testId }: { recent: AgentAccessRefusalRecord[]; total: number; testId: string }) {
  if (recent.length === 0) return null;
  return (
    <>
      <h5 className="pt-1 text-xs font-medium text-text-secondary">Newest</h5>
      <ul className="space-y-1 text-sm" data-testid={testId}>
        {recent.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="rounded-md border border-border-soft px-3 py-2">
            <p className="text-text-primary">
              {entry.dimension}
              {entry.rule ? ` · rule ${entry.rule}` : ""}
              {entry.targetLabel ? ` · ${entry.targetLabel}` : ""}
            </p>
            <p className="text-xs text-text-secondary">
              {formatDateTime(entry.at)}
              {entry.site ? ` · checked at ${entry.site}` : ""}
            </p>
          </li>
        ))}
      </ul>
      {recent.length < total ? (
        <p className="text-xs text-text-secondary">
          The newest {recent.length} of {total}. The full record is under Activity with system events shown.
        </p>
      ) : null}
    </>
  );
}

/**
 * Enforce mode: what the profile's rules refuse, item by item, and the
 * refusals recorded in the window — the inventory's `enforced` summary: the
 * total and the newest records, counting only what this viewer may see. A
 * refusal is an attempt, not misconduct; the people it can always reach are
 * never refused.
 */
function EnforcedRefusalsSection({ inventory }: { inventory: AgentAccessInventory }) {
  const refusedItems = inventory.items.filter((item) => item.defined.v2 && !item.defined.v2.allowed);
  const enforced = inventory.enforced ?? null;
  const earlierShadow = inventory.shadow?.wouldRefuseTotal ?? 0;
  return (
    <Section
      id="agent-access-enforced"
      title="Refused under enforcement"
      description="Enforcement is on: the agent is refused anything its profile's rules don't allow. Its accountable person, steward and company admins stay reachable."
    >
      <div className="space-y-1" data-testid="agent-access-enforced-items">
        <h4 className="text-sm font-medium text-text-primary">Refused by the profile's rules</h4>
        {refusedItems.length === 0 ? (
          <EmptyNote>The profile's rules allow every item above.</EmptyNote>
        ) : (
          <ul className="space-y-1 text-sm">
            {refusedItems.map((item) => (
              <li key={item.id} className="rounded-md border border-border-soft px-3 py-2" data-testid="agent-access-enforced-row">
                <p className="text-text-primary">
                  {item.label}
                  {item.defined.v2?.rule ? <span className="text-text-secondary"> · rule {item.defined.v2.rule}</span> : null}
                </p>
                <p className="text-xs text-text-secondary">
                  {ENFORCED_REFUSED_TEXT}
                  {item.used.refusals != null ? ` · refused ${times(item.used.refusals)} in this window` : ""}
                  {item.used.lastAt ? ` · last ${formatDateTime(item.used.lastAt)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1" data-testid="agent-access-enforced-logged">
        <h4 className="text-sm font-medium text-text-primary">Recorded in this window</h4>
        {!enforced ? (
          <EmptyNote>The server sent no refusal summary for this window.</EmptyNote>
        ) : (
          <>
            <p className="text-sm text-text-primary" data-testid="agent-access-enforced-total">
              {enforced.refusedTotal === 0
                ? "No refusals by its access rules recorded in this window."
                : `${countText(enforced.refusedTotal, "refusal", "refusals")} by its access rules recorded in this window.`}
            </p>
            <RefusalRecords recent={enforced.recent} total={enforced.refusedTotal} testId="agent-access-enforced-recent" />
          </>
        )}
      </div>
      {earlierShadow > 0 ? (
        <p className="text-xs text-text-secondary" data-testid="agent-access-enforced-shadow-history">
          {countText(earlierShadow, "would-be refusal was", "would-be refusals were")} logged in this window while rules were checked
          without refusing (shadow).
        </p>
      ) : null}
    </Section>
  );
}

export function AgentAccessView({ inventory }: { inventory: AgentAccessInventory }) {
  const mode = inventory.enforcementMode;
  const used = inventory.items.filter((item) => item.used.state === "used" || item.used.state === "used_and_refused");
  const refused = inventory.items.filter(
    (item) => item.used.state === "refused" || item.used.state === "used_and_refused",
  );
  const refusalCodes = sortedRefusalCodes(inventory.refusalsByCode ?? {});
  const host = inventory.hostEnvironment;
  const windowText = formatWindow(inventory.window);

  return (
    <div className="max-w-4xl space-y-8" data-testid="agent-access-tab">
      <Banner>
        <p>{inventory.profileDefined ? ACCESS_PROFILE_BANNER_TEXT : ACCESS_BANNER_TEXT}</p>
        <p className="mt-1 text-xs" data-testid="agent-access-mode">
          Window {windowText}. Read {formatDateTime(inventory.generatedAt)}. Enforcement of person-defined access:{" "}
          {MODE_TEXT[mode]}.
        </p>
      </Banner>

      {AGENT_ACCESS_DIMENSIONS.map((dimension) => {
        const items = inventory.items.filter((item) => item.dimension === dimension);
        const copy = DIMENSION_COPY[dimension];
        return (
          <Section key={dimension} id={`agent-access-${dimension}`} title={copy.title} description={copy.description}>
            {items.length === 0 ? (
              <EmptyNote>Nothing recorded in this group.</EmptyNote>
            ) : (
              <ul className="space-y-2">
                {items.map((item) => (
                  <AccessItemRow key={item.id} item={item} mode={mode} />
                ))}
              </ul>
            )}
          </Section>
        );
      })}

      <Section id="agent-access-used" title="What it used" description={`Observed in activity records, ${windowText}.`}>
        {used.length === 0 ? (
          <EmptyNote>No use observed in this window.</EmptyNote>
        ) : (
          <ul className="space-y-1 text-sm">
            {used.map((item) => (
              <li key={item.id}>
                {item.label}: <span className="tabular-nums">{times(item.used.uses)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="agent-access-refused"
        title="What was refused"
        description="Refused attempts are attempts, not misconduct."
      >
        {refused.length === 0 && refusalCodes.length === 0 ? (
          <EmptyNote>No refused attempts observed in this window.</EmptyNote>
        ) : (
          <>
            <div className="space-y-1" data-testid="agent-access-refused-by-code">
              <h4 className="text-sm font-medium text-text-primary">By reason</h4>
              {refusalCodes.length === 0 ? (
                <EmptyNote>No refusal reasons recorded.</EmptyNote>
              ) : (
                <ul className="space-y-1 text-sm">
                  {refusalCodes.map(([code, n]) => (
                    <li key={code}>
                      {refusalCodeText(code)}: <span className="tabular-nums">{times(n)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-1" data-testid="agent-access-refused-by-item">
              <h4 className="text-sm font-medium text-text-primary">By access item</h4>
              {refused.length === 0 ? (
                <EmptyNote>None of these refusals maps to a single item above.</EmptyNote>
              ) : (
                <ul className="space-y-1 text-sm">
                  {refused.map((item) => (
                    <li key={item.id}>
                      {item.label}: <span className="tabular-nums">{times(item.used.refusals)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </Section>

      {mode === "shadow" ? <WouldRefuseSection inventory={inventory} /> : null}
      {mode === "enforce" ? <EnforcedRefusalsSection inventory={inventory} /> : null}

      <Section id="agent-access-host" title="Execution environment">
        <p className="text-sm text-text-primary" data-testid="agent-access-host-detail">
          {host.detail}
        </p>
        <FactList>
          <Fact label="Kind">{HOST_KIND_TEXT[host.kind]}</Fact>
          <Fact label="Adapter">
            <code className="font-mono text-xs">{host.adapterType}</code>
          </Fact>
          <Fact label="Host permissions">{hostPermissionsText(host.hostPermissionsRestricted)}</Fact>
          <Fact label="Environment">
            {host.environmentId ? <code className="font-mono text-xs">{host.environmentId}</code> : "None set"}
          </Fact>
        </FactList>
      </Section>

      <Section
        id="agent-access-reachable"
        title="Always reachable"
        description="Who it can always ask for help or approval."
      >
        {inventory.alwaysReachable.length === 0 ? (
          <EmptyNote>Nobody is recorded as always reachable.</EmptyNote>
        ) : (
          <ul className="space-y-1 text-sm">
            {inventory.alwaysReachable.map((contact) => (
              <li key={`${contact.role}-${contact.kind}-${contact.id}`}>
                {contact.label} <span className="text-text-secondary">· {REACHABLE_ROLE_TEXT[contact.role]}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <GapList id="agent-access-gaps" gaps={inventory.gaps} />
    </div>
  );
}

export function AgentAccessTab({ companyId, agentId }: { companyId: string; agentId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: agentPerformanceQueryKeys.access(companyId, agentId),
    queryFn: () => agentPerformanceApi.access(companyId, agentId),
    retry: false,
  });
  if (!data) return <ViewStatus what="access" isLoading={isLoading} error={error} restricted />;
  // Would-be refusals come with the inventory (`shadow`); nothing else is read.
  return <AgentAccessView inventory={data} />;
}
