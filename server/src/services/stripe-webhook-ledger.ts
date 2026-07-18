import { stripeWebhookEvents } from "@paperclipai/db";
import { isUniqueViolation } from "../lib/pg-error.js";

export function stripeWebhookLedger(db: any) {
  return {
    record: async (eventId: string, eventType: string, payload: any) => {
      try {
        await db.insert(stripeWebhookEvents).values({ eventId, eventType, payload });
        return { inserted: true };
      } catch (err: any) {
        if (isUniqueViolation(err)) return { inserted: false }; // duplicate
        throw err;
      }
    },
  };
}
