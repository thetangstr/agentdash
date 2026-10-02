import { Link, Navigate, useLocation } from "@/lib/router";
// AgentDash: CoSConversation — onboarding v2 entry point
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ChatPanel from "./ChatPanel";
import { onboardingApi } from "../api/onboarding";
import { ApiError } from "../api/client";
import { agentsApi } from "../api/agents";
import { conversationsApi } from "../api/conversations";
import { useCompany } from "../context/CompanyContext";
import type { CardContext } from "../components/cards";
import { HermesProviderStep } from "../components/onboarding/HermesProviderStep";
import { refreshAccessQueries } from "../lib/access-refresh";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

// AgentDash (GH #786): the CoS page header and suggested first messages.
export const COS_HEADER_LINE = "Tell me what you want built. I'll staff it and ask you only when it's your call.";
// Role-neutral: the first session is not always an engineering company
// (first-session test, Lane A item 4).
export const COS_SUGGESTED_MESSAGES = [
  "Plan this quarter with me",
  "Who should I hire first?",
  "Turn a goal into tasks",
];
// AgentDash: what an empty CoS conversation says before the first message
// arrives. A fresh company's inbox normally opens with a server-posted CoS
// greeting; this covers a conversation that has none yet.
export const COS_EMPTY_STATE_TITLE = "Your Chief of Staff is ready.";
export const COS_EMPTY_STATE_BODY =
  "Tell me what you're trying to get done this quarter and where you want to be in a year. I'll propose a small team, hire it when you say so, and turn the goal into tasks.";

interface BootstrapState {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
}

/**
 * How the conversation sits on the page.
 * - "fullscreen": the founder's first session, before any company exists
 *   (bare /cos during bootstrap). There is no Layout to sit in yet.
 * - "embedded": Ask inside the company Layout at /:prefix/cos, with the
 *   sidebar. The chat fills the content area; only the message list scrolls.
 */
export type CoSConversationLayout = "fullscreen" | "embedded";

/**
 * AgentDash: the bare /cos route. Onboarding, emails, the claim hand-off and
 * older links all point here. Once a company exists, Ask belongs inside the
 * sidebar Layout, so this redirects to the selected company's /:prefix/cos
 * (keeping any query or hash). A brand-new founder with no company yet gets
 * the full-screen bootstrap conversation instead.
 */
export function CoSEntryRoute() {
  const { companies, selectedCompany, loading } = useCompany();
  const location = useLocation();

  if (loading) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Setting up your workspace…
      </div>
    );
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (targetCompany) {
    return (
      <Navigate
        to={`/${targetCompany.issuePrefix}/cos${location.search}${location.hash}`}
        replace
      />
    );
  }

  return <CoSConversation layout="fullscreen" />;
}

/** AgentDash: Ask at /:prefix/cos, rendered inside the sidebar Layout. */
export function CoSAskPage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Ask" }]);
  }, [setBreadcrumbs]);
  return <CoSConversation layout="embedded" />;
}

export function CoSConversation({ layout = "fullscreen" }: { layout?: CoSConversationLayout } = {}) {
  const { selectedCompanyId, loading: companiesLoading } = useCompany();
  const [bootstrapped, setBootstrapped] = useState<BootstrapState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notAvailable, setNotAvailable] = useState<string | null>(null);
  const queryClient = useQueryClient();

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
        const r = await onboardingApi.bootstrap(selectedCompanyId);
        if (cancelled) return;
        // AgentDash: bootstrap may have created the first company; refetch
        // the access queries so the gate does not judge on the old cache.
        await refreshAccessQueries(queryClient);
        if (cancelled) return;
        setBootstrapped({
          companyId: r.companyId,
          cosAgentId: r.cosAgentId,
          conversationId: r.conversationId,
        });
      } catch (err: unknown) {
        if (cancelled) return;
        // AgentDash (PR #956 review): only a workspace owner or admin may set
        // up the Chief of Staff (403), and an archived workspace is refused
        // (409). A member who opens /cos first gets a plain explanation, not
        // an error page.
        if (err instanceof ApiError && (err.status === 403 || err.status === 409)) {
          setNotAvailable(
            err.status === 403
              ? "Your workspace's Chief of Staff isn't set up yet. A workspace owner or admin sets it up the first time they open this page."
              : err.message,
          );
          return;
        }
        const msg = err instanceof Error ? err.message : "Failed to bootstrap workspace";
        setError(msg);
      }
    }

    resolve();
    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId, companiesLoading, queryClient]);

  if (notAvailable) {
    return (
      <div className="mx-auto max-w-lg p-8 text-center text-sm" data-testid="cos-not-available">
        <p className="font-medium">Chief of Staff not available</p>
        <p className="mt-2 text-muted-foreground">{notAvailable}</p>
        <Link className="mt-4 inline-block underline" to="/dashboard">
          Go to Home
        </Link>
      </div>
    );
  }

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
      layout={layout}
    />
  );
}

// Separate component so the agents-list useQuery hook is only mounted once we
// have a real companyId; keeps hook order stable across the error/loading
// branches above.
function CoSConversationView({
  bootstrapped,
  cardContext,
  layout,
}: {
  bootstrapped: BootstrapState;
  cardContext: CardContext;
  layout: CoSConversationLayout;
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

  // AgentDash (GH #786): the CoS page says what the Chief of Staff does and
  // offers first messages, for every company (one UX).

  // AgentDash (#725): a hosted box's Hermes has no model provider until the
  // founder adds a key, so the CoS cannot reply yet. Ask for it first.
  const queryClient = useQueryClient();
  const adapterStatusKey = ["onboarding-adapter-status"];
  const { data: adapterStatus } = useQuery({
    queryKey: adapterStatusKey,
    queryFn: () => onboardingApi.adapterStatus(),
    retry: false,
  });
  const hermesProvider = adapterStatus?.hermesProvider;
  if (hermesProvider?.required && !hermesProvider.configured) {
    return (
      <HermesProviderStep
        companyId={bootstrapped.companyId}
        options={hermesProvider.options}
        canConfigure={hermesProvider.canConfigure}
        onConfigured={() => {
          void queryClient.invalidateQueries({ queryKey: adapterStatusKey });
        }}
      />
    );
  }

  return (
    <div
      data-testid="cos-conversation"
      data-layout={layout}
      className={
        layout === "embedded"
          // Fill Layout's <main> content area: a fixed height on mobile (the
          // page itself scrolls there), the full main height from md up (main
          // scrolls there, so h-full keeps it from ever needing to). Only the
          // message list inside ChatPanel scrolls; the composer stays pinned.
          ? "flex h-[calc(100dvh-10rem)] min-h-[420px] flex-col overflow-hidden rounded-lg border border-border md:h-full md:min-h-0"
          : "fixed inset-0 flex flex-col"
      }
    >
      <div className="shrink-0 border-b px-4 py-2 text-sm"><Link to="/workforce" className="underline">Review hired roles, company knowledge and first jobs</Link></div>
      <div className="min-h-0 flex-1">
        <ChatPanel
          conversationId={bootstrapped.conversationId}
          companyId={bootstrapped.companyId}
          cardContext={cardContext}
          agentDirectory={agentDirectory}
          headerProps={{ agentRole: COS_HEADER_LINE }}
          suggestions={COS_SUGGESTED_MESSAGES}
          emptyState={
            <div className="rounded-lg border border-border-soft bg-surface-raised p-4 text-sm">
              <p className="font-medium">{COS_EMPTY_STATE_TITLE}</p>
              <p className="mt-1 text-text-secondary">{COS_EMPTY_STATE_BODY}</p>
            </div>
          }
        />
      </div>
    </div>
  );
}
