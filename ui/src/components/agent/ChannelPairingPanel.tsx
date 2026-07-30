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
 */
export function ChannelPairingPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();

  const channels = useQuery({
    queryKey: queryKeys.myAgent.channels(companyId),
    queryFn: () => stewardshipsApi.listMyChannels(companyId),
    enabled: !!companyId,
  });

  const pair = useMutation({
    mutationFn: () => stewardshipsApi.startTelegramPairing(companyId),
  });

  const revoke = useMutation({
    mutationFn: (bindingId: string) => stewardshipsApi.revokeChannel(companyId, bindingId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.myAgent.channels(companyId) });
    },
  });

  const telegram = (channels.data?.bindings ?? []).find(
    (binding) => binding.provider === "telegram" && !binding.revokedAt,
  );

  return (
    <section aria-labelledby="my-agent-channels-heading" className="rounded-lg border p-4">
      <h2 id="my-agent-channels-heading" className="text-sm font-semibold">
        Channels
      </h2>

      {telegram ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span>
            Telegram · <span className="font-medium">Connected</span>
          </span>
          <button
            type="button"
            className="rounded border px-2 py-1 text-xs"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(telegram.id)}
          >
            {revoke.isPending ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-2 text-xs">
          <p className="text-muted-foreground">
            Connect Telegram to decide approvals and talk to your agent from your phone.
          </p>
          <div>
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              disabled={pair.isPending}
              onClick={() => pair.mutate()}
            >
              {pair.isPending ? "Generating link…" : "Connect Telegram"}
            </button>
          </div>
          {pair.data && (
            <p>
              <a
                href={pair.data.deepLink}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Open Telegram to finish connecting
              </a>{" "}
              <span className="text-muted-foreground">
                — single use, expires {new Date(pair.data.expiresAt).toLocaleTimeString()}
              </span>
            </p>
          )}
        </div>
      )}

      {/* Both the owner-ceiling refusal and the missing-bot-username case land
          here. A button that quietly does nothing reads as a broken page. */}
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
