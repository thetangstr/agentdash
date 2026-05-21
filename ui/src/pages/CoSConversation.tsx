// AgentDash: CoSConversation — onboarding v2 entry point
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2, Clock3, FileText, ShieldCheck } from "lucide-react";
import ChatPanel from "./ChatPanel";
import { onboardingApi } from "../api/onboarding";
import { agentsApi } from "../api/agents";
import type { CardContext } from "../components/cards";

interface BootstrapState {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
}

export function CoSConversation() {
  const [bootstrapped, setBootstrapped] = useState<BootstrapState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pilotLaunch, setPilotLaunch] = useState<{
    projectId: string;
    issueIds: string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    onboardingApi
      .bootstrap()
      .then((r) => {
        if (cancelled) return;
        setBootstrapped({
          companyId: r.companyId,
          cosAgentId: r.cosAgentId,
          conversationId: r.conversationId,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? "Failed to bootstrap workspace");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="p-8 text-center">
        <div className="text-red-600 mb-2">Couldn't set up your workspace</div>
        <div className="text-sm text-gray-600">{error}</div>
        <button
          className="mt-4 border px-4 py-2 rounded"
          onClick={() => {
            setError(null);
            setBootstrapped(null);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!bootstrapped) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Setting up your workspace…
      </div>
    );
  }

  const cardContext: CardContext = {
    onProposalConfirm: async () => {
      // Confirming a plan either launches the CoS pilot project or materializes
      // the legacy agent-team proposal, depending on the latest card kind.
      try {
        const result = await onboardingApi.confirmPlan({
          conversationId: bootstrapped.conversationId,
        });
        if (result.projectId) {
          setPilotLaunch({
            projectId: result.projectId,
            issueIds: result.issueIds ?? [],
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Failed to launch plan";
        setError(reason);
      }
    },
    onProposalReject: async (reason) => {
      // Ask the CoS to revise the latest plan card; the server posts the
      // replacement card into the conversation.
      try {
        await onboardingApi.revisePlan({
          conversationId: bootstrapped.conversationId,
          revisionText: reason ?? "",
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Failed to revise plan";
        setError(reason);
      }
    },
    onInviteSend: async (emails) => {
      try {
        return await onboardingApi.sendInvites({
          conversationId: bootstrapped.conversationId,
          companyId: bootstrapped.companyId,
          emails,
        });
      } catch (err) {
        // Non-blocking — onboarding completes even on partial invite failure.
        const reason = err instanceof Error ? err.message : "Invite request failed";
        return {
          inviteIds: [],
          invites: [],
          errors: emails.map((email) => ({ email, reason })),
        };
      }
    },
    onInviteSkip: () => {
      // No-op; the InvitePrompt closes itself.
    },
  };

  return (
    <CoSConversationView
      bootstrapped={bootstrapped}
      cardContext={cardContext}
      pilotLaunch={pilotLaunch}
    />
  );
}

// Separate component so the agents-list useQuery hook is only mounted once we
// have a real companyId; keeps hook order stable across the error/loading
// branches above.
function CoSConversationView({
  bootstrapped,
  cardContext,
  pilotLaunch,
}: {
  bootstrapped: BootstrapState;
  cardContext: CardContext;
  pilotLaunch: { projectId: string; issueIds: string[] } | null;
}) {
  // #209: feed the composer's @mention typeahead with the company's agents.
  const { data: agents } = useQuery({
    queryKey: ["company-agents", bootstrapped.companyId],
    queryFn: () => agentsApi.list(bootstrapped.companyId),
    staleTime: 5 * 60 * 1000,
  });
  const agentDirectory = (agents ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
  }));

  return (
    <div className="fixed inset-0 flex flex-col">
      <ChatPanel
        conversationId={bootstrapped.conversationId}
        companyId={bootstrapped.companyId}
        cardContext={cardContext}
        agentDirectory={agentDirectory}
        headerProps={{
          agentRole: pilotLaunch
            ? "30-day CoS pilot running"
            : "30-day CoS pilot setup",
        }}
        rail={<CoSPilotRail launched={pilotLaunch} />}
      />
    </div>
  );
}

function CoSPilotRail({
  launched,
}: {
  launched: { projectId: string; issueIds: string[] } | null;
}) {
  const steps = launched
    ? [
        { label: "Delegation contract accepted", done: true },
        { label: "Pilot project created", done: true },
        { label: `${launched.issueIds.length} traceable issues opened`, done: true },
        { label: "Heartbeat active", done: true },
      ]
    : [
        { label: "Understand your work style", done: true },
        { label: "Draft delegation contract", done: false },
        { label: "Shape 30-day pilot", done: false },
        { label: "Launch heartbeat", done: false },
      ];

  return (
    <div className="flex h-full flex-col p-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-tertiary">Chief of Staff pilot</p>
        <h2 className="mt-1 text-base font-semibold text-text-primary">
          {launched ? "Operating mode" : "Guided setup"}
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          {launched
            ? "Your CoS now works from the pilot project, posts heartbeat briefs, drafts work, and escalates approval requests."
            : "The setup creates a delegation contract first, then a contained 30-day pilot with human approval gates."}
        </p>
      </div>

      <div className="mt-5 space-y-2">
        {steps.map((step) => (
          <div key={step.label} className="flex items-center gap-2 text-sm">
            <CheckCircle2
              className={`h-4 w-4 ${step.done ? "text-accent-600" : "text-text-tertiary"}`}
              aria-hidden
            />
            <span className={step.done ? "text-text-primary" : "text-text-secondary"}>{step.label}</span>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-md border border-border-soft bg-surface-base p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <ShieldCheck className="h-4 w-4 text-accent-600" aria-hidden />
          Approval boundaries
        </div>
        <p className="mt-2 text-sm text-text-secondary">
          RFP submissions, external sends, and billing, payroll, HR, or recruiting changes stay human-approved.
        </p>
      </div>

      <div className="mt-3 rounded-md border border-border-soft bg-surface-base p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Activity className="h-4 w-4 text-accent-600" aria-hidden />
          Trace hint
        </div>
        <p className="mt-2 text-sm text-text-secondary">
          The dashboard tracks access used, drafts created, approvals requested, time saved, and risks surfaced.
        </p>
      </div>

      <div className="mt-auto grid gap-2 pt-4 text-xs text-text-tertiary">
        <div className="flex items-center gap-2">
          <Clock3 className="h-3.5 w-3.5" aria-hidden />
          Daily business-day brief after launch
        </div>
        <div className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          Outputs: delegation contract and 30-day pilot plan
        </div>
      </div>
    </div>
  );
}
