import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HumanChannelProvider } from "@paperclipai/shared";
import { ApiError } from "../../api/client";
import { humanChannelsApi } from "../../api/human-channels";
import { queryKeys } from "../../lib/queryKeys";

/**
 * AgentDash-MK: pair the signed-in steward's own identity to a chat channel.
 *
 * These are the `/me/` routes, so the surface belongs on the steward's own
 * page: a person pairs THEIR account, and identity is always the session —
 * there is no field for a Telegram id or a phone number, and there must never
 * be one. Both proofs of control come from the user sending the minted token
 * FROM the account itself; a typed identifier proves nothing.
 *
 * Every provider gets a row, Teams included. When Teams answers 503 (the bot is
 * not configured) the row stays and reads "not available" — the gap is left
 * visible rather than hidden, so a steward can see why the escalation channel
 * is not offered.
 */

interface ProviderRow {
  id: HumanChannelProvider;
  label: string;
  blurb: string;
  /** Rendered under every state; the WhatsApp window is a standing fact. */
  caveat?: string;
}

const PROVIDERS: ProviderRow[] = [
  {
    id: "telegram",
    label: "Telegram",
    blurb: "Decide approvals and talk to your agent from Telegram.",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    blurb: "Decide approvals and talk to your agent from WhatsApp.",
    caveat:
      "WhatsApp only delivers free-form messages within a 24-hour window that " +
      "opens on your last inbound message. Outside it you will first receive a " +
      "template prompt to reopen the window.",
  },
  {
    id: "teams",
    label: "Teams",
    blurb: "Receive stalled escalations and decide approvals from Microsoft Teams.",
  },
];

export function MyChannels({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();

  const channels = useQuery({
    queryKey: queryKeys.myAgent.channels(companyId),
    queryFn: () => humanChannelsApi.listMine(companyId),
    enabled: !!companyId,
  });

  const pair = useMutation({
    mutationFn: (provider: HumanChannelProvider) =>
      humanChannelsApi.startPairing(companyId, provider),
  });

  const revoke = useMutation({
    mutationFn: (bindingId: string) => humanChannelsApi.revoke(companyId, bindingId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.myAgent.channels(companyId) });
    },
  });

  const bindings = channels.data?.bindings ?? [];

  return (
    <section aria-labelledby="my-agent-channels-heading" className="rounded-lg border p-4">
      <h2 id="my-agent-channels-heading" className="text-sm font-semibold">
        Channels
      </h2>

      <div className="mt-2 flex flex-col gap-3 text-xs">
        {PROVIDERS.map((provider) => {
          const active = bindings.find(
            (binding) => binding.provider === provider.id && !binding.revokedAt,
          );
          // A minted link belongs only under the provider it was minted for;
          // the mutation holds one result at a time, so key on the variable it
          // was called with.
          const isThisProvider = pair.variables === provider.id;
          const showLink = pair.data && isThisProvider && pair.isSuccess;
          const pairError = isThisProvider && pair.isError ? pair.error : null;
          // Teams 503 is the "not available" case; anything else is a real error
          // the steward should read verbatim.
          const teamsUnavailable =
            provider.id === "teams" &&
            pairError instanceof ApiError &&
            pairError.status === 503;

          return (
            <div key={provider.id} className="flex flex-col gap-1">
              {active ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    {provider.label} · <span className="font-medium">Connected</span>
                  </span>
                  <button
                    type="button"
                    className="rounded border px-2 py-1 text-xs"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(active.id)}
                  >
                    {revoke.isPending ? "Disconnecting…" : "Disconnect"}
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-muted-foreground">{provider.blurb}</p>
                  <div>
                    <button
                      type="button"
                      className="rounded border px-2 py-1 text-xs"
                      disabled={pair.isPending && isThisProvider}
                      onClick={() => pair.mutate(provider.id)}
                    >
                      {pair.isPending && isThisProvider
                        ? "Generating link…"
                        : `Connect ${provider.label}`}
                    </button>
                  </div>
                  {showLink && (
                    <p>
                      <a
                        href={pair.data!.deepLink}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        Open {provider.label} to finish connecting
                      </a>{" "}
                      <span className="text-muted-foreground">
                        — single use, expires{" "}
                        {new Date(pair.data!.expiresAt).toLocaleTimeString()}
                      </span>
                    </p>
                  )}
                  {teamsUnavailable && (
                    <p className="text-muted-foreground" role="status">
                      Teams is not available yet — an administrator must configure
                      the Teams bot before this channel can be paired.
                    </p>
                  )}
                  {pairError && !teamsUnavailable && (
                    <p className="text-destructive" role="alert">
                      {pairError instanceof Error
                        ? pairError.message
                        : "Could not start pairing"}
                    </p>
                  )}
                </>
              )}
              {provider.caveat && (
                <p className="text-muted-foreground">{provider.caveat}</p>
              )}
            </div>
          );
        })}
      </div>

      {revoke.isError && (
        <p className="mt-2 text-destructive" role="alert">
          {revoke.error instanceof Error ? revoke.error.message : "Could not disconnect"}
        </p>
      )}
    </section>
  );
}
