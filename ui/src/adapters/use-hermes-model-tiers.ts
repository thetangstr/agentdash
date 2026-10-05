import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { adaptersApi, type AdapterInfo } from "@/api/adapters";
import { queryKeys } from "@/lib/queryKeys";
import { useBoardOrgAccess } from "@/hooks/useBoardSessionReady";

export type HermesModelTiersInfo = NonNullable<AdapterInfo["modelTiers"]>;

/**
 * The hermes_local high/low model tiers AS THE SERVER RESOLVES THEM on this
 * instance — env overrides applied and the opt-in + BYOK gate evaluated —
 * read from the same GET /api/adapters response the capability store uses.
 * Null while the list is loading; `enabled: false` means a hermes_local
 * agent's empty model means Hermes' own configured default, not a tier.
 */
export function useHermesModelTiers(): HermesModelTiersInfo | null {
  const orgAccess = useBoardOrgAccess();
  const { data: adapters } = useQuery({
    enabled: orgAccess,
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    staleTime: 5 * 60 * 1000,
  });
  return useMemo(
    () => adapters?.find((a) => a.type === "hermes_local")?.modelTiers ?? null,
    [adapters],
  );
}
