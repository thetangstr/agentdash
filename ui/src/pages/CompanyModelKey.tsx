// AgentDash (GH #794, UX-13): Settings > Model key — the one place to see
// which provider the workspace's agents run on and when the key was last
// checked, and for an instance admin to rotate it. The key itself is
// write-only: it is checked with one small request, stored encrypted, and
// never rendered. Non-admins see the status plus who to ask.
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { ApiError } from "@/api/client";
import { onboardingApi, type HermesProviderId, type HermesProviderOption } from "@/api/onboarding";
import { ProviderKeyBlocked } from "@/components/onboarding/ProviderKeyBlocked";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";

function checkedLabel(configuredAt: string | null): string {
  if (!configuredAt) return "never checked";
  const checked = new Date(configuredAt);
  return `last checked ${checked.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function errorSentence(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong while saving the key. Try again.";
}

export function CompanyModelKey() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Model key" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const adapterStatus = useQuery({
    queryKey: ["onboarding-adapter-status"],
    queryFn: () => onboardingApi.adapterStatus(),
    retry: false,
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to manage the model key.</div>;
  }

  const provider = adapterStatus.data?.hermesProvider;
  const providerLabel =
    provider?.options.find((option) => option.provider === provider.provider)?.label ?? provider?.provider;

  return (
    <div className="max-w-3xl space-y-8" data-testid="company-model-key">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Model key</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The provider your agents and your Chief of Staff run on. The key is checked once when it is
          saved and never shown again.
        </p>
      </div>

      <section className="rounded-lg border border-border bg-card" aria-labelledby="model-key-heading">
        <div className="border-b border-border px-4 py-2.5">
          <h2 id="model-key-heading" className="text-sm font-semibold">
            Provider
          </h2>
        </div>
        <div className="px-4 py-3">
          {adapterStatus.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading provider…</p>
          ) : adapterStatus.error ? (
            <p role="alert" className="text-sm text-destructive">
              {adapterStatus.error instanceof Error
                ? adapterStatus.error.message
                : "Could not load the provider status."}
            </p>
          ) : !provider?.required && !provider?.configured ? (
            <p className="text-sm text-muted-foreground" data-testid="model-key-not-required">
              This workspace does not use a hosted model provider — agents run on the adapters
              configured on this machine.
            </p>
          ) : (
            <div className="space-y-4">
              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex items-baseline gap-2">
                  <dt className="text-xs font-medium text-muted-foreground">Provider</dt>
                  <dd className="font-medium">{provider?.configured ? providerLabel : "None yet"}</dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="text-xs font-medium text-muted-foreground">Model</dt>
                  <dd className="font-medium">{provider?.model ?? "provider default"}</dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="text-xs font-medium text-muted-foreground">Key</dt>
                  <dd className="text-muted-foreground" data-testid="model-key-checked">
                    {provider?.configured ? checkedLabel(provider.configuredAt) : "not set"}
                  </dd>
                </div>
              </dl>

              {provider?.canConfigure ? (
                <RotateKeyForm
                  companyId={selectedCompanyId}
                  options={provider.options}
                  onSaved={() => {
                    void queryClient.invalidateQueries({ queryKey: ["onboarding-adapter-status"] });
                  }}
                />
              ) : (
                <div className="text-sm" data-testid="model-key-readonly">
                  <p className="text-muted-foreground">Only an administrator can change the model key.</p>
                  <ProviderKeyBlocked companyId={selectedCompanyId} />
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RotateKeyForm({
  companyId,
  options,
  onSaved,
}: {
  companyId: string;
  options: HermesProviderOption[];
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState<HermesProviderId>(options[0]?.provider ?? "zai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const selected = options.find((option) => option.provider === provider) ?? options[0];

  const save = useMutation({
    mutationFn: () =>
      onboardingApi.setupHermesProvider({
        companyId,
        provider,
        apiKey: apiKey.trim(),
        ...(model.trim() ? { model: model.trim() } : {}),
      }),
    onSuccess: () => {
      setApiKey("");
      setSaved(true);
      onSaved();
    },
    onError: (err) => {
      setSaved(false);
      setError(errorSentence(err));
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!apiKey.trim() || save.isPending) return;
    setError(null);
    setSaved(false);
    save.mutate();
  }

  return (
    <form className="space-y-3 border-t border-border pt-4" onSubmit={submit} data-testid="model-key-rotate">
      <p className="text-sm font-medium">Replace the key</p>
      <fieldset className="flex flex-wrap gap-3">
        {options.map((option) => (
          <label key={option.provider} className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="model-key-provider"
              value={option.provider}
              checked={provider === option.provider}
              onChange={() => setProvider(option.provider)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">New API key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="rounded border border-border bg-background px-3 py-2"
            placeholder={selected?.keyHint}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <label className="flex min-w-44 flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Model (optional)</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            className="rounded border border-border bg-background px-3 py-2"
            placeholder={selected?.defaultModel}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <Button type="submit" size="sm" disabled={!apiKey.trim() || save.isPending}>
          {save.isPending ? "Checking the key…" : "Check and save"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-400" data-testid="model-key-saved">
          Saved — agents pick up the new key on their next run.
        </p>
      ) : null}
    </form>
  );
}
