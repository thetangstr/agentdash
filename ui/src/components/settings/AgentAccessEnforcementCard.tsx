import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentAccessEnforcementMode } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentAccessEnforcementApi, agentProfileQueryKeys } from "@/api/agent-profiles";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { queryKeys } from "@/lib/queryKeys";

// AgentDash: Agent Performance Management gate 2 — how the company checks the
// access rules people define in operating profiles (access LLD §4, §7, §11).
// Admins choose among the modes the server says are selectable
// (`selectableModes`); anything else is shown disabled. Members see the
// current mode, read-only. The server is the authority on both: this control
// is presentation, and its refusals are shown.
// Gate 3: `enforce` is selectable. Choosing it opens a confirmation that says
// plainly what changes; nothing is sent until the admin confirms. Leaving
// enforce (to shadow or off) needs no confirmation: it only stops refusing.

export const ENFORCE_UNAVAILABLE_TEXT = "Not available on this server yet";
const MODE_UNAVAILABLE_TEXT = "Not available yet";
export const ENFORCE_CONFIRM_TITLE = "Turn on enforcement?";
export const ENFORCE_CONFIRM_LABEL = "Turn on enforcement";
/** What changes when enforcement is turned on, in the order the dialog says it. */
export const ENFORCE_CHANGES: readonly string[] = [
  "Agents are refused anything outside the access their operating profile defines: projects they can see, connections they can use, skills they can add, and who they can contact or assign work to.",
  "A refused run doesn't start; it leaves a note on the issue and its owner is told.",
  "Agents with no defined access keep today's rules, except that a task they send to a person's computer runs only on their steward's or accountable person's computer.",
  "Each agent's accountable person, steward and company admins always stay reachable, so an agent can still ask for help or approval.",
  "Every refusal is recorded on the agent's Access tab and in Activity.",
  "You can switch back to Shadow or Off at any time.",
];

const MODE_OPTIONS: Array<{ mode: AgentAccessEnforcementMode; label: string; description: string; unavailableText: string }> = [
  {
    mode: "off",
    label: "Off",
    description: "Person-defined access rules are not checked. Today's rules apply as before.",
    unavailableText: MODE_UNAVAILABLE_TEXT,
  },
  {
    mode: "shadow",
    label: "Shadow",
    description:
      "Rules are checked and every would-be refusal is logged on the agent's Access tab. Nothing is refused and no agent gets more access.",
    unavailableText: MODE_UNAVAILABLE_TEXT,
  },
  {
    mode: "enforce",
    label: "Enforce",
    description:
      "Agents are refused anything outside their defined access. Their accountable person, steward and company admins stay reachable.",
    unavailableText: ENFORCE_UNAVAILABLE_TEXT,
  },
];

const MODE_NAME: Record<AgentAccessEnforcementMode, string> = { off: "Off", shadow: "Shadow", enforce: "Enforce" };

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The server did not say why.";
}

export function AgentAccessEnforcementCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const groupName = useId();
  const headingId = `${groupName}-heading`;
  const [announcement, setAnnouncement] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmingEnforce, setConfirmingEnforce] = useState(false);

  const modeQuery = useQuery({
    queryKey: agentProfileQueryKeys.enforcement(companyId),
    queryFn: () => agentAccessEnforcementApi.get(companyId),
    retry: false,
    enabled: !!companyId,
  });
  // Presentation only: the PATCH route itself is admin-only.
  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    enabled: !!companyId,
  });
  const isAdmin = membersQuery.data?.access.canManageAgents ?? false;

  const setMode = useMutation({
    mutationFn: (mode: AgentAccessEnforcementMode) => agentAccessEnforcementApi.set(companyId, mode),
    onSuccess: (result) => {
      setProblem(null);
      queryClient.setQueryData(agentProfileQueryKeys.enforcement(companyId), result);
      setAnnouncement(`Access rule checking is now ${MODE_NAME[result.mode].toLowerCase()}.`);
    },
    onError: (error) => {
      setAnnouncement("");
      setProblem(`The mode was not changed: ${messageOf(error)}`);
    },
  });

  const current = setMode.isPending && setMode.variables ? setMode.variables : modeQuery.data?.mode;
  // The server names what may be chosen; anything else is shown, disabled.
  const selectable = new Set<AgentAccessEnforcementMode>(modeQuery.data?.selectableModes ?? []);

  return (
    <section aria-labelledby={headingId} className="space-y-2" data-testid="company-settings-access-enforcement">
      <h3 id={headingId} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Agent access rules
      </h3>
      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        <p className="text-sm text-muted-foreground">
          How AgentDash checks the access people define in an agent's operating profile.
        </p>
        {modeQuery.error ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn't read the current mode: {messageOf(modeQuery.error)}
          </p>
        ) : !modeQuery.data ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the current mode…
          </p>
        ) : isAdmin ? (
          <fieldset className="space-y-2" aria-busy={setMode.isPending}>
            <legend className="text-sm font-medium text-foreground">Mode</legend>
            {MODE_OPTIONS.map((option) => {
              const optionId = `${groupName}-${option.mode}`;
              const descriptionId = `${optionId}-description`;
              const disabled = !selectable.has(option.mode);
              return (
                <div key={option.mode} className="flex items-start gap-2">
                  <input
                    type="radio"
                    id={optionId}
                    name={groupName}
                    value={option.mode}
                    className="mt-1 accent-foreground"
                    checked={current === option.mode}
                    disabled={disabled}
                    aria-describedby={descriptionId}
                    onChange={() => {
                      if (disabled || setMode.isPending || option.mode === modeQuery.data?.mode) return;
                      if (option.mode === "enforce") {
                        setConfirmingEnforce(true);
                        return;
                      }
                      setMode.mutate(option.mode);
                    }}
                    data-testid={`access-enforcement-${option.mode}`}
                  />
                  <div>
                    <label htmlFor={optionId} className={disabled ? "text-sm text-muted-foreground" : "text-sm text-foreground"}>
                      {option.label}
                    </label>
                    <p id={descriptionId} className="text-xs text-muted-foreground">
                      {disabled ? `${option.unavailableText}. ${option.description}` : option.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </fieldset>
        ) : (
          <div className="space-y-1" data-testid="access-enforcement-readonly">
            <p className="text-sm text-foreground">
              Current mode: <span className="font-medium">{MODE_NAME[modeQuery.data.mode]}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {MODE_OPTIONS.find((option) => option.mode === modeQuery.data?.mode)?.description} Only company admins can change this.
            </p>
          </div>
        )}
        <p role="status" aria-live="polite" className={announcement ? "text-sm text-foreground" : "sr-only"} data-testid="access-enforcement-status">
          {announcement}
        </p>
        {problem ? (
          <p role="alert" className="text-sm text-destructive" data-testid="access-enforcement-error">
            {problem}
          </p>
        ) : null}
      </div>
      <Dialog open={confirmingEnforce} onOpenChange={setConfirmingEnforce}>
        <DialogContent data-testid="access-enforcement-confirm">
          <DialogHeader>
            <DialogTitle>{ENFORCE_CONFIRM_TITLE}</DialogTitle>
            <DialogDescription>What changes for this company's agents:</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-foreground">
            {ENFORCE_CHANGES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmingEnforce(false)} data-testid="access-enforcement-confirm-cancel">
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirmingEnforce(false);
                setMode.mutate("enforce");
              }}
              data-testid="access-enforcement-confirm-enforce"
            >
              {ENFORCE_CONFIRM_LABEL}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
