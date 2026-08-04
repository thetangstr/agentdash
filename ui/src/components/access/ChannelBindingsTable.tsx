import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import { ApiError } from "@/api/client";
import { humanChannelsApi } from "@/api/human-channels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";

/**
 * AgentDash-MK: administrator audit view of every human↔channel binding in the
 * company, with a revoke control.
 *
 * Read-only by construction of the backing route: `GET /channel-bindings` is
 * administrator-only and answers 403 to everyone else, so a non-admin who
 * somehow renders this sees the refusal, never another member's binding. The
 * UI does not re-implement that authority — it reflects the server's answer.
 */
export function ChannelBindingsTable({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();

  const bindingsQuery = useQuery({
    queryKey: queryKeys.access.channelBindings(companyId),
    queryFn: () => humanChannelsApi.listAll(companyId),
    enabled: !!companyId,
    retry: false,
  });

  const revoke = useMutation({
    mutationFn: (bindingId: string) => humanChannelsApi.revoke(companyId, bindingId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.channelBindings(companyId) });
    },
  });

  const header = (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Channel bindings</h2>
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Every verified human↔channel pairing in this company. Revoking one severs
        that person's chat channel; it does not remove their membership.
      </p>
    </div>
  );

  if (bindingsQuery.isLoading) {
    return (
      <section className="space-y-4">
        {header}
        <p className="text-sm text-muted-foreground">Loading channel bindings…</p>
      </section>
    );
  }

  if (bindingsQuery.error) {
    const forbidden =
      bindingsQuery.error instanceof ApiError && bindingsQuery.error.status === 403;
    const message = forbidden
      ? "You do not have permission to view company channel bindings. This audit view is limited to owners and administrators."
      : bindingsQuery.error instanceof Error
        ? bindingsQuery.error.message
        : "Failed to load channel bindings.";
    return (
      <section className="space-y-4">
        {header}
        <p className="text-sm text-destructive" role="alert">
          {message}
        </p>
      </section>
    );
  }

  const bindings = bindingsQuery.data?.bindings ?? [];

  return (
    <section className="space-y-4">
      {header}
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="grid grid-cols-[120px_minmax(0,1.4fr)_120px_120px] gap-3 border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <div>Provider</div>
          <div>External identity</div>
          <div>Status</div>
          <div className="text-right">Action</div>
        </div>
        {bindings.length === 0 ? (
          <div className="px-4 py-8 text-sm text-muted-foreground">
            No channel bindings in this company yet.
          </div>
        ) : (
          bindings.map((binding) => {
            const revoked = !!binding.revokedAt;
            return (
              <div
                key={binding.id}
                className="grid grid-cols-[120px_minmax(0,1.4fr)_120px_120px] gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="text-sm font-medium">{binding.provider}</div>
                <div className="min-w-0 text-sm">
                  <div className="truncate">{binding.externalUserId}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    user {binding.userId}
                  </div>
                </div>
                <div>
                  <Badge variant={revoked ? "outline" : "secondary"}>
                    {revoked ? "revoked" : "active"}
                  </Badge>
                </div>
                <div className="text-right">
                  {revoked ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(binding.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      {revoke.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {revoke.error instanceof Error ? revoke.error.message : "Failed to revoke binding."}
        </p>
      ) : null}
    </section>
  );
}
