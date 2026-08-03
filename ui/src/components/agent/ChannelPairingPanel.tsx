import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { stewardshipsApi } from "../../api/stewardships";
import { queryKeys } from "../../lib/queryKeys";

/**
 * AgentDash-MK: connect a chat channel to the signed-in steward's agent.
 *
 * Minting is deliberately an explicit act rather than something the page does
 * on load. A user holds at most one outstanding challenge per provider, so
 * minting invalidates any link they already opened — a page refresh must not
 * silently break a pairing in progress on their phone.
 *
 * The component never sees the raw token. The server returns a deep link and
 * only a deep link, so there is nothing here that could be logged or copied
 * separately from the thing the user is meant to open.
 *
 * There is no field for a Telegram id or a phone number, and there must never
 * be one: both ceremonies prove control by having the user send the token from
 * the account itself. A typed identifier proves nothing, and for WhatsApp — where
 * the identifier is a guessable phone number — it would be the sharpest edge in
 * the product.
 */

type PairableProvider = "telegram" | "whatsapp";

const PROVIDERS: Array<{ id: PairableProvider; label: string; blurb: string }> = [
  {
    id: "telegram",
    label: "Telegram",
    blurb: "Decide approvals and talk to your agent from Telegram.",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    blurb: "Decide approvals and talk to your agent from WhatsApp.",
  },
];

export function ChannelPairingPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();

  const channels = useQuery({
    queryKey: queryKeys.myAgent.channels(companyId),
    queryFn: () => stewardshipsApi.listMyChannels(companyId),
    enabled: !!companyId,
  });

  const pair = useMutation({
    mutationFn: (provider: PairableProvider) => stewardshipsApi.startPairing(companyId, provider),
  });

  const revoke = useMutation({
    mutationFn: (bindingId: string) => stewardshipsApi.revokeChannel(companyId, bindingId),
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
          // A link is shown only for the provider it was minted for; the
          // mutation holds one result at a time, so keying on the variable it
          // was called with keeps a Telegram link from appearing under WhatsApp.
          const showLink = pair.data && pair.variables === provider.id;

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
                      disabled={pair.isPending}
                      onClick={() => pair.mutate(provider.id)}
                    >
                      {pair.isPending && pair.variables === provider.id
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
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Both the owner-ceiling refusal and the missing-config case land here.
          A button that quietly does nothing reads as a broken page. */}
      {pair.error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {pair.error instanceof Error ? pair.error.message : "Could not start pairing"}
        </p>
      )}
      {revoke.error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {revoke.error instanceof Error ? revoke.error.message : "Could not disconnect"}
        </p>
      )}
    </section>
  );
}
