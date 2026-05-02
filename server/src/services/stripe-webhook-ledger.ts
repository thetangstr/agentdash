import { stripeWebhookEvents } from "@paperclipai/db";

export function stripeWebhookLedger(db: any) {
  return {
    record: async (eventId: string, eventType: string, payload: any) => {
      try {
        await db.insert(stripeWebhookEvents).values({ eventId, eventType, payload });
        return { inserted: true };
      } catch (err: any) {
        if (err?.code === "23505") return { inserted: false }; // duplicate
        throw err;
      }
    },
  };
}
