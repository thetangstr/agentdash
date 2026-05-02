import { publishLiveEvent } from "../services/live-events.js";

export function emitMessageCreated(message: {
  id: string;
  conversationId: string;
  companyId: string;
  [key: string]: unknown;
}): void {
  publishLiveEvent({
    companyId: message.companyId,
    type: "message.created",
    payload: { message },
  });
}

export function emitMessageRead(input: {
  conversationId: string;
  userId: string;
  lastReadMessageId: string;
  companyId: string;
}): void {
  publishLiveEvent({
    companyId: input.companyId,
    type: "message.read",
    payload: {
      conversationId: input.conversationId,
      userId: input.userId,
      lastReadMessageId: input.lastReadMessageId,
    },
  });
}
