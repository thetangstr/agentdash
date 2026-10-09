import { api } from "./client";

/** The signed-in person's own notification choices. */
export interface NotificationPreferences {
  /** Email me when my agents ask me something or need a decision. */
  inboxEmail: boolean;
  /** False when this instance sends no email at all. */
  emailConfigured: boolean;
}

export const notificationPreferencesApi = {
  get: () => api.get<NotificationPreferences>("/notification-preferences/me"),
  update: (input: { inboxEmail: boolean }) =>
    api.put<NotificationPreferences>("/notification-preferences/me", input),
};
