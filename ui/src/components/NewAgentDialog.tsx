import { WorkforceRoleSelect, WorkforceTemplatePreview } from "./WorkforceTemplatePreview";
import { resolveWorkforceTemplate } from "@paperclipai/shared";
import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { adaptersApi } from "../api/adapters";
import { conversationsApi } from "../api/conversations";
import { healthApi } from "../api/health";
import { queryKeys } from "@/lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Bot,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { useBoardOrgAccess } from "../hooks/useBoardSessionReady";

/**
 * Adapter types that are suitable for agent creation (excludes internal
 * system adapters like "process" and "http").
 */
const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);

function isAgentAdapterType(type: string): boolean {
  return !SYSTEM_ADAPTER_TYPES.has(type);
}

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent, openNewIssue } = useDialog();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [showAdvancedCards, setShowAdvancedCards] = useState(false);
  const [workforceTemplateId, setWorkforceTemplateId] = useState("");
  const [hireRole, setHireRole] = useState("");
  const [hireWork, setHireWork] = useState("");
  const [hireSubmitting, setHireSubmitting] = useState(false);
  const [hireError, setHireError] = useState<string | null>(null);
  const hireSession = useRef({ submitting: false });
  // AgentDash: a reopened dialog or another company starts a new request
  // session. Earlier async work must not post, clear, close or navigate it.
  useEffect(() => {
    hireSession.current = { submitting: false };
    setWorkforceTemplateId("");
    setHireRole("");
    setHireWork("");
    setHireError(null);
    setHireSubmitting(false);
    return () => { hireSession.current = { submitting: false }; };
  }, [newAgentOpen, selectedCompanyId]);
  const disabledTypes = useDisabledAdaptersSync();

  const { data: health, isError: healthFailed } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  // AgentDash (GH #789): hosted agentdash.cloud boxes run Hermes only, so the
  // adapter grid is a dead end there — hiring goes through the CoS instead.
  // One UX (doc/plans/2026-09-30-one-ux.md): the same for every company. While
  // health is loading we render nothing rather than flash the adapter path on
  // a hosted box — but a failed health check falls through to the normal
  // dialog rather than spinning forever.
  const hostedHirePath = health?.hostedBox === true;
  const hirePathPending = health === undefined && !healthFailed;

  // Fetch registered adapters from server (syncs disabled store + provides data).
  // AgentDash (b2 polish): this dialog mounts under Layout on /company-create
  // too, where a fresh sign-up has a session but no membership — the server
  // answers 403 until then, so wait for org access first.
  const orgAccess = useBoardOrgAccess();
  const { data: serverAdapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    enabled: orgAccess,
    staleTime: 5 * 60 * 1000,
  });

  // Fetch existing agents for the "Ask CEO" flow
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  // The delegate follows the button's promise: "Ask your Chief of Staff",
  // falling back to the CEO so a workspace without a CoS still delegates.
  const findByRole = (role: string) => (agents ?? []).find((a) => a.role === role);
  const delegateAgent = findByRole("chief_of_staff") ?? findByRole("ceo");

  /**
   * On an empty workspace there is nobody to delegate to, and offering it
   * anyway is a dead end: "Ask the CEO to create a new agent" files an issue
   * with `assigneeAgentId: undefined`, so it lands unassigned and no agent
   * ever picks it up. Nothing errors — the user simply gets a task that sits
   * there forever, which is the worst possible first minute in a new
   * workspace.
   *
   * The delegation path is genuinely the better one once a CoS exists, so it
   * stays the default. It is only skipped while there is no agent at all,
   * which is exactly the case where it cannot work.
   */
  const hasAnyAgent = (agents ?? []).length > 0;

  // Build the adapter grid from the UI registry merged with display metadata.
  // This automatically includes external/plugin adapters.
  const adapterGrid = useMemo(() => {
    const registered = listUIAdapters()
      .filter((a) =>
        isAgentAdapterType(a.type) &&
        !disabledTypes.has(a.type) &&
        isVisualAdapterChoice(a.type)
      );

    // Sort: recommended first, then alphabetical
    return registered
      .map((a) => {
        const display = getAdapterDisplay(a.type);
        return {
          value: a.type,
          label: display.label,
          desc: display.description,
          icon: display.icon,
          recommended: display.recommended,
          comingSoon: display.comingSoon,
          disabledLabel: display.disabledLabel,
        };
      })
      .sort((a, b) => {
        if (a.recommended && !b.recommended) return -1;
        if (!a.recommended && b.recommended) return 1;
        return a.label.localeCompare(b.label);
      });
  }, [disabledTypes, serverAdapters]);

  function handleAskCeo() {
    closeNewAgent();
    openNewIssue({
      assigneeAgentId: delegateAgent?.id,
      title: "Create a new agent",
      description: workforceTemplateId ? `Hire with workforceTemplateId: ${workforceTemplateId} (pinned version 1).` : "(type in what kind of agent you want here)",
    });
  }

  async function handleAskChiefOfStaff() {
    const session = hireSession.current;
    if (!selectedCompanyId || session.submitting) return;
    session.submitting = true;
    setHireSubmitting(true);
    setHireError(null);
    const role = hireRole.trim() || "an agent";
    const work = hireWork.trim();
    const body =
      `Please hire ${role}.` +
      (work ? ` It should work on: ${work}.` : "") +
      (workforceTemplateId ? ` Use workforceTemplateId: ${workforceTemplateId} (pinned version 1).` : "");
    try {
      const conversation = await conversationsApi.companyInbox(selectedCompanyId);
      if (hireSession.current !== session) return;
      await conversationsApi.post(conversation.id, body, selectedCompanyId);
      if (hireSession.current !== session) return;
      setHireRole("");
      setHireWork("");
      closeNewAgent();
      navigate("/cos");
    } catch {
      if (hireSession.current !== session) return;
      setHireError("Couldn't send that. Try again.");
    } finally {
      if (hireSession.current === session) {
        session.submitting = false;
        setHireSubmitting(false);
      }
    }
  }

  function handleAdvancedConfig() {
    setShowAdvancedCards(true);
  }

  function handleAdvancedAdapterPick(adapterType: string) {
    closeNewAgent();
    setShowAdvancedCards(false);
    navigate(`/agents/new?adapterType=${encodeURIComponent(adapterType)}${workforceTemplateId ? `&workforceTemplateId=${encodeURIComponent(workforceTemplateId)}` : ""}`);
  }

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) {
          setShowAdvancedCards(false);
          closeNewAgent();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="sm:max-w-md p-0 gap-0 max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <DialogTitle className="text-sm font-normal text-muted-foreground">Add a new agent</DialogTitle>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => {
              setShowAdvancedCards(false);
              closeNewAgent();
            }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="p-6 space-y-6">
          <WorkforceRoleSelect value={workforceTemplateId} onChange={id => { setWorkforceTemplateId(id); const template = resolveWorkforceTemplate(id); if (template) setHireRole(template.name); }}/>
          <WorkforceTemplatePreview templateId={workforceTemplateId}/>
          <button className="text-sm underline" onClick={() => { closeNewAgent(); navigate('/workforce'); }}>Company knowledge and first-job setup</button>
          {hirePathPending ? (
            <div className="flex justify-center py-8" aria-hidden="true">
              <Bot className="h-6 w-6 animate-pulse text-muted-foreground" />
            </div>
          ) : hostedHirePath ? (
            <>
              {/* Hosted hire path: a short form filed through the CoS */}
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                  <Bot className="h-6 w-6 text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Ask your Chief of Staff for a hire — tell it the role and what
                  it should work on, and it handles setup, reporting, and
                  permissions.
                </p>
              </div>

              <div className="space-y-3">
                <Input
                  placeholder="Role — e.g. Frontend engineer"
                  value={hireRole}
                  onChange={(e) => setHireRole(e.target.value)}
                />
                <Textarea
                  placeholder="What should it work on?"
                  value={hireWork}
                  onChange={(e) => setHireWork(e.target.value)}
                  rows={3}
                />
                {hireError && (
                  <p className="text-sm text-destructive">{hireError}</p>
                )}
                <Button
                  className="w-full"
                  size="lg"
                  onClick={handleAskChiefOfStaff}
                  disabled={hireSubmitting || !hireRole.trim()}
                >
                  <Bot className="h-4 w-4 mr-2" />
                  {hireSubmitting ? "Asking…" : "Ask your Chief of Staff"}
                </Button>
              </div>
            </>
          ) : !showAdvancedCards && hasAnyAgent ? (
            <>
              {/* Recommendation */}
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                  <Bot className="h-6 w-6 text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  The easiest way to add a new agent is to ask your Chief of Staff
                  (CoS) — just tell it what role you need and it handles setup,
                  reporting, and permissions.
                </p>
              </div>

              <Button className="w-full" size="lg" onClick={handleAskCeo}>
                <Bot className="h-4 w-4 mr-2" />
                Ask your Chief of Staff to create a new agent
              </Button>

              {/* Advanced link */}
              <div className="text-center">
                <button
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                  onClick={handleAdvancedConfig}
                >
                  I want advanced configuration myself
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowAdvancedCards(false)}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <p className="text-sm text-muted-foreground">
                  Choose your adapter type for advanced setup.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {adapterGrid.map((opt) => (
                  <button
                    key={opt.value}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-md border border-border p-3 text-xs transition-colors hover:bg-accent/50 relative",
                      opt.comingSoon && "opacity-40 cursor-not-allowed",
                    )}
                    disabled={!!opt.comingSoon}
                    title={opt.comingSoon ? opt.disabledLabel : undefined}
                    onClick={() => {
                      if (!opt.comingSoon) handleAdvancedAdapterPick(opt.value);
                    }}
                  >
                    {opt.recommended && (
                      <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                        Recommended
                      </span>
                    )}
                    <opt.icon className="h-4 w-4" />
                    <span className="font-medium">{opt.label}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {opt.desc}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
