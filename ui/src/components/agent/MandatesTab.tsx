import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { mandatesApi, type Attestation, type Mandate } from "@/api/mandates";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatCents, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PERMISSION_KEY = "clockchain:attest";

type MandateAgent = { id: string; name: string; role?: string };

function parseDollarsToCents(value: string): number | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function expiryDateToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function agentName(agents: MandateAgent[], id: string) {
  return agents.find((a) => a.id === id)?.name ?? "Unknown agent";
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active" || status === "granted") return "default";
  if (status === "revoked" || status === "expired") return "destructive";
  return "secondary";
}

function mandateAction(mandate: Mandate): string | null {
  if (!Array.isArray(mandate.scope) || mandate.scope.length === 0) return null;
  return mandate.scope.includes("release_payment") ? "release_payment" : mandate.scope[0];
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function attestationBadge(att: Attestation): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  if (att.receiptStatus === "anchored") {
    return {
      label: att.blockHeight != null ? `Anchored · block ${att.blockHeight}` : "Anchored",
      variant: "secondary",
    };
  }
  if (att.receiptStatus === "denied") {
    return {
      label: att.reason ? `Denied — ${att.reason}` : "Denied",
      variant: "destructive",
    };
  }
  if (att.receiptStatus === "pending") {
    return { label: "Pending", variant: "outline" };
  }
  return { label: att.receiptStatus, variant: "outline" };
}

export function MandatesTab({
  companyId,
  agentId,
  agents,
}: {
  companyId: string;
  agentId: string;
  agents: MandateAgent[];
}) {
  const queryClient = useQueryClient();

  const eligibleGrantors = agents.filter((a) => a.id !== agentId);
  const defaultGrantorId =
    eligibleGrantors.find((a) => a.role === "ceo")?.id ?? eligibleGrantors[0]?.id ?? "";

  const [grantorAgentId, setGrantorAgentId] = useState(defaultGrantorId);
  const [actions, setActions] = useState("");
  const [dollars, setDollars] = useState("");
  const [expiry, setExpiry] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setGrantorAgentId((current) => {
      if (current && eligibleGrantors.some((a) => a.id === current)) return current;
      return defaultGrantorId;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultGrantorId]);

  const { data: mandates, isLoading, error: listError } = useQuery({
    queryKey: queryKeys.mandates.list(companyId, agentId),
    queryFn: () => mandatesApi.list(companyId, agentId),
    enabled: !!companyId && !!agentId,
  });

  const {
    data: attestations,
    isLoading: attestationsLoading,
    error: attestationsError,
  } = useQuery({
    queryKey: queryKeys.mandates.attestations(companyId),
    queryFn: () => mandatesApi.listAttestations(companyId),
    enabled: !!companyId,
  });

  const runAttestationMutation = useMutation({
    mutationFn: (vars: { mandateId: string; action: string }) =>
      mandatesApi.runAttestation(companyId, vars),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mandates.attestations(companyId) });
    },
  });

  const createMutation = useMutation({
    mutationFn: (vars: { scope: string[]; spendCapCents: number; expiresAt: string }) =>
      mandatesApi.create(companyId, {
        grantorAgentId,
        granteeAgentId: agentId,
        scope: vars.scope,
        permissionKey: PERMISSION_KEY,
        spendCapCents: vars.spendCapCents,
        expiresAt: vars.expiresAt,
      }),
    onSuccess: () => {
      setFormError(null);
      setActions("");
      setDollars("");
      setExpiry("");
      queryClient.invalidateQueries({ queryKey: queryKeys.mandates.list(companyId, agentId) });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Failed to grant mandate");
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!grantorAgentId) {
      setFormError("Choose a grantor.");
      return;
    }
    const scope = actions.split(",").map((s) => s.trim()).filter(Boolean);
    if (scope.length === 0) {
      setFormError("Add at least one allowed action.");
      return;
    }
    const spendCapCents = parseDollarsToCents(dollars);
    if (spendCapCents === null) {
      setFormError("Enter a valid non-negative dollar amount.");
      return;
    }
    const expiresAt = expiryDateToIso(expiry);
    if (!expiresAt) {
      setFormError("Choose an expiry date.");
      return;
    }

    setFormError(null);
    createMutation.mutate({ scope, spendCapCents, expiresAt });
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardContent className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Grant a mandate</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Authorize this agent to attest actions to Clockchain on another agent's behalf.
            </p>
          </div>

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="mandate-grantor">Grantor</Label>
                <Select value={grantorAgentId} onValueChange={setGrantorAgentId}>
                  <SelectTrigger id="mandate-grantor" className="w-full">
                    <SelectValue placeholder="Select a grantor" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleGrantors.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="mandate-cap">Spend cap (USD)</Label>
                <Input
                  id="mandate-cap"
                  value={dollars}
                  onChange={(event) => setDollars(event.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="mandate-actions">Allowed actions (comma-separated)</Label>
                <Input
                  id="mandate-actions"
                  value={actions}
                  onChange={(event) => setActions(event.target.value)}
                  placeholder="e.g. release_payment, attest_invoice"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="mandate-expiry">Expires</Label>
                <input
                  id="mandate-expiry"
                  type="date"
                  value={expiry}
                  onChange={(event) => setExpiry(event.target.value)}
                  className={cn(
                    "border-border-soft h-9 w-full min-w-0 rounded-md border bg-surface-raised px-3 py-1 text-base text-text-primary shadow-sm transition-[color,box-shadow] outline-none",
                    "focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200",
                    "md:text-sm",
                  )}
                />
              </div>
            </div>

            {formError && <p className="text-sm text-destructive">{formError}</p>}

            <Button type="submit" disabled={createMutation.isPending || eligibleGrantors.length === 0}>
              {createMutation.isPending ? "Granting..." : "Grant mandate"}
            </Button>
            {eligibleGrantors.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No other agents available to act as grantor.
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Granted mandates</h3>

        {listError && (
          <p className="text-sm text-destructive">
            {listError instanceof Error ? listError.message : "Failed to load mandates"}
          </p>
        )}

        {!isLoading && (mandates ?? []).length === 0 && !listError && (
          <p className="text-sm text-muted-foreground">No mandates granted to this agent yet.</p>
        )}

        {(mandates ?? []).map((mandate: Mandate) => {
          const action = mandateAction(mandate);
          const runningThis =
            runAttestationMutation.isPending &&
            runAttestationMutation.variables?.mandateId === mandate.id;
          return (
            <Card key={mandate.id}>
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-text-primary">
                    {agentName(agents, mandate.grantorAgentId)} → {agentName(agents, mandate.granteeAgentId)}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant(mandate.status)}>{mandate.status}</Badge>
                    {mandate.ccLedgerId && mandate.ccBlockHeight != null ? (
                      <Badge variant="secondary">Anchored · block {mandate.ccBlockHeight}</Badge>
                    ) : mandate.ccLedgerId ? (
                      <Badge variant="outline">Pending anchor</Badge>
                    ) : (
                      <Badge variant="outline">Not anchored</Badge>
                    )}
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  {Array.isArray(mandate.scope) && mandate.scope.length > 0
                    ? mandate.scope.join(", ")
                    : "No actions in scope"}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Cap {formatCents(mandate.spendCapCents)}</span>
                  <span>Expires {formatDate(mandate.expiresAt)}</span>
                </div>
                {action && (
                  <div className="pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      disabled={runningThis || runAttestationMutation.isPending}
                      onClick={() =>
                        runAttestationMutation.mutate({ mandateId: mandate.id, action })
                      }
                    >
                      {runningThis ? `Running ${action}…` : `Run ${action}`}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Attested actions</h3>

        {attestationsError && (
          <p className="text-sm text-destructive">
            {attestationsError instanceof Error
              ? attestationsError.message
              : "Failed to load attested actions"}
          </p>
        )}

        {attestationsLoading && (
          <p className="text-sm text-muted-foreground">Loading attested actions…</p>
        )}

        {!attestationsLoading && (attestations ?? []).length === 0 && !attestationsError && (
          <p className="text-sm text-muted-foreground">
            No attested actions yet — run one above.
          </p>
        )}

        {(attestations ?? []).map((att: Attestation) => {
          const badge = attestationBadge(att);
          return (
            <Card key={att.id}>
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-text-primary">{att.action}</div>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{att.counterpartyDid}</span>
                  <span>mandate {shortId(att.mandateId)}</span>
                  <span>{formatDate(att.createdAt)}</span>
                </div>
                {att.ledgerId && (
                  <div className="font-mono text-xs text-muted-foreground">
                    ledger {att.ledgerId}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
