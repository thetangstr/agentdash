// AgentDash: chat substrate message list — bubble layout
import { Sparkles } from "lucide-react";
import type { Message } from "../api/conversations";
import { CardRenderer, type CardContext } from "./cards";
import { ChatMarkdown } from "./ChatMarkdown";

export function MessageList({
  messages,
  cardContext,
}: {
  messages: Message[];
  cardContext: CardContext;
}) {
  // AgentDash (scan 4, lane N): older conversations hold a separate "Task
  // created" message next to the proposal card that already turned into one.
  // Show the task once.
  const createdFromProposals = new Set<string>();
  for (const m of messages) {
    const payload = m.cardKind === "issue_proposal_v1" ? (m.cardPayload as { issueId?: unknown } | null) : null;
    if (payload && typeof payload.issueId === "string") createdFromProposals.add(payload.issueId);
  }
  const visible = messages.filter((m) => {
    if (m.cardKind !== "issue_created_v1") return true;
    const issueId = (m.cardPayload as { issueId?: unknown } | null)?.issueId;
    return !(typeof issueId === "string" && createdFromProposals.has(issueId));
  });

  return (
    <div className="message-list flex flex-col gap-5">
      {visible.map((m) => {
        const author = m.role ?? m.authorKind;
        const isAgent = author === "agent";
        const text = m.content ?? m.body ?? "";
        const timeStr = new Date(m.createdAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });

        // AgentDash (scan 3, lane G): a card (plan, invite, status, review)
        // renders full width with no chat-bubble wrapper. Inside the 80%
        // bubble next to the avatar a phone left the plan card one word wide.
        // From sm up it lines up with the agent bubbles (avatar + gap = 44px).
        if (m.cardKind && m.cardKind !== "interview_question_v1") {
          return (
            <div
              key={m.id}
              className="flex w-full min-w-0 flex-col gap-1 sm:pl-11"
              data-testid="chat-card-message"
              data-card-kind={m.cardKind}
            >
              <div className="w-full min-w-0">
                <CardRenderer
                  cardKind={m.cardKind}
                  payload={m.cardPayload}
                  context={cardContext}
                  messageId={m.id}
                  conversationId={m.conversationId}
                />
              </div>
              <span className="text-[11px] text-text-tertiary px-1">{timeStr}</span>
            </div>
          );
        }

        return (
          <div
            key={m.id}
            className={`flex items-end gap-3 ${isAgent ? "justify-start" : "justify-end"}`}
          >
            {/* Agent avatar — left side only */}
            {isAgent && (
              <div className="w-8 h-8 rounded-full bg-accent-500 flex items-center justify-center shrink-0 mb-5 max-sm:hidden">
                <Sparkles className="w-3.5 h-3.5 text-text-inverse" aria-hidden="true" />
              </div>
            )}

            {/* Bubble + timestamp column */}
            <div className={`flex min-w-0 flex-col gap-1 max-w-[80%] max-sm:max-w-full ${isAgent ? "items-start" : "items-end"}`}>
              {m.cardKind === "interview_question_v1" ? (
                // Interview questions render as a normal agent text bubble —
                // no "Step N" chip. The chip framed it as a survey, which
                // didn't match the conversational tone the CoS is meant to set.
                <div className="bg-surface-raised border border-border-soft text-text-primary px-4 py-3 rounded-2xl rounded-tl-sm leading-relaxed text-sm whitespace-pre-wrap max-sm:[overflow-wrap:anywhere] max-sm:px-3.5 max-sm:py-2.5">
                  {(m.cardPayload as any)?.question ?? text}
                </div>
              ) : isAgent ? (
                // AgentDash (scan 4, lane N): agent replies are markdown.
                <div className="bg-surface-raised border border-border-soft text-text-primary px-4 py-3 rounded-2xl rounded-tl-sm leading-relaxed text-sm max-sm:[overflow-wrap:anywhere] max-sm:px-3.5 max-sm:py-2.5">
                  <ChatMarkdown>{text}</ChatMarkdown>
                </div>
              ) : (
                <div className="bg-accent-500 text-text-inverse px-4 py-3 rounded-2xl rounded-br-sm leading-relaxed text-sm whitespace-pre-wrap max-sm:[overflow-wrap:anywhere] max-sm:px-3.5 max-sm:py-2.5">
                  {text}
                </div>
              )}

              {/* Timestamp below bubble */}
              <span className="text-[11px] text-text-tertiary px-1 max-sm:text-xs">{timeStr}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
