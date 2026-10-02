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

/**
 * AgentDash (scan 4, lane N): a card message changed state in place (a plan
 * was hired, a task suggestion was created or declined). Open chats replace
 * the message by id, so every viewer sees the new state without a reload.
 */
export function emitMessageUpdated(message: {
  id: string;
  conversationId: string;
  companyId: string;
  [key: string]: unknown;
}): void {
  publishLiveEvent({
    companyId: message.companyId,
    type: "message.updated",
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
