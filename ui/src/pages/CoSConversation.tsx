// AgentDash: CoSConversation — onboarding v2 entry point
import { useEffect, useState } from "react";
import ChatPanel from "./ChatPanel";
import { onboardingApi } from "../api/onboarding";
import type { CardContext } from "../components/cards";

interface BootstrapState {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
}

export function CoSConversation() {
  const [bootstrapped, setBootstrapped] = useState<BootstrapState | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    onProposalConfirm: () => {
      // Already confirmed server-side when proposal_card_v1 was emitted; no-op in v1.
    },
    onProposalReject: async (reason) => {
      try {
        await onboardingApi.rejectAgent({
          conversationId: bootstrapped.conversationId,
          cosAgentId: bootstrapped.cosAgentId,
          reason,
        });
        // Re-trigger confirm to get a new proposal.
        await onboardingApi.confirmAgent({
          conversationId: bootstrapped.conversationId,
          reportsToAgentId: bootstrapped.cosAgentId,
          companyId: bootstrapped.companyId,
        });
      } catch {
        // Non-blocking — the chat transcript already reflects the rejection.
      }
    },
    onInviteSend: async (emails) => {
      try {
        await onboardingApi.sendInvites({
          conversationId: bootstrapped.conversationId,
          companyId: bootstrapped.companyId,
          emails,
        });
      } catch {
        // Non-blocking — onboarding completes even on partial invite failure.
      }
    },
    onInviteSkip: () => {
      // No-op; the InvitePrompt closes itself.
    },
  };

  return (
    <div className="fixed inset-0 flex flex-col">
      <ChatPanel
        conversationId={bootstrapped.conversationId}
        companyId={bootstrapped.companyId}
        cardContext={cardContext}
        agentDirectory={[]}
      />
    </div>
  );
}
