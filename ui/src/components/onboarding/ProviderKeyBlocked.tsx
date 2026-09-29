// AgentDash (GH #794, UX-13): the model-key dead end, fixed.
//
// A member who needs a model provider key but cannot set one used to get a
// bare "ask whoever set up the workspace" with no name and no action. This
// names the people who can act (instance admins first, owner/admin members
// as the fallback) and offers "Let them know" — an email through the
// existing mailer. Shared by the /cos provider step, the hosted first-run
// waiting state, and Settings → Model key for non-admins.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MailCheck } from "lucide-react";
import { ApiError } from "@/api/client";
import { onboardingApi, type ModelKeyAdmin, type ModelKeyRequestResult } from "@/api/onboarding";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";

function displayName(admin: ModelKeyAdmin): string {
  return admin.name ?? "a workspace admin";
}

function nameList(admins: ModelKeyAdmin[]): string {
  const names = admins.map(displayName);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function ProviderKeyBlocked({ companyId, homeHref }: { companyId: string; homeHref?: string }) {
  const admins = useQuery({
    queryKey: ["onboarding", "model-key-admins", companyId],
    queryFn: () => onboardingApi.modelKeyAdmins(companyId),
    retry: false,
  });
  const [results, setResults] = useState<ModelKeyRequestResult[] | null>(null);

  const notify = useMutation({
    mutationFn: () => onboardingApi.requestModelKey(companyId),
    onSuccess: (data) => setResults(data.results),
  });

  const people = admins.data?.admins ?? [];
  const fixers = people.filter((admin) => admin.canFix);
  const contacts = fixers.length > 0 ? fixers : people;
  const sent = results?.some((result) => result.status === "sent") ?? false;
  const noRecipients = results !== null && results.length === 0;
  // The server rate-limits repeat nudges (429) — reflect it instead of
  // letting the button look clickable for a request that will be refused.
  const cooldownActive = notify.error instanceof ApiError && notify.error.status === 429;

  return (
    <div className="mt-3 space-y-3" data-testid="provider-key-blocked">
      {contacts.length > 0 ? (
        <p className="text-muted-foreground">
          Ask <span className="font-medium text-foreground">{nameList(contacts)}</span> — an admin
          can add the key under{" "}
          <Link className="underline" to="/company/settings/model-key">
            Settings → Model key
          </Link>
          .
        </p>
      ) : (
        <p className="text-muted-foreground">
          Ask a workspace admin — they can add the key under{" "}
          <Link className="underline" to="/company/settings/model-key">
            Settings → Model key
          </Link>
          .
        </p>
      )}

      {results === null ? (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={notify.isPending || contacts.length === 0 || cooldownActive}
            onClick={() => notify.mutate()}
          >
            {notify.isPending ? "Letting them know…" : cooldownActive ? "They've been told" : "Let them know"}
          </Button>
          {notify.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {cooldownActive
                ? notify.error.message
                : "Could not reach the server — try again or message them directly."}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="provider-key-notified">
          <MailCheck className="h-4 w-4 text-emerald-600" />
          {sent
            ? "Done — they've been emailed."
            : noRecipients
              ? "No one has an email address on file — message them directly."
              : "The email couldn't be sent — message them directly."}
        </p>
      )}

      {homeHref ? (
        <Link className="inline-block text-sm underline" to={homeHref}>
          Go to Home
        </Link>
      ) : null}
    </div>
  );
}
