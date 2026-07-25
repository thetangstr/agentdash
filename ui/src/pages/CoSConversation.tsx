// AgentDash: CoSConversation — onboarding v2 entry point
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ChatPanel from "./ChatPanel";
import { onboardingApi } from "../api/onboarding";
import { agentsApi } from "../api/agents";
import { conversationsApi } from "../api/conversations";
import { useCompany } from "../context/CompanyContext";
import type { CardContext } from "../components/cards";

interface BootstrapState {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
}

export function CoSConversation() {
  const { selectedCompanyId, loading: companiesLoading } = useCompany();
  const [bootstrapped, setBootstrapped] = useState<BootstrapState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Wait for the company list to load before deciding which path to take.
    // On a direct /cos navigation, selectedCompanyId starts null until the
    // company query resolves. Without this guard, we'd fall through to
    // bootstrap and create/reuse the wrong company.
    if (companiesLoading) return;

    // If a company is already selected in the sidebar, try to load its existing
    // CoS conversation first. Only fall back to bootstrap (which creates a
    // company + CoS + conversation) if there's no selected company.
    async function resolve() {
      if (selectedCompanyId) {
        try {
          const conv = await conversationsApi.companyInbox(selectedCompanyId);
          if (cancelled) return;
          // Find the CoS agent for this company
          const agents = await agentsApi.list(selectedCompanyId);
          if (cancelled) return;
          const cos = agents.find((a) => a.role === "chief_of_staff") ?? agents[0];
          if (conv && cos) {
            setBootstrapped({
              companyId: selectedCompanyId,
              cosAgentId: cos.id,
              conversationId: conv.id,
            });
            return;
          }
          // No conversation exists yet — bootstrap will create it
        } catch {
          // Fall through to bootstrap
        }
      }

      // First-time onboarding path: bootstrap creates company + CoS + conversation
      try {
        const r = await onboardingApi.bootstrap();
        if (cancelled) return;
        setBootstrapped({
          companyId: r.companyId,
          cosAgentId: r.cosAgentId,
          conversationId: r.conversationId,
        });
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to bootstrap workspace";
        setError(msg);
      }
    }

    resolve();
    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId, companiesLoading]);

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
      // Phase D: confirm the agent_plan_proposal_v1 card -> materialize agents.
      // (The legacy proposal_card_v1 path is also fired via this callback; the
      // server already created that agent at card-emit time, so confirm-plan
      // is the only path that materializes here.)
      try {
        await onboardingApi.confirmPlan({
          conversationId: bootstrapped.conversationId,
        });
      } catch {
        // Non-blocking — the closing message + agents land via WS regardless.
      }
    },
    onProposalReject: async (reason) => {
      // Phase F revision-loop is deferred — server stub returns 501 — but we
      // still wire the button so the round-trip is observable.
      try {
        await onboardingApi.revisePlan({
          conversationId: bootstrapped.conversationId,
          revisionText: reason ?? "",
        });
      } catch {
        // Expected until Phase F lands.
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
    />
  );
}

// Separate component so the agents-list useQuery hook is only mounted once we
// have a real companyId; keeps hook order stable across the error/loading
// branches above.
function CoSConversationView({
  bootstrapped,
  cardContext,
}: {
  bootstrapped: BootstrapState;
  cardContext: CardContext;
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
      />
    </div>
  );
}
