import { stripeWebhookEvents } from "@paperclipai/db";

export function stripeWebhookLedger(db: any) {
  return {
    record: async (eventId: string, eventType: string, payload: any) => {
      // AgentDash (SC-8): usable inside the entitlement transaction. Catching
      // a unique violation would leave that PostgreSQL transaction aborted.
      const inserted = await db.insert(stripeWebhookEvents).values({ eventId, eventType, payload })
        .onConflictDoNothing({ target: stripeWebhookEvents.eventId }).returning({ eventId: stripeWebhookEvents.eventId });
      return { inserted: inserted.length > 0 };
    },
  };
}
