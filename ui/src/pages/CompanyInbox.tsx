import { useQuery } from "@tanstack/react-query";
import ChatPanel from "./ChatPanel";
import { conversationsApi } from "../api/conversations";
import { useCompany } from "../context/CompanyContext";

export function CompanyInbox() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? null;

  const { data: conversation, isLoading, error } = useQuery({
    queryKey: ["company-inbox", companyId],
    queryFn: () => conversationsApi.companyInbox(companyId!),
    enabled: !!companyId,
  });

  if (!companyId || !selectedCompany) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
        Select a company to open Company Chat.
      </div>
    );
  }

  if (isLoading || !conversation) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
        Opening Company Chat…
      </div>
    );
  }

  if (error) {
    const message = error instanceof Error ? error.message : "Failed to open Company Chat.";
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {message}
      </div>
    );
  }

  return (
    <div className="fixed inset-y-0 right-0 left-0 md:left-[var(--sidebar-width,0px)] flex flex-col bg-surface-page">
      <ChatPanel
        conversationId={conversation.id}
        companyId={companyId}
        headerProps={{
          agentName: "Company Inbox",
          agentRole: `Chat with ${selectedCompany.name}'s CoS and route work into Paperclip objects.`,
        }}
      />
    </div>
  );
}
