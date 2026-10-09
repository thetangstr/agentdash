import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notificationPreferencesApi } from "../../api/notification-preferences";

const QUERY_KEY = ["notification-preferences", "me"] as const;

/**
 * The person's own switch for inbox emails: a pointer, at most every 15
 * minutes, when their agents ask them something or need a decision. On by
 * default. Says plainly when the instance sends no email, rather than offering
 * a switch that does nothing.
 */
export function InboxEmailToggle() {
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: QUERY_KEY, queryFn: () => notificationPreferencesApi.get() });
  const update = useMutation({
    mutationFn: (inboxEmail: boolean) => notificationPreferencesApi.update({ inboxEmail }),
    onSuccess: (data) => queryClient.setQueryData(QUERY_KEY, data),
  });

  if (!prefs.data) return null;
  const { inboxEmail, emailConfigured } = prefs.data;

  return (
    <section aria-labelledby="inbox-email-heading" className="rounded-lg border px-4 py-3">
      <h2 id="inbox-email-heading" className="text-sm font-semibold">
        Email me when my agents need me
      </h2>
      <label className="mt-2 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={inboxEmail}
          disabled={update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
        />
        <span>
          A short email pointing at the issue when an agent asks you a question or needs a decision — at
          most one every 15 minutes. It never contains the question itself; you answer in Claude or Codex
          or here.
        </span>
      </label>
      {!emailConfigured ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This AgentDash instance is not set up to send email, so none will arrive until it is.
        </p>
      ) : null}
      {update.isError ? (
        <p className="mt-2 text-xs text-destructive">Could not save that. Try again.</p>
      ) : null}
    </section>
  );
}
