// AgentDash: chat substrate message list — bubble layout
import { Sparkles } from "lucide-react";
import type { Message } from "../api/conversations";
import { CardRenderer, type CardContext } from "./cards";

export function MessageList({
  messages,
  cardContext,
}: {
  messages: Message[];
  cardContext: CardContext;
}) {
  return (
    <div className="message-list flex flex-col gap-5">
      {messages.map((m) => {
        const author = m.role ?? m.authorKind;
        const isAgent = author === "agent";
        const text = m.content ?? m.body ?? "";
        const timeStr = new Date(m.createdAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });

        return (
          <div
            key={m.id}
            className={`flex items-end gap-3 ${isAgent ? "justify-start" : "justify-end"}`}
          >
            {/* Agent avatar — left side only */}
            {isAgent && (
              <div className="w-8 h-8 rounded-full bg-accent-500 flex items-center justify-center shrink-0 mb-5">
                <Sparkles className="w-3.5 h-3.5 text-text-inverse" aria-hidden="true" />
              </div>
            )}

            {/* Bubble + timestamp column */}
            <div className={`flex flex-col gap-1 max-w-[80%] ${isAgent ? "items-start" : "items-end"}`}>
              {m.cardKind ? (
                <>
                  {m.cardKind === "interview_question_v1" ? (
                    // Interview questions: pull question text out as bubble body;
                    // show a small "Step N" chip above the bubble if fixedIndex is set.
                    <div className="flex flex-col gap-1 items-start w-full">
                      {typeof (m.cardPayload as any)?.fixedIndex === "number" && (
                        <span className="text-[10px] font-semibold tracking-widest uppercase text-accent-500 px-1">
                          Step {(m.cardPayload as any).fixedIndex + 1}
                        </span>
                      )}
                      <div className="bg-surface-raised border border-border-soft text-text-primary px-4 py-3 rounded-2xl rounded-tl-sm leading-relaxed text-sm">
                        {(m.cardPayload as any)?.question ?? text}
                      </div>
                    </div>
                  ) : (
                    // All other card kinds — render through CardRenderer as before
                    <div className="bg-surface-raised border border-border-soft rounded-2xl rounded-tl-sm px-4 py-3 w-full">
                      <CardRenderer cardKind={m.cardKind} payload={m.cardPayload} context={cardContext} />
                    </div>
                  )}
                </>
              ) : isAgent ? (
                <div className="bg-surface-raised border border-border-soft text-text-primary px-4 py-3 rounded-2xl rounded-tl-sm leading-relaxed text-sm whitespace-pre-wrap">
                  {text}
                </div>
              ) : (
                <div className="bg-accent-500 text-text-inverse px-4 py-3 rounded-2xl rounded-br-sm leading-relaxed text-sm whitespace-pre-wrap">
                  {text}
                </div>
              )}

              {/* Timestamp below bubble */}
              <span className="text-[11px] text-text-tertiary px-1">{timeStr}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
