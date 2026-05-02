// AgentDash: chat substrate message list
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
    <div className="message-list space-y-4">
      {messages.map((m) => {
        const author = m.role ?? m.authorKind;
        const text = m.content ?? m.body ?? "";
        return (
          <div key={m.id} className={`msg msg--${author}`}>
            <div className="text-xs text-gray-500">
              {author === "agent" ? "Agent" : "You"} ·{" "}
              {new Date(m.createdAt).toLocaleTimeString()}
            </div>
            {m.cardKind ? (
              <CardRenderer cardKind={m.cardKind} payload={m.cardPayload} context={cardContext} />
            ) : (
              <div className="msg__body whitespace-pre-wrap">{text}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
